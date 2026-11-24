import Anthropic from '@anthropic-ai/sdk';
import { EventType, type Interrupt, type ResumeEntry } from '@ag-ui/core';
import type { ThreadMemory } from '../store/threadStore.js';
import { newId, type Agent, type AgentContext } from '../agents/types.js';
import {
  MIN_SCORE,
  debtToIncome,
  getCreditReport,
  monthlyPayment,
  parseApplicationInput,
  rateForScore,
  type CreditState,
  type Recommendation,
  type RiskCheck,
} from './domain.js';

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-5-5';
const MAX_TURNS = 12;
const MAX_DTI = 0.4;
const APPROVAL_TOOLS = new Set(['approve_loan', 'reject_loan']);

const SYSTEM = `Eres un analista de crédito dentro de una app bancaria. Respondes siempre en español, breve y claro, en texto plano: sin markdown, sin asteriscos, sin viñetas ni encabezados.
Analiza una solicitud con las herramientas y propón una decisión. Un analista humano autoriza la decisión final.
Reglas: score mínimo ${MIN_SCORE}; deuda/ingreso máximo ${MAX_DTI * 100}%; plazos permitidos: los que indica la solicitud, en ese orden. No uses otros; el sistema calcula la tasa.
Di qué harás y consulta get_credit_report. Después usa calculate_payment con el plazo solicitado. Si supera el límite, explica y prueba el siguiente plazo permitido. Nunca calcules números por tu cuenta.
Termina con approve_loan si cumple todo o reject_loan si no cumple, con razones concretas. Explica la recomendación antes de proponerla. La aplicación pausará para que un humano decida. Al reanudar, confirma su decisión brevemente y termina.`;

const TOOLS: Anthropic.Tool[] = [
  { name: 'get_credit_report', description: 'Consulta el buró de crédito del solicitante. Solo lectura.', input_schema: { type: 'object', properties: { applicationId: { type: 'string' } }, required: ['applicationId'] } },
  { name: 'calculate_payment', description: 'Calcula tasa según score, pago mensual y deuda/ingreso para un plazo. Requiere consulta del buró.', input_schema: { type: 'object', properties: { termMonths: { type: 'integer' } }, required: ['termMonths'] } },
  { name: 'approve_loan', description: 'Propone emitir el crédito. La app pausa para aprobación humana.', input_schema: { type: 'object', properties: { termMonths: { type: 'integer' }, rationale: { type: 'string' }, conditions: { type: 'array', items: { type: 'string' } } }, required: ['termMonths', 'rationale'] } },
  { name: 'reject_loan', description: 'Propone rechazar. La app pausa para confirmación humana o revisión manual.', input_schema: { type: 'object', properties: { reasons: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'De 1 a 3 razones concretas, cada una de máximo 15 palabras, con el dato clave (p. ej. "Deuda/ingreso de 88%, máximo 40%")' } }, required: ['reasons'] } },
];

export type ClaudeClient = Pick<Anthropic, 'messages'>;

const STEP_FOR_TOOL: Record<string, string> = {
  get_credit_report: 'credit_report', calculate_payment: 'affordability', approve_loan: 'decision', reject_loan: 'decision',
};
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function createCreditClaudeAgent(getClient: () => ClaudeClient): Agent {
  return async (ctx) => {
    const { threadId, runId } = ctx.input;
    ctx.emit({ type: EventType.RUN_STARTED, threadId, runId });
    const resume = ctx.input.resume?.[0];
    let memory: ThreadMemory<CreditState> | undefined;

    if (resume) {
      memory = await ctx.store.get<CreditState>(threadId);
      if (!memory?.pending || memory.pending.interruptId !== resume.interruptId) {
        ctx.emit({ type: EventType.RUN_ERROR, message: 'Unknown or expired interrupt', code: 'BAD_RESUME' });
        return;
      }
      applyAnalystDecision(ctx, memory, resume);
    } else {
      const parsed = parseApplicationInput(ctx.input.state);
      if (!parsed.ok) {
        ctx.emit({ type: EventType.RUN_ERROR, message: parsed.errors.join(' '), code: 'INVALID_APPLICATION' });
        return;
      }
      const state = { ...parsed.state, status: 'analyzing' as const };
      memory = {
        agentId: 'credit', state, serverContext: { simulatedScore: parsed.simulatedScore },
        claudeMessages: [{ role: 'user', content: `Analiza esta solicitud:\n${JSON.stringify({ applicationId: state.applicationId, applicant: state.applicant, request: state.request }, null, 2)}\nPlazos permitidos para esta solicitud, en orden: ${allowedTerms(state).join(', ')} meses.` }],
      };
      await ctx.store.save(threadId, memory);
      ctx.emit({ type: EventType.STATE_SNAPSHOT, snapshot: state });
    }

    const steps = new StepTracker(ctx);
    try {
      await agentLoop(ctx, memory, getClient(), steps);
    } catch (err) {
      if (ctx.signal.aborted) return;
      steps.finish();
      const message = err instanceof Anthropic.APIError ? `Claude API error ${err.status}: ${err.message}` : String(err);
      ctx.emit({ type: EventType.RUN_ERROR, message, code: 'UPSTREAM' });
    }
  };
}

class StepTracker {
  private current: string | null = null;
  constructor(private readonly ctx: AgentContext) {}
  enter(step?: string) {
    if (!step || step === this.current) return;
    this.finish(); this.current = step;
    this.ctx.emit({ type: EventType.STEP_STARTED, stepName: step });
  }
  finish() {
    if (!this.current) return;
    this.ctx.emit({ type: EventType.STEP_FINISHED, stepName: this.current }); this.current = null;
  }
}

async function agentLoop(ctx: AgentContext, memory: ThreadMemory<CreditState>, client: ClaudeClient, steps: StepTracker) {
  const { threadId, runId } = ctx.input;
  const messages = memory.claudeMessages!;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = client.messages.stream({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages }, { signal: ctx.signal });
    const blocks = new Map<number, { kind: 'text' | 'tool'; id: string }>();
    for await (const ev of stream) {
      if (ev.type === 'content_block_start') {
        if (ev.content_block.type === 'text') {
          const id = newId(); blocks.set(ev.index, { kind: 'text', id });
          ctx.emit({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' });
        } else if (ev.content_block.type === 'tool_use') {
          steps.enter(STEP_FOR_TOOL[ev.content_block.name]);
          blocks.set(ev.index, { kind: 'tool', id: ev.content_block.id });
          ctx.emit({ type: EventType.TOOL_CALL_START, toolCallId: ev.content_block.id, toolCallName: ev.content_block.name });
        }
      } else if (ev.type === 'content_block_delta') {
        const block = blocks.get(ev.index);
        if (!block) continue;
        if (ev.delta.type === 'text_delta' && ev.delta.text) ctx.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: block.id, delta: ev.delta.text });
        else if (ev.delta.type === 'input_json_delta' && ev.delta.partial_json) ctx.emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: block.id, delta: ev.delta.partial_json });
      } else if (ev.type === 'content_block_stop') {
        const block = blocks.get(ev.index);
        if (block?.kind === 'text') ctx.emit({ type: EventType.TEXT_MESSAGE_END, messageId: block.id });
        if (block?.kind === 'tool') ctx.emit({ type: EventType.TOOL_CALL_END, toolCallId: block.id });
      }
    }
    const final = await stream.finalMessage();
    messages.push({ role: 'assistant', content: final.content });
    const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (final.stop_reason !== 'tool_use' || toolUses.length === 0) {
      steps.finish(); await ctx.store.save(threadId, memory);
      ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } }); return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let proposal: { toolUse: Anthropic.ToolUseBlock; args: Record<string, unknown> } | undefined;
    for (const toolUse of toolUses) {
      if (APPROVAL_TOOLS.has(toolUse.name) && !proposal) {
        const check = validateProposal(memory, toolUse);
        if (check.ok) proposal = { toolUse, args: check.args };
        else results.push(toolResult(ctx, toolUse.id, { error: check.error }, true));
      } else if (APPROVAL_TOOLS.has(toolUse.name)) {
        results.push(toolResult(ctx, toolUse.id, { error: 'Solo se permite una propuesta a la vez.' }, true));
      } else results.push(runServerTool(ctx, memory, toolUse));
    }
    if (proposal) {
      steps.finish(); await pauseForAnalyst(ctx, memory, proposal.toolUse, proposal.args, results); return;
    }
    messages.push({ role: 'user', content: results });
  }
  steps.finish();
  ctx.emit({ type: EventType.RUN_ERROR, message: 'El agente excedió el número máximo de pasos', code: 'MAX_TURNS' });
}

function toolResult(ctx: AgentContext, id: string, result: unknown, isError = false): Anthropic.ToolResultBlockParam {
  const content = JSON.stringify(result);
  ctx.emit({ type: EventType.TOOL_CALL_RESULT, messageId: newId(), toolCallId: id, content, role: 'tool' });
  return { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

function setCheck(ctx: AgentContext, state: CreditState, check: RiskCheck) {
  const index = state.checks.findIndex((item) => item.id === check.id);
  if (index >= 0) { state.checks[index] = check; ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: `/checks/${index}`, value: check }] }); }
  else { state.checks.push(check); ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/checks/-', value: check }] }); }
}

function runServerTool(ctx: AgentContext, memory: ThreadMemory<CreditState>, toolUse: Anthropic.ToolUseBlock): Anthropic.ToolResultBlockParam {
  const state = memory.state;
  const input = toolUse.input as Record<string, unknown>;
  if (toolUse.name === 'get_credit_report') {
    const report = getCreditReport(state.applicationId, memory.serverContext?.simulatedScore as number | undefined);
    state.applicant.creditScore = report.creditScore;
    ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/applicant/creditScore', value: report.creditScore }] });
    const score = report.creditScore;
    setCheck(ctx, state, { id: 'score', label: 'Score de crédito', status: score < MIN_SCORE ? 'fail' : score < 680 ? 'warn' : 'pass', detail: `Score ${score}, ${report.latePaymentsLast12m} atrasos en 12 meses${score < MIN_SCORE ? ` (mínimo ${MIN_SCORE})` : ''}` });
    setCheck(ctx, state, { id: 'employment', label: 'Antigüedad laboral', status: state.applicant.employmentYears >= 1 ? 'pass' : 'warn', detail: `${state.applicant.employmentYears} años en su empleo actual` });
    return toolResult(ctx, toolUse.id, report);
  }
  if (toolUse.name === 'calculate_payment') {
    const score = state.applicant.creditScore;
    if (score === undefined) return toolResult(ctx, toolUse.id, { error: 'Primero consulta el buró con get_credit_report.' }, true);
    const termMonths = Number(input.termMonths);
    if (!allowedTerms(state).includes(termMonths)) return toolResult(ctx, toolUse.id, { error: `Plazo no permitido. Usa uno de: ${allowedTerms(state).join(', ')}.` }, true);
    const annualRate = rateForScore(score);
    const payment = monthlyPayment(state.request.amount, annualRate, termMonths);
    const dti = debtToIncome(state.applicant, payment);
    state.metrics = { annualRate, monthlyPayment: payment, debtToIncome: dti };
    ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/metrics', value: state.metrics }] });
    setCheck(ctx, state, { id: 'dti', label: 'Deuda / ingreso', status: dti <= MAX_DTI ? 'pass' : 'warn', detail: `${pct(dti)} con pago de $${payment.toLocaleString('es-MX')} a ${termMonths} meses (máximo ${pct(MAX_DTI)})` });
    return toolResult(ctx, toolUse.id, { termMonths, annualRate, monthlyPayment: payment, debtToIncome: dti, withinLimit: dti <= MAX_DTI });
  }
  return toolResult(ctx, toolUse.id, { error: `Herramienta desconocida: ${toolUse.name}` }, true);
}

const allowedTerms = (state: CreditState) => [...new Set([state.request.termMonths, 36, 48])].filter((term) => term >= state.request.termMonths);
type ProposalCheck = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function validateProposal(memory: ThreadMemory<CreditState>, toolUse: Anthropic.ToolUseBlock): ProposalCheck {
  const state = memory.state;
  const input = toolUse.input as Record<string, unknown>;
  const score = state.applicant.creditScore;
  if (score === undefined) return { ok: false, error: 'Primero consulta el buró con get_credit_report.' };
  if (toolUse.name === 'reject_loan') {
    const reasons = Array.isArray(input.reasons)
      ? input.reasons.map((reason) => String(reason).trim().replace(/[.;]+$/, '')).filter(Boolean).slice(0, 3)
      : [];
    if (!reasons.length) return { ok: false, error: 'Indica al menos una razón concreta del rechazo.' };
    return { ok: true, args: { applicationId: state.applicationId, reasons } };
  }
  const termMonths = Number(input.termMonths);
  if (!allowedTerms(state).includes(termMonths)) return { ok: false, error: `Plazo no permitido. Usa uno de: ${allowedTerms(state).join(', ')}.` };
  if (score < MIN_SCORE) return { ok: false, error: `No se puede aprobar: el score ${score} es menor al mínimo de ${MIN_SCORE}.` };
  const annualRate = rateForScore(score);
  const dti = debtToIncome(state.applicant, monthlyPayment(state.request.amount, annualRate, termMonths));
  if (dti > MAX_DTI) return { ok: false, error: `No se puede aprobar a ${termMonths} meses: deuda/ingreso de ${pct(dti)} supera el ${pct(MAX_DTI)}.` };
  return { ok: true, args: { applicationId: state.applicationId, amount: state.request.amount, termMonths, annualRate, rationale: String(input.rationale ?? ''), conditions: Array.isArray(input.conditions) ? input.conditions.map(String) : [] } };
}

async function pauseForAnalyst(ctx: AgentContext, memory: ThreadMemory<CreditState>, toolUse: Anthropic.ToolUseBlock, args: Record<string, unknown>, otherResults: Anthropic.ToolResultBlockParam[]) {
  const { threadId, runId } = ctx.input;
  const state = memory.state;
  const approve = toolUse.name === 'approve_loan';
  const termMonths = approve ? Number(args.termMonths) : state.request.termMonths;
  const recommendation: Recommendation = approve
    ? { decision: 'approve', amount: Number(args.amount), termMonths, annualRate: Number(args.annualRate), conditions: (args.conditions as string[]).length ? args.conditions as string[] : termMonths !== state.request.termMonths ? [`Plazo ajustado de ${state.request.termMonths} a ${termMonths} meses`] : [], rationale: String(args.rationale) }
    : { decision: 'reject', amount: state.request.amount, termMonths, annualRate: state.metrics.annualRate ?? rateForScore(state.applicant.creditScore ?? 0), conditions: [], rationale: `No cumple: ${(args.reasons as string[]).join('; ')}.` };
  if (!approve) {
    const idx = state.checks.findIndex((check) => check.id === 'dti');
    if (idx >= 0 && state.checks[idx].status === 'warn') setCheck(ctx, state, { ...state.checks[idx], status: 'fail' });
  }
  state.recommendation = recommendation; state.status = 'pending_approval';
  ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/recommendation', value: recommendation }, { op: 'replace', path: '/status', value: 'pending_approval' }] });
  const interrupt: Interrupt = { id: newId(), reason: 'tool_approval', toolCallId: toolUse.id, message: approve ? `¿Autorizas emitir el crédito de $${recommendation.amount.toLocaleString('es-MX')} a ${termMonths} meses?` : '¿Confirmas el rechazo de la solicitud?' };
  memory.pending = { interruptId: interrupt.id, toolCallId: toolUse.id, toolName: toolUse.name, args };
  memory.pendingToolResults = otherResults;
  await ctx.store.save(threadId, memory);
  ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'interrupt', interrupts: [interrupt] } });
}

function applyAnalystDecision(ctx: AgentContext, memory: ThreadMemory<CreditState>, resume: ResumeEntry) {
  const pending = memory.pending!;
  const state = memory.state;
  const confirmed = resume.status === 'resolved' && resume.payload?.decision === 'approve';
  const reason = resume.payload?.reason as string | undefined;
  let result: Record<string, unknown>;
  const setStatus = (status: CreditState['status']) => { state.status = status; ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/status', value: status }] }); };
  if (pending.toolName === 'reject_loan') {
    if (confirmed) { result = { rejected: true, ...pending.args }; setStatus('rejected'); }
    else { result = { rejected: false, sentToManualReview: true, analystNote: reason }; setStatus('manual_review'); }
  } else if (!confirmed) {
    result = { issued: false, reason: reason ?? 'Rechazado por el analista' }; setStatus('rejected');
  } else {
    const args = { ...pending.args, ...(resume.payload?.editedArgs ?? {}) } as { amount: number; termMonths: number; annualRate: number };
    const payment = monthlyPayment(args.amount, args.annualRate, args.termMonths);
    const dti = debtToIncome(state.applicant, payment);
    result = { issued: true, loanId: `LN-${Date.now().toString().slice(-6)}`, amount: args.amount, termMonths: args.termMonths, annualRate: args.annualRate, monthlyPayment: payment, editedByAnalyst: Boolean(resume.payload?.editedArgs) };
    state.metrics = { annualRate: args.annualRate, monthlyPayment: payment, debtToIncome: dti };
    ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/metrics', value: state.metrics }] }); setStatus('approved');
  }
  const content = JSON.stringify(result);
  ctx.emit({ type: EventType.TOOL_CALL_RESULT, messageId: newId(), toolCallId: pending.toolCallId, content, role: 'tool' });
  memory.claudeMessages!.push({ role: 'user', content: [...(memory.pendingToolResults ?? []), { type: 'tool_result', tool_use_id: pending.toolCallId, content }] });
  memory.pending = undefined; memory.pendingToolResults = undefined;
}

let client: Anthropic | undefined;
export const creditClaudeAgent = createCreditClaudeAgent(() => (client ??= new Anthropic()));
