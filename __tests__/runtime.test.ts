import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnthropicAgents } from '../src/api.js';
import type { AgentEvent, Session, UserEvent } from '../src/types.js';

// Mock the state module so the tests don't touch `.jaunty-state.json`
// (which would race with state.test.ts running in parallel).
vi.mock('../src/state.js', () => ({
  getAgentByRole: vi.fn(),
  getEnvironmentId: vi.fn(),
  getRepos: vi.fn(async () => []),
  getVaultIds: vi.fn(async () => []),
}));

import { getAgentByRole, getEnvironmentId, getRepos, getVaultIds } from '../src/state.js';
import { ManagedAgentsRuntime } from '../src/runtimes/managed-agents.js';

function fakeApi(overrides: Partial<AnthropicAgents> = {}): AnthropicAgents {
  return overrides as AnthropicAgents;
}

async function* yieldEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e;
}

const mockedGetAgentByRole = getAgentByRole as ReturnType<typeof vi.fn>;
const mockedGetEnvironmentId = getEnvironmentId as ReturnType<typeof vi.fn>;
const mockedGetRepos = getRepos as ReturnType<typeof vi.fn>;
const mockedGetVaultIds = getVaultIds as ReturnType<typeof vi.fn>;

describe('ManagedAgentsRuntime.runRoleSession', () => {
  beforeEach(() => {
    mockedGetAgentByRole.mockReset();
    mockedGetEnvironmentId.mockReset();
    mockedGetRepos.mockReset();
    mockedGetVaultIds.mockReset();
    mockedGetRepos.mockResolvedValue([]);
    mockedGetVaultIds.mockResolvedValue([]);
  });

  it('throws when the role has no deployed agent', async () => {
    mockedGetAgentByRole.mockResolvedValue(undefined);
    mockedGetEnvironmentId.mockResolvedValue('env_1');
    const runtime = new ManagedAgentsRuntime(fakeApi());
    await expect(runtime.runRoleSession('product', 'hello')).rejects.toThrow(/not deployed/);
  });

  it('throws when no environment is configured', async () => {
    mockedGetAgentByRole.mockResolvedValue({
      role: 'product',
      agentId: 'agent_1',
      version: 1,
      deployedAt: '2026-04-08',
    });
    mockedGetEnvironmentId.mockResolvedValue(null);
    const runtime = new ManagedAgentsRuntime(fakeApi());
    await expect(runtime.runRoleSession('product', 'hello')).rejects.toThrow(/No environment/);
  });

  it('creates the session, sends the message, and returns an AgentSession', async () => {
    mockedGetAgentByRole.mockResolvedValue({
      role: 'product',
      agentId: 'agent_p',
      version: 1,
      deployedAt: '2026-04-08',
    });
    mockedGetEnvironmentId.mockResolvedValue('env_xyz');

    const createSession = vi.fn(async () => ({ id: 'sess_001' }) as Session);
    const sendMessage = vi.fn(async () => undefined);
    const stream = vi.fn(() => yieldEvents([]));
    const api = fakeApi({ createSession, sendMessage, stream });

    const runtime = new ManagedAgentsRuntime(api);
    const session = await runtime.runRoleSession('product', 'do the thing', {
      title: 'feature-build: product',
    });

    expect(session.id).toBe('sess_001');
    expect(createSession).toHaveBeenCalledWith({
      agent: 'agent_p',
      environment_id: 'env_xyz',
      title: 'feature-build: product',
    });
    expect(sendMessage).toHaveBeenCalledWith('sess_001', 'do the thing');
  });

  it('attaches repos and vault ids from state by default', async () => {
    mockedGetAgentByRole.mockResolvedValue({
      role: 'product',
      agentId: 'agent_p',
      version: 1,
      deployedAt: '2026-04-08',
    });
    mockedGetEnvironmentId.mockResolvedValue('env_xyz');
    mockedGetRepos.mockResolvedValue([
      { type: 'github_repository', url: 'https://github.com/x/y', authorization_token: 'pat' },
    ]);
    mockedGetVaultIds.mockResolvedValue(['vault_a']);

    const createSession = vi.fn(async () => ({ id: 'sess_002' }) as Session);
    const api = fakeApi({
      createSession,
      sendMessage: vi.fn(async () => undefined),
      stream: vi.fn(() => yieldEvents([])),
    });

    const runtime = new ManagedAgentsRuntime(api);
    await runtime.runRoleSession('product', 'm');

    expect(createSession).toHaveBeenCalledWith({
      agent: 'agent_p',
      environment_id: 'env_xyz',
      resources: [{ type: 'github_repository', url: 'https://github.com/x/y', authorization_token: 'pat' }],
      vault_ids: ['vault_a'],
    });
  });

  it('options override state-derived repos and vaultIds', async () => {
    mockedGetAgentByRole.mockResolvedValue({
      role: 'product',
      agentId: 'agent_p',
      version: 1,
      deployedAt: '2026-04-08',
    });
    mockedGetEnvironmentId.mockResolvedValue('env_xyz');
    mockedGetRepos.mockResolvedValue([
      { type: 'github_repository', url: 'https://github.com/x/from-state', authorization_token: 'pat' },
    ]);
    mockedGetVaultIds.mockResolvedValue(['from-state-vault']);

    const createSession = vi.fn(async () => ({ id: 'sess_003' }) as Session);
    const api = fakeApi({
      createSession,
      sendMessage: vi.fn(async () => undefined),
      stream: vi.fn(() => yieldEvents([])),
    });

    const runtime = new ManagedAgentsRuntime(api);
    await runtime.runRoleSession('product', 'm', {
      resources: [{ type: 'github_repository', url: 'https://github.com/x/override', authorization_token: 'pat2' }],
      vaultIds: ['override-vault'],
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    const call: unknown[] = (createSession.mock.calls as unknown as unknown[][])[0]!;
    const arg = call[0] as {
      resources?: { url: string }[];
      vault_ids?: string[];
    };
    expect(arg.resources?.[0]?.url).toBe('https://github.com/x/override');
    expect(arg.vault_ids).toEqual(['override-vault']);
  });
});

describe('ManagedAgentSession', () => {
  beforeEach(() => {
    mockedGetAgentByRole.mockReset();
    mockedGetEnvironmentId.mockReset();
    mockedGetRepos.mockReset();
    mockedGetVaultIds.mockReset();
    mockedGetAgentByRole.mockResolvedValue({
      role: 'product',
      agentId: 'agent_p',
      version: 1,
      deployedAt: '2026-04-08',
    });
    mockedGetEnvironmentId.mockResolvedValue('env_xyz');
    mockedGetRepos.mockResolvedValue([]);
    mockedGetVaultIds.mockResolvedValue([]);
  });

  it('events delegates to api.stream', async () => {
    const events: AgentEvent[] = [{ id: 'e1', type: 'session.status_running', processed_at: '2026-04-08T00:00:00Z' }];
    const stream = vi.fn(() => yieldEvents(events));
    const api = fakeApi({
      createSession: vi.fn(async () => ({ id: 'sess_s' }) as Session),
      sendMessage: vi.fn(async () => undefined),
      stream,
    });

    const session = await new ManagedAgentsRuntime(api).runRoleSession('product', 'go');
    const out: AgentEvent[] = [];
    for await (const e of session.events) out.push(e);

    expect(stream).toHaveBeenCalledWith('sess_s');
    expect(out).toEqual(events);
  });

  it('sendInput routes user.message to api.sendMessage', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const api = fakeApi({
      createSession: vi.fn(async () => ({ id: 'sess_x' }) as Session),
      sendMessage,
      stream: vi.fn(() => yieldEvents([])),
    });
    const session = await new ManagedAgentsRuntime(api).runRoleSession('product', 'init');
    sendMessage.mockClear();

    await session.sendInput({
      type: 'user.message',
      content: [{ type: 'text', text: 'hi again' }],
    });

    expect(sendMessage).toHaveBeenCalledWith('sess_x', 'hi again');
  });

  it('sendInput routes user.tool_confirmation to api.confirmTool', async () => {
    const confirmTool = vi.fn(async () => undefined);
    const api = fakeApi({
      createSession: vi.fn(async () => ({ id: 'sess_x' }) as Session),
      sendMessage: vi.fn(async () => undefined),
      stream: vi.fn(() => yieldEvents([])),
      confirmTool,
    });
    const session = await new ManagedAgentsRuntime(api).runRoleSession('product', 'init');

    await session.sendInput({
      type: 'user.tool_confirmation',
      tool_use_id: 'tu_1',
      result: 'allow',
    });

    expect(confirmTool).toHaveBeenCalledWith('sess_x', 'tu_1', 'allow', undefined);
  });

  it('sendInput routes user.custom_tool_result to api.sendCustomToolResult', async () => {
    const sendCustomToolResult = vi.fn(async () => undefined);
    const api = fakeApi({
      createSession: vi.fn(async () => ({ id: 'sess_x' }) as Session),
      sendMessage: vi.fn(async () => undefined),
      stream: vi.fn(() => yieldEvents([])),
      sendCustomToolResult,
    });
    const session = await new ManagedAgentsRuntime(api).runRoleSession('product', 'init');

    await session.sendInput({
      type: 'user.custom_tool_result',
      custom_tool_use_id: 'ct_1',
      content: [{ type: 'text', text: 'result body' }],
    });

    expect(sendCustomToolResult).toHaveBeenCalledWith('sess_x', 'ct_1', 'result body', false);
  });

  it('sendInput routes user.interrupt to api.interrupt', async () => {
    const interrupt = vi.fn(async () => undefined);
    const api = fakeApi({
      createSession: vi.fn(async () => ({ id: 'sess_x' }) as Session),
      sendMessage: vi.fn(async () => undefined),
      stream: vi.fn(() => yieldEvents([])),
      interrupt,
    });
    const session = await new ManagedAgentsRuntime(api).runRoleSession('product', 'init');

    await session.sendInput({ type: 'user.interrupt' });

    expect(interrupt).toHaveBeenCalledWith('sess_x');
  });

  it('sendInput throws on an unhandled UserEvent shape', async () => {
    const api = fakeApi({
      createSession: vi.fn(async () => ({ id: 'sess_x' }) as Session),
      sendMessage: vi.fn(async () => undefined),
      stream: vi.fn(() => yieldEvents([])),
    });
    const session = await new ManagedAgentsRuntime(api).runRoleSession('product', 'init');

    // Force an event shape the switch's `default` branch will hit. Cast
    // through `unknown` because UserEvent is a closed union — but if a future
    // SDK version adds a new variant, we want a loud failure not silent
    // pass-through.
    const malformed = { type: 'user.unknown_future_event' } as unknown as UserEvent;
    await expect(session.sendInput(malformed)).rejects.toThrow(/unhandled UserEvent type/);
  });

  it('interrupt() delegates to api.interrupt', async () => {
    const interrupt = vi.fn(async () => undefined);
    const api = fakeApi({
      createSession: vi.fn(async () => ({ id: 'sess_x' }) as Session),
      sendMessage: vi.fn(async () => undefined),
      stream: vi.fn(() => yieldEvents([])),
      interrupt,
    });
    const session = await new ManagedAgentsRuntime(api).runRoleSession('product', 'init');

    await session.interrupt();

    expect(interrupt).toHaveBeenCalledWith('sess_x');
  });

  // satisfy unused-var lint on the imported type
  const _e: UserEvent | undefined = undefined;
  void _e;
});
