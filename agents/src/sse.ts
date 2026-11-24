import type { Response } from 'express';
import type { AGUIEvent } from '@ag-ui/core';

// Escritor de Server-Sent Events. Cada evento AG-UI viaja como una línea `data: {json}`
// seguida de una línea en blanco. El navegador lo recibe en streaming.
export class SseWriter {
  private closed = false;

  constructor(private readonly res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // evita buffering en proxies tipo nginx
    res.flushHeaders();
    res.on('close', () => {
      this.closed = true;
    });
  }

  get isClosed() {
    return this.closed;
  }

  send(event: AGUIEvent) {
    if (this.closed) return;
    const withTimestamp = { timestamp: Date.now(), ...event };
    this.res.write(`data: ${JSON.stringify(withTimestamp)}\n\n`);
  }

  // Comentario SSE: mantiene viva la conexión en procesos largos (no lo ve la app).
  heartbeat() {
    if (!this.closed) this.res.write(': ping\n\n');
  }

  end() {
    if (!this.closed) this.res.end();
    this.closed = true;
  }
}
