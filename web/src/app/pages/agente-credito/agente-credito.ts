import { Component, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import type { AGUIEvent, RunAgentInput } from '@ag-ui/core';
import { AgentStreamService } from '../../agents/agent-stream.service';

@Component({
  selector: 'app-agente-credito',
  template: `
    <section class="page-header">
      <div class="eyebrow">Agentes</div>
      <h1>Agente de crédito</h1>
      <p>Ejecuta un análisis y observa los eventos emitidos en tiempo real.</p>
    </section>

    <section class="card agent-card">
      <div class="actions">
        @if (running()) {
          <button class="btn ghost" type="button" (click)="stop()">Detener análisis</button>
        } @else {
          <button class="btn primary" type="button" (click)="start()">Iniciar análisis</button>
        }
        <span class="event-count">{{ events().length }} eventos</span>
      </div>

      @if (error()) {
        <p class="error-message" role="alert">{{ error() }}</p>
      }

      <h2>Actividad del agente</h2>
      <ol class="event-list">
        @for (event of events(); track $index) {
          <li><code>{{ event.type }}</code></li>
        } @empty {
          <li class="empty">Los eventos aparecerán aquí al iniciar el análisis.</li>
        }
      </ol>
    </section>
  `,
  styles: [`
    .agent-card { max-width: 780px; }
    .actions { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; }
    .event-count { color: var(--muted); font-size: .88rem; }
    .agent-card h2 { font-size: 1.15rem; }
    .event-list { display: grid; gap: 8px; max-height: 420px; margin: 0; padding-left: 24px; overflow: auto; }
    .event-list li { padding: 5px 0; }
    .event-list .empty { color: var(--muted); }
    .error-message { padding: 12px 14px; color: var(--danger); background: var(--danger-bg); border-radius: var(--radius-sm); }
  `],
})
export class AgenteCredito {
  private readonly agent = inject(AgentStreamService);
  private sub?: Subscription;

  readonly events = signal<AGUIEvent[]>([]);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);

  start() {
    this.events.set([]);
    this.error.set(null);
    this.running.set(true);

    const input: RunAgentInput = {
      threadId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { mode: 'mock' },
    };

    this.sub = this.agent.run('credit', input).subscribe({
      next: (event) => this.events.update((list) => [...list, event]),
      error: (err: unknown) => {
        this.error.set(err instanceof Error ? err.message : String(err));
        this.running.set(false);
      },
      complete: () => this.running.set(false),
    });
  }

  stop() {
    this.sub?.unsubscribe();
    this.sub = undefined;
    this.running.set(false);
  }
}
