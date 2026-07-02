import { describe, it, expect, vi } from 'vitest';
import { isTerminal, translateSdkMessage } from '../src/runtimes/sdk-events.js';
import type { AgentEvent } from '../src/types.js';

describe('translateSdkMessage', () => {
  it('captures the session id from system.init and emits no event', () => {
    const onSessionId = vi.fn();
    const result = translateSdkMessage(
      { type: 'system', subtype: 'init', session_id: 'sess_abc', uuid: 'uuid-1' },
      onSessionId,
    );
    expect(result).toBeNull();
    expect(onSessionId).toHaveBeenCalledWith('sess_abc');
  });

  it('produces agent.message for assistant text content', () => {
    const event = translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'uuid-2',
        session_id: 'sess',
        message: { content: [{ type: 'text', text: 'hello there' }] },
      },
      () => {},
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('agent.message');
    if (event!.type === 'agent.message') {
      expect(event.content).toEqual([{ type: 'text', text: 'hello there' }]);
    }
  });

  it('joins multiple text blocks into a single agent.message', () => {
    const event = translateSdkMessage(
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
    );
    expect(event).not.toBeNull();
    if (event!.type === 'agent.message') {
      expect(event.content.length).toBe(2);
    }
  });

  it('produces agent.tool_use when the assistant message is tool-only', () => {
    const event = translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'uuid-4',
        session_id: 'sess',
        message: {
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/x' } }],
        },
      },
      () => {},
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('agent.tool_use');
    if (event!.type === 'agent.tool_use') {
      expect(event.name).toBe('Read');
      expect(event.input).toEqual({ file_path: '/x' });
    }
  });

  it('prefers text over tool_use when both blocks are present', () => {
    const event = translateSdkMessage(
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
    );
    expect(event!.type).toBe('agent.message');
  });

  it('produces session.status_idle for result.success', () => {
    const event = translateSdkMessage(
      { type: 'result', subtype: 'success', uuid: 'uuid-6', session_id: 'sess' },
      () => {},
    );
    expect(event!.type).toBe('session.status_idle');
  });

  it('attaches native total_cost_usd from the result onto status_idle', () => {
    const event = translateSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        uuid: 'uuid-6b',
        session_id: 'sess',
        total_cost_usd: 0.0421,
      },
      () => {},
    );
    expect(event!.type).toBe('session.status_idle');
    expect((event as { total_cost_usd?: number }).total_cost_usd).toBe(0.0421);
  });

  it('omits total_cost_usd when the result has none (managed-agents shape)', () => {
    const event = translateSdkMessage(
      { type: 'result', subtype: 'success', uuid: 'uuid-6c', session_id: 'sess' },
      () => {},
    );
    expect((event as { total_cost_usd?: number }).total_cost_usd).toBeUndefined();
  });

  it('produces session.error for result error subtypes with the error message', () => {
    const event = translateSdkMessage(
      {
        type: 'result',
        subtype: 'error_during_execution',
        uuid: 'uuid-7',
        session_id: 'sess',
        errors: ['something blew up', 'and then again'],
      },
      () => {},
    );
    expect(event!.type).toBe('session.error');
    if (event!.type === 'session.error') {
      expect(event.error.type).toBe('error_during_execution');
      expect(event.error.message).toContain('something blew up');
    }
  });

  it('returns null for unknown / unparsable shapes', () => {
    expect(translateSdkMessage(null, () => {})).toBeNull();
    expect(translateSdkMessage('not an object', () => {})).toBeNull();
    expect(translateSdkMessage({}, () => {})).toBeNull();
    expect(translateSdkMessage({ type: 'unknown-shape' }, () => {})).toBeNull();
  });

  it('returns null for assistant messages with empty content', () => {
    const event = translateSdkMessage(
      { type: 'assistant', uuid: 'uuid-8', session_id: 'sess', message: { content: [] } },
      () => {},
    );
    expect(event).toBeNull();
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
