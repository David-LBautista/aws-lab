import { EventType, type AGUIEvent, type Interrupt } from '@ag-ui/core';
import { applyPatch, type Operation } from 'fast-json-patch';
import { Allow, parse as parsePartialJson } from 'partial-json';

export type RunStatus =
  | 'idle'
  | 'connecting'
  | 'running'
  | 'awaiting_approval'
  | 'done'
  | 'error'
  | 'cancelled';

export interface ToolCallView {
  id: string;
  name: string;
  argsText: string;
  args: Record<string, unknown> | null;
  status: 'streaming' | 'called' | 'completed';
  result?: string;
}

export type TimelineItem =
  | { kind: 'message'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string }
  | { kind: 'step'; id: string; name: string; finished: boolean };

export interface AgentView<S> {
  status: RunStatus;
  timeline: TimelineItem[];
  toolCalls: Record<string, ToolCallView>;
  state: S | null;
  currentStep: string | null;
  interrupt: Interrupt | null;
  error: string | null;
  eventCount: number;
}

export function initialView<S>(): AgentView<S> {
  return {
    status: 'idle',
    timeline: [],
    toolCalls: {},
    state: null,
    currentStep: null,
    interrupt: null,
    error: null,
    eventCount: 0,
  };
}

function parsePartialArguments(text: string): Record<string, unknown> | null {
  try {
    const value = parsePartialJson(text, Allow.ALL);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function applyEvent<S>(view: AgentView<S>, event: AGUIEvent): AgentView<S> {
  const next: AgentView<S> = { ...view, eventCount: view.eventCount + 1 };

  switch (event.type) {
    case EventType.RUN_STARTED:
      return { ...next, status: 'running', error: null, interrupt: null };

    case EventType.TEXT_MESSAGE_START:
      return {
        ...next,
        timeline: [...next.timeline, { kind: 'message', id: event.messageId, text: '', streaming: true }],
      };

    case EventType.TEXT_MESSAGE_CONTENT:
      return {
        ...next,
        timeline: next.timeline.map((item) =>
          item.kind === 'message' && item.id === event.messageId
            ? { ...item, text: item.text + event.delta }
            : item,
        ),
      };

    case EventType.TEXT_MESSAGE_END:
      return {
        ...next,
        timeline: next.timeline.map((item) =>
          item.kind === 'message' && item.id === event.messageId ? { ...item, streaming: false } : item,
        ),
      };

    case EventType.TOOL_CALL_START:
      return {
        ...next,
        timeline: [...next.timeline, { kind: 'tool', id: event.toolCallId }],
        toolCalls: {
          ...next.toolCalls,
          [event.toolCallId]: {
            id: event.toolCallId,
            name: event.toolCallName,
            argsText: '',
            args: null,
            status: 'streaming',
          },
        },
      };

    case EventType.TOOL_CALL_ARGS: {
      const call = next.toolCalls[event.toolCallId];
      if (!call) return next;
      const argsText = call.argsText + event.delta;
      return {
        ...next,
        toolCalls: {
          ...next.toolCalls,
          [call.id]: { ...call, argsText, args: parsePartialArguments(argsText) ?? call.args },
        },
      };
    }

    case EventType.TOOL_CALL_END: {
      const call = next.toolCalls[event.toolCallId];
      return call
        ? { ...next, toolCalls: { ...next.toolCalls, [call.id]: { ...call, status: 'called' } } }
        : next;
    }

    case EventType.TOOL_CALL_RESULT: {
      const call = next.toolCalls[event.toolCallId];
      return call
        ? {
            ...next,
            toolCalls: {
              ...next.toolCalls,
              [call.id]: { ...call, status: 'completed', result: String(event.content) },
            },
          }
        : next;
    }

    case EventType.STATE_SNAPSHOT:
      return { ...next, state: event.snapshot as S };

    case EventType.STATE_DELTA: {
      if (!next.state) return next;
      try {
        const state = applyPatch(next.state, event.delta as Operation[], false, false).newDocument;
        return { ...next, state };
      } catch {
        return { ...next, error: 'El estado se desincronizó y no se pudo aplicar un cambio.' };
      }
    }

    case EventType.STEP_STARTED:
      return {
        ...next,
        currentStep: event.stepName,
        timeline: [
          ...next.timeline,
          { kind: 'step', id: `step-${next.eventCount}`, name: event.stepName, finished: false },
        ],
      };

    case EventType.STEP_FINISHED:
      return {
        ...next,
        currentStep: null,
        timeline: next.timeline.map((item) =>
          item.kind === 'step' && item.name === event.stepName ? { ...item, finished: true } : item,
        ),
      };

    case EventType.RUN_FINISHED: {
      const outcome = event.outcome;
      if (outcome?.type === 'interrupt') {
        return {
          ...next,
          status: 'awaiting_approval',
          interrupt: outcome.interrupts[0] ?? null,
        };
      }
      return { ...next, status: 'done', currentStep: null };
    }

    case EventType.RUN_ERROR:
      return { ...next, status: 'error', error: event.message, currentStep: null };

    default:
      return next;
  }
}
