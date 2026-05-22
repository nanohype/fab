import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AgentEvent } from '../src/types.js';
import type { ParsedArgs } from '../src/args.js';
import { executeRoleSession, serializeEvent, streamEventsToJsonl } from '../src/runtimes/role-session.js';

function args(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return { command: 'role-session', sub: '', positional: [], flags: {}, ...overrides };
}

async function* asStream(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}

const message: AgentEvent = {
  type: 'agent.message',
  id: 'm1',
  content: [{ type: 'text', text: 'on it' }],
  processed_at: '2026-05-22T00:00:00Z',
};
const toolUse: AgentEvent = {
  type: 'agent.tool_use',
  id: 't1',
  name: 'Bash',
  input: { command: 'go test ./...' },
  processed_at: '2026-05-22T00:00:01Z',
};
const idle: AgentEvent = { type: 'session.status_idle', id: 's1', processed_at: '2026-05-22T00:00:02Z' };
const failed: AgentEvent = {
  type: 'session.error',
  id: 's1',
  error: { type: 'error_during_execution', message: 'boom' },
  processed_at: '2026-05-22T00:00:02Z',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('serializeEvent', () => {
  it('encodes an event as exactly one newline-terminated JSON line', () => {
    const line = serializeEvent(message);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });

  it('round-trips every event shape through JSON.parse', () => {
    for (const event of [message, toolUse, idle, failed]) {
      expect(JSON.parse(serializeEvent(event))).toEqual(event);
    }
  });
});

describe('streamEventsToJsonl', () => {
  it('writes each event as a JSONL line and exits 0 on session.status_idle', async () => {
    const events = [message, toolUse, idle];
    const lines: string[] = [];
    const code = await streamEventsToJsonl(asStream(events), (line) => {
      lines.push(line);
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(events.length);
    expect(lines.map((line) => JSON.parse(line))).toEqual(events);
  });

  it('exits 1 when the session ends in session.error', async () => {
    const lines: string[] = [];
    const code = await streamEventsToJsonl(asStream([message, failed]), (line) => {
      lines.push(line);
    });
    expect(code).toBe(1);
    expect(lines).toHaveLength(2);
  });

  it('exits 1 when the stream ends with no terminal event', async () => {
    const lines: string[] = [];
    const code = await streamEventsToJsonl(asStream([message, toolUse]), (line) => {
      lines.push(line);
    });
    expect(code).toBe(1);
  });
});

describe('executeRoleSession', () => {
  it('returns 1 and writes usage when neither args nor env supply a role', async () => {
    vi.stubEnv('FAB_ROLE', undefined);
    vi.stubEnv('FAB_MESSAGE', undefined);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await executeRoleSession(args());
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalled();
  });

  it('resolves the role from the --role flag through to the runtime', async () => {
    vi.stubEnv('FAB_ROLE', undefined);
    vi.stubEnv('FAB_MESSAGE', undefined);
    await expect(
      executeRoleSession(args({ flags: { role: 'not-a-real-role' }, sub: 'build', positional: ['it'] })),
    ).rejects.toThrow(/not-a-real-role/);
  });

  it('resolves the role and message from the environment', async () => {
    vi.stubEnv('FAB_ROLE', 'also-not-real');
    vi.stubEnv('FAB_MESSAGE', 'ship the thing');
    await expect(executeRoleSession(args())).rejects.toThrow(/also-not-real/);
  });
});
