import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { EventType } from '@ag-ui/core';
import { SseWriter } from './sse.js';
import { agents } from './agents/registry.js';
import { AbortedError } from './agents/types.js';
import { InMemoryThreadStore, type ThreadStore } from './store/threadStore.js';
import { DynamoThreadStore } from './store/dynamoThreadStore.js';
import { prepareRun } from './server/prepareRun.js';

const PORT = Number(process.env.PORT ?? 8787);
const claudeAvailable = Boolean(process.env.ANTHROPIC_API_KEY);
const defaultMode = process.env.AGENT_MODE ?? (claudeAvailable ? 'claude' : 'mock');
const store: ThreadStore = process.env.THREADS_TABLE
  ? new DynamoThreadStore(process.env.THREADS_TABLE)
  : new InMemoryThreadStore();

const app = express();
app.use(cors({ origin: ['http://localhost:4200', 'http://localhost:5173'] }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({ name: 'agents-api', health: '/api/health', run: 'POST /api/agents/:agentId' });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, defaultMode, claudeAvailable, agents: Object.keys(agents) });
});

// Endpoint AG-UI: recibe un RunAgentInput (POST) y responde con un stream SSE de eventos.
app.post('/api/agents/:agentId', async (req, res) => {
  const run = prepareRun(req.params.agentId, req.body, { claudeAvailable, defaultMode });
  if (!run.ok) {
    res.status(run.status).json({ error: run.error });
    return;
  }

  const sse = new SseWriter(res);
  const controller = new AbortController();
  // Si el navegador cierra la conexión (Stop, recarga, pestaña cerrada) cancelamos el agente.
  res.on('close', () => controller.abort());
  const heartbeat = setInterval(() => sse.heartbeat(), 15_000);

  try {
    await run.agent({ input: run.input, emit: (e) => sse.send(e), signal: controller.signal, store });
  } catch (err) {
    if (!(err instanceof AbortedError) && !controller.signal.aborted) {
      console.error(err);
      sse.send({ type: EventType.RUN_ERROR, message: 'Unexpected server error', code: 'INTERNAL' });
    }
  } finally {
    clearInterval(heartbeat);
    sse.end();
  }
});

app.listen(PORT, () => console.log(`Agents API on http://localhost:${PORT} (mode: ${defaultMode}, store: ${process.env.THREADS_TABLE ? 'dynamodb' : 'memory'})`));
