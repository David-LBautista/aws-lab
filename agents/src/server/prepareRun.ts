import type { RunAgentInput } from '@ag-ui/core';
import { agents } from '../agents/registry.js';
import type { Agent } from '../agents/types.js';

export interface RunOptions {
  claudeAvailable: boolean;
  defaultMode: string;
  userGroups?: string[];
  claudeGroup?: string;
}

export type PreparedRun =
  | { ok: true; agent: Agent; input: RunAgentInput; mode: string }
  | { ok: false; status: number; error: string };

export function prepareRun(agentId: string | undefined, body: unknown, opts: RunOptions): PreparedRun {
  const entry = agentId ? agents[agentId] : undefined;
  if (!entry) return { ok: false, status: 404, error: `Unknown agent "${agentId}"` };

  const input = body as RunAgentInput | null;
  if (!input?.threadId || !input?.runId || !Array.isArray(input?.messages)) {
    return { ok: false, status: 400, error: 'Body must be a RunAgentInput with threadId, runId and messages' };
  }

  const mode = (input.forwardedProps?.mode as string | undefined) ?? opts.defaultMode;
  if (mode === 'claude') {
    if (!opts.claudeAvailable) return { ok: false, status: 400, error: 'Claude mode needs ANTHROPIC_API_KEY' };
    if (!entry.claude) return { ok: false, status: 400, error: `Agent "${agentId}" has no Claude version yet` };
    if (opts.claudeGroup && !opts.userGroups?.includes(opts.claudeGroup)) {
      return { ok: false, status: 403, error: 'Tu usuario no tiene permiso para usar el modo Claude.' };
    }
    return { ok: true, agent: entry.claude, input, mode };
  }

  return { ok: true, agent: entry.mock, input, mode: 'mock' };
}
