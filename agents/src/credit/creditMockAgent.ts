import { EventType, type Interrupt, type ResumeEntry } from '@ag-ui/core';
import type { ThreadMemory } from '../store/threadStore.js';
import { newId, sleep, type Agent, type AgentContext } from '../agents/types.js';
import {
  debtToIncome,
  getCreditReport,
  monthlyPayment,
  rateForScore,
  sampleApplication,
  type CreditState,
  type Recommendation,
  type RiskCheck,
} from './domain.js';

// Agente de créditos con guion (gratis). Mismo protocolo AG-UI que el agente legal,
// otro dominio: analiza una solicitud, propone una decisión y espera al analista humano.

const DELAY = Number(process.env.MOCK_DELAY_MS ?? 35);
const MAX_DTI = 0.4; // regla de negocio: deudas + nuevo pago no deben pasar del 40% del ingreso

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

  // ---------- Corrida nueva ----------
  const memory: ThreadMemory<CreditState> = { agentId: 'credit', state: sampleApplication() };
  const state = memory.state;
  await ctx.store.save(threadId, memory);
  ctx.emit({ type: EventType.STATE_SNAPSHOT, snapshot: state });
  ctx.emit({
    type: EventType.STATE_DELTA,
    delta: [{ op: 'replace', path: '/status', value: 'analyzing' }],
  });

  const addCheck = (check: RiskCheck) => {
    state.checks.push(check);
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [{ op: 'add', path: '/checks/-', value: check }],
    });
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
  await say(
    ctx,
    `Voy a analizar la solicitud de ${state.applicant.name}. Primero consulto su historial en el buró de crédito.`,
  );
  const scoreCheck = addCheck({
    id: 'score',
    label: 'Score de crédito',
    status: 'pending',
    detail: 'Consultando buró…',
  });
  const report = getCreditReport(state.applicationId);
  await callTool(ctx, 'get_credit_report', { applicationId: state.applicationId }, report);
  state.applicant.creditScore = report.creditScore;
  ctx.emit({
    type: EventType.STATE_DELTA,
    delta: [{ op: 'add', path: '/applicant/creditScore', value: report.creditScore }],
  });
  updateCheck(
    scoreCheck,
    report.creditScore >= 680 ? 'pass' : 'fail',
    `Score ${report.creditScore}, ${report.latePaymentsLast12m} atraso en 12 meses`,
  );

  const jobOk = state.applicant.employmentYears >= 2;
  addCheck({
    id: 'employment',
    label: 'Antigüedad laboral',
    status: jobOk ? 'pass' : 'warn',
    detail: `${state.applicant.employmentYears} años en su empleo actual`,
  });
  ctx.emit({ type: EventType.STEP_FINISHED, stepName: 'credit_report' });

  if (ctx.input.forwardedProps?.simulateError) {
    ctx.emit({
      type: EventType.RUN_ERROR,
      message: 'El servicio de buró no respondió (simulado)',
      code: 'SIMULATED',
    });
    return;
  }

  // Paso 2: capacidad de pago. El agente calcula, detecta un riesgo y ajusta el plazo.
  ctx.emit({ type: EventType.STEP_STARTED, stepName: 'affordability' });
  const annualRate = rateForScore(report.creditScore);
  let term = state.request.termMonths;
  let payment = monthlyPayment(state.request.amount, annualRate, term);
  await callTool(
    ctx,
    'calculate_payment',
    { amount: state.request.amount, annualRate, termMonths: term },
    { monthlyPayment: payment },
  );
  let dti = debtToIncome(state.applicant, payment);
  state.metrics = { annualRate, monthlyPayment: payment, debtToIncome: dti };
  ctx.emit({
    type: EventType.STATE_DELTA,
    delta: [{ op: 'replace', path: '/metrics', value: state.metrics }],
  });
  const dtiCheck = addCheck({
    id: 'dti',
    label: 'Deuda / ingreso',
    status: dti <= MAX_DTI ? 'pass' : 'warn',
    detail: `${pct(dti)} con pago de ${money(payment)} a ${term} meses (máximo ${pct(MAX_DTI)})`,
  });

  if (dti > MAX_DTI) {
    await say(
      ctx,
      `A ${term} meses la razón deuda/ingreso queda en ${pct(dti)}, arriba del ${pct(MAX_DTI)}. Pruebo con un plazo más largo.`,
    );
    term = 36;
    payment = monthlyPayment(state.request.amount, annualRate, term);
    await callTool(
      ctx,
      'calculate_payment',
      { amount: state.request.amount, annualRate, termMonths: term },
      { monthlyPayment: payment },
    );
    dti = debtToIncome(state.applicant, payment);
    state.metrics = { annualRate, monthlyPayment: payment, debtToIncome: dti };
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [{ op: 'replace', path: '/metrics', value: state.metrics }],
    });
    updateCheck(
      dtiCheck,
      dti <= MAX_DTI ? 'pass' : 'fail',
      `${pct(dti)} con pago de ${money(payment)} a ${term} meses`,
    );
  }
  ctx.emit({ type: EventType.STEP_FINISHED, stepName: 'affordability' });

  // Paso 3: recomendación. Aprobar un crédito es irreversible => lo decide el analista.
  ctx.emit({ type: EventType.STEP_STARTED, stepName: 'decision' });
  const recommendation: Recommendation = {
    decision: 'approve',
    amount: state.request.amount,
    termMonths: term,
    annualRate,
    conditions:
      term !== state.request.termMonths
        ? [`Plazo ajustado de ${state.request.termMonths} a ${term} meses`]
        : [],
    rationale: `Score ${report.creditScore}, ${state.applicant.employmentYears} años de antigüedad y deuda/ingreso de ${pct(dti)}.`,
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
  await say(
    ctx,
    `Recomiendo aprobar ${money(recommendation.amount)} a ${term} meses con tasa de ${pct(annualRate)} anual. Necesito tu autorización para emitirlo.`,
  );

  const proposal = {
    applicationId: state.applicationId,
    amount: recommendation.amount,
    termMonths: recommendation.termMonths,
    annualRate: recommendation.annualRate,
  };
  const approveCallId = await callTool(ctx, 'approve_loan', proposal); // sin resultado: NO se ejecuta
  ctx.emit({ type: EventType.STEP_FINISHED, stepName: 'decision' });

  const interrupt: Interrupt = {
    id: newId(),
    reason: 'tool_approval',
    toolCallId: approveCallId,
    message: `¿Autorizas emitir el crédito de ${money(recommendation.amount)} a ${term} meses?`,
    responseSchema: {
      type: 'object',
      properties: {
        decision: { enum: ['approve', 'reject'] },
        editedArgs: {
          type: 'object',
          properties: { amount: { type: 'number' }, termMonths: { type: 'number' } },
        },
        reason: { type: 'string' },
      },
      required: ['decision'],
    },
  };

  await ctx.store.save(threadId, {
    ...memory,
    pending: {
      interruptId: interrupt.id,
      toolCallId: approveCallId,
      toolName: 'approve_loan',
      args: proposal,
    },
  });
  ctx.emit({
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    outcome: { type: 'interrupt', interrupts: [interrupt] },
  });
};

async function continueAfterAnalyst(ctx: AgentContext, resume: ResumeEntry) {
  const { threadId, runId } = ctx.input;
  const memory = await ctx.store.get<CreditState>(threadId);
  if (!memory?.pending || memory.pending.interruptId !== resume.interruptId) {
    ctx.emit({
      type: EventType.RUN_ERROR,
      message: 'Unknown or expired interrupt',
      code: 'BAD_RESUME',
    });
    return;
  }
  const state = memory.state;
  const decision = resume.status === 'cancelled' ? 'reject' : resume.payload?.decision;

  if (decision !== 'approve') {
    state.status = 'rejected';
    ctx.emit({
      type: EventType.STATE_DELTA,
      delta: [{ op: 'replace', path: '/status', value: 'rejected' }],
    });
    const reason = resume.payload?.reason ? ` Motivo registrado: "${resume.payload.reason}".` : '';
    await say(ctx, `Entendido, la solicitud ${state.applicationId} queda rechazada.${reason}`);
  } else {
    // El analista puede ajustar monto o plazo antes de aprobar: recalculamos con lo que aprobó.
    const args = { ...memory.pending.args, ...(resume.payload?.editedArgs ?? {}) } as {
      amount: number;
      termMonths: number;
      annualRate: number;
    };
    const payment = monthlyPayment(args.amount, args.annualRate, args.termMonths);
    const dti = debtToIncome(state.applicant, payment);
    if (resume.payload?.editedArgs) {
      await say(
        ctx,
        `Aplico tus ajustes: ${money(args.amount)} a ${args.termMonths} meses, pago de ${money(payment)} (deuda/ingreso ${pct(dti)}).`,
      );
    }
    await sleep(DELAY * 6, ctx.signal);
    const loanId = `LN-${Date.now().toString().slice(-6)}`;
    // Solo ahora se "ejecuta" la acción irreversible, con los valores que aprobó el humano.
    ctx.emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: newId(),
      toolCallId: memory.pending.toolCallId,
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
    await say(
      ctx,
      `Crédito ${loanId} emitido: ${money(args.amount)} a ${args.termMonths} meses, pago mensual de ${money(payment)}.`,
    );
  }

  await ctx.store.save(threadId, { ...memory, pending: undefined });
  ctx.emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } });
}
