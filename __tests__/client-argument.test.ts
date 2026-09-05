import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/runtimes/index.js';
import { RUNTIME_NAMES, type RuntimeName } from '../src/runtime.js';
import type { AnthropicAgents } from '../src/api.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {},
    async interrupt() {},
  }),
}));

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

// ── What the client argument is for, away from the default transport ──
//
// `createRuntime(api)` takes the same argument whichever transport resolves, so
// the CLI hands every command one client and lets a placeholder stand in where
// no key is set. That is only safe while the runtimes other than the default
// leave it alone: one of them reaching for it would turn a placeholder into an
// authentication failure in the middle of a workflow that has no business
// calling the REST API.
//
// The population is the transport list less the default, so a transport added
// to the tree is covered without being added here.

const OTHERS = RUNTIME_NAMES.filter((n) => n !== 'managed-agents') as RuntimeName[];

/** A client that reports any use of itself, rather than answering. */
function unusableClient(used: string[]): AnthropicAgents {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        const name = String(prop);
        if (name === 'then') return undefined;
        used.push(name);
        return () => {
          throw new Error(`the client was invoked: ${name}`);
        };
      },
    },
  ) as unknown as AnthropicAgents;
}

type Teardown = () => void;

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

const FIXTURE: Record<string, (dir: string) => Teardown> = {
  sdk: () => setEnv({ MCP_GATEWAY_TOKEN: 'gateway-token' }),
  'claude-cli': (dir) => {
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

describe('the client a workflow hands a transport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fab-client-'));
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        agents: [{ role: 'pr-reviewer', agentId: 'agent-1' }],
        environmentId: 'env-1',
        repos: [],
        skills: [],
        memory: { enabled: false, storeId: null },
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(OTHERS)(
    '%s starts a session without touching it',
    async (name) => {
      // Every transport here has a fixture, so one added to the tree without one
      // fails on the lookup rather than passing for having been skipped.
      const fixture = FIXTURE[name];
      expect(fixture, `${name} has no way to be driven here`).toBeDefined();
      const teardown = fixture(dir);
      const restore = setEnv({ FAB_RUNTIME: name, FAB_STATE_FILE: join(dir, 'state.json') });
      const used: string[] = [];
      try {
        const session = await createRuntime(unusableClient(used)).runRoleSession(
          'pr-reviewer',
          'go',
        );
        await session.interrupt();
      } finally {
        restore();
        teardown();
      }
      expect(used, `${name} reached for the client`).toEqual([]);
    },
    30_000,
  );
});
