import Anthropic from '@anthropic-ai/sdk';
import { EventType, type Interrupt, type ResumeEntry } from '@ag-ui/core';
import { initialDraft, searchCaseLaw, type DraftState } from '../domain.js';
import type { ThreadMemory } from '../store/threadStore.js';
import { newId, type Agent, type AgentContext } from './types.js';

// Agente REAL con Claude (Messages API en streaming + tool use).
// Traduce los eventos de streaming de Claude a eventos del protocolo AG-UI:
//   content_block_start (text)      -> TEXT_MESSAGE_START
//   text_delta                      -> TEXT_MESSAGE_CONTENT
//   content_block_start (tool_use)  -> TOOL_CALL_START
//   input_json_delta                -> TOOL_CALL_ARGS   (JSON parcial)
//   content_block_stop              -> TEXT_MESSAGE_END / TOOL_CALL_END
// Requiere ANTHROPIC_API_KEY (Claude Console). La suscripción Pro NO incluye API.

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-5-5';
const MAX_TURNS = 10;

const SYSTEM = `You are a litigation drafting assistant working inside a drafting app.
Case: Smith v. Acme Corp. We represent the defendant, Acme Corp. The plaintiff alleges that Acme
"breached its duties" without identifying any specific act, date or contract provision.
Task: draft a short Motion to Dismiss under Rule 12(b)(6).
Workflow:
1. Briefly say what you will do, then call search_case_law to find the pleading standard.
2. Write exactly three sections with write_section, one call per section, in this order:
   id "intro" ("I. Introduction"), id "standard" ("II. Legal Standard"), id "argument" ("III. Argument").
   Keep each section to 2-4 sentences and cite only cases returned by search_case_law.
3. Say in one sentence that the draft is ready, then call file_motion.
   Filing is irreversible: the app will pause and ask the human to approve, edit or reject it.
4. After the human decides, acknowledge the result in one or two sentences and stop.
Never invent citations.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_case_law',
    description: 'Search a case-law database. Read-only. Returns cases with their holdings.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'write_section',
    description: 'Add or replace one section of the draft motion shown to the user.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['id', 'title', 'content'],
    },
  },
  {
    name: 'file_motion',
    description:
      'File the motion with the court. IRREVERSIBLE. The app pauses and asks the human to approve, edit or reject.',
    input_schema: {
      type: 'object',
      properties: {
        court: { type: 'string' },
        filingTitle: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['court', 'filingTitle', 'summary'],
    },
  },
];

let client: Anthropic | undefined;
const getClient = () => (client ??= new Anthropic()); // lee ANTHROPIC_API_KEY del entorno

export const claudeAgent: Agent = async (ctx) => {
  const { threadId, runId } = ctx.input;
  ctx.emit({ type: EventType.RUN_STARTED, threadId, runId });

  const resume = ctx.input.resume?.[0];
  let memory = await ctx.store.get<DraftState>(threadId); // ← antes: threads.get(threadId)

  if (resume) {
    if (!memory?.pending || memory.pending.interruptId !== resume.interruptId) {
      ctx.emit({
        type: EventType.RUN_ERROR,
        message: 'Unknown or expired interrupt',
        code: 'BAD_RESUME',
      });
      return;
    }
    applyHumanDecision(ctx, memory, resume);
  } else {
    const lastUser = [...ctx.input.messages].reverse().find((m) => m.role === 'user');
    const prompt = typeof lastUser?.content === 'string' ? lastUser.content : 'Draft the motion.';
    memory = {
      agentId: 'legal',
      state: initialDraft(),
      claudeMessages: [{ role: 'user', content: prompt }],
    };
    await ctx.store.save(threadId, memory); // ← antes: threads.set(threadId, memory)
    ctx.emit({ type: EventType.STATE_SNAPSHOT, snapshot: memory.state });
  }

  try {
    await agentLoop(ctx, memory);
  } catch (err) {
    if (ctx.signal.aborted) return; // el usuario canceló: no hay a quién avisar
    const message =
      err instanceof Anthropic.APIError
        ? `Claude API error ${err.status}: ${err.message}`
        : String(err);
    ctx.emit({ type: EventType.RUN_ERROR, message, code: 'UPSTREAM' });
  }
};

async function agentLoop(ctx: AgentContext, memory: ThreadMemory<DraftState>) {
  const { threadId, runId } = ctx.input;
  const messages = memory.claudeMessages!;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = getClient().messages.stream(
      { model: MODEL, max_tokens: 2048, system: SYSTEM, tools: TOOLS, messages },
      { signal: ctx.signal },
    );

    // index del bloque de Claude -> id del mensaje/tool call en AG-UI
    const blocks = new Map<number, { kind: 'text' | 'tool'; id: string }>();

    for await (const ev of stream) {
      if (ev.type === 'content_block_start') {
        if (ev.content_block.type === 'text') {
          const id = newId();
          blocks.set(ev.index, { kind: 'text', id });
          ctx.emit({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' });
        } else if (ev.content_block.type === 'tool_use') {
          blocks.set(ev.index, { kind: 'tool', id: ev.content_block.id });
          ctx.emit({
            type: EventType.TOOL_CALL_START,
            toolCallId: ev.content_block.id,
            toolCallName: ev.content_block.name,
          });
        }
      } else if (ev.type === 'content_block_delta') {
        const block = blocks.get(ev.index);
        if (!block) continue;
        if (ev.delta.type === 'text_delta' && ev.delta.text) {
          ctx.emit({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: block.id,
            delta: ev.delta.text,
          });
        } else if (ev.delta.type === 'input_json_delta' && ev.delta.partial_json) {
          ctx.emit({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: block.id,
            delta: ev.delta.partial_json,
          });
        }
      } else if (ev.type === 'content_block_stop') {
        const block = blocks.get(ev.index);
        if (block?.kind === 'text')
          ctx.emit({ type: EventType.TEXT_MESSAGE_END, messageId: block.id });
        if (block?.kind === 'tool')
          ctx.emit({ type: EventType.TOOL_CALL_END, toolCallId: block.id });
      }
    }

    const final = await stream.finalMessage();
    messages.push({ role: 'assistant', content: final.content });

    const toolUses = final.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (final.stop_reason !== 'tool_use' || toolUses.length === 0) {
      await ctx.store.save(threadId, memory); // ← nuevo: guardar antes de terminar
      ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } });
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let needsApproval: Anthropic.ToolUseBlock | undefined;

    for (const toolUse of toolUses) {
      if (toolUse.name === 'file_motion') {
        needsApproval = toolUse; // acción con efectos: NO se ejecuta aquí
        continue;
      }
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: runServerTool(ctx, memory, toolUse),
      });
    }

    if (needsApproval) {
      const interrupt: Interrupt = {
        id: newId(),
        reason: 'tool_approval',
        toolCallId: needsApproval.id,
        message: 'Approve filing this motion with the court?',
      };
      memory.pending = {
        interruptId: interrupt.id,
        toolCallId: needsApproval.id,
        toolName: needsApproval.name,
        args: needsApproval.input as Record<string, unknown>,
      };
      memory.pendingToolResults = results;
      memory.state = { ...memory.state, filingStatus: 'pending_approval' };
      ctx.emit({
        type: EventType.STATE_DELTA,
        delta: [{ op: 'replace', path: '/filingStatus', value: 'pending_approval' }],
      });
      await ctx.store.save(threadId, memory); // ← nuevo: guardar la propuesta pendiente antes de pausar
      ctx.emit({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: { type: 'interrupt', interrupts: [interrupt] },
      });
      return;
    }

    messages.push({ role: 'user', content: results });
  }

  ctx.emit({
    type: EventType.RUN_ERROR,
    message: 'Agent exceeded the maximum number of turns',
    code: 'MAX_TURNS',
  });
}

// Herramientas que el servidor ejecuta sin pedir permiso (lectura o cambios al borrador).
function runServerTool(
  ctx: AgentContext,
  memory: ThreadMemory<DraftState>,
  toolUse: Anthropic.ToolUseBlock,
): string {
  const input = toolUse.input as Record<string, string>;
  let result: unknown;

  if (toolUse.name === 'search_case_law') {
    const citations = searchCaseLaw(input.query ?? '');
    memory.state = { ...memory.state, citations, filingStatus: 'drafting' };
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [
        { op: 'replace', path: '/citations', value: citations },
        { op: 'replace', path: '/filingStatus', value: 'drafting' },
      ],
    });
    result = citations;
  } else if (toolUse.name === 'write_section') {
    const section = {
      id: input.id,
      title: input.title,
      content: input.content,
      status: 'done' as const,
    };
    const index = memory.state.sections.findIndex((s) => s.id === input.id);
    if (index >= 0) {
      memory.state.sections[index] = section;
      ctx.emit({
        type: EventType.STATE_DELTA,
        delta: [{ op: 'replace', path: `/sections/${index}`, value: section }],
      });
    } else {
      memory.state.sections.push(section);
      ctx.emit({
        type: EventType.STATE_DELTA,
        delta: [{ op: 'add', path: '/sections/-', value: section }],
      });
    }
    result = { ok: true };
  } else {
    result = { error: `Unknown tool ${toolUse.name}` };
  }

  const content = JSON.stringify(result);
  ctx.emit({
    type: EventType.TOOL_CALL_RESULT,
    messageId: newId(),
    toolCallId: toolUse.id,
    content,
    role: 'tool',
  });
  return content;
}

// Aplica la decisión humana y la devuelve a Claude como tool_result del file_motion pendiente.
function applyHumanDecision(
  ctx: AgentContext,
  memory: ThreadMemory<DraftState>,
  resume: ResumeEntry,
) {
  const pending = memory.pending!;
  const approved = resume.status === 'resolved' && resume.payload?.decision === 'approve';
  let content: string;

  if (approved) {
    const finalArgs = { ...pending.args, ...(resume.payload?.editedArgs ?? {}) };
    // Aquí iría la integración real (presentar el escrito). La simulamos.
    content = JSON.stringify({
      filed: true,
      docketEntry: 42,
      ...finalArgs,
      editedByHuman: !!resume.payload?.editedArgs,
    });
    memory.state = {
      ...memory.state,
      filingStatus: 'approved',
      sections: memory.state.sections.map((s) => ({ ...s, status: 'approved' })),
    };
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [
        { op: 'replace', path: '/filingStatus', value: 'approved' },
        ...memory.state.sections.map((_, i) => ({
          op: 'replace' as const,
          path: `/sections/${i}/status`,
          value: 'approved',
        })),
      ],
    });
  } else {
    content = JSON.stringify({
      filed: false,
      rejectedByHuman: true,
      reason: resume.payload?.reason ?? 'No reason given',
    });
    memory.state = { ...memory.state, filingStatus: 'rejected' };
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [{ op: 'replace', path: '/filingStatus', value: 'rejected' }],
    });
  }

  ctx.emit({
    type: EventType.TOOL_CALL_RESULT,
    messageId: newId(),
    toolCallId: pending.toolCallId,
    content,
    role: 'tool',
  });

  memory.claudeMessages!.push({
    role: 'user',
    content: [
      ...(memory.pendingToolResults ?? []),
      { type: 'tool_result', tool_use_id: pending.toolCallId, content },
    ],
  });
  memory.pending = undefined;
  memory.pendingToolResults = undefined;
}
