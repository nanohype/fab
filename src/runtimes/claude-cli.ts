import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { AgentRuntime, AgentSession, RunRoleOptions } from '../runtime.js';
import type { AgentEvent, FabState, TeamMember, TeamRole, UserEvent } from '../types.js';
import { TEAM } from '../team.js';
import { buildSystemPrompt } from '../prompts.js';
import { loadState, getPrimaryRepo } from '../state.js';
import { resolveMcpServers } from '../mcp.js';
import { uploadCostEvent } from '../cost.js';
import { isTerminal, translateSdkMessage } from './sdk-events.js';

/**
 * Subprocess-driven runtime that spawns `claude -p` per role session. Lets
 * fab execute workflows against the user's Claude Code subscription
 * credentials today (the SDK's subscription-auth path lights up
 * 2026-06-15). Each role session is a single `claude -p` process; multi-
 * turn within a session uses `--input-format stream-json` (stdin piping);
 * cross-process continuation (`revise`) uses `--resume <session-id>`.
 *
 * Configuration knobs:
 *   - `FAB_CLAUDE_BARE=1`     pass `--bare` (skip user CLAUDE.md, hooks,
 *                                  auto-memory; force ANTHROPIC_API_KEY auth)
 *   - `FAB_CLAUDE_PATH`        override binary lookup (default: `claude`)
 *   - `FAB_CLAUDE_EXTRA_ARGS`  space-separated flags appended to every spawn
 *   - `FAB_CLAUDE_MCP_DIR`     directory for per-session MCP config files
 *                                  (default: os.tmpdir())
 *
 * Parity matrix lives in `docs/transports.md`.
 */
export class ClaudeCliRuntime implements AgentRuntime {
  async runRoleSession(role: TeamRole, message: string, options?: RunRoleOptions): Promise<AgentSession> {
    const member = TEAM.find((m) => m.role === role);
    if (!member) {
      throw new Error(`Unknown role: "${role}"`);
    }

    const state = await loadState();
    const sessionId = randomUUID();
    const systemPrompt = buildSystemPrompt(member, state);
    const repo = await getPrimaryRepo();

    const mcpConfig = buildMcpConfigJson(member.mcpServers, process.env);
    const mcpConfigPath = mcpConfig ? writeMcpConfigFile(sessionId, mcpConfig) : null;

    const args = buildClaudeArgs({
      sessionId,
      systemPrompt,
      model: member.model,
      mcpConfigPath,
      bare: process.env.FAB_CLAUDE_BARE === '1',
      addDir: repo ? `/workspace/${repo.repo}` : null,
      resumeFrom: null,
      title: options?.title,
      env: process.env,
    });

    return new ClaudeCliSession({
      initialArgs: args,
      initialMessage: message,
      sessionId,
      mcpConfigPath,
      role,
      model: member.model,
    });
  }

  resumeSession(sessionId: string): AgentSession {
    // Lazy resume: the session has no spawn until the caller sends input via
    // `sendInput`. At that point we spawn `claude -p --resume <id>` with the
    // pending message. Workflow `revise` uses this path.
    return new ResumedClaudeCliSession(sessionId);
  }
}

interface SessionConstructorOptions {
  initialArgs: string[];
  initialMessage: string;
  sessionId: string;
  mcpConfigPath: string | null;
  role: TeamRole;
  model: string;
}

class ClaudeCliSession implements AgentSession {
  public readonly id: string;
  private readonly role: TeamRole;
  private readonly model: string;
  private readonly mcpConfigPath: string | null;
  private proc: ChildProcessWithoutNullStreams;
  private capturedSessionId: string;
  private stderrBuf = '';
  private terminalEmitted = false;
  private cleaned = false;

  constructor(opts: SessionConstructorOptions) {
    this.id = opts.sessionId;
    this.capturedSessionId = opts.sessionId;
    this.mcpConfigPath = opts.mcpConfigPath;
    this.role = opts.role;
    this.model = opts.model;
    this.proc = spawnClaude(opts.initialArgs);
    this.wireStderr();
    this.writeUserMessage(opts.initialMessage);
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.translateEvents();
  }

  async sendInput(input: UserEvent): Promise<void> {
    switch (input.type) {
      case 'user.message':
        this.writeUserMessage(textOfContent(input.content));
        return;
      case 'user.interrupt':
        await this.interrupt();
        return;
      case 'user.tool_confirmation':
      case 'user.custom_tool_result':
        // Claude Code handles tool confirmation via `--permission-mode`
        // configuration, not per-call client confirmations. Workflow runs
        // execute under `bypassPermissions`; explicit user confirmations
        // have no analogue at this transport layer.
        return;
      default:
        throw new Error(`ClaudeCliRuntime: unhandled UserEvent type "${(input as { type: string }).type}"`);
    }
  }

  async interrupt(): Promise<void> {
    if (this.proc.exitCode === null && !this.proc.killed) {
      this.proc.kill('SIGINT');
    }
  }

  private writeUserMessage(text: string): void {
    if (this.proc.exitCode !== null || this.proc.killed) return;
    const payload =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
      }) + '\n';
    try {
      this.proc.stdin.write(payload);
    } catch {
      // EPIPE: subprocess exited before we could write. Swallow — the
      // events translator will emit session.error from the exit handler.
    }
  }

  private wireStderr(): void {
    this.proc.stderr.setEncoding('utf-8');
    this.proc.stderr.on('data', (chunk: string) => {
      // Keep the most recent 8KB so we can surface diagnostic context on
      // crash without unbounded memory growth.
      this.stderrBuf = (this.stderrBuf + chunk).slice(-8192);
    });
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.mcpConfigPath) {
      try {
        unlinkSync(this.mcpConfigPath);
      } catch {
        // already removed or never created — both fine
      }
    }
  }

  private emitCostEvent(result: ResultMessage): void {
    if (typeof result.total_cost_usd !== 'number') return;
    void uploadCostEvent({
      sessionId: this.capturedSessionId,
      agentRole: this.role,
      model: this.model,
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
      costUsd: result.total_cost_usd,
      source: 'claude-cli',
      timestamp: new Date().toISOString(),
    });
  }

  private async *translateEvents(): AsyncIterable<AgentEvent> {
    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Malformed line — log but keep streaming. Workflow runs are
          // long; one bad chunk shouldn't take the whole gate down.
          process.stderr.write(`[claude-cli] dropped malformed line: ${line.slice(0, 120)}\n`);
          continue;
        }

        // Cost capture on result messages — the CLI surfaces totals only
        // at session end, not per-request like Managed Agents.
        if (isResultSuccess(parsed)) {
          this.emitCostEvent(parsed as ResultMessage);
        }

        const event = translateSdkMessage(parsed, (id) => {
          this.capturedSessionId = id;
        });
        if (!event) continue;
        yield event;
        if (isTerminal(event)) {
          this.terminalEmitted = true;
          // Close stdin so the CLI exits after processing the terminal
          // result. Otherwise --input-format stream-json keeps the
          // process alive waiting for the next user message.
          try {
            this.proc.stdin.end();
          } catch {
            // already closed — fine
          }
        }
      }

      // stdout closed. If the subprocess died without emitting a terminal
      // result event, surface the failure so workflow code can react.
      if (!this.terminalEmitted) {
        const code = this.proc.exitCode;
        yield {
          type: 'session.error',
          id: this.capturedSessionId,
          error: {
            type: 'subprocess_exit',
            message:
              `claude -p exited with code ${code ?? 'unknown'} before emitting a result.` +
              (this.stderrBuf ? ` stderr: ${this.stderrBuf.trim()}` : ''),
          },
          processed_at: new Date().toISOString(),
        };
      }
    } finally {
      this.cleanup();
    }
  }
}

/**
 * Stand-in for a session that hasn't started yet. Resume is lazy because
 * the SDK + CLI both need the next user message before they can usefully
 * spawn `claude -p --resume <id>`. We don't try to attach to a previously
 * started subprocess — those are dead the moment they emit `result`.
 */
class ResumedClaudeCliSession implements AgentSession {
  private liveSession: ClaudeCliSession | null = null;

  constructor(public readonly id: string) {}

  get events(): AsyncIterable<AgentEvent> {
    const live = (): ClaudeCliSession | null => this.liveSession;
    return (async function* () {
      const session = live();
      if (!session) return;
      yield* session.events;
    })();
  }

  async sendInput(input: UserEvent): Promise<void> {
    if (input.type !== 'user.message') {
      // tool_confirmation / custom_tool_result are no-ops on this transport;
      // interrupt on a session that hasn't spawned does nothing.
      return;
    }

    if (!this.liveSession) {
      // First send after resume — spawn the actual subprocess now.
      const state = await loadState();
      const repo = await getPrimaryRepo();
      const args = buildClaudeArgs({
        sessionId: this.id,
        systemPrompt: null, // resume inherits the original session's system prompt
        model: null,
        mcpConfigPath: null,
        bare: process.env.FAB_CLAUDE_BARE === '1',
        addDir: repo ? `/workspace/${repo.repo}` : null,
        resumeFrom: this.id,
        title: undefined,
        env: process.env,
      });
      this.liveSession = new ClaudeCliSession({
        initialArgs: args,
        initialMessage: textOfContent(input.content),
        sessionId: this.id,
        mcpConfigPath: null,
        // Resume sessions don't carry the original role; cost tracking
        // here logs as the calibration role since resume is invoked by
        // the revise flow which is per-role-revision.
        role: 'pr-reviewer',
        model: 'claude-sonnet-4-6',
      });
      // Suppress unused warning — state holds workflow context that future
      // resume strategies may consume.
      void state;
      return;
    }

    await this.liveSession.sendInput(input);
  }

  async interrupt(): Promise<void> {
    if (this.liveSession) await this.liveSession.interrupt();
  }
}

// ── Pure functions (exported for tests) ────────────────────────────────

export interface BuildClaudeArgsOptions {
  sessionId: string;
  systemPrompt: string | null;
  model: string | null;
  mcpConfigPath: string | null;
  bare: boolean;
  addDir: string | null;
  resumeFrom: string | null;
  title: string | undefined;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the argv passed to `claude` for a single role session. Pure
 * function so the test suite can assert the exact flag set without
 * spawning anything. Order matches the docs/transports.md narrative.
 */
export function buildClaudeArgs(opts: BuildClaudeArgsOptions): string[] {
  const args: string[] = ['-p'];

  // I/O contracts — stream-json both ways gives us multi-turn within one
  // process plus structured event parsing.
  args.push('--output-format', 'stream-json');
  args.push('--input-format', 'stream-json');
  args.push('--include-partial-messages');
  args.push('--verbose'); // stream-json output requires --verbose per CLI validation

  // Session identity. Fresh runs set the id; resume points at an existing
  // one. Never both (mutually exclusive).
  if (opts.resumeFrom) {
    args.push('--resume', opts.resumeFrom);
  } else {
    args.push('--session-id', opts.sessionId);
    args.push('--no-session-persistence');
  }

  // Permission posture. Workflow runs execute unattended; the same
  // `always_allow` posture used by Managed Agents toolsets applies here.
  args.push('--permission-mode', 'bypassPermissions');

  // Model selection. Roles declare full names (`claude-sonnet-4-6`); the
  // CLI also accepts aliases (`sonnet`, `opus`).
  if (opts.model) {
    args.push('--model', opts.model);
  }

  // System prompt. `--append-system-prompt` layers on Claude Code's own
  // default; we keep the default so subprocess tooling stays intact and
  // append the role's prompt + factory preamble on top.
  if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }

  // MCP servers. Pass per-session config; the strict flag prevents the
  // CLI from auto-discovering project-level configs we didn't ask for.
  if (opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath);
    args.push('--strict-mcp-config');
  }

  // Working directory expansion. Code-producing workflows mount the
  // primary repo; expose it to subprocess tools.
  if (opts.addDir) {
    args.push('--add-dir', opts.addDir);
  }

  // Inheritance posture. `--bare` strips user-level CLAUDE.md, hooks,
  // auto-memory, OAuth — full clean slate. Default flow inherits.
  if (opts.bare) {
    args.push('--bare');
  } else {
    // Limit to user-level settings; project + local settings introduce
    // per-workspace surprises in a multi-role workflow run.
    args.push('--setting-sources', 'user');
  }

  // Display name — surfaces in the session picker if persistence is later
  // re-enabled and in the terminal title during interactive use.
  if (opts.title) {
    args.push('--name', opts.title);
  }

  // Escape hatch. Power users can append arbitrary flags via env var.
  const extra = opts.env.FAB_CLAUDE_EXTRA_ARGS?.trim();
  if (extra) {
    args.push(...extra.split(/\s+/));
  }

  return args;
}

interface McpHttpEntry {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

interface McpConfigShape {
  mcpServers: Record<string, McpHttpEntry>;
}

/**
 * Servers that route through the mcp-gateway and need the shared bearer
 * token. Match's `src/mcp.ts`'s `switchboardService()` set + the memory
 * Lambda. Listed explicitly here so authentication injection doesn't
 * depend on URL-prefix matching (which races with env-var resolution).
 */
const GATEWAY_HOSTED: ReadonlySet<string> = new Set([
  'hubspot',
  'gdrive',
  'analytics',
  'gcalendar',
  'gcse',
  'stripe',
  'memory',
]);

/**
 * Render the role's MCP server list into Claude Code's `--mcp-config` JSON
 * shape. Returns null when the role declares no servers or every server
 * was dropped (caller skips the `--mcp-config` flag entirely).
 *
 * Gateway-routed servers (see {@link GATEWAY_HOSTED}) get
 * `Authorization: Bearer <MCP_GATEWAY_TOKEN>` injected. Third-party direct
 * servers (github, linear, slack, notion, sentry, figma, hunter) pass
 * through without fab-side auth headers — Claude Code handles those
 * via its own credential store.
 *
 * **Missing gateway token behaviour:**
 *   - Default (`FAB_MCP_STRICT` unset): gateway servers are silently
 *     dropped from the config and a single-line warning is written to
 *     stderr. The agent runs with whatever non-gateway servers remain
 *     plus Claude Code's built-in tools.
 *   - Strict (`FAB_MCP_STRICT=1`): missing token throws. Use this in
 *     production where every declared MCP server is load-bearing.
 */
export function buildMcpConfigJson(serverNames: string[], env: NodeJS.ProcessEnv): string | null {
  if (serverNames.length === 0) return null;

  const { servers } = resolveMcpServers(serverNames);
  if (servers.length === 0) return null;

  const gatewayToken = env.MCP_GATEWAY_TOKEN ?? '';
  const strict = env.FAB_MCP_STRICT === '1';
  const skipped: string[] = [];

  const mcpServers: Record<string, McpHttpEntry> = {};
  for (const server of servers) {
    const entry: McpHttpEntry = { type: 'http', url: server.url };

    if (GATEWAY_HOSTED.has(server.name)) {
      if (!gatewayToken) {
        if (strict) {
          throw new Error(
            `MCP server "${server.name}" routes through the gateway but MCP_GATEWAY_TOKEN is not set. ` +
              `Set the token, remove the server from the role's mcpServers list, or unset FAB_MCP_STRICT to fall back to skip-with-warning.`,
          );
        }
        skipped.push(server.name);
        continue;
      }
      entry.headers = { Authorization: `Bearer ${gatewayToken}` };
    }

    // Static headers declared in the registry (rare) flow through.
    if (server.headers) {
      entry.headers = { ...entry.headers, ...server.headers };
    }

    mcpServers[server.name] = entry;
  }

  if (skipped.length > 0) {
    process.stderr.write(
      `[claude-cli] MCP_GATEWAY_TOKEN not set — dropping gateway server(s): ${skipped.join(', ')}. ` +
        `Set MCP_GATEWAY_TOKEN to enable them, or set FAB_MCP_STRICT=1 to fail loudly.\n`,
    );
  }

  if (Object.keys(mcpServers).length === 0) return null;

  const shape: McpConfigShape = { mcpServers };
  return JSON.stringify(shape, null, 2);
}

// ── Internal helpers ───────────────────────────────────────────────────

function spawnClaude(args: string[]): ChildProcessWithoutNullStreams {
  const claudePath = process.env.FAB_CLAUDE_PATH ?? 'claude';
  const proc = spawn(claudePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // ENOENT bubbles to the 'error' event, not the result of spawn(). Add a
  // listener so the subprocess failure surfaces cleanly rather than crashing
  // the parent with an unhandled error.
  proc.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      process.stderr.write(
        `[claude-cli] "${claudePath}" not found on PATH. ` +
          `Install Claude Code (https://docs.claude.com/en/docs/claude-code) or set FAB_CLAUDE_PATH.\n`,
      );
    } else {
      process.stderr.write(`[claude-cli] subprocess error: ${err.message}\n`);
    }
  });
  return proc;
}

function writeMcpConfigFile(sessionId: string, json: string): string {
  const dir = process.env.FAB_CLAUDE_MCP_DIR ?? tmpdir();
  const path = join(dir, `fab-mcp-${sessionId}.json`);
  writeFileSync(path, json, { encoding: 'utf-8', mode: 0o600 });
  return path;
}

function textOfContent(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('');
}

interface ResultMessage {
  type: 'result';
  subtype: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function isResultSuccess(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const m = raw as { type?: string; subtype?: string };
  return m.type === 'result' && m.subtype === 'success';
}

/**
 * Test-only export for the resolved system prompt path. Workflow code goes
 * through `runRoleSession`; this lets tests verify state plumbing without
 * spawning anything.
 */
export function _buildClaudeCliSystemPrompt(role: TeamRole, state: FabState): string {
  const member: TeamMember | undefined = TEAM.find((m) => m.role === role);
  if (!member) throw new Error(`Unknown role: "${role}"`);
  return buildSystemPrompt(member, state);
}
