import type { Agent } from './types.js';
import { mockAgent } from './mockAgent.js';
import { claudeAgent } from './claudeAgent.js';
import { creditMockAgent } from '../credit/creditMockAgent.js';
import { creditClaudeAgent } from '../credit/creditClaudeAgent.js';

// Cada agente tiene una versión mock (gratis) y, opcionalmente, una con Claude.
// Agregar un agente nuevo = agregar una entrada aquí.
export const agents: Record<string, { mock: Agent; claude?: Agent }> = {
  legal: { mock: mockAgent, claude: claudeAgent },
  credit: { mock: creditMockAgent, claude: creditClaudeAgent },
};
