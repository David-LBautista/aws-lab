import { describe, expect, it } from 'vitest';
import { EventType, type AGUIEvent, type RunAgentInput } from '@ag-ui/core';
import { creditMockAgent } from '../src/credit/creditMockAgent.js';
import { InMemoryThreadStore } from '../src/store/threadStore.js';
import type { ApplicationInput, CreditState } from '../src/credit/domain.js';

// Corre el agente como lo haría el servidor, pero guardando los eventos en un arreglo.
async function runAgent(store: InMemoryThreadStore, input: Partial<RunAgentInput>) {
  const events: AGUIEvent[] = [];
  await creditMockAgent({
    input: {
      threadId: 'thread-1',
      runId: crypto.randomUUID(),
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      ...input,
    } as RunAgentInput,
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    store,
  });
  return events;
}

const ofType = <T extends AGUIEvent['type']>(events: AGUIEvent[], type: T) =>
  events.filter((e): e is Extract<AGUIEvent, { type: T }> => e.type === type);

const last = (events: AGUIEvent[]) => events[events.length - 1];

const toolNames = (events: AGUIEvent[]) => ofType(events, EventType.TOOL_CALL_START).map((e) => e.toolCallName);

function interruptOf(events: AGUIEvent[]) {
  const end = last(events);
  if (end.type !== EventType.RUN_FINISHED || end.outcome?.type !== 'interrupt') throw new Error('No terminó en pausa');
  return end.outcome.interrupts[0];
}

const directa: ApplicationInput = { name: 'Juan Pérez', monthlyIncome: 50000, monthlyDebts: 3000, employmentYears: 5, amount: 100000, termMonths: 24 };
const rechazo: ApplicationInput = { name: 'Ana Torres', monthlyIncome: 12000, monthlyDebts: 8000, employmentYears: 2, amount: 150000, termMonths: 24 };

describe('creditMockAgent: primera corrida', () => {
  it('respeta el orden del protocolo: empieza con RUN_STARTED y termina en pausa', async () => {
    const events = await runAgent(new InMemoryThreadStore(), { state: directa });
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.STATE_SNAPSHOT);
    expect(interruptOf(events).reason).toBe('tool_approval');
  });

  it('aprobación directa: propone emitir al plazo pedido sin condiciones', async () => {
    const store = new InMemoryThreadStore();
    const events = await runAgent(store, { state: directa });
    expect(toolNames(events)).toEqual(['get_credit_report', 'calculate_payment', 'approve_loan']);

    const memory = await store.get<CreditState>('thread-1');
    expect(memory?.state.recommendation).toMatchObject({ decision: 'approve', termMonths: 24, conditions: [] });
    expect(memory?.pending?.toolName).toBe('approve_loan');
  });

  it('con ajuste: si a 24 meses no alcanza, prueba 36 y aprueba ahí', async () => {
    const store = new InMemoryThreadStore();
    const events = await runAgent(store, { state: {} }); // sin datos = María López
    expect(toolNames(events)).toEqual(['get_credit_report', 'calculate_payment', 'calculate_payment', 'approve_loan']);

    const { state } = (await store.get<CreditState>('thread-1'))!;
    expect(state.recommendation).toMatchObject({ decision: 'approve', termMonths: 36 });
    expect(state.recommendation?.conditions).toContain('Plazo ajustado de 24 a 36 meses');
  });

  it('rechazo por capacidad de pago: prueba 24, 36 y 48 meses y recomienda rechazar', async () => {
    const store = new InMemoryThreadStore();
    const events = await runAgent(store, { state: rechazo });
    expect(toolNames(events).filter((n) => n === 'calculate_payment')).toHaveLength(3);
    expect(toolNames(events).at(-1)).toBe('reject_loan');

    const { state } = (await store.get<CreditState>('thread-1'))!;
    expect(state.checks.find((c) => c.id === 'dti')?.status).toBe('fail');
    expect(state.recommendation?.decision).toBe('reject');
  });

  it('rechazo por score bajo', async () => {
    const store = new InMemoryThreadStore();
    await runAgent(store, { state: { ...directa, simulatedScore: 550 } });
    const { state } = (await store.get<CreditState>('thread-1'))!;
    expect(state.checks.find((c) => c.id === 'score')?.status).toBe('fail');
    expect(state.recommendation?.rationale).toContain('550');
  });

  it('la acción irreversible NO se ejecuta antes de la aprobación (no hay resultado)', async () => {
    const events = await runAgent(new InMemoryThreadStore(), { state: directa });
    const approveCall = ofType(events, EventType.TOOL_CALL_START).find((e) => e.toolCallName === 'approve_loan')!;
    const results = ofType(events, EventType.TOOL_CALL_RESULT).map((e) => e.toolCallId);
    expect(results).not.toContain(approveCall.toolCallId);
  });

  it('datos inválidos: responde RUN_ERROR y no analiza nada', async () => {
    const events = await runAgent(new InMemoryThreadStore(), { state: { ...directa, amount: 1000 } });
    expect(last(events)).toMatchObject({ type: EventType.RUN_ERROR, code: 'INVALID_APPLICATION' });
    expect(toolNames(events)).toEqual([]);
  });
});

describe('creditMockAgent: decisión del analista (resume)', () => {
  async function pausedRun(application: ApplicationInput) {
    const store = new InMemoryThreadStore();
    const interrupt = interruptOf(await runAgent(store, { state: application }));
    const resume = (payload: Record<string, unknown>) =>
      runAgent(store, { resume: [{ interruptId: interrupt.id, status: 'resolved', payload }] });
    return { store, interrupt, resume };
  }

  it('aprobar: emite el crédito y termina con éxito', async () => {
    const { store, interrupt, resume } = await pausedRun(directa);
    const events = await resume({ decision: 'approve' });

    const result = ofType(events, EventType.TOOL_CALL_RESULT).find((e) => e.toolCallId === interrupt.toolCallId)!;
    expect(JSON.parse(String(result.content))).toMatchObject({ issued: true, amount: 100000, termMonths: 24 });
    expect(last(events)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'success' } });

    const memory = await store.get<CreditState>('thread-1');
    expect(memory?.state.status).toBe('approved');
    expect(memory?.pending).toBeUndefined();
  });

  it('aprobar con ajustes: recalcula con lo que editó el analista', async () => {
    const { store, interrupt, resume } = await pausedRun(directa);
    const events = await resume({ decision: 'approve', editedArgs: { amount: 80000, termMonths: 12 } });

    const result = ofType(events, EventType.TOOL_CALL_RESULT).find((e) => e.toolCallId === interrupt.toolCallId)!;
    const issued = JSON.parse(String(result.content));
    expect(issued).toMatchObject({ amount: 80000, termMonths: 12 });
    expect((await store.get<CreditState>('thread-1'))?.state.metrics.monthlyPayment).toBe(issued.monthlyPayment);
  });

  it('no autorizar el crédito: queda rechazado y la tool call recibe resultado "no emitido"', async () => {
    const { store, interrupt, resume } = await pausedRun(directa);
    const events = await resume({ decision: 'reject', reason: 'Falta comprobante' });

    const result = ofType(events, EventType.TOOL_CALL_RESULT).find((e) => e.toolCallId === interrupt.toolCallId)!;
    expect(JSON.parse(String(result.content))).toEqual({ issued: false, reason: 'Falta comprobante' });
    expect((await store.get<CreditState>('thread-1'))?.state.status).toBe('rejected');
  });

  it('confirmar el rechazo propuesto: queda rechazado', async () => {
    const { store, resume } = await pausedRun(rechazo);
    await resume({ decision: 'approve' });
    expect((await store.get<CreditState>('thread-1'))?.state.status).toBe('rejected');
  });

  it('no confirmar el rechazo: se envía a revisión manual', async () => {
    const { store, interrupt, resume } = await pausedRun(rechazo);
    const events = await resume({ decision: 'reject' });

    const result = ofType(events, EventType.TOOL_CALL_RESULT).find((e) => e.toolCallId === interrupt.toolCallId)!;
    expect(JSON.parse(String(result.content))).toMatchObject({ sentToManualReview: true });
    expect((await store.get<CreditState>('thread-1'))?.state.status).toBe('manual_review');
  });

  it('un interrupt desconocido o ya usado responde BAD_RESUME', async () => {
    const { resume, store, interrupt } = await pausedRun(directa);
    await resume({ decision: 'approve' }); // se usa una vez
    const again = await runAgent(store, { resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { decision: 'approve' } }] });
    expect(last(again)).toMatchObject({ type: EventType.RUN_ERROR, code: 'BAD_RESUME' });
  });
});
