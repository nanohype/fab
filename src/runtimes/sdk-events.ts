import type { AgentEvent } from '../types.js';

/**
 * Shared SDK message → jaunty AgentEvent translator. The Agent SDK
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
    content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
  };
}

interface MaybeResult {
  type: string;
  subtype: string;
  uuid: string;
  session_id: string;
  is_error?: boolean;
  errors?: string[];
}

export function translateSdkMessage(raw: unknown, onSessionId: (id: string) => void): AgentEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as MaybeSystemInit;

  if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
    onSessionId(m.session_id);
    return null;
  }

  if (m.type === 'assistant') {
    const a = raw as MaybeAssistant;
    // An `assistant` message can contain interleaved text + tool_use blocks.
    // Surface the first text block as `agent.message` so the workflow
    // formatter has something to render; tool-use blocks emit their own
    // events. Multi-block messages collapse into a single event by
    // concatenating text content — workflow code consumes the joined text.
    const textBlocks = a.message.content.filter((b) => b.type === 'text' && typeof b.text === 'string');
    if (textBlocks.length > 0) {
      return {
        type: 'agent.message',
        id: a.uuid,
        content: textBlocks.map((b) => ({ type: 'text', text: b.text! })),
        processed_at: new Date().toISOString(),
      };
    }
    const toolUse = a.message.content.find((b) => b.type === 'tool_use');
    if (toolUse) {
      return {
        type: 'agent.tool_use',
        id: toolUse.id ?? a.uuid,
        name: toolUse.name ?? 'unknown',
        input: toolUse.input ?? {},
        processed_at: new Date().toISOString(),
      };
    }
    return null;
  }

  if (m.type === 'result') {
    const r = raw as MaybeResult;
    if (r.subtype === 'success') {
      return {
        type: 'session.status_idle',
        id: r.uuid,
        processed_at: new Date().toISOString(),
      };
    }
    return {
      type: 'session.error',
      id: r.uuid,
      error: {
        type: r.subtype,
        message: r.errors?.join('\n') ?? r.subtype,
      },
      processed_at: new Date().toISOString(),
    };
  }

  return null;
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
