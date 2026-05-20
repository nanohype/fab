import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createRuntime,
  resolveRuntimeKind,
  ClaudeCliRuntime,
  LocalRuntime,
  ManagedAgentsRuntime,
} from '../src/runtimes/index.js';

describe('runtime factory', () => {
  const ORIGINAL = process.env.JAUNTY_RUNTIME;

  beforeEach(() => {
    delete process.env.JAUNTY_RUNTIME;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.JAUNTY_RUNTIME;
    } else {
      process.env.JAUNTY_RUNTIME = ORIGINAL;
    }
  });

  it('defaults to managed-agents when JAUNTY_RUNTIME is unset', () => {
    expect(resolveRuntimeKind()).toBe('managed-agents');
  });

  it('honors JAUNTY_RUNTIME=local', () => {
    process.env.JAUNTY_RUNTIME = 'local';
    expect(resolveRuntimeKind()).toBe('local');
  });

  it('honors JAUNTY_RUNTIME=managed-agents explicitly', () => {
    process.env.JAUNTY_RUNTIME = 'managed-agents';
    expect(resolveRuntimeKind()).toBe('managed-agents');
  });

  it('honors JAUNTY_RUNTIME=claude-cli', () => {
    process.env.JAUNTY_RUNTIME = 'claude-cli';
    expect(resolveRuntimeKind()).toBe('claude-cli');
  });

  it('errors loudly on unknown JAUNTY_RUNTIME values', () => {
    process.env.JAUNTY_RUNTIME = 'something-else';
    expect(() => resolveRuntimeKind()).toThrow(/Unknown JAUNTY_RUNTIME/);
  });

  it('createRuntime returns a ManagedAgentsRuntime by default', () => {
    const stubApi = {} as unknown as Parameters<typeof createRuntime>[0];
    const rt = createRuntime(stubApi);
    expect(rt).toBeInstanceOf(ManagedAgentsRuntime);
  });

  it('createRuntime returns a LocalRuntime when configured', () => {
    process.env.JAUNTY_RUNTIME = 'local';
    const stubApi = {} as unknown as Parameters<typeof createRuntime>[0];
    const rt = createRuntime(stubApi);
    expect(rt).toBeInstanceOf(LocalRuntime);
  });

  it('createRuntime returns a ClaudeCliRuntime when configured', () => {
    process.env.JAUNTY_RUNTIME = 'claude-cli';
    const stubApi = {} as unknown as Parameters<typeof createRuntime>[0];
    const rt = createRuntime(stubApi);
    expect(rt).toBeInstanceOf(ClaudeCliRuntime);
  });
});
