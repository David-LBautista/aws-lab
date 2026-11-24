import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { EventType, type AGUIEvent, type RunAgentInput } from '@ag-ui/core';
import { createCreditClaudeAgent, type ClaudeClient } from '../src/credit/creditClaudeAgent.js';
import { InMemoryThreadStore } from '../src/store/threadStore.js';
import type { ApplicationInput, CreditState } from '../src/credit/domain.js';

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> };

function fakeClaude(turns: Block[][]) {
  const requests: Anthropic.MessageCreateParams[] = [];
  let turn = 0;
  let toolSeq = 0;
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        requests.push(structuredClone(params));
        const blocks = turns[turn++];
        if (!blocks) throw new Error(`El guion no tiene turno ${turn}`);
        const content = blocks.map((block) => block.type === 'text'
          ? { type: 'text', text: block.text, citations: null }
          : { type: 'tool_use', id: `toolu_${++toolSeq}`, name: block.name, input: block.input }) as Anthropic.ContentBlock[];
        async function* events() {
          for (const [index, block] of content.entries()) {
            if (block.type === 'text') {
              yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
              yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } };
            } else if (block.type === 'tool_use') {
              yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } };
              yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } };
            }
            yield { type: 'content_block_stop', index };
          }
        }
        const stopReason = content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
        return Object.assign(events(), { finalMessage: async () => ({ content, stop_reason: stopReason }) });
      },
    },
  } as unknown as ClaudeClient;
  return { client, requests };
}

async function run(client: ClaudeClient, store: InMemoryThreadStore, input: Partial<RunAgentInput>) {
  const events: AGUIEvent[] = [];
  await createCreditClaudeAgent(() => client)({
    input: { threadId: 't1', runId: crypto.randomUUID(), messages: [], tools: [], context: [], state: {}, ...input } as RunAgentInput,
    emit: (event) => events.push(event), signal: new AbortController().signal, store,
  });
  return events;
}

const last = (events: AGUIEvent[]) => events[events.length - 1];
const results = (events: AGUIEvent[]) => events.filter((event) => event.type === EventType.TOOL_CALL_RESULT).map((event) => JSON.parse(String((event as { content: string }).content)));
const rechazo: ApplicationInput = { name: 'Ana Torres', monthlyIncome: 12000, monthlyDebts: 8000, employmentYears: 2, amount: 150000, termMonths: 24 };
const say = (text: string): Block => ({ type: 'text', text });
const tool = (name: string, input: Record<string, unknown> = {}): Block => ({ type: 'tool_use', name, input });

describe('creditClaudeAgent', () => {
  it('deja los cálculos al servidor y pausa la propuesta hasta autorización humana', async () => {
    const store = new InMemoryThreadStore();
    const { client, requests } = fakeClaude([
      [say('Consulto el buró.'), tool('get_credit_report', { applicationId: 'no-confiable' })],
      [tool('calculate_payment', { termMonths: 24 })],
      [say('Pruebo 36 meses.'), tool('calculate_payment', { termMonths: 36 })],
      [say('Recomiendo aprobar.'), tool('approve_loan', { termMonths: 36, rationale: 'Cumple a 36 meses' })],
    ]);
    const events = await run(client, store, { state: {} });
    expect(results(events)[1]).toMatchObject({ termMonths: 24, monthlyPayment: 7931, debtToIncome: 0.45, withinLimit: false });
    expect(results(events)[2]).toMatchObject({ termMonths: 36, monthlyPayment: 5885, withinLimit: true });
    expect(results(events)).toHaveLength(3);
    expect(last(events)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'interrupt' } });
    expect(events.filter((event) => event.type === EventType.STEP_STARTED).map((event) => (event as { stepName: string }).stepName)).toEqual(['credit_report', 'affordability', 'decision']);
    const memory = await store.get<CreditState>('t1');
    expect(memory?.state.recommendation).toMatchObject({ decision: 'approve', termMonths: 36, annualRate: 0.24 });
    expect(memory?.pending?.toolName).toBe('approve_loan');
    expect(String(requests[0].system)).toContain('40%');
    expect(JSON.stringify(requests[0].messages)).not.toContain('simulatedScore');
  });

  it('reanuda con el resultado de la decisión humana y termina', async () => {
    const store = new InMemoryThreadStore();
    const { client, requests } = fakeClaude([
      [tool('get_credit_report')], [tool('calculate_payment', { termMonths: 36 })],
      [tool('approve_loan', { termMonths: 36, rationale: 'Cumple' })], [say('Crédito emitido.')],
    ]);
    const paused = await run(client, store, { state: {} });
    const interrupt = (last(paused) as { outcome: { interrupts: { id: string; toolCallId: string }[] } }).outcome.interrupts[0];
    const resumed = await run(client, store, { resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { decision: 'approve' } }] });
    expect(results(resumed)[0]).toMatchObject({ issued: true, termMonths: 36, monthlyPayment: 5885 });
    expect(last(resumed)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'success' } });
    expect((await store.get<CreditState>('t1'))?.state.status).toBe('approved');
    expect(JSON.stringify(requests[3].messages.at(-1)?.content)).toContain(interrupt.toolCallId);
  });

  it('reanuda un rechazo enviado a revisión manual y completa el tool result', async () => {
    const store = new InMemoryThreadStore();
    const { client } = fakeClaude([[tool('get_credit_report')], [tool('reject_loan', { reasons: ['No cumple los criterios'] })], [say('Se envió a revisión manual.')]]);
    const paused = await run(client, store, { state: rechazo });
    const interrupt = (last(paused) as { outcome: { interrupts: { id: string }[] } }).outcome.interrupts[0];
    const resumed = await run(client, store, { resume: [{ interruptId: interrupt.id, status: 'resolved', payload: { decision: 'reject', reason: 'Revisar documentos' } }] });
    expect(results(resumed)[0]).toMatchObject({ rejected: false, sentToManualReview: true, analystNote: 'Revisar documentos' });
    expect((await store.get<CreditState>('t1'))?.state.status).toBe('manual_review');
    expect(last(resumed)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'success' } });
  });

  it('rechaza propuestas que rompen reglas sin pedir autorización', async () => {
    const store = new InMemoryThreadStore();
    const { client } = fakeClaude([
      [tool('get_credit_report')], [tool('approve_loan', { termMonths: 24, rationale: 'Me cae bien' })],
      [say('No cumple.'), tool('reject_loan', { reasons: ['Deuda/ingreso muy alta'] })],
    ]);
    const events = await run(client, store, { state: rechazo });
    expect(results(events)[1].error).toContain('No se puede aprobar');
    const memory = await store.get<CreditState>('t1');
    expect(memory?.pending?.toolName).toBe('reject_loan');
    expect(memory?.state.recommendation?.decision).toBe('reject');
  });

  it('rechaza plazos inventados y valida la solicitud antes de llamar a Claude', async () => {
    const { client, requests } = fakeClaude([
      [tool('get_credit_report')], [tool('calculate_payment', { termMonths: 120 })], [say('Termino.')],
    ]);
    const events = await run(client, new InMemoryThreadStore(), { state: {} });
    expect(results(events)[1].error).toContain('Plazo no permitido');
    const invalid = fakeClaude([]);
    const invalidEvents = await run(invalid.client, new InMemoryThreadStore(), { state: { ...rechazo, amount: 10 } });
    expect(last(invalidEvents)).toMatchObject({ type: EventType.RUN_ERROR, code: 'INVALID_APPLICATION' });
    expect(invalid.requests).toHaveLength(0);
    expect(requests.length).toBe(3);
  });
});
