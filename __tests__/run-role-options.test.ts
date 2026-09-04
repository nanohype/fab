import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The in-cluster ServiceAccount token lives at a path Kubernetes fixes, so the
// k8s transport has no seam to point somewhere else. Only `readFileSync` is
// replaced, and only for that path: a Node builtin standing in for a mounted
// file, leaving every transport under observation the shipped one.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: (path: string, ...rest: unknown[]) =>
      String(path).endsWith('/serviceaccount/token')
        ? 'test-sa-token\n'
        : real.readFileSync(path, ...(rest as [])),
  };
});

// The sdk transport resolves the Agent SDK itself, so the package is where it
// meets the outside. A stand-in that answers `query` keeps the drive to fab's
// own code — the alternative is a real agent loop reaching for a subprocess and
// an API key, which measures the SDK rather than the transport.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {},
    async interrupt() {},
  }),
}));

const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
import {
  type AgentSession,
  RUN_ROLE_OPTION_SUPPORT,
  type RunRoleOptions,
  RUNTIME_NAMES,
  type RuntimeName,
} from '../src/runtime.js';
import { ManagedAgentsRuntime } from '../src/runtimes/managed-agents.js';
import { SdkAgentSession, SdkRuntime } from '../src/runtimes/sdk.js';
import { buildClaudeArgs } from '../src/runtimes/claude-cli.js';
import type { AnthropicAgents } from '../src/api.js';
import type { TeamRole, UserEvent } from '../src/types.js';
import { createRuntime, resolveRuntimeKind } from '../src/runtimes/index.js';

/** What `resolveRuntimeKind` returns for a given `FAB_RUNTIME` value. */
function resolveRuntimeKindFor(name: string): string {
  const prior = process.env.FAB_RUNTIME;
  process.env.FAB_RUNTIME = name;
  try {
    return resolveRuntimeKind();
  } finally {
    if (prior === undefined) delete process.env.FAB_RUNTIME;
    else process.env.FAB_RUNTIME = prior;
  }
}

// ── Which transports read which option ──────────────────────────────
//
// A field a transport does not honour is ignored in silence, so a caller who
// attaches repos to a transport that never reads them gets a session that looks
// configured and is not. That makes the support matrix part of the contract,
// and the reason it is data rather than a sentence in a doc comment is this
// file: prose drifts from the code with nothing to notice, and a map does not.

const FIELDS = Object.keys(RUN_ROLE_OPTION_SUPPORT) as (keyof RunRoleOptions)[];
// The coverage set is the tree's own list, not a copy of it. A transport added
// to RUNTIME_NAMES arrives here without anyone remembering to add it, which is
// the only way a set-versus-list check is a check.
const ALL = RUNTIME_NAMES;

/** Deployed in the fixture state, and a member of `TEAM` on every transport. */
const ROLE: TeamRole = 'pr-reviewer';

/**
 * Every field carrying a value, so a read guarded by the field's presence runs.
 *
 * `Required` rather than the interface itself: a field added to
 * `RunRoleOptions` and left without a value here does not compile, so the drive
 * cannot quietly stop covering it.
 */
const POPULATED: Required<RunRoleOptions> = {
  title: 'a title',
  resources: [
    { type: 'github_repository', url: 'https://github.com/o/r', authorization_token: 't' },
  ],
  vaultIds: ['vault-1'],
  metadata: { role: ROLE },
};

/**
 * A `RunRoleOptions` that records which of its fields are read.
 *
 * The reads are recorded at the object rather than inferred from the text that
 * performs them, so the spelling does not matter: `options.title`,
 * `options[field]`, a destructured binding, a spread, a rename, a helper one
 * module away and a helper five are the same event here. Every field is an own
 * property whatever the values, so a transport that enumerates or spreads the
 * object is recorded as reading all of them — which it does.
 */
function recordingOptions(values: Partial<RunRoleOptions>): {
  options: RunRoleOptions;
  reads: Set<string>;
} {
  const reads = new Set<string>();
  const target: Record<string, unknown> = {};
  for (const field of FIELDS) target[field] = values[field];
  const options = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'string' && (FIELDS as string[]).includes(prop)) reads.add(prop);
      return Reflect.get(t, prop, receiver);
    },
  }) as RunRoleOptions;
  return { options, reads };
}

type Teardown = () => void;

/** Set env vars for the duration of one drive, and put back what was there. */
function setEnv(vars: Record<string, string>): Teardown {
  const prior = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return () => {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * What each transport needs in place before it will start a session.
 *
 * Keyed by the transport list, so a transport the tree can resolve `FAB_RUNTIME`
 * to and this file has no way to drive is a compile error rather than a case
 * that quietly observes nothing. Each fixture stands in for the substrate the
 * transport talks to — an apiserver, a `claude` binary — and for nothing inside
 * fab: the transport under observation is the shipped one, reached through
 * `createRuntime`.
 */
const FIXTURE: Record<RuntimeName, (dir: string) => Teardown> = {
  'managed-agents': () => () => {},
  sdk: () => setEnv({ MCP_GATEWAY_TOKEN: 'gateway-token' }),
  'claude-cli': (dir) => {
    // A subprocess that outlives its spawn and ignores its arguments: the read
    // under observation happens while the command line is built, and what the
    // binary does with it belongs to `claude`.
    const stub = join(dir, 'claude-stub');
    writeFileSync(stub, '#!/usr/bin/env node\nprocess.stdin.resume();\n', { mode: 0o755 });
    return setEnv({ FAB_CLAUDE_PATH: stub, FAB_CLAUDE_MCP_DIR: dir });
  },
  'sdk-k8s': () => {
    const restore = setEnv({
      KUBERNETES_SERVICE_HOST: 'kube.test',
      KUBERNETES_SERVICE_PORT: '6443',
      FAB_K8S_NAMESPACE: 'eks-agent-platform',
      FAB_K8S_SESSION_IMAGE: 'ghcr.io/nanohype/fab:1.2.3',
      FAB_K8S_PLATFORM: 'acme',
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ metadata: { name: 'fab-pr-reviewer-abcde' } }),
    })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
      restore();
    };
  },
};

/** A session-creating API that records nothing and reaches no network. */
const stubApi = () =>
  ({
    createSession: async () => ({ id: 'sess-1' }),
    sendMessage: async () => {},
    interrupt: async () => {},
  }) as unknown as AnthropicAgents;

/**
 * Start a session on `name` with a recording options object, and report which
 * fields it read.
 *
 * The session is started rather than inspected, so a transport that cannot run
 * one throws here and the case fails. A gate that cannot reach its subject
 * reporting that the subject reads nothing is the one outcome that must not be
 * available to it.
 */
async function observeReads(
  name: RuntimeName,
  values: Partial<RunRoleOptions>,
  dir: string,
): Promise<Set<string>> {
  const teardown = FIXTURE[name](dir);
  const restore = setEnv({ FAB_RUNTIME: name, FAB_STATE_FILE: join(dir, 'state.json') });
  const { options, reads } = recordingOptions(values);
  let session: AgentSession | undefined;
  try {
    session = await createRuntime(stubApi()).runRoleSession(ROLE, 'go', options);
    return reads;
  } finally {
    if (session) await session.interrupt();
    restore();
    teardown();
  }
}

describe('the support matrix is well formed', () => {
  it('covers every option field and names only real transports', () => {
    expect(FIELDS.sort()).toEqual(['metadata', 'resources', 'title', 'vaultIds']);
    for (const [field, names] of Object.entries(RUN_ROLE_OPTION_SUPPORT)) {
      expect(names.length, `${field} is honoured by no transport`).toBeGreaterThan(0);
      for (const n of names) expect(ALL).toContain(n);
    }
  });

  it('covers every transport the tree resolves FAB_RUNTIME to', () => {
    // The set this is checked against is the one `resolveRuntimeKind` accepts,
    // so a transport the tree can run and the matrix does not describe fails
    // here rather than passing unexamined.
    for (const name of RUNTIME_NAMES) {
      expect(resolveRuntimeKindFor(name), `${name} is not resolvable`).toBe(name);
      expect(Object.keys(FIXTURE)).toContain(name);
    }
  });
});

describe('the matrix matches what each transport reads', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fab-reads-'));
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        agents: [{ role: ROLE, agentId: 'agent-1' }],
        environmentId: 'env-1',
        repos: [],
        skills: [],
        memory: { enabled: false, storeId: null },
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Observed, not resolved from the source. The matrix is a claim about
  // behaviour — a field this transport does not read is a field a caller can
  // set and never see honoured — so each transport is run and the reads are
  // watched as they happen. That makes attribution execution rather than
  // reachability: a field read inside a shared helper belongs to the transports
  // that run it, not to every transport that can import it.
  //
  // What the drive does not see is a read on a branch it does not take. Every
  // read site in the tree branches on whether the field carries a value, so
  // each transport is driven twice — once with all four fields populated, once
  // with all four present and empty — and the two observations are unioned.
  it.each(ALL)('%s reads exactly the fields the matrix gives it', async (name) => {
    const expected = FIELDS.filter((f) => RUN_ROLE_OPTION_SUPPORT[f].includes(name)).sort();
    const observed = new Set<string>();
    for (const values of [POPULATED, {}]) {
      for (const field of await observeReads(name, values, dir)) observed.add(field);
    }
    expect([...observed].sort()).toEqual(expected);
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
