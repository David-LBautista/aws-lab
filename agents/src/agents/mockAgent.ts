import { EventType, type Interrupt, type ResumeEntry } from '@ag-ui/core';
import { initialDraft, searchCaseLaw, type DraftSection, type DraftState } from '../domain.js';
import type { ThreadMemory } from '../store/threadStore.js';
import { newId, sleep, type Agent, type AgentContext } from './types.js';

// Agente "falso" con guion: emite EXACTAMENTE los mismos eventos AG-UI que un agente real,
// sin gastar créditos de API. Sirve para desarrollar la UI y para las pruebas E2E.

const DELAY = Number(process.env.MOCK_DELAY_MS ?? 35);

const SECTIONS: Array<Omit<DraftSection, 'status' | 'content'> & { text: string }> = [
  {
    id: 'intro',
    title: 'I. Introduction',
    text:
      'Defendant Acme Corp. respectfully moves to dismiss the Complaint under Rule 12(b)(6). ' +
      'The Complaint relies on conclusory allegations and fails to state a plausible claim for relief.',
  },
  {
    id: 'standard',
    title: 'II. Legal Standard',
    text:
      'To survive a motion to dismiss, a complaint must contain sufficient factual matter to state a claim ' +
      'that is plausible on its face (Bell Atlantic Corp. v. Twombly, 2007). Threadbare recitals of the ' +
      'elements of a cause of action do not suffice (Ashcroft v. Iqbal, 2009).',
  },
  {
    id: 'argument',
    title: 'III. Argument',
    text:
      'Plaintiff alleges only that Acme "breached its duties" without identifying any specific act, date, ' +
      'or contractual provision. These are labels and conclusions, not facts, and they do not nudge the ' +
      'claim across the line from conceivable to plausible.',
  },
];

const PROPOSED_FILING = {
  court: 'U.S. District Court, Southern District of New York',
  filingTitle: "Defendant's Motion to Dismiss",
  summary: 'Moves to dismiss under Rule 12(b)(6) for failure to state a plausible claim.',
};

// Divide un texto en trozos pequeños para simular tokens.
function chunks(text: string, size = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function streamText(ctx: AgentContext, text: string) {
  const messageId = newId();
  ctx.emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
  for (const piece of chunks(text, 6)) {
    await sleep(DELAY / 2, ctx.signal);
    ctx.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: piece });
  }
  ctx.emit({ type: EventType.TEXT_MESSAGE_END, messageId });
}

async function streamToolCall(ctx: AgentContext, toolCallName: string, args: object) {
  const toolCallId = newId();
  ctx.emit({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName });
  // Los argumentos llegan como JSON PARCIAL: la UI debe poder mostrarlos antes de que estén completos.
  for (const piece of chunks(JSON.stringify(args), 8)) {
    await sleep(DELAY / 2, ctx.signal);
    ctx.emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: piece });
  }
  ctx.emit({ type: EventType.TOOL_CALL_END, toolCallId });
  return toolCallId;
}

export const mockAgent: Agent = async (ctx) => {
  const { threadId, runId } = ctx.input;
  ctx.emit({ type: EventType.RUN_STARTED, threadId, runId });

  const resume: ResumeEntry | undefined = ctx.input.resume?.[0];
  if (resume) return continueAfterHuman(ctx, resume);

  // ---------- Corrida nueva ----------
  const memory: ThreadMemory<DraftState> = { agentId: 'legal', state: initialDraft() };
  await ctx.store.save(threadId, memory); // (1) guardamos la conversación nueva
  ctx.emit({ type: EventType.STATE_SNAPSHOT, snapshot: memory.state });

  // Paso 1: investigación (herramienta de solo lectura, se ejecuta sin pedir permiso)
  ctx.emit({ type: EventType.STEP_STARTED, stepName: 'research' });
  await streamText(ctx, "I'll start by researching the federal pleading standard.");
  const query = { query: 'plausibility pleading standard' };
  const searchId = await streamToolCall(ctx, 'search_case_law', query);
  await sleep(DELAY * 4, ctx.signal);
  const citations = searchCaseLaw(query.query);
  ctx.emit({
    type: EventType.TOOL_CALL_RESULT,
    messageId: newId(),
    toolCallId: searchId,
    content: JSON.stringify(citations),
    role: 'tool',
  });
  ctx.emit({
    type: EventType.STATE_DELTA,
    delta: [
      { op: 'replace', path: '/citations', value: citations },
      { op: 'replace', path: '/filingStatus', value: 'drafting' },
    ],
  });
  ctx.emit({ type: EventType.STEP_FINISHED, stepName: 'research' });

  // Permite probar el manejo de errores desde la UI o las pruebas E2E.
  if (ctx.input.forwardedProps?.simulateError) {
    ctx.emit({
      type: EventType.RUN_ERROR,
      message: 'Simulated upstream failure while drafting',
      code: 'SIMULATED',
    });
    return;
  }

  // Paso 2: redacción. Cada sección se agrega y se "escribe" con STATE_DELTA (JSON Patch).
  ctx.emit({ type: EventType.STEP_STARTED, stepName: 'drafting' });
  for (const [i, section] of SECTIONS.entries()) {
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [
        {
          op: 'add',
          path: '/sections/-',
          value: { id: section.id, title: section.title, content: '', status: 'drafting' },
        },
      ],
    });
    let written = '';
    for (const piece of chunks(section.text, 14)) {
      await sleep(DELAY, ctx.signal);
      written += piece;
      ctx.emit({
        type: EventType.STATE_DELTA,
        delta: [{ op: 'replace', path: `/sections/${i}/content`, value: written }],
      });
    }
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [{ op: 'replace', path: `/sections/${i}/status`, value: 'done' }],
    });
  }
  memory.state = {
    ...memory.state,
    citations,
    filingStatus: 'pending_approval',
    sections: SECTIONS.map((s) => ({ id: s.id, title: s.title, content: s.text, status: 'done' })),
  };
  ctx.emit({ type: EventType.STEP_FINISHED, stepName: 'drafting' });

  // Paso 3: acción con efectos (presentar el escrito) => NO se ejecuta, se pide aprobación.
  await streamText(
    ctx,
    'The draft is ready. Filing is irreversible, so I need your approval first.',
  );
  const filingId = await streamToolCall(ctx, 'file_motion', PROPOSED_FILING);
  ctx.emit({
    type: EventType.STATE_DELTA,
    delta: [{ op: 'replace', path: '/filingStatus', value: 'pending_approval' }],
  });

  const interrupt: Interrupt = {
    id: newId(),
    reason: 'tool_approval',
    toolCallId: filingId,
    message: 'Approve filing this motion with the court?',
    responseSchema: {
      type: 'object',
      properties: {
        decision: { enum: ['approve', 'reject'] },
        editedArgs: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['decision'],
    },
  };

  // (2) guardamos la propuesta pendiente para poder continuar en otra corrida
  await ctx.store.save(threadId, {
    ...memory,
    pending: {
      interruptId: interrupt.id,
      toolCallId: filingId,
      toolName: 'file_motion',
      args: PROPOSED_FILING,
    },
  });

  // La corrida TERMINA en pausa. Continuar = una corrida nueva con `resume`.
  ctx.emit({
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    outcome: { type: 'interrupt', interrupts: [interrupt] },
  });
};

async function continueAfterHuman(ctx: AgentContext, resume: ResumeEntry) {
  const { threadId, runId } = ctx.input;

  // (3) recuperamos la conversación pausada
  const memory = await ctx.store.get<DraftState>(threadId);
  if (!memory?.pending || memory.pending.interruptId !== resume.interruptId) {
    ctx.emit({
      type: EventType.RUN_ERROR,
      message: 'Unknown or expired interrupt',
      code: 'BAD_RESUME',
    });
    return;
  }
  const pending = memory.pending;
  const decision = resume.status === 'cancelled' ? 'reject' : resume.payload?.decision;

  if (decision !== 'approve') {
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [{ op: 'replace', path: '/filingStatus', value: 'rejected' }],
    });
    const reason = resume.payload?.reason ? ` Noted: "${resume.payload.reason}".` : '';
    await streamText(
      ctx,
      `Understood. I did not file the motion.${reason} Tell me what to revise.`,
    );
  } else {
    const finalArgs = { ...pending.args, ...(resume.payload?.editedArgs ?? {}) };
    if (resume.payload?.editedArgs) {
      await streamText(ctx, 'Thanks, I will use your edited filing details.');
    }
    await sleep(DELAY * 6, ctx.signal);
    // Solo ahora "ejecutamos" la herramienta con efectos, con los argumentos aprobados.
    ctx.emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: newId(),
      toolCallId: pending.toolCallId,
      content: JSON.stringify({ filed: true, docketEntry: 42, ...finalArgs }),
      role: 'tool',
    });
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
    await streamText(ctx, `Filed "${finalArgs.filingTitle}" as docket entry 42.`);
  }

  // (4) la conversación ya no tiene nada pendiente
  await ctx.store.save(threadId, { ...memory, pending: undefined });
  ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } });
}
