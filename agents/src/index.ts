import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { SseWriter } from './sse.js';
import { agents } from './agents/registry.js';
import { AbortedError } from './agents/types.js';
import { InMemoryThreadStore } from './store/threadStore.js';

const PORT = Number(process.env.PORT ?? 8787);
const claudeAvailable = Boolean(process.env.ANTHROPIC_API_KEY);
const defaultMode = process.env.AGENT_MODE ?? (claudeAvailable ? 'claude' : 'mock');
const store = new InMemoryThreadStore(); // paso 7: DynamoThreadStore

const app = express();
app.use(cors({ origin: ['http://localhost:4200', 'http://localhost:5173'] }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, defaultMode, claudeAvailable, agents: Object.keys(agents) });
});

app.post('/api/agents/:agentId', async (req, res) => {
  const entry = agents[req.params.agentId];
  if (!entry) {
    res.status(404).json({ error: `Unknown agent "${req.params.agentId}"` });
    return;
  }

  const input = req.body as RunAgentInput;
  if (!input?.threadId || !input?.runId || !Array.isArray(input?.messages)) {
    res
      .status(400)
      .json({ error: 'Body must be a RunAgentInput with threadId, runId and messages' });
    return;
  }

  const mode = (input.forwardedProps?.mode as string | undefined) ?? defaultMode;
  if (mode === 'claude' && !claudeAvailable) {
    res.status(400).json({ error: 'Claude mode needs ANTHROPIC_API_KEY' });
    return;
  }
  const agent = mode === 'claude' ? entry.claude : entry.mock;

  const sse = new SseWriter(res);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const heartbeat = setInterval(() => sse.heartbeat(), 15_000);

  try {
    await agent({ input, emit: (e) => sse.send(e), signal: controller.signal, store });
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

app.listen(PORT, () =>
  console.log(`Agents API on http://localhost:${PORT} (mode: ${defaultMode})`),
);
