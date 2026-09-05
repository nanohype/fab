import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiClient, MissingApiKeyError, runtimeClient } from '../src/client.js';
import { RUNTIME_NAMES } from '../src/runtime.js';

// ── What a missing key costs, and where ─────────────────────────────
//
// A command that reaches the Managed Agents API is a managed-agents operation
// on every transport, so a missing key stops it on every transport and says the
// same thing each time. The transport is not the discriminator: refusing on it
// would send an operator to change a variable that was never the problem, and
// would refuse a run whose credential was there all along and whose
// `FAB_RUNTIME` was left over from something else.
//
// The exception is the client the workflow path carries into `createRuntime`,
// which the runtimes away from the default never call. A key is required where
// it would be spent.

const OTHERS = RUNTIME_NAMES.filter((n) => n !== 'managed-agents');

describe('a client for a caller that will use it', () => {
  let priorKey: string | undefined;
  let priorRuntime: string | undefined;

  beforeEach(() => {
    priorKey = process.env.ANTHROPIC_API_KEY;
    priorRuntime = process.env.FAB_RUNTIME;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FAB_RUNTIME;
  });
  afterEach(() => {
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
    if (priorRuntime === undefined) delete process.env.FAB_RUNTIME;
    else process.env.FAB_RUNTIME = priorRuntime;
  });

  it.each(RUNTIME_NAMES)('refuses without a key under %s', (name) => {
    process.env.FAB_RUNTIME = name;
    expect(() => apiClient(), `${name} built a client with no key`).toThrow(MissingApiKeyError);
  });

  it.each(RUNTIME_NAMES)('builds one with a key under %s', (name) => {
    process.env.FAB_RUNTIME = name;
    process.env.ANTHROPIC_API_KEY = 'sk-fake';
    expect(apiClient()).toBeDefined();
  });

  it('refuses in the words an operator reads', () => {
    // `main` prints the message of whatever reaches it, so this string is the
    // whole of what an operator is told, on every transport.
    expect(() => apiClient()).toThrow('ANTHROPIC_API_KEY is not set');
  });

  it('says nothing about the transport, which is not why it refused', () => {
    process.env.FAB_RUNTIME = 'sdk';
    try {
      apiClient();
      expect.unreachable('a client was built with no key');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/FAB_RUNTIME|sdk|transport|runtime/i);
    }
  });
});

describe('the client the workflow path carries', () => {
  let priorKey: string | undefined;
  let priorRuntime: string | undefined;

  beforeEach(() => {
    priorKey = process.env.ANTHROPIC_API_KEY;
    priorRuntime = process.env.FAB_RUNTIME;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FAB_RUNTIME;
  });
  afterEach(() => {
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
    if (priorRuntime === undefined) delete process.env.FAB_RUNTIME;
    else process.env.FAB_RUNTIME = priorRuntime;
  });

  it.each(OTHERS)('%s: builds without a key, because the runtime never calls it', (name) => {
    process.env.FAB_RUNTIME = name;
    expect(runtimeClient()).toBeDefined();
  });

  it('the default transport: refuses, because there the runtime is the API', () => {
    process.env.FAB_RUNTIME = 'managed-agents';
    expect(() => runtimeClient()).toThrow(MissingApiKeyError);
  });
});
