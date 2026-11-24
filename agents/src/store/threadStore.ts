import type Anthropic from '@anthropic-ai/sdk';

// Lo que recordamos de cada conversación entre corridas.
// S = tipo de estado de cada agente (borrador legal, solicitud de crédito…)
export interface ThreadMemory<S = unknown> {
  agentId: string;
  state: S;
  pending?: {
    interruptId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  };
  // Datos del servidor que el modelo no debe ver ni poder cambiar.
  serverContext?: Record<string, unknown>;
  claudeMessages?: Anthropic.MessageParam[];
  pendingToolResults?: Anthropic.ToolResultBlockParam[];
}

// El contrato: los agentes solo conocen esto.
export interface ThreadStore {
  get<S>(threadId: string): Promise<ThreadMemory<S> | undefined>;
  save<S>(threadId: string, memory: ThreadMemory<S>): Promise<void>;
}

// Implementación en memoria para desarrollo local y pruebas.
export class InMemoryThreadStore implements ThreadStore {
  private threads = new Map<string, ThreadMemory>();

  async get<S>(threadId: string) {
    return this.threads.get(threadId) as ThreadMemory<S> | undefined;
  }

  async save<S>(threadId: string, memory: ThreadMemory<S>) {
    this.threads.set(threadId, memory as ThreadMemory);
  }
}
