import { describe, it, expect } from 'vitest';
import {
  buildSdkQueryOptions,
  SdkAgentSession,
  ResumedSdkAgentSession,
  SdkRuntime,
  _buildSdkSystemPrompt,
} from '../src/runtimes/sdk.js';
import { loadState } from '../src/state.js';
import type { AgentEvent, UserEvent } from '../src/types.js';

// No module-level mock of @anthropic-ai/claude-agent-sdk. SdkAgentSession takes
// the SDK module as a constructor argument, so a fake is injected the way the
// production code already allows — mocking the package would assert against a
// seam the runtime does not actually use.

/** Minimal stand-in for the Agent SDK: replays messages, records the query call. */
function fakeSdk(messages: unknown[] = []) {
  const calls: { prompt: unknown; options?: Record<string, unknown> }[] = [];
  let interrupted = 0;
  return {
    calls,
    interrupts: () => interrupted,
    query(params: { prompt: unknown; options?: Record<string, unknown> }) {
      calls.push(params);
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
        },
        async interrupt() {
          interrupted += 1;
        },
      };
    },
  };
}

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-42' };
const RESULT = { type: 'result', subtype: 'success', session_id: 'sess-42', result: 'done' };

async function collect(session: SdkAgentSession): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of session.events) out.push(e);
  return out;
}

describe('buildSdkQueryOptions', () => {
  const base = { model: 'claude-sonnet-5', systemPrompt: 'role prompt' };

  it('always sets model, systemPrompt and bypassPermissions', () => {
    expect(buildSdkQueryOptions(base)).toEqual({
      model: 'claude-sonnet-5',
      systemPrompt: 'role prompt',
      permissionMode: 'bypassPermissions',
    });
  });

  it('omits every optional key rather than setting it undefined', () => {
    // An explicit `undefined` is not the same as an absent key to the SDK.
    const keys = Object.keys(buildSdkQueryOptions(base));
    for (const k of [
      'maxBudgetUsd',
      'mcpServers',
      'strictMcpConfig',
      'effort',
      'env',
      'metadata',
    ]) {
      expect(keys).not.toContain(k);
    }
  });

  it('sets maxBudgetUsd when a budget is configured, including zero', () => {
    expect(buildSdkQueryOptions({ ...base, budgetUsd: 12.5 }).maxBudgetUsd).toBe(12.5);
    // 0 is a real cap (spend nothing), not "unset" — a falsy check would drop it.
    expect(buildSdkQueryOptions({ ...base, budgetUsd: 0 }).maxBudgetUsd).toBe(0);
    expect(buildSdkQueryOptions({ ...base, budgetUsd: null })).not.toHaveProperty('maxBudgetUsd');
  });

  it('pairs mcpServers with strictMcpConfig, and sends neither when empty', () => {
    const servers = { github: { type: 'http' as const, url: 'https://mcp.example/github' } };
    const withServers = buildSdkQueryOptions({ ...base, mcpServers: servers });
    expect(withServers.mcpServers).toEqual(servers);
    // Scoping matters: without strictMcpConfig the SDK also loads the user's
    // ambient ~/.claude config, so a role would gain tools fab never granted.
    expect(withServers.strictMcpConfig).toBe(true);

    const none = buildSdkQueryOptions({ ...base, mcpServers: {} });
    expect(none).not.toHaveProperty('mcpServers');
    expect(none).not.toHaveProperty('strictMcpConfig');
  });

  it('overlays the backend env on process.env without dropping it', () => {
    const opts = buildSdkQueryOptions({ ...base, backendEnv: { CLAUDE_CODE_USE_BEDROCK: '1' } });
    const env = opts.env as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
    expect(buildSdkQueryOptions({ ...base, backendEnv: null })).not.toHaveProperty('env');
  });

  it('passes effort and metadata straight through', () => {
    expect(buildSdkQueryOptions({ ...base, effort: 'high' }).effort).toBe('high');
    expect(buildSdkQueryOptions({ ...base, metadata: { run: 'r1' } }).metadata).toEqual({
      run: 'r1',
    });
  });
});

describe('SdkAgentSession', () => {
  it('reports a placeholder id until the SDK reports the real one', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('go');
    expect(session.id).toBe('sdk-session-pending');
    await collect(session);
    expect(session.id).toBe('sess-42');
  });

  it('seeds the initial message as the first item on the input stream', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('the brief');
    const prompt = sdk.calls[0].prompt as AsyncIterable<unknown>;
    const first = await prompt[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'the brief' },
    });
  });

  it('delivers a message queued before the consumer asks for it', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('first');
    await session.sendInput({
      type: 'user.message',
      content: [{ type: 'text', text: 'second' }],
    } as UserEvent);
    const it = (sdk.calls[0].prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ message: { content: 'first' } });
    expect((await it.next()).value).toMatchObject({ message: { content: 'second' } });
  });

  it('hands a message to a consumer that is already waiting', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('first');
    const it = (sdk.calls[0].prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    await it.next(); // drain the seed so the next call parks
    const pending = it.next(); // no input yet — this waits
    await session.sendInput({
      type: 'user.message',
      content: [{ type: 'text', text: 'late' }],
    } as UserEvent);
    expect((await pending).value).toMatchObject({ message: { content: 'late' } });
  });

  it('closes the input stream once a terminal event is translated', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('go');
    await collect(session);
    // The SDK subprocess only shuts down when its input iterable completes.
    const it = (sdk.calls[0].prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    await it.next();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it('refuses input after close rather than dropping it silently', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('go');
    await collect(session);
    await expect(
      session.sendInput({
        type: 'user.message',
        content: [{ type: 'text', text: 'too late' }],
      } as UserEvent),
    ).rejects.toThrow(/cannot send input after the session is closed/);
  });

  it('interrupts the query and closes input', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('go');
    await session.sendInput({ type: 'user.interrupt' } as UserEvent);
    expect(sdk.interrupts()).toBe(1);
    await expect(
      session.sendInput({
        type: 'user.message',
        content: [{ type: 'text', text: 'x' }],
      } as UserEvent),
    ).rejects.toThrow();
  });

  it('accepts tool-confirmation events as no-ops', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('go');
    // The SDK resolves these internally via permission hooks; the contract is
    // that they neither throw nor reach the input stream.
    await session.sendInput({ type: 'user.tool_confirmation' } as UserEvent);
    await session.sendInput({ type: 'user.custom_tool_result' } as UserEvent);
    expect(sdk.interrupts()).toBe(0);
  });

  it('throws on an unknown UserEvent type', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('go');
    await expect(session.sendInput({ type: 'user.nope' } as unknown as UserEvent)).rejects.toThrow(
      /unhandled UserEvent type "user.nope"/,
    );
  });

  it('throws when events are read before start', async () => {
    const session = new SdkAgentSession(fakeSdk(), 'claude-sonnet-5', 'prompt');
    await expect(collect(session)).rejects.toThrow(/has not been started/);
  });

  it('drops untranslatable SDK messages instead of emitting empties', async () => {
    const sdk = fakeSdk([INIT, { type: 'totally_unknown' }, RESULT]);
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('go');
    const events = await collect(session);
    expect(events.every((e) => typeof e.type === 'string' && e.type.length > 0)).toBe(true);
  });

  it('passes the built options through to query()', async () => {
    const sdk = fakeSdk([INIT, RESULT]);
    const session = new SdkAgentSession(
      sdk,
      'claude-opus-5',
      'sys',
      undefined,
      'api',
      5,
      {},
      'low',
    );
    await session.start('go');
    expect(sdk.calls[0].options).toMatchObject({
      model: 'claude-opus-5',
      systemPrompt: 'sys',
      permissionMode: 'bypassPermissions',
      maxBudgetUsd: 5,
      effort: 'low',
    });
  });
});

describe('ResumedSdkAgentSession', () => {
  it('keeps the id it was asked for', () => {
    expect(new ResumedSdkAgentSession('sess-9').id).toBe('sess-9');
  });

  it('streams nothing', async () => {
    const seen: AgentEvent[] = [];
    for await (const e of new ResumedSdkAgentSession('sess-9').events) seen.push(e);
    expect(seen).toEqual([]);
  });

  it('fails loudly on input rather than silently accepting it', async () => {
    // The point of the stand-in: an empty stream alone would read as an idle
    // session, so the refusal has to surface somewhere.
    await expect(
      new ResumedSdkAgentSession('sess-9').sendInput({
        type: 'user.message',
        content: [{ type: 'text', text: 'hi' }],
      } as UserEvent),
    ).rejects.toThrow(/resuming an existing session by id is not supported/);
  });

  it('interrupts without throwing', async () => {
    await expect(new ResumedSdkAgentSession('sess-9').interrupt()).resolves.toBeUndefined();
  });
});

describe('SdkRuntime', () => {
  it('rejects an unknown role before touching the SDK', async () => {
    await expect(new SdkRuntime().runRoleSession('not-a-role' as never, 'hi')).rejects.toThrow(
      /Unknown role: "not-a-role"/,
    );
  });

  it('resumeSession hands back the refusing stand-in', () => {
    const resumed = new SdkRuntime().resumeSession('sess-3');
    expect(resumed.id).toBe('sess-3');
    expect(resumed).toBeInstanceOf(ResumedSdkAgentSession);
  });

  it('_buildSdkSystemPrompt resolves a real role and rejects an unknown one', async () => {
    const state = await loadState();
    expect(_buildSdkSystemPrompt('product', state).length).toBeGreaterThan(0);
    expect(() => _buildSdkSystemPrompt('nope' as never, state)).toThrow(/Unknown role/);
  });
});
