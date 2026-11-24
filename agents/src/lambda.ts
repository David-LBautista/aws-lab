import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { EventType, type AGUIEvent } from '@ag-ui/core';
import { agents } from './agents/registry.js';
import { AbortedError } from './agents/types.js';
import { prepareRun } from './server/prepareRun.js';
import { DynamoThreadStore } from './store/dynamoThreadStore.js';

declare const awslambda: {
  streamifyResponse(
    handler: (event: APIGatewayProxyEvent, stream: NodeJS.WritableStream, context: Context) => Promise<void>,
  ): unknown;
  HttpResponseStream: {
    from(stream: NodeJS.WritableStream, metadata: { statusCode: number; headers?: Record<string, string> }): NodeJS.WritableStream;
  };
};

const store = new DynamoThreadStore(process.env.THREADS_TABLE ?? '');
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
const claudeGroup = process.env.CLAUDE_GROUP || undefined;
let secretLoaded: Promise<void> | undefined;

function loadAnthropicKey(): Promise<void> {
  const secretId = process.env.ANTHROPIC_SECRET_ID;
  if (!secretId || process.env.ANTHROPIC_API_KEY) return Promise.resolve();
  return (secretLoaded ??= new SecretsManagerClient({})
    .send(new GetSecretValueCommand({ SecretId: secretId }))
    .then((response) => {
      const key = response.SecretString?.trim();
      if (key?.startsWith('sk-ant-')) process.env.ANTHROPIC_API_KEY = key;
    })
    .catch((error: unknown) => {
      secretLoaded = undefined;
      console.error('No se pudo leer el secreto de Anthropic', error);
    }));
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

function getUserGroups(event: APIGatewayProxyEvent): string[] {
  const raw = event.requestContext.authorizer?.claims?.['cognito:groups'];
  return raw ? String(raw).replace(/[\[\]]/g, '').split(/[\s,]+/).filter(Boolean) : [];
}

function writeJson(stream: NodeJS.WritableStream, statusCode: number, body: unknown, headers: Record<string, string>) {
  const response = awslambda.HttpResponseStream.from(stream, {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  response.write(JSON.stringify(body));
  response.end();
}

export const handler = awslambda.streamifyResponse(async (event, responseStream, context) => {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  const cors = corsHeaders(origin);
  await loadAnthropicKey();
  const claudeAvailable = Boolean(process.env.ANTHROPIC_API_KEY);

  if (event.httpMethod === 'GET' && event.resource === '/api/health') {
    writeJson(responseStream, 200, { ok: true, defaultMode: 'mock', claudeAvailable, agents: Object.keys(agents) }, cors);
    return;
  }

  let body: unknown;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
    body = JSON.parse(raw ?? '{}');
  } catch {
    writeJson(responseStream, 400, { error: 'Invalid JSON body' }, cors);
    return;
  }

  const run = prepareRun(event.pathParameters?.agentId, body, {
    claudeAvailable,
    defaultMode: 'mock',
    userGroups: getUserGroups(event),
    claudeGroup,
  });
  if (!run.ok) {
    writeJson(responseStream, run.status, { error: run.error }, cors);
    return;
  }

  const sse = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', ...cors },
  });
  const send = (event: AGUIEvent) => sse.write(`data: ${JSON.stringify({ timestamp: Date.now(), ...event })}\n\n`);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), Math.max(context.getRemainingTimeInMillis() - 5_000, 1_000));
  const heartbeat = setInterval(() => sse.write(': ping\n\n'), 15_000);

  try {
    await run.agent({ input: run.input, emit: send, signal: controller.signal, store });
  } catch (error) {
    if (controller.signal.aborted) {
      send({ type: EventType.RUN_ERROR, message: 'Se agotó el tiempo de la corrida', code: 'TIMEOUT' });
    } else if (!(error instanceof AbortedError)) {
      console.error(error);
      send({ type: EventType.RUN_ERROR, message: 'Unexpected server error', code: 'INTERNAL' });
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    sse.end();
  }
});
