import { EventType, type Interrupt, type ResumeEntry } from '@ag-ui/core';
import type { ThreadMemory } from '../store/threadStore.js';
import { newId, sleep, type Agent, type AgentContext } from '../agents/types.js';
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

// Agente de créditos con guion (gratis). La solicitud llega desde el formulario
// (RunAgentInput.state) y hay tres caminos: aprobar al plazo pedido,
// aprobar ajustando el plazo, o recomendar rechazo.

const DELAY = Number(process.env.MOCK_DELAY_MS ?? 35);
const MAX_DTI = 0.4; // deudas + nuevo pago no deben pasar del 40% del ingreso
const TERM_OPTIONS = [36, 48]; // plazos que el agente prueba si el pedido no alcanza

const money = (n: number) => `$${n.toLocaleString('es-MX')}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function say(ctx: AgentContext, text: string) {
  const messageId = newId();
  ctx.emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
  for (const piece of chunks(text, 6)) {
    await sleep(DELAY / 2, ctx.signal);
    ctx.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: piece });
  }
  ctx.emit({ type: EventType.TEXT_MESSAGE_END, messageId });
}

// Emite una tool call con sus argumentos en streaming y, si se da, su resultado.
async function callTool(ctx: AgentContext, toolCallName: string, args: object, result?: unknown) {
  const toolCallId = newId();
  ctx.emit({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName });
  for (const piece of chunks(JSON.stringify(args), 8)) {
    await sleep(DELAY / 2, ctx.signal);
    ctx.emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: piece });
  }
  ctx.emit({ type: EventType.TOOL_CALL_END, toolCallId });
  if (result !== undefined) {
    await sleep(DELAY * 3, ctx.signal);
    ctx.emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: newId(),
      toolCallId,
      content: JSON.stringify(result),
      role: 'tool',
    });
  }
  return toolCallId;
}

export const creditMockAgent: Agent = async (ctx) => {
  const { threadId, runId } = ctx.input;
  ctx.emit({ type: EventType.RUN_STARTED, threadId, runId });

  const resume = ctx.input.resume?.[0];
  if (resume) return continueAfterAnalyst(ctx, resume);

  // ---------- Corrida nueva: validar lo que mandó el navegador ----------
  const parsed = parseApplicationInput(ctx.input.state);
  if (!parsed.ok) {
    ctx.emit({ type: EventType.RUN_ERROR, message: parsed.errors.join(' '), code: 'INVALID_APPLICATION' });
    return;
  }

  const memory: ThreadMemory<CreditState> = { agentId: 'credit', state: parsed.state };
  const state = memory.state;
  await ctx.store.save(threadId, memory);
  ctx.emit({ type: EventType.STATE_SNAPSHOT, snapshot: state });
  ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/status', value: 'analyzing' }] });

  const addCheck = (check: RiskCheck) => {
    state.checks.push(check);
    ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/checks/-', value: check }] });
    return state.checks.length - 1;
  };
  const updateCheck = (index: number, status: RiskCheck['status'], detail: string) => {
    state.checks[index] = { ...state.checks[index], status, detail };
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [
        { op: 'replace', path: `/checks/${index}/status`, value: status },
        { op: 'replace', path: `/checks/${index}/detail`, value: detail },
      ],
    });
  };

  // Paso 1: buró de crédito (herramienta de solo lectura)
  ctx.emit({ type: EventType.STEP_STARTED, stepName: 'credit_report' });
  await say(ctx, `Voy a analizar la solicitud de ${state.applicant.name}. Primero consulto su historial en el buró de crédito.`);
  const scoreCheck = addCheck({ id: 'score', label: 'Score de crédito', status: 'pending', detail: 'Consultando buró…' });
  const report = getCreditReport(state.applicationId, parsed.simulatedScore);
  await callTool(ctx, 'get_credit_report', { applicationId: state.applicationId }, report);
  state.applicant.creditScore = report.creditScore;
  ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/applicant/creditScore', value: report.creditScore }] });

  const scoreOk = report.creditScore >= MIN_SCORE;
  updateCheck(
    scoreCheck,
    !scoreOk ? 'fail' : report.creditScore < 680 ? 'warn' : 'pass',
    `Score ${report.creditScore}, ${report.latePaymentsLast12m} atrasos en 12 meses` +
      (!scoreOk ? ` (mínimo ${MIN_SCORE})` : report.creditScore < 680 ? ' (tasa más alta)' : ''),
  );

  addCheck({
    id: 'employment',
    label: 'Antigüedad laboral',
    status: state.applicant.employmentYears >= 1 ? 'pass' : 'warn',
    detail: `${state.applicant.employmentYears} años en su empleo actual`,
  });
  ctx.emit({ type: EventType.STEP_FINISHED, stepName: 'credit_report' });

  if (ctx.input.forwardedProps?.simulateError) {
    ctx.emit({ type: EventType.RUN_ERROR, message: 'El servicio de buró no respondió (simulado)', code: 'SIMULATED' });
    return;
  }

  // Paso 2: capacidad de pago. Prueba el plazo pedido y, si no alcanza, plazos más largos.
  ctx.emit({ type: EventType.STEP_STARTED, stepName: 'affordability' });
  const annualRate = rateForScore(report.creditScore);
  const terms = [state.request.termMonths, ...TERM_OPTIONS.filter((t) => t > state.request.termMonths)];

  let term = terms[0];
  let payment = 0;
  let dti = 0;
  let dtiCheck = -1;

  for (const [attempt, candidate] of terms.entries()) {
    if (attempt > 0) {
      await say(ctx, `A ${term} meses la razón deuda/ingreso queda en ${pct(dti)}, arriba del ${pct(MAX_DTI)}. Pruebo con ${candidate} meses.`);
    }
    term = candidate;
    payment = monthlyPayment(state.request.amount, annualRate, term);
    await callTool(ctx, 'calculate_payment', { amount: state.request.amount, annualRate, termMonths: term }, { monthlyPayment: payment });
    dti = debtToIncome(state.applicant, payment);
    state.metrics = { annualRate, monthlyPayment: payment, debtToIncome: dti };
    ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/metrics', value: state.metrics }] });

    const detail = `${pct(dti)} con pago de ${money(payment)} a ${term} meses (máximo ${pct(MAX_DTI)})`;
    if (dtiCheck < 0) {
      dtiCheck = addCheck({ id: 'dti', label: 'Deuda / ingreso', status: dti <= MAX_DTI ? 'pass' : 'warn', detail });
    } else {
      updateCheck(dtiCheck, dti <= MAX_DTI ? 'pass' : 'warn', detail);
    }
    if (dti <= MAX_DTI) break;
  }

  const affordable = dti <= MAX_DTI;
  if (!affordable) updateCheck(dtiCheck, 'fail', `${pct(dti)} incluso a ${term} meses (máximo ${pct(MAX_DTI)})`);
  ctx.emit({ type: EventType.STEP_FINISHED, stepName: 'affordability' });

  // Paso 3: recomendación. Sea aprobar o rechazar, la decisión final es del analista.
  ctx.emit({ type: EventType.STEP_STARTED, stepName: 'decision' });
  const approve = scoreOk && affordable;
  const reasons = [
    !scoreOk ? `score ${report.creditScore} menor al mínimo de ${MIN_SCORE}` : null,
    !affordable ? `deuda/ingreso de ${pct(dti)} incluso a ${term} meses` : null,
  ].filter((r): r is string => r !== null);

  const recommendation: Recommendation = {
    decision: approve ? 'approve' : 'reject',
    amount: state.request.amount,
    termMonths: term,
    annualRate,
    conditions: approve && term !== state.request.termMonths ? [`Plazo ajustado de ${state.request.termMonths} a ${term} meses`] : [],
    rationale: approve
      ? `Score ${report.creditScore}, ${state.applicant.employmentYears} años de antigüedad y deuda/ingreso de ${pct(dti)}.`
      : `No cumple: ${reasons.join('; ')}.`,
  };
  state.recommendation = recommendation;
  state.status = 'pending_approval';
  ctx.emit({
    type: EventType.STATE_DELTA,
    delta: [
      { op: 'replace', path: '/recommendation', value: recommendation },
      { op: 'replace', path: '/status', value: 'pending_approval' },
    ],
  });

  let toolName: 'approve_loan' | 'reject_loan';
  let proposal: Record<string, unknown>;
  let question: string;

  if (approve) {
    await say(ctx, `Recomiendo aprobar ${money(recommendation.amount)} a ${term} meses con tasa de ${pct(annualRate)} anual. Necesito tu autorización para emitirlo.`);
    toolName = 'approve_loan';
    proposal = { applicationId: state.applicationId, amount: recommendation.amount, termMonths: term, annualRate };
    question = `¿Autorizas emitir el crédito de ${money(recommendation.amount)} a ${term} meses?`;
  } else {
    await say(ctx, `Recomiendo rechazar la solicitud: ${reasons.join('; ')}. Confirma el rechazo o envíala a revisión manual.`);
    toolName = 'reject_loan';
    proposal = { applicationId: state.applicationId, reasons };
    question = '¿Confirmas el rechazo de la solicitud?';
  }

  const callId = await callTool(ctx, toolName, proposal); // sin resultado: NO se ejecuta
  ctx.emit({ type: EventType.STEP_FINISHED, stepName: 'decision' });

  const interrupt: Interrupt = {
    id: newId(),
    reason: 'tool_approval',
    toolCallId: callId,
    message: question,
  };
  await ctx.store.save(threadId, {
    ...memory,
    pending: { interruptId: interrupt.id, toolCallId: callId, toolName, args: proposal },
  });
  ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'interrupt', interrupts: [interrupt] } });
};

async function continueAfterAnalyst(ctx: AgentContext, resume: ResumeEntry) {
  const { threadId, runId } = ctx.input;
  const memory = await ctx.store.get<CreditState>(threadId);
  if (!memory?.pending || memory.pending.interruptId !== resume.interruptId) {
    ctx.emit({ type: EventType.RUN_ERROR, message: 'Unknown or expired interrupt', code: 'BAD_RESUME' });
    return;
  }
  const state = memory.state;
  const pending = memory.pending;
  // "approve" = el analista confirma lo que propuso el agente (emitir o rechazar).
  const confirmed = resume.status === 'resolved' && resume.payload?.decision === 'approve';

  if (pending.toolName === 'reject_loan') {
    if (confirmed) {
      ctx.emit({
        type: EventType.TOOL_CALL_RESULT,
        messageId: newId(),
        toolCallId: pending.toolCallId,
        content: JSON.stringify({ rejected: true, ...pending.args }),
        role: 'tool',
      });
      state.status = 'rejected';
      ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/status', value: 'rejected' }] });
      await say(ctx, `Solicitud ${state.applicationId} rechazada.`);
    } else {
      // El analista no está de acuerdo con el rechazo: un humano la revisará a detalle.
      ctx.emit({
        type: EventType.TOOL_CALL_RESULT,
        messageId: newId(),
        toolCallId: pending.toolCallId,
        content: JSON.stringify({ rejected: false, sentToManualReview: true }),
        role: 'tool',
      });
      state.status = 'manual_review';
      ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/status', value: 'manual_review' }] });
      const reason = resume.payload?.reason ? ` Nota: "${resume.payload.reason}".` : '';
      await say(ctx, `Entendido, no la rechazo. La envío a revisión manual.${reason}`);
    }
  } else if (!confirmed) {
    ctx.emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: newId(),
      toolCallId: pending.toolCallId,
      content: JSON.stringify({
        issued: false,
        reason: resume.payload?.reason ?? 'Rechazado por el analista',
      }),
      role: 'tool',
    });
    state.status = 'rejected';
    ctx.emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/status', value: 'rejected' }] });
    const reason = resume.payload?.reason ? ` Motivo registrado: "${resume.payload.reason}".` : '';
    await say(ctx, `Entendido, la solicitud ${state.applicationId} queda rechazada.${reason}`);
  } else {
    // El analista puede ajustar monto o plazo antes de aprobar: recalculamos con lo que aprobó.
    const args = { ...pending.args, ...(resume.payload?.editedArgs ?? {}) } as {
      amount: number;
      termMonths: number;
      annualRate: number;
    };
    const payment = monthlyPayment(args.amount, args.annualRate, args.termMonths);
    const dti = debtToIncome(state.applicant, payment);
    if (resume.payload?.editedArgs) {
      await say(ctx, `Aplico tus ajustes: ${money(args.amount)} a ${args.termMonths} meses, pago de ${money(payment)} (deuda/ingreso ${pct(dti)}).`);
    }
    await sleep(DELAY * 6, ctx.signal);
    const loanId = `LN-${Date.now().toString().slice(-6)}`;
    // Solo ahora se "ejecuta" la acción irreversible, con los valores que aprobó el humano.
    ctx.emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: newId(),
      toolCallId: pending.toolCallId,
      content: JSON.stringify({ issued: true, loanId, ...args, monthlyPayment: payment }),
      role: 'tool',
    });
    state.status = 'approved';
    state.metrics = { annualRate: args.annualRate, monthlyPayment: payment, debtToIncome: dti };
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [
        { op: 'replace', path: '/metrics', value: state.metrics },
        { op: 'replace', path: '/status', value: 'approved' },
      ],
    });
    await say(ctx, `Crédito ${loanId} emitido: ${money(args.amount)} a ${args.termMonths} meses, pago mensual de ${money(payment)}.`);
  }

  await ctx.store.save(threadId, { ...memory, pending: undefined });
  ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } });
}
