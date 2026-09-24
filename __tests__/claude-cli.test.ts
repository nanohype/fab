import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  ClaudeCliRuntime,
  _buildClaudeCliSystemPrompt,
  buildClaudeArgs,
  buildMcpConfigJson,
} from '../src/runtimes/claude-cli.js';
import { loadState } from '../src/state.js';
import type { FabState } from '../src/types.js';

describe('buildClaudeArgs', () => {
  const baseEnv = {} as NodeJS.ProcessEnv;

  it('emits the canonical flag set for a fresh session', () => {
    const args = buildClaudeArgs({
      sessionId: '00000000-0000-4000-8000-000000000001',
      systemPromptFile: '/tmp/fab-prompt-1.md',
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
    expect(args).toContain('--append-system-prompt-file');
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('/tmp/fab-prompt-1.md');
    expect(args).not.toContain('--append-system-prompt');
    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp-1.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--setting-sources');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--effort'); // unset by default
  });

  it('adds --effort when a role sets an effort level', () => {
    const args = buildClaudeArgs({
      sessionId: '00000000-0000-4000-8000-000000000002',
      systemPromptFile: '/tmp/fab-prompt-1.md',
      model: 'claude-sonnet-4-6',
      mcpConfigPath: null,
      bare: false,
      addDir: null,
      resumeFrom: null,
      title: undefined,
      effort: 'high',
      env: baseEnv,
    });
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort when effort is unset', () => {
    const args = buildClaudeArgs({
      sessionId: '00000000-0000-4000-8000-000000000003',
      systemPromptFile: '/tmp/fab-prompt-1.md',
      model: 'claude-sonnet-4-6',
      mcpConfigPath: null,
      bare: false,
      addDir: null,
      resumeFrom: null,
      title: undefined,
      env: baseEnv,
    });
    expect(args).not.toContain('--effort');
  });

  it('adds --bare and drops --setting-sources when bare mode is on', () => {
    const args = buildClaudeArgs({
      sessionId: '00000000-0000-4000-8000-000000000002',
      systemPromptFile: '/tmp/fab-prompt-1.md',
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
      systemPromptFile: null,
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
    expect(args).not.toContain('--append-system-prompt-file');
  });

  it('adds --add-dir for repo-mounted workflows', () => {
    const args = buildClaudeArgs({
      sessionId: 'sess',
      systemPromptFile: '/tmp/p.md',
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

  it('appends FAB_CLAUDE_EXTRA_ARGS verbatim', () => {
    const args = buildClaudeArgs({
      sessionId: 'sess',
      systemPromptFile: '/tmp/p.md',
      model: 'm',
      mcpConfigPath: null,
      bare: false,
      addDir: null,
      resumeFrom: null,
      title: undefined,
      env: { FAB_CLAUDE_EXTRA_ARGS: '--debug api --effort high' } as NodeJS.ProcessEnv,
    });

    expect(args).toContain('--debug');
    expect(args).toContain('api');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
  });

  it('passes --name when title supplied', () => {
    const args = buildClaudeArgs({
      sessionId: 'sess',
      systemPromptFile: '/tmp/p.md',
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
    // hubspot is one of the GATEWAY_HOSTED servers — auth header must
    // attach regardless of the resolved URL.
    const json = buildMcpConfigJson(['hubspot'], {
      MCP_GATEWAY_TOKEN: 'secret-token-abc',
    } as NodeJS.ProcessEnv);

    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.mcpServers.hubspot.type).toBe('http');
    expect(config.mcpServers.hubspot.url).toBeTypeOf('string');
    expect(config.mcpServers.hubspot.headers.Authorization).toBe('Bearer secret-token-abc');
  });

  it('drops gateway server with stderr warning when token is missing (default lenient)', () => {
    const stderrCalls: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCalls.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const json = buildMcpConfigJson(['hubspot'], {} as NodeJS.ProcessEnv);
      // hubspot is the only requested server and it got dropped — json is null
      expect(json).toBeNull();
      expect(stderrCalls.join('')).toMatch(/MCP_GATEWAY_TOKEN not set/);
      expect(stderrCalls.join('')).toMatch(/hubspot/);
    } finally {
      process.stderr.write = orig;
    }
  });

  it('keeps non-gateway servers when gateway servers are dropped', () => {
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const json = buildMcpConfigJson(['github', 'hubspot'], {} as NodeJS.ProcessEnv);
      expect(json).not.toBeNull();
      const config = JSON.parse(json!);
      expect(Object.keys(config.mcpServers)).toEqual(['github']);
    } finally {
      process.stderr.write = orig;
    }
  });

  it('throws under FAB_MCP_STRICT=1 when gateway server is missing token', () => {
    expect(() =>
      buildMcpConfigJson(['hubspot'], {
        FAB_MCP_STRICT: '1',
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

// ── The system prompt reaches the subprocess through a file ─────────
//
// Linux caps one execve argument at MAX_ARG_STRLEN. A gate role's prompt
// carries the rubric depth plus every overlay append, so it can pass that cap,
// and a prompt passed as an argument would then fail the spawn with E2BIG
// before the role runs. macOS has no per-argument cap, so only a measurement
// shows it.

const MAX_ARG_STRLEN = 131_072;

describe('the system prompt a claude-cli session hands its subprocess', () => {
  let dir: string;
  let home: string;
  const record = (): string => join(dir, 'record.json');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fab-cli-prompt-'));
    home = join(dir, 'home');
    mkdirSync(join(home, '.fab', 'skills'), { recursive: true });

    // State with every section that adds to a gate role's prompt.
    const state: Partial<FabState> = {
      journal: { enabled: true, basePath: '/workspace/.fab/journal' },
      repos: [
        {
          type: 'github_repository',
          url: 'https://github.com/acme/widgets',
          authorization_token: 'ghp_test',
          mount_path: '/workspace/widgets',
        },
      ],
      sourceDirs: ['services/api', 'services/worker', 'packages/shared'],
      projectLanguage: 'typescript',
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));

    // A stand-in for `claude` that records its arguments and the prompt file
    // it was handed, read at startup as the real binary reads it, then waits.
    const stub = join(dir, 'claude');
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const argv = process.argv.slice(2);',
        "const at = argv.indexOf('--append-system-prompt-file');",
        "const prompt = at === -1 ? null : fs.readFileSync(argv[at + 1], 'utf-8');",
        `fs.writeFileSync(${JSON.stringify(`${record()}.tmp`)}, JSON.stringify({ argv, prompt }));`,
        `fs.renameSync(${JSON.stringify(`${record()}.tmp`)}, ${JSON.stringify(record())});`,
        'process.stdin.resume();',
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(stub, 0o755);

    vi.stubEnv('HOME', home);
    vi.stubEnv('FAB_SKILLS_DIR', undefined);
    vi.stubEnv('FAB_STATE_FILE', join(dir, 'state.json'));
    vi.stubEnv('FAB_CLAUDE_PATH', stub);
    vi.stubEnv('FAB_CLAUDE_MCP_DIR', dir);
    vi.stubEnv('MCP_GATEWAY_TOKEN', 'gateway-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every argument under the per-argument limit when the prompt is over it', async () => {
    // An overlay of about 40 KB, grown when the bundled rubric alone leaves the
    // prompt short of the limit, so the case always measures a prompt past it.
    const bare = Buffer.byteLength(_buildClaudeCliSystemPrompt('qa-security', await loadState()));
    const rule = '- A personal grading rule that deepens one dimension of the rubric.\n';
    const lines = Math.ceil(Math.max(40_000, MAX_ARG_STRLEN - bare + 4_096) / rule.length);
    writeFileSync(
      join(home, '.fab', 'skills', 'quality-check.append.md'),
      `## Personal additions\n\n${rule.repeat(lines)}`,
    );
    const expected = _buildClaudeCliSystemPrompt('qa-security', await loadState());
    expect(Buffer.byteLength(expected)).toBeGreaterThan(MAX_ARG_STRLEN);

    const session = await new ClaudeCliRuntime().runRoleSession('qa-security', 'go');
    try {
      for (let i = 0; i < 3000 && !existsSync(record()); i++) {
        await new Promise((res) => setTimeout(res, 25));
      }
      const { argv, prompt } = JSON.parse(readFileSync(record(), 'utf-8')) as {
        argv: string[];
        prompt: string | null;
      };

      for (const arg of argv) {
        expect(Buffer.byteLength(arg), 'one argv element').toBeLessThan(MAX_ARG_STRLEN);
      }
      // Each build wraps untrusted input in a fresh random tag.
      const untagged = (text: string | null) => text?.replace(/untrusted-[0-9a-f]+/g, 'untrusted');
      expect(untagged(prompt)).toBe(untagged(expected));

      const promptFile = argv[argv.indexOf('--append-system-prompt-file') + 1];
      expect(statSync(promptFile).mode & 0o777).toBe(0o600);
      await session.interrupt();
      expect(existsSync(promptFile), 'the prompt file outlived its session').toBe(false);
    } finally {
      await session.interrupt();
    }
  }, 90_000);
});
