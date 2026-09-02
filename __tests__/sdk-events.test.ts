import { describe, it, expect, vi } from 'vitest';
import { isTerminal, translateSdkMessage } from '../src/runtimes/sdk-events.js';
import type { AgentEvent } from '../src/types.js';

// A translated message is a list, because an assistant message carries two
// things: what the model said and what the request cost. `first` reads the
// content event these cases are about; the cost span is asserted separately.
function first(events: AgentEvent[]): AgentEvent | null {
  return events[0] ?? null;
}

/** Claude Code's per-request usage block, as it appears on an assistant message. */
const USAGE = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 4000,
};

describe('translateSdkMessage', () => {
  it('captures the session id from system.init and emits no event', () => {
    const onSessionId = vi.fn();
    const result = translateSdkMessage(
      { type: 'system', subtype: 'init', session_id: 'sess_abc', uuid: 'uuid-1' },
      onSessionId,
    );
    expect(result).toEqual([]);
    expect(onSessionId).toHaveBeenCalledWith('sess_abc');
  });

  it('produces agent.message for assistant text content', () => {
    const event = first(
      translateSdkMessage(
        {
          type: 'assistant',
          uuid: 'uuid-2',
          session_id: 'sess',
          message: { content: [{ type: 'text', text: 'hello there' }] },
        },
        () => {},
      ),
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('agent.message');
    if (event!.type === 'agent.message') {
      expect(event.content).toEqual([{ type: 'text', text: 'hello there' }]);
    }
  });

  it('joins multiple text blocks into a single agent.message', () => {
    const event = first(
      translateSdkMessage(
        {
          type: 'assistant',
          uuid: 'uuid-3',
          session_id: 'sess',
          message: {
            content: [
              { type: 'text', text: 'first ' },
              { type: 'text', text: 'second' },
            ],
          },
        },
        () => {},
      ),
    );
    expect(event).not.toBeNull();
    if (event!.type === 'agent.message') {
      expect(event.content.length).toBe(2);
    }
  });

  it('produces agent.tool_use when the assistant message is tool-only', () => {
    const event = first(
      translateSdkMessage(
        {
          type: 'assistant',
          uuid: 'uuid-4',
          session_id: 'sess',
          message: {
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/x' } }],
          },
        },
        () => {},
      ),
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('agent.tool_use');
    if (event!.type === 'agent.tool_use') {
      expect(event.name).toBe('Read');
      expect(event.input).toEqual({ file_path: '/x' });
    }
  });

  it('prefers text over tool_use when both blocks are present', () => {
    const event = first(
      translateSdkMessage(
        {
          type: 'assistant',
          uuid: 'uuid-5',
          session_id: 'sess',
          message: {
            content: [
              { type: 'text', text: 'thinking out loud' },
              { type: 'tool_use', id: 'tu-2', name: 'Bash', input: {} },
            ],
          },
        },
        () => {},
      ),
    );
    expect(event!.type).toBe('agent.message');
  });

  it('produces session.status_idle for result.success', () => {
    const event = first(
      translateSdkMessage(
        { type: 'result', subtype: 'success', uuid: 'uuid-6', session_id: 'sess' },
        () => {},
      ),
    );
    expect(event!.type).toBe('session.status_idle');
  });

  it('attaches native total_cost_usd from the result onto status_idle', () => {
    const event = first(
      translateSdkMessage(
        {
          type: 'result',
          subtype: 'success',
          uuid: 'uuid-6b',
          session_id: 'sess',
          total_cost_usd: 0.0421,
        },
        () => {},
      ),
    );
    expect(event!.type).toBe('session.status_idle');
    expect((event as { total_cost_usd?: number }).total_cost_usd).toBe(0.0421);
  });

  it('omits total_cost_usd when the result has none (managed-agents shape)', () => {
    const event = first(
      translateSdkMessage(
        { type: 'result', subtype: 'success', uuid: 'uuid-6c', session_id: 'sess' },
        () => {},
      ),
    );
    expect((event as { total_cost_usd?: number }).total_cost_usd).toBeUndefined();
  });

  it('produces session.error for result error subtypes with the error message', () => {
    const event = first(
      translateSdkMessage(
        {
          type: 'result',
          subtype: 'error_during_execution',
          uuid: 'uuid-7',
          session_id: 'sess',
          errors: ['something blew up', 'and then again'],
        },
        () => {},
      ),
    );
    expect(event!.type).toBe('session.error');
    if (event!.type === 'session.error') {
      expect(event.error.type).toBe('error_during_execution');
      expect(event.error.message).toContain('something blew up');
    }
  });

  it('emits nothing for unknown / unparsable shapes', () => {
    expect(translateSdkMessage(null, () => {})).toEqual([]);
    expect(translateSdkMessage('not an object', () => {})).toEqual([]);
    expect(translateSdkMessage({}, () => {})).toEqual([]);
    expect(translateSdkMessage({ type: 'unknown-shape' }, () => {})).toEqual([]);
  });

  it('emits nothing for assistant messages with no content and no usage', () => {
    expect(
      translateSdkMessage(
        { type: 'assistant', uuid: 'uuid-8', session_id: 'sess', message: { content: [] } },
        () => {},
      ),
    ).toEqual([]);
  });
});

// ── The cost span the budget ceiling reads ──────────────────────────
//
// streamSessionWithAdvisor compares its accumulated total against the limit on
// `span.model_request_end` and on nothing else. Every transport that speaks
// this message shape reaches the ceiling only through these spans; the result
// message's `total_cost_usd` arrives after the session is over.

describe('cost spans from assistant usage', () => {
  const assistant = (usage: unknown, content: unknown[] = [{ type: 'text', text: 'hi' }]) => ({
    type: 'assistant',
    uuid: 'uuid-cost',
    session_id: 'sess',
    message: { id: 'msg_01', usage, content },
  });

  it('emits a span carrying the per-request token counts', () => {
    const events = translateSdkMessage(assistant(USAGE), () => {});
    const span = events.find((e) => e.type === 'span.model_request_end');
    expect(span).toBeDefined();
    if (span?.type === 'span.model_request_end') {
      expect(span.is_error).toBe(false);
      expect(span.id).toBe('msg_01');
      expect(span.model_usage).toEqual({
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 4000,
      });
    }
  });

  it('puts the content event before the span', () => {
    // A ceiling that trips on the span must not discard the text that preceded
    // it: the partial output is what the caller returns.
    const events = translateSdkMessage(assistant(USAGE), () => {});
    expect(events.map((e) => e.type)).toEqual(['agent.message', 'span.model_request_end']);
  });

  it('emits the span for a tool-only message too', () => {
    const events = translateSdkMessage(
      assistant(USAGE, [{ type: 'tool_use', id: 'tu', name: 'Bash', input: {} }]),
      () => {},
    );
    expect(events.map((e) => e.type)).toEqual(['agent.tool_use', 'span.model_request_end']);
  });

  it('emits the span alone when a message has usage and no renderable content', () => {
    expect(translateSdkMessage(assistant(USAGE, []), () => {}).map((e) => e.type)).toEqual([
      'span.model_request_end',
    ]);
  });

  it('treats absent cache counts as zero rather than dropping the span', () => {
    const events = translateSdkMessage(
      assistant({ input_tokens: 10, output_tokens: 20 }),
      () => {},
    );
    const span = events.find((e) => e.type === 'span.model_request_end');
    if (span?.type === 'span.model_request_end') {
      expect(span.model_usage.cache_creation_input_tokens).toBe(0);
      expect(span.model_usage.cache_read_input_tokens).toBe(0);
    } else {
      throw new Error('no span emitted');
    }
  });

  it('emits no span when the message carries no usable counts', () => {
    for (const usage of [undefined, {}, { input_tokens: 5 }, { output_tokens: 5 }]) {
      const events = translateSdkMessage(assistant(usage), () => {});
      expect(events.some((e) => e.type === 'span.model_request_end')).toBe(false);
    }
  });
});

describe('isTerminal', () => {
  it('detects session.status_idle as terminal', () => {
    const event: AgentEvent = {
      type: 'session.status_idle',
      id: 'uuid',
      processed_at: '2026-05-18T00:00:00Z',
    };
    expect(isTerminal(event)).toBe(true);
  });

  it('detects session.error as terminal', () => {
    const event: AgentEvent = {
      type: 'session.error',
      id: 'uuid',
      error: { type: 'x', message: 'y' },
      processed_at: '2026-05-18T00:00:00Z',
    };
    expect(isTerminal(event)).toBe(true);
  });

  it('returns false for non-terminal events', () => {
    const event: AgentEvent = {
      type: 'agent.message',
      id: 'uuid',
      content: [{ type: 'text', text: 'hi' }],
      processed_at: '2026-05-18T00:00:00Z',
    };
    expect(isTerminal(event)).toBe(false);
  });
});
