import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, buildMcpConfigJson } from '../src/runtimes/claude-cli.js';

describe('buildClaudeArgs', () => {
  const baseEnv = {} as NodeJS.ProcessEnv;

  it('emits the canonical flag set for a fresh session', () => {
    const args = buildClaudeArgs({
      sessionId: '00000000-0000-4000-8000-000000000001',
      systemPrompt: 'role prompt',
      model: 'claude-sonnet-4-6',
      mcpConfigPath: '/tmp/mcp-1.json',
      bare: false,
      addDir: null,
      resumeFrom: null,
      title: undefined,
      env: baseEnv,
    });

    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--input-format');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('00000000-0000-4000-8000-000000000001');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('role prompt');
    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp-1.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--setting-sources');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--add-dir');
  });

  it('adds --bare and drops --setting-sources when bare mode is on', () => {
    const args = buildClaudeArgs({
      sessionId: '00000000-0000-4000-8000-000000000002',
      systemPrompt: 'role prompt',
      model: 'claude-sonnet-4-6',
      mcpConfigPath: null,
      bare: true,
      addDir: null,
      resumeFrom: null,
      title: undefined,
      env: baseEnv,
    });

    expect(args).toContain('--bare');
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--mcp-config');
  });

  it('switches --session-id for --resume when resuming', () => {
    const args = buildClaudeArgs({
      sessionId: 'ignored-during-resume',
      systemPrompt: null,
      model: null,
      mcpConfigPath: null,
      bare: false,
      addDir: null,
      resumeFrom: '00000000-0000-4000-8000-000000000003',
      title: undefined,
      env: baseEnv,
    });

    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('00000000-0000-4000-8000-000000000003');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--no-session-persistence');
    // Model + system-prompt omitted when null — resume inherits the original
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('adds --add-dir for repo-mounted workflows', () => {
    const args = buildClaudeArgs({
      sessionId: 'sess',
      systemPrompt: 'p',
      model: 'm',
      mcpConfigPath: null,
      bare: false,
      addDir: '/workspace/marshal',
      resumeFrom: null,
      title: undefined,
      env: baseEnv,
    });

    expect(args).toContain('--add-dir');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/workspace/marshal');
  });

  it('appends JAUNTY_CLAUDE_EXTRA_ARGS verbatim', () => {
    const args = buildClaudeArgs({
      sessionId: 'sess',
      systemPrompt: 'p',
      model: 'm',
      mcpConfigPath: null,
      bare: false,
      addDir: null,
      resumeFrom: null,
      title: undefined,
      env: { JAUNTY_CLAUDE_EXTRA_ARGS: '--debug api --effort high' } as NodeJS.ProcessEnv,
    });

    expect(args).toContain('--debug');
    expect(args).toContain('api');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
  });

  it('passes --name when title supplied', () => {
    const args = buildClaudeArgs({
      sessionId: 'sess',
      systemPrompt: 'p',
      model: 'm',
      mcpConfigPath: null,
      bare: false,
      addDir: null,
      resumeFrom: null,
      title: 'feature-build: product',
      env: baseEnv,
    });

    expect(args).toContain('--name');
    expect(args[args.indexOf('--name') + 1]).toBe('feature-build: product');
  });
});

describe('buildMcpConfigJson', () => {
  it('returns null when no servers requested', () => {
    expect(buildMcpConfigJson([], {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('renders third-party servers without auth headers', () => {
    const json = buildMcpConfigJson(['github'], {} as NodeJS.ProcessEnv);
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.mcpServers.github.type).toBe('http');
    expect(config.mcpServers.github.url).toMatch(/githubcopilot\.com/);
    expect(config.mcpServers.github.headers).toBeUndefined();
  });

  it('injects gateway bearer for gateway-routed servers', () => {
    // memory is one of the GATEWAY_HOSTED servers — auth header must
    // attach regardless of the resolved URL.
    const json = buildMcpConfigJson(['memory'], {
      MCP_GATEWAY_TOKEN: 'secret-token-abc',
    } as NodeJS.ProcessEnv);

    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.mcpServers.memory.type).toBe('http');
    expect(config.mcpServers.memory.url).toBeTypeOf('string');
    expect(config.mcpServers.memory.headers.Authorization).toBe('Bearer secret-token-abc');
  });

  it('drops gateway server with stderr warning when token is missing (default lenient)', () => {
    const stderrCalls: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCalls.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const json = buildMcpConfigJson(['memory'], {} as NodeJS.ProcessEnv);
      // memory is the only requested server and it got dropped — json is null
      expect(json).toBeNull();
      expect(stderrCalls.join('')).toMatch(/MCP_GATEWAY_TOKEN not set/);
      expect(stderrCalls.join('')).toMatch(/memory/);
    } finally {
      process.stderr.write = orig;
    }
  });

  it('keeps non-gateway servers when gateway servers are dropped', () => {
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const json = buildMcpConfigJson(['github', 'memory'], {} as NodeJS.ProcessEnv);
      expect(json).not.toBeNull();
      const config = JSON.parse(json!);
      expect(Object.keys(config.mcpServers)).toEqual(['github']);
    } finally {
      process.stderr.write = orig;
    }
  });

  it('throws under JAUNTY_MCP_STRICT=1 when gateway server is missing token', () => {
    expect(() =>
      buildMcpConfigJson(['memory'], {
        JAUNTY_MCP_STRICT: '1',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MCP_GATEWAY_TOKEN is not set/);
  });

  it('renders multiple mixed servers in one config', () => {
    const json = buildMcpConfigJson(['github', 'linear', 'notion'], {} as NodeJS.ProcessEnv);
    const config = JSON.parse(json!);
    expect(Object.keys(config.mcpServers).sort()).toEqual(['github', 'linear', 'notion']);
    expect(config.mcpServers.github.headers).toBeUndefined();
    expect(config.mcpServers.linear.headers).toBeUndefined();
    expect(config.mcpServers.notion.headers).toBeUndefined();
  });

  it('skips unknown server names without throwing', () => {
    const json = buildMcpConfigJson(['github', 'does-not-exist'], {} as NodeJS.ProcessEnv);
    const config = JSON.parse(json!);
    expect(Object.keys(config.mcpServers)).toEqual(['github']);
  });
});
