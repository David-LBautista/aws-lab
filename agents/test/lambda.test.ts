import { beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryThreadStore } from '../src/store/threadStore.js';

vi.mock('../src/store/dynamoThreadStore.js', () => ({ DynamoThreadStore: InMemoryThreadStore }));

interface Captured {
  statusCode?: number;
  headers?: Record<string, string>;
  body: string;
  ended: boolean;
}

function fakeStream() {
  const captured: Captured = { body: '', ended: false };
  const stream = {
    write: (chunk: string) => { captured.body += chunk; return true; },
    end: () => { captured.ended = true; },
  };
  return { stream, captured };
}

type Handler = (event: unknown, stream: unknown, context: unknown) => Promise<void>;
let handler: Handler;

beforeAll(async () => {
  process.env.THREADS_TABLE = 'test';
  process.env.ALLOWED_ORIGINS = 'https://lab.davidlucas.dev';
  process.env.CLAUDE_GROUP = 'agents-claude';
  (globalThis as typeof globalThis & { awslambda?: unknown }).awslambda = {
    streamifyResponse: (fn: unknown) => fn,
    HttpResponseStream: {
      from(stream: object, metadata: { statusCode: number; headers?: Record<string, string> }) {
        Object.assign(stream, { meta: metadata });
        return stream;
      },
    },
  };
  ({ handler } = await import('../src/lambda.js') as unknown as { handler: Handler });
});

const context = { getRemainingTimeInMillis: () => 60_000 };
const event = (overrides: Record<string, unknown> = {}) => ({
  httpMethod: 'POST',
  resource: '/api/agents/{agentId}',
  headers: { origin: 'https://lab.davidlucas.dev' },
  pathParameters: { agentId: 'credit' },
  requestContext: { authorizer: { claims: { 'cognito:groups': '' } } },
  isBase64Encoded: false,
  body: JSON.stringify({ threadId: 't1', runId: 'r1', messages: [], tools: [], context: [], state: {} }),
  ...overrides,
});

describe('lambda handler', () => {
  it('responde health con JSON y CORS para el origen permitido', async () => {
    const { stream, captured } = fakeStream();
    await handler(event({ httpMethod: 'GET', resource: '/api/health' }), stream, context);
    const meta = (stream as { meta: { statusCode: number; headers: Record<string, string> } }).meta;
    expect(meta.statusCode).toBe(200);
    expect(meta.headers['Access-Control-Allow-Origin']).toBe('https://lab.davidlucas.dev');
    expect(JSON.parse(captured.body)).toMatchObject({ ok: true, agents: ['legal', 'credit'] });
  });

  it('emite eventos SSE del agente hasta su pausa', async () => {
    const { stream, captured } = fakeStream();
    await handler(event(), stream, context);
    const meta = (stream as { meta: { headers: Record<string, string> } }).meta;
    expect(meta.headers['Content-Type']).toBe('text/event-stream');
    const events = captured.body.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    expect(events[0].type).toBe('RUN_STARTED');
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'interrupt' } });
    expect(captured.ended).toBe(true);
  });

  it('no permite CORS desde orígenes desconocidos', async () => {
    const { stream } = fakeStream();
    await handler(event({ httpMethod: 'GET', resource: '/api/health', headers: { origin: 'https://evil.example' } }), stream, context);
    const meta = (stream as { meta: { headers: Record<string, string> } }).meta;
    expect(meta.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('responde 400 con JSON inválido', async () => {
    const { stream } = fakeStream();
    await handler(event({ body: '{no json' }), stream, context);
    expect((stream as { meta: { statusCode: number } }).meta.statusCode).toBe(400);
  });
});
