import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CurrencyPipe, JsonPipe, PercentPipe } from '@angular/common';
import { CreditAgentStore } from '../../agents/credit-agent.store';
import type { ToolCallView } from '../../agents/agent-run.reducer';
import type { CheckStatus } from '../../agents/credit.types';
import { ApplicationForm } from './application-form';

@Component({
  selector: 'app-agente-credito',
  imports: [ApplicationForm, CurrencyPipe, JsonPipe, PercentPipe],
  providers: [CreditAgentStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './agente-credito.html',
  styleUrl: './agente-credito.scss',
})
export class AgenteCredito {
  protected readonly store = inject(CreditAgentStore);

  protected readonly statusText: Record<string, string> = {
    idle: 'Listo para analizar',
    connecting: 'Conectando…',
    running: 'El agente está analizando',
    awaiting_approval: 'Esperando tu decisión',
    done: 'Análisis terminado',
    error: 'Error',
    cancelled: 'Detenido',
  };

  protected readonly stepText: Record<string, string> = {
    credit_report: 'Buró de crédito',
    affordability: 'Capacidad de pago',
    decision: 'Decisión',
  };

  protected readonly toolText: Record<string, string> = {
    get_credit_report: 'Consultando buró de crédito',
    calculate_payment: 'Calculando pago mensual',
    approve_loan: 'Propone emitir el crédito',
    reject_loan: 'Propone rechazar la solicitud',
  };

  protected readonly applicationStatusText: Record<string, string> = {
    received: 'Recibida',
    analyzing: 'En análisis',
    pending_approval: 'Pendiente de autorización',
    approved: 'Aprobada',
    rejected: 'Rechazada',
    manual_review: 'En revisión manual',
  };

  protected readonly checkIcon: Record<CheckStatus, string> = {
    pending: 'En curso',
    pass: 'Cumple',
    warn: 'Revisar',
    fail: 'No cumple',
  };

  protected toolOutcome(call: ToolCallView): string {
    if (!call.result) {
      if (call.status === 'streaming') return 'recibiendo argumentos…';
      if (call.status === 'called') {
        return this.store.status() === 'awaiting_approval' ? 'esperando autorización' : 'ejecutando…';
      }
      return this.store.status() === 'awaiting_approval' ? 'esperando autorización' : 'pendiente';
    }
    try {
      const result = JSON.parse(call.result);
      if (result.issued === false) return 'no autorizado';
      if (result.sentToManualReview) return 'enviado a revisión';
      if (result.rejected) return 'rechazo confirmado';
    } catch {
      // Un resultado que no sea JSON sigue contando como completado.
    }
    return call.status === 'completed' ? 'listo' : 'ejecutando…';
  }

  protected pendingTool(): string | undefined {
    const id = this.store.interrupt()?.toolCallId;
    return id ? this.store.toolCalls()[id]?.name : undefined;
  }
}
