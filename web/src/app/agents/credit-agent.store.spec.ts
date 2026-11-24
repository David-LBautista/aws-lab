import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { EventType, type AGUIEvent, type RunAgentInput } from '@ag-ui/core';
import { AgentStreamService } from './agent-stream.service';
import { CreditAgentStore } from './credit-agent.store';

// Sustituto del servicio HTTP: cada run() devuelve un Subject que la prueba controla.
class FakeAgentStream {
  readonly calls: { agentId: string; input: RunAgentInput; stream: Subject<AGUIEvent> }[] = [];

  run(agentId: string, input: RunAgentInput) {
    const stream = new Subject<AGUIEvent>();
    this.calls.push({ agentId, input, stream });
    return stream.asObservable();
  }

  get last() {
    return this.calls[this.calls.length - 1];
  }
}

// El store agrupa eventos por frame (animationFrameScheduler); esperamos a que pase uno.
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

const interrupt = { id: 'i1', reason: 'tool_approval', toolCallId: 'c1', message: '¿Autorizas?' };

describe('CreditAgentStore', () => {
  let store: CreditAgentStore;
  let fake: FakeAgentStream;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CreditAgentStore, { provide: AgentStreamService, useClass: FakeAgentStream }],
    });
    store = TestBed.inject(CreditAgentStore);
    fake = TestBed.inject(AgentStreamService) as unknown as FakeAgentStream;
  });

  it('empieza en idle', () => {
    expect(store.status()).toBe('idle');
    expect(store.busy()).toBe(false);
  });

  it('start() manda la solicitud en state y pasa a connecting', () => {
    const application = { name: 'Juan Pérez', monthlyIncome: 50000, monthlyDebts: 3000, employmentYears: 5, amount: 100000, termMonths: 24 };
    store.start(application);

    expect(fake.last.agentId).toBe('credit');
    expect(fake.last.input.state).toEqual(application);
    expect(fake.last.input.forwardedProps).toEqual({ mode: 'mock' });
    expect(store.status()).toBe('connecting');
    expect(store.busy()).toBe(true);
  });

  it('usa el motor seleccionado y conserva el mismo al reanudar', async () => {
    store.mode.set('claude');
    store.start();
    const first = fake.last;
    expect(first.input.forwardedProps).toEqual({ mode: 'claude' });
    first.stream.next({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' });
    first.stream.next({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r', outcome: { type: 'interrupt', interrupts: [interrupt] } } as AGUIEvent);
    await nextFrame();

    store.mode.set('mock');
    store.respond({ decision: 'approve' });
    expect(fake.last.input.forwardedProps).toEqual({ mode: 'claude' });
  });

  it('aplica los eventos que llegan del stream', async () => {
    store.start();
    const { stream } = fake.last;
    stream.next({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' });
    stream.next({ type: EventType.STATE_SNAPSHOT, snapshot: { applicant: { name: 'María López' }, status: 'received' } });
    stream.next({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/status', value: 'analyzing' }] });
    await nextFrame();

    expect(store.status()).toBe('running');
    expect(store.application()?.applicant.name).toBe('María López');
    expect(store.application()?.status).toBe('analyzing');
    expect(store.eventCount()).toBe(3);
  });

  it('respond() reanuda en el mismo hilo con el interrupt y la decisión', async () => {
    store.start();
    const first = fake.last;
    first.stream.next({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' });
    first.stream.next({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r', outcome: { type: 'interrupt', interrupts: [interrupt] } } as AGUIEvent);
    await nextFrame();
    expect(store.status()).toBe('awaiting_approval');

    store.respond({ decision: 'approve', editedArgs: { termMonths: 48 } });

    expect(fake.calls).toHaveLength(2);
    expect(fake.last.input.threadId).toBe(first.input.threadId);
    expect(fake.last.input.runId).not.toBe(first.input.runId);
    expect(fake.last.input.resume).toEqual([
      { interruptId: 'i1', status: 'resolved', payload: { decision: 'approve', editedArgs: { termMonths: 48 } } },
    ]);
    expect(store.interrupt()).toBeNull();
  });

  it('respond() sin interrupt pendiente no hace nada', () => {
    store.respond({ decision: 'approve' });
    expect(fake.calls).toHaveLength(0);
  });

  it('stop() cancela la suscripción (y con ella la petición HTTP)', () => {
    store.start();
    const { stream } = fake.last;
    expect(stream.observed).toBe(true);

    store.stop();
    expect(stream.observed).toBe(false);
    expect(store.status()).toBe('cancelled');
  });

  it('un nuevo start() cancela la corrida anterior', () => {
    store.start();
    const first = fake.last.stream;
    store.start();
    expect(first.observed).toBe(false);
    expect(fake.calls).toHaveLength(2);
  });

  it('un error de red deja la vista en error con el mensaje', async () => {
    store.start();
    fake.last.stream.error(new Error('El servidor respondió 500'));
    await nextFrame();
    expect(store.status()).toBe('error');
    expect(store.error()).toBe('El servidor respondió 500');
  });
});
