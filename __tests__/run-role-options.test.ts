import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_ROLE_OPTION_SUPPORT, type RunRoleOptions, type RuntimeName } from '../src/runtime.js';
import { ManagedAgentsRuntime } from '../src/runtimes/managed-agents.js';
import { SdkAgentSession, SdkRuntime } from '../src/runtimes/sdk.js';
import { buildClaudeArgs } from '../src/runtimes/claude-cli.js';
import type { AnthropicAgents } from '../src/api.js';
import type { UserEvent } from '../src/types.js';

// ── Which transports read which option ──────────────────────────────
//
// A field a transport does not honour is ignored in silence, so a caller who
// attaches repos to a transport that never reads them gets a session that looks
// configured and is not. That makes the support matrix part of the contract,
// and the reason it is data rather than a sentence in a doc comment is this
// file: prose drifts from the code with nothing to notice, and a map does not.

const FIELDS = Object.keys(RUN_ROLE_OPTION_SUPPORT) as (keyof RunRoleOptions)[];
const ALL: readonly RuntimeName[] = ['managed-agents', 'sdk', 'sdk-k8s', 'claude-cli'];

const MODULE_OF: Record<RuntimeName, string> = {
  'managed-agents': 'src/runtimes/managed-agents.ts',
  sdk: 'src/runtimes/sdk.ts',
  'sdk-k8s': 'src/runtimes/sdk-k8s.ts',
  'claude-cli': 'src/runtimes/claude-cli.ts',
};

const sourceOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf-8');

/** Source with comments removed, so a mention in prose is not read as a use. */
function code(rel: string): string {
  return sourceOf(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('the support matrix is well formed', () => {
  it('covers every option field and names only real transports', () => {
    expect(FIELDS.sort()).toEqual(['metadata', 'resources', 'title', 'vaultIds']);
    for (const [field, names] of Object.entries(RUN_ROLE_OPTION_SUPPORT)) {
      expect(names.length, `${field} is honoured by no transport`).toBeGreaterThan(0);
      for (const n of names) expect(ALL).toContain(n);
    }
  });
});

describe('a transport the matrix omits does not read the field', () => {
  // The claim is about the module, so the module is what is read. Driving
  // sdk-k8s would need a cluster and claude-cli a subprocess; what those two
  // do with a field they never name is settled without either.
  it.each(
    FIELDS.flatMap((field) =>
      ALL.filter((n) => !RUN_ROLE_OPTION_SUPPORT[field].includes(n)).map(
        (name) => [field, name] as const,
      ),
    ),
  )('%s is absent from the %s transport', (field, name) => {
    expect(code(MODULE_OF[name])).not.toContain(`options?.${field}`);
    expect(code(MODULE_OF[name])).not.toContain(`options.${field}`);
  });
});

describe('a transport the matrix lists does read the field', () => {
  // Without this the matrix is checkable in one direction only: adding a
  // transport to a field it ignores would remove the case that would have
  // caught it, and the map could claim support nothing provides.
  it.each(
    FIELDS.flatMap((field) => RUN_ROLE_OPTION_SUPPORT[field].map((name) => [field, name] as const)),
  )('%s is read by the %s transport', (field, name) => {
    const src = code(MODULE_OF[name]);
    expect(src.includes(`options?.${field}`) || src.includes(`options.${field}`)).toBe(true);
  });
});

describe('managed-agents honours title, resources and vaultIds', () => {
  let created: Record<string, unknown>[] = [];
  let prior: string | undefined;

  beforeEach(() => {
    created = [];
    prior = process.env.FAB_STATE_FILE;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.FAB_STATE_FILE;
    else process.env.FAB_STATE_FILE = prior;
  });

  const api = () =>
    ({
      createSession: async (body: Record<string, unknown>) => {
        created.push(body);
        return { id: 'sess-1' };
      },
      sendMessage: async () => {},
    }) as unknown as AnthropicAgents;

  it('passes them to session creation, and passes metadata to nothing', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'fab-opts-'));
    process.env.FAB_STATE_FILE = join(dir, 'state.json');
    writeFileSync(
      process.env.FAB_STATE_FILE,
      JSON.stringify({
        agents: [{ role: 'pr-reviewer', agentId: 'agent-1' }],
        environmentId: 'env-1',
        repos: [],
        skills: [],
        memory: { enabled: false, storeId: null },
      }),
    );
    try {
      await new ManagedAgentsRuntime(api()).runRoleSession('pr-reviewer', 'go', {
        title: 'a title',
        resources: [
          { type: 'github_repository', url: 'https://github.com/o/r', authorization_token: 't' },
        ],
        vaultIds: ['vault-1'],
        metadata: { role: 'pr-reviewer' },
      });
      const body = created[0]!;
      expect(body.title).toBe('a title');
      expect(body.resources).toHaveLength(1);
      expect(body.vault_ids).toEqual(['vault-1']);
      // Declared on the interface, read by this transport nowhere.
      expect(body).not.toHaveProperty('metadata');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a shape it has no helper for, rather than reporting a delivery', async () => {
    let calls = 0;
    const recording = {
      sendMessage: async () => {
        calls += 1;
      },
    } as unknown as AnthropicAgents;
    const session = new ManagedAgentsRuntime(recording).resumeSession('sess-1');
    await expect(
      session.sendInput({ type: 'user.unknown_shape' } as unknown as UserEvent),
    ).rejects.toThrow(/unhandled UserEvent type/);
    expect(calls).toBe(0);
  });
});

describe('the sdk transport honours metadata and mounts nothing', () => {
  it('carries metadata into the query and no workspace keys', async () => {
    let seen: Record<string, unknown> | undefined;
    const sdk = {
      query(params: { options?: Record<string, unknown> }) {
        seen = params.options;
        return {
          async *[Symbol.asyncIterator]() {},
          async interrupt() {},
        };
      },
    };
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt', {
      title: 'ignored here',
      resources: [
        { type: 'github_repository', url: 'https://github.com/o/r', authorization_token: 't' },
      ],
      metadata: { role: 'pr-reviewer' },
    });
    await session.start('go');
    expect(seen?.metadata).toEqual({ role: 'pr-reviewer' });
    // The transport runs against the caller's working directory; there is
    // nothing for repo resources to be mounted into.
    for (const key of ['cwd', 'addDir', 'additionalDirectories', 'resources']) {
      expect(seen).not.toHaveProperty(key);
    }
  });

  it('refuses to reattach, visibly', async () => {
    const resumed = new SdkRuntime().resumeSession('sess-abc');
    expect(resumed.id).toBe('sess-abc');
    const streamed = [];
    for await (const e of resumed.events) streamed.push(e);
    // An empty stream a caller could read as an idle session is the outcome
    // this refusal exists to avoid, so it must also throw on input.
    expect(streamed).toEqual([]);
    await expect(
      resumed.sendInput({ type: 'user.message', content: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrow(/not supported/);
  });
});

describe('the claude-cli transport honours title', () => {
  it('puts it on the command line', () => {
    const args = buildClaudeArgs({
      sessionId: 's',
      systemPrompt: 'p',
      model: 'claude-sonnet-5',
      mcpConfigPath: null,
      bare: false,
      addDir: null,
      resumeFrom: null,
      title: 'a title',
      effort: null,
      env: {},
    });
    expect(args.join(' ')).toContain('a title');
  });
});
