import type { Agent } from './types.js';
import { mockAgent } from './mockAgent.js';
import { claudeAgent } from './claudeAgent.js';

// Agregar un agente nuevo = agregar una entrada aquí.
export const agents: Record<string, { mock: Agent; claude: Agent }> = {
  legal: { mock: mockAgent, claude: claudeAgent },
};
