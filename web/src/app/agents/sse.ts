import type { AGUIEvent } from '@ag-ui/core';

// Separa el buffer en eventos SSE completos y conserva el fragmento incompleto.
export function parseSseBuffer(buffer: string): { events: AGUIEvent[]; rest: string } {
  const events: AGUIEvent[] = [];
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    const data = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) events.push(JSON.parse(data) as AGUIEvent);
  }
  return { events, rest };
}
