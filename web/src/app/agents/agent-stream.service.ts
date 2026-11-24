import { Injectable, inject } from '@angular/core';
import { Observable, switchMap, take } from 'rxjs';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { EventType, type AGUIEvent, type RunAgentInput } from '@ag-ui/core';
import { environment } from '../../environments/environment';
import { parseSseBuffer } from './sse';

@Injectable({ providedIn: 'root' })
export class AgentStreamService {
  private readonly oidc = inject(OidcSecurityService);

  run(agentId: string, input: RunAgentInput): Observable<AGUIEvent> {
    return this.oidc.getAccessToken().pipe(
      take(1),
      switchMap((token) => {
        if (!environment.agentsApiUrl) {
          throw new Error('La API de agentes no está configurada en este entorno.');
        }
        return this.stream(
          `${environment.agentsApiUrl.replace(/\/$/, '')}/api/agents/${encodeURIComponent(agentId)}`,
          input,
          token,
        );
      }),
    );
  }

  private stream(url: string, input: RunAgentInput, token: string): Observable<AGUIEvent> {
    return new Observable<AGUIEvent>((subscriber) => {
      const controller = new AbortController();

      void (async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const body: { error?: string } = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finished = false;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseBuffer(buffer);
          buffer = rest;
          for (const event of events) {
            if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
              finished = true;
            }
            subscriber.next(event);
          }
        }

        if (!finished) throw new Error('Se perdió la conexión antes de que el agente terminara.');
        subscriber.complete();
      })().catch((err: unknown) => {
        if (!controller.signal.aborted) subscriber.error(err);
      });

      return () => controller.abort();
    });
  }
}
