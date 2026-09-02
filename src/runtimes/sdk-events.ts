import type { AgentEvent } from '../types.js';

/**
 * Shared SDK message → fab AgentEvent translator. The Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`) and the `claude` CLI's
 * `--output-format stream-json` mode emit the same SDKMessage shape — they're
 * the same Claude Code binary under the hood — so one translator serves both
 * the in-process runtime and the subprocess runtime.
 */

interface MaybeSystemInit {
  type: string;
  subtype?: string;
  session_id?: string;
}

interface MaybeAssistant {
  type: string;
  uuid: string;
  session_id: string;
  message: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
    content: {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }[];
  };
}

/**
 * The per-request token counts an assistant message carries, as the cost span
 * the budget tracker reads.
 *
 * Without this the kill-switch is unreachable outside managed-agents: the only
 * cost signal these transports produced was `total_cost_usd` on the terminal
 * result, which arrives after the money is spent and so can report a breach but
 * never prevent one. The counts are per request, which is what makes them
 * summable — an accumulated total is what a ceiling is compared against.
 */
function costSpan(a: MaybeAssistant): AgentEvent | null {
  const u = a.message.usage;
  if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') {
    return null;
  }
  return {
    type: 'span.model_request_end',
    id: a.message.id ?? a.uuid,
    is_error: false,
    model_usage: {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    },
    processed_at: new Date().toISOString(),
  };
}

interface MaybeResult {
  type: string;
  subtype: string;
  uuid: string;
  session_id: string;
  is_error?: boolean;
  errors?: string[];
  total_cost_usd?: number;
}

/**
 * Translate one SDK message into the events it carries, in the order a consumer
 * must see them.
 *
 * A list rather than one event because an assistant message carries two things:
 * what the model said and what the request cost. Returning only the first is how
 * the cost went missing on every transport that speaks this shape.
 */
export function translateSdkMessage(raw: unknown, onSessionId: (id: string) => void): AgentEvent[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const m = raw as MaybeSystemInit;

  if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
    onSessionId(m.session_id);
    return [];
  }

  // Other `system` messages — status updates, compaction boundaries, and any
  // subtype the 0.3.x SDK introduces — carry no payload the workflow layer
  // consumes; the run is driven by `assistant` + `result`. Ignore them
  // explicitly so a new subtype is a documented no-op, not a silent drop.
  if (m.type === 'system') return [];

  if (m.type === 'assistant') {
    const a = raw as MaybeAssistant;
    // Content before cost, so text the model produced is captured before a
    // ceiling can end the stream on the span that follows it.
    const span = costSpan(a);
    // An `assistant` message can contain interleaved text + tool_use blocks.
    // Surface the first text block as `agent.message` so the workflow
    // formatter has something to render; tool-use blocks emit their own
    // events. Multi-block messages collapse into a single event by
    // concatenating text content — workflow code consumes the joined text.
    const textBlocks = a.message.content.filter(
      (b) => b.type === 'text' && typeof b.text === 'string',
    );
    if (textBlocks.length > 0) {
      return [
        {
          type: 'agent.message',
          id: a.uuid,
          content: textBlocks.map((b) => ({ type: 'text', text: b.text! })),
          processed_at: new Date().toISOString(),
        },
        ...(span ? [span] : []),
      ];
    }
    const toolUse = a.message.content.find((b) => b.type === 'tool_use');
    if (toolUse) {
      return [
        {
          type: 'agent.tool_use',
          id: toolUse.id ?? a.uuid,
          name: toolUse.name ?? 'unknown',
          input: toolUse.input ?? {},
          processed_at: new Date().toISOString(),
        },
        ...(span ? [span] : []),
      ];
    }
    // A message with neither text nor a tool call still cost something.
    return span ? [span] : [];
  }

  if (m.type === 'result') {
    const r = raw as MaybeResult;
    if (r.subtype === 'success') {
      return [
        {
          type: 'session.status_idle',
          id: r.uuid,
          // The run's own total, which reconciles the summed spans against what
          // the transport actually billed.
          ...(typeof r.total_cost_usd === 'number' && { total_cost_usd: r.total_cost_usd }),
          processed_at: new Date().toISOString(),
        },
      ];
    }
    return [
      {
        type: 'session.error',
        id: r.uuid,
        error: {
          type: r.subtype,
          message: r.errors?.join('\n') ?? r.subtype,
        },
        processed_at: new Date().toISOString(),
      },
    ];
  }

  return [];
}

export function isTerminal(event: AgentEvent): boolean {
  return event.type === 'session.status_idle' || event.type === 'session.error';
}

export function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('');
}
