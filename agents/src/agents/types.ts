import type { AGUIEvent, RunAgentInput } from '@ag-ui/core';
import type { ThreadStore } from '../store/threadStore.js';

export interface AgentContext {
  input: RunAgentInput;
  emit: (event: AGUIEvent) => void;
  signal: AbortSignal;
  store: ThreadStore; // el almacenamiento llega inyectado
}

export type Agent = (ctx: AgentContext) => Promise<void>;

export class AbortedError extends Error {
  constructor() {
    super('aborted');
  }
}

export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AbortedError());
      },
      { once: true },
    );
  });
}

export const newId = () => crypto.randomUUID();
