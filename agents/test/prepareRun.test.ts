import { describe, expect, it } from 'vitest';
import { prepareRun } from '../src/server/prepareRun.js';

const input = { threadId: 't', runId: 'r', messages: [], tools: [], context: [], state: {} };
const opts = { claudeAvailable: true, defaultMode: 'mock' };

describe('prepareRun', () => {
  it('responde 404 si el agente no existe', () => {
    expect(prepareRun('nope', input, opts)).toMatchObject({ ok: false, status: 404 });
  });

  it('responde 400 si el body no es un RunAgentInput', () => {
    expect(prepareRun('credit', { hola: 1 }, opts)).toMatchObject({ ok: false, status: 400 });
  });

  it('usa el mock por defecto', () => {
    expect(prepareRun('credit', input, opts)).toMatchObject({ ok: true, mode: 'mock' });
  });

  it('responde 400 si piden Claude y no hay API key', () => {
    const body = { ...input, forwardedProps: { mode: 'claude' } };
    expect(prepareRun('credit', body, { ...opts, claudeAvailable: false })).toMatchObject({ ok: false, status: 400 });
  });

  it('limita Claude al grupo configurado cuando se usa en AWS', () => {
    const body = { ...input, forwardedProps: { mode: 'claude' } };
    const aws = { ...opts, claudeGroup: 'agents-claude' };
    expect(prepareRun('credit', body, { ...aws, userGroups: [] })).toMatchObject({ ok: false, status: 403 });
    expect(prepareRun('credit', body, { ...aws, userGroups: ['agents-claude'] })).toMatchObject({ ok: true, mode: 'claude' });
  });
});
