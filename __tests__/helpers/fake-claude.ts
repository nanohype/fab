import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession } from '../../src/runtime.js';
import { ClaudeCliRuntime } from '../../src/runtimes/claude-cli.js';
import type { TeamRole } from '../../src/types.js';

// ── A claude-cli session backed by a fixture binary ─────────────────
//
// Three cases have now raced the same hazard: a session's own wall clock starts
// when its stream is first read, and a child that has not finished starting has
// not spoken, so on a loaded suite the clock reaches its limit before the
// subprocess reaches its first line. Each was fixed where it was found, and the
// next case written met it again — which is what a remedy applied per case
// rather than owned somewhere looks like.
//
// So the wait is not something a case does. `startFakeClaudeSession` does not
// return until the child exists, and a case has no opportunity to read the
// stream earlier. The environment a fixture needs is set and restored here for
// the same reason.

export interface FakeClaudeSession {
  /** The live session, already backed by a running subprocess. */
  readonly session: AgentSession;
  /** The subprocess's pid, for asserting what became of it. */
  readonly pid: number;
  /** The fixture directory, for anything a case wants to place beside the binary. */
  readonly dir: string;
  /** Resolves once the subprocess is gone, or after ~10s if it is not. */
  waitForExit(): Promise<void>;
  /** True when the operating system no longer has the process. */
  isGone(): boolean;
  /** Restore the environment and remove the fixture. */
  dispose(): void;
}

export interface FakeClaudeOptions {
  /** Lines the fixture writes to stdout, in order, as SDK messages. */
  readonly emit: readonly unknown[];
  /**
   * Keep the process alive after the last line. Default: true.
   *
   * A fixture that exits as soon as it has written races the reader that has
   * not attached yet, and the race is invisible until a loaded suite loses it.
   * What every case here asserts is how a session ends — a ceiling, a bound —
   * so the subprocess outliving the read is the condition they all want, and
   * exiting is the one that has to be asked for.
   */
  readonly hang?: boolean;
  /**
   * The session idle bound while this fixture runs.
   *
   * Defaulted well above a fixture's own duration and well below a suite's
   * patience: a subprocess that never speaks ends its case by name rather than
   * hanging it, and a bound this size cannot be what ends a case that works.
   */
  readonly idleMs?: number;
  readonly role?: TeamRole;
  readonly message?: string;
}

const ENV_KEYS = ['FAB_CLAUDE_PATH', 'FAB_CLAUDE_MCP_DIR', 'FAB_SESSION_IDLE_MS'] as const;

/** Poll for `path`, generously: process startup is not what any case measures. */
async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (existsSync(path)) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(
    `no fixture subprocess wrote ${path} within 75s — it started slowly, or the spawn failed and said so on stderr`,
  );
}

/**
 * Spawn a claude-cli session against a fixture binary and return once it is
 * running.
 *
 * The binary records its pid before its first line, so the wait below is a wait
 * for the process to exist rather than for it to have said anything — which is
 * what lets a case assert about silence without racing startup.
 */
export async function startFakeClaudeSession(opts: FakeClaudeOptions): Promise<FakeClaudeSession> {
  const dir = mkdtempSync(join(tmpdir(), 'fab-fake-claude-'));
  const pidFile = join(dir, 'pid');
  const binary = join(dir, 'claude');

  const body = [
    '#!/usr/bin/env node',
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    ...opts.emit.map(
      (line) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(line)}\n`)});`,
    ),
    ...(opts.hang === false ? [] : ['setInterval(() => {}, 1e9);']),
  ].join('\n');
  writeFileSync(binary, body, { mode: 0o755 });
  // writeFileSync's mode is masked by the umask; the bit has to be set again.
  chmodSync(binary, 0o755);

  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FAB_CLAUDE_PATH = binary;
  process.env.FAB_CLAUDE_MCP_DIR = dir;
  process.env.FAB_SESSION_IDLE_MS = String(opts.idleMs ?? 20_000);

  const dispose = (): void => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const session = await new ClaudeCliRuntime().runRoleSession(
      opts.role ?? 'pr-reviewer',
      opts.message ?? 'go',
    );
    await waitForFile(pidFile);
    const pid = Number(readFileSync(pidFile, 'utf-8'));

    const isGone = (): boolean => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };

    return {
      session,
      pid,
      dir,
      isGone,
      dispose,
      async waitForExit() {
        for (let i = 0; i < 400; i++) {
          if (isGone()) return;
          await new Promise((res) => setTimeout(res, 25));
        }
      },
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

/** An assistant message carrying `usage`, as one API turn's content block. */
export const assistantMessage = (
  id: string,
  text: string,
  usage: Record<string, number>,
  sessionId = 'sess-fixture',
): unknown => ({
  type: 'assistant',
  uuid: `u-${id}-${text}`,
  session_id: sessionId,
  message: { id, usage, content: [{ type: 'text', text }] },
});

/** The init line every fixture opens with. */
export const initLine = (sessionId = 'sess-fixture'): unknown => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
});

/** The terminal result line. */
export const resultLine = (sessionId = 'sess-fixture'): unknown => ({
  type: 'result',
  subtype: 'success',
  uuid: 'r',
  session_id: sessionId,
});
