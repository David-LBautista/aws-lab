import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { animationFrameScheduler, bufferTime, filter, Subscription } from 'rxjs';
import type { RunAgentInput } from '@ag-ui/core';
import { AgentStreamService } from './agent-stream.service';
import { applyEvent, initialView, type AgentView } from './agent-run.reducer';
import type { ApplicationInput, CreditState } from './credit.types';

export type AgentMode = 'mock' | 'claude';

export interface AnalystDecision {
  decision: 'approve' | 'reject';
  editedArgs?: { amount?: number; termMonths?: number };
  reason?: string;
}

@Injectable()
export class CreditAgentStore {
  private readonly agent = inject(AgentStreamService);
  private readonly view = signal<AgentView<CreditState>>(initialView<CreditState>());
  private sub?: Subscription;
  private threadId: string | null = null;
  private runMode: AgentMode = 'mock';

  readonly mode = signal<AgentMode>('mock');

  readonly status = computed(() => this.view().status);
  readonly timeline = computed(() => this.view().timeline);
  readonly toolCalls = computed(() => this.view().toolCalls);
  readonly application = computed(() => this.view().state);
  readonly currentStep = computed(() => this.view().currentStep);
  readonly interrupt = computed(() => this.view().interrupt);
  readonly error = computed(() => this.view().error);
  readonly eventCount = computed(() => this.view().eventCount);
  readonly busy = computed(() => this.status() === 'connecting' || this.status() === 'running');

  constructor() {
    inject(DestroyRef).onDestroy(() => this.sub?.unsubscribe());
  }

  start(application?: ApplicationInput) {
    this.threadId = crypto.randomUUID();
    this.runMode = this.mode();
    this.view.set({ ...initialView<CreditState>(), status: 'connecting' });
    this.run({
      threadId: this.threadId,
      runId: crypto.randomUUID(),
      messages: [],
      tools: [],
      context: [],
      state: application ?? {},
      forwardedProps: { mode: this.runMode },
    });
  }

  respond(decision: AnalystDecision) {
    const interrupt = this.interrupt();
    if (!interrupt || !this.threadId) return;

    this.view.update((view) => ({ ...view, status: 'connecting', interrupt: null }));
    this.run({
      threadId: this.threadId,
      runId: crypto.randomUUID(),
      messages: [],
      tools: [],
      context: [],
      forwardedProps: { mode: this.runMode },
      resume: [{ interruptId: interrupt.id, status: 'resolved', payload: decision }],
    });
  }

  stop() {
    this.sub?.unsubscribe();
    this.sub = undefined;
    this.view.update((view) => ({
      ...view,
      status: 'cancelled',
      currentStep: null,
      timeline: view.timeline.map((item) =>
        item.kind === 'message' ? { ...item, streaming: false } : item,
      ),
    }));
  }

  private run(input: RunAgentInput) {
    this.sub?.unsubscribe();
    this.sub = this.agent
      .run('credit', input)
      .pipe(bufferTime(0, animationFrameScheduler), filter((batch) => batch.length > 0))
      .subscribe({
        next: (batch) =>
          this.view.update((view) => batch.reduce((current, event) => applyEvent(current, event), view)),
        error: (error: unknown) =>
          this.view.update((view) => ({
            ...view,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            currentStep: null,
          })),
      });
  }
}
