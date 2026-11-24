import { EventType, type AGUIEvent } from '@ag-ui/core';
import { applyEvent, initialView, type AgentView } from './agent-run.reducer';

interface TestState {
  status: string;
  checks: { id: string; status: string }[];
}

// Aplica varios eventos seguidos, como lo hace el store.
const reduce = (events: AGUIEvent[], from: AgentView<TestState> = initialView<TestState>()) =>
  events.reduce((view, event) => applyEvent(view, event), from);

const started: AGUIEvent = { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' };

describe('applyEvent', () => {
  it('es pura: no modifica la vista que recibe', () => {
    const before = initialView<TestState>();
    const frozen = structuredClone(before);
    const after = applyEvent(before, started);
    expect(before).toEqual(frozen);
    expect(after).not.toBe(before);
  });

  it('cuenta cada evento, incluso los que ignora', () => {
    const view = reduce([started, { type: EventType.RAW, event: {} } as AGUIEvent]);
    expect(view.eventCount).toBe(2);
  });

  it('RUN_STARTED pasa a running y limpia errores anteriores', () => {
    const view = applyEvent({ ...initialView<TestState>(), status: 'error', error: 'falló' }, started);
    expect(view.status).toBe('running');
    expect(view.error).toBeNull();
  });

  it('arma un mensaje con los fragmentos de texto', () => {
    const view = reduce([
      started,
      { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Hola, ' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'analizo tu solicitud.' },
    ]);
    expect(view.timeline).toEqual([{ kind: 'message', id: 'm1', text: 'Hola, analizo tu solicitud.', streaming: true }]);

    const ended = applyEvent(view, { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' });
    expect(ended.timeline[0]).toMatchObject({ streaming: false });
  });

  it('muestra los argumentos de una tool call mientras llegan (JSON incompleto)', () => {
    const view = reduce([
      started,
      { type: EventType.TOOL_CALL_START, toolCallId: 'c1', toolCallName: 'calculate_payment' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{"amount":1500' },
    ]);
    expect(view.toolCalls['c1']).toMatchObject({ name: 'calculate_payment', status: 'streaming', args: { amount: 1500 } });
    expect(view.timeline).toContainEqual({ kind: 'tool', id: 'c1' });
  });

  it('completa la tool call con END y RESULT', () => {
    const view = reduce([
      started,
      { type: EventType.TOOL_CALL_START, toolCallId: 'c1', toolCallName: 'calculate_payment' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{"amount":150000,"termMonths":36}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'c1' },
      { type: EventType.TOOL_CALL_RESULT, messageId: 'x', toolCallId: 'c1', content: '{"monthlyPayment":5885}', role: 'tool' },
    ]);
    expect(view.toolCalls['c1']).toMatchObject({
      status: 'completed',
      args: { amount: 150000, termMonths: 36 },
      result: '{"monthlyPayment":5885}',
    });
  });

  it('ignora eventos de tool calls que no conoce', () => {
    const view = reduce([started, { type: EventType.TOOL_CALL_ARGS, toolCallId: 'nope', delta: '{}' }]);
    expect(view.toolCalls).toEqual({});
  });

  it('STATE_SNAPSHOT reemplaza el estado y STATE_DELTA aplica JSON Patch sin mutar', () => {
    const snap = reduce([started, { type: EventType.STATE_SNAPSHOT, snapshot: { status: 'received', checks: [] } }]);
    const next = applyEvent(snap, {
      type: EventType.STATE_DELTA,
      delta: [
        { op: 'replace', path: '/status', value: 'analyzing' },
        { op: 'add', path: '/checks/-', value: { id: 'score', status: 'pass' } },
      ],
    });
    expect(next.state).toEqual({ status: 'analyzing', checks: [{ id: 'score', status: 'pass' }] });
    expect(snap.state).toEqual({ status: 'received', checks: [] }); // el anterior no cambió
    expect(next.state).not.toBe(snap.state); // referencia nueva → el signal detecta el cambio
  });

  it('un patch que no aplica marca error de desincronización', () => {
    const snap = reduce([started, { type: EventType.STATE_SNAPSHOT, snapshot: { status: 'received', checks: [] } }]);
    const next = applyEvent(snap, { type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/checks/5/status', value: 'x' }] });
    expect(next.error).toContain('desincronizó');
    expect(next.state).toEqual(snap.state);
  });

  it('marca el paso actual y lo cierra', () => {
    const running = reduce([started, { type: EventType.STEP_STARTED, stepName: 'credit_report' }]);
    expect(running.currentStep).toBe('credit_report');
    expect(running.timeline[0]).toMatchObject({ kind: 'step', name: 'credit_report', finished: false });

    const done = applyEvent(running, { type: EventType.STEP_FINISHED, stepName: 'credit_report' });
    expect(done.currentStep).toBeNull();
    expect(done.timeline[0]).toMatchObject({ finished: true });
  });

  it('RUN_FINISHED con interrupt deja la vista esperando al humano', () => {
    const interrupt = { id: 'i1', reason: 'tool_approval', toolCallId: 'c1', message: '¿Autorizas?' };
    const view = reduce([
      started,
      { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r', outcome: { type: 'interrupt', interrupts: [interrupt] } } as AGUIEvent,
    ]);
    expect(view.status).toBe('awaiting_approval');
    expect(view.interrupt).toEqual(interrupt);
  });

  it('RUN_FINISHED normal termina la corrida', () => {
    const view = reduce([started, { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' }]);
    expect(view.status).toBe('done');
  });

  it('RUN_ERROR guarda el mensaje', () => {
    const view = reduce([started, { type: EventType.RUN_ERROR, message: 'Datos inválidos' }]);
    expect(view.status).toBe('error');
    expect(view.error).toBe('Datos inválidos');
  });
});
