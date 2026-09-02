import type { AgentEvent, SessionErrorEvent } from '../types.js';

// ── Wall clocks on a session's event stream ────────────────────────────
//
// An agent loop with no wall clock cannot be told apart from a hung one.
// PRODUCTION_BAR requirement 4 states the rule fab enforces on every factory
// deliverable — "Every external client must have an explicit per-call timeout
// ... Default-infinity is a production incident waiting to happen" — and an
// LLM session is an external call that can stall for the same reasons an HTTP
// call can, with no socket to close when it does.
//
// Two clocks, because neither answers the other's question:
//
//   idle  — no event for N ms. This is what "hung" means. A session that has
//           produced nothing is not thinking; every transport emits partial
//           message and tool-use events while real work happens.
//   total — M ms since the stream opened, whatever the liveness. This is what
//           bounds a session that is alive and unproductive: a loop emitting a
//           heartbeat tool call every ten seconds never trips an idle clock.
//
// A single total clock — `AbortSignal.timeout()` armed once before the read and
// never reset, the shape at `src/api.ts` and `src/runtimes/sdk-k8s.ts` — cannot
// distinguish a hung session from a long one, so it must be set high enough to
// let real work finish and is therefore too high to catch a stall.

/**
 * No event for this long means the session is stalled rather than working.
 *
 * The floor is the longest a single tool call can plausibly take without
 * emitting anything: `src/prehook.ts` gives one build command 15 minutes, and a
 * role that shells out to a build sees the same wait with no event in between.
 * Below that, a legitimate build trips the clock.
 */
export const SESSION_IDLE_MS = 900_000;

/**
 * A single session may run this long in total, however live it looks.
 *
 * Matches `LOG_FOLLOW_TIMEOUT_MS` in `src/runtimes/sdk-k8s.ts`, which is the
 * ceiling the k8s transport already places on one session. Transports that
 * disagree about how long "too long" is give an operator no single number to
 * reason about.
 */
export const SESSION_TOTAL_MS = 1_800_000;

/**
 * Below this a bound is more likely a typo than a policy — a session that is
 * merely slow would be killed as hung, which is the failure this module exists
 * to prevent rather than cause.
 */
export const MIN_BOUND_MS = 1_000;

export interface SessionDeadlines {
  readonly idleMs: number;
  readonly totalMs: number;
}

/** Which clock ended the stream. */
export type DeadlineKind = 'idle' | 'total';

/** A session whose stream can be stopped. Narrower than `AgentSession` on purpose. */
export interface Stoppable {
  readonly id: string;
  stop(): Promise<void>;
}

/**
 * The bounds in force, from the environment.
 *
 * Env rather than `.fab-state.json` because the bound has to reach a session
 * running inside an AgentSandbox pod, and a pod receives its configuration only
 * through the forwarded environment — it cannot read the operator's state file.
 * A knob that silently does not apply to one transport is worse than no knob.
 *
 * A malformed or out-of-range value throws. Falling back to the default would
 * leave an operator who set a bound believing it applied.
 */
export function resolveSessionDeadlines(env: NodeJS.ProcessEnv): SessionDeadlines {
  return {
    idleMs: readBound(env, 'FAB_SESSION_IDLE_MS', SESSION_IDLE_MS),
    totalMs: readBound(env, 'FAB_SESSION_TOTAL_MS', SESSION_TOTAL_MS),
  };
}

function readBound(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  // `Number` accepts '0x384', ' 12 ' and '1e3'; a duration knob that reads hex
  // is a knob whose value an operator cannot predict from the string they set.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be whole milliseconds, got "${raw}"`);
  }
  const ms = Number(raw);
  if (ms < MIN_BOUND_MS) {
    throw new Error(`${name} must be at least ${MIN_BOUND_MS}ms, got ${ms}`);
  }
  return ms;
}

/**
 * The event a caller sees when a clock expires.
 *
 * `session.error` rather than `session.status_terminated` because both
 * definitions of terminal already accept it: `isTerminal` in `sdk-events.ts`,
 * which stops a transport appending a second synthetic ending, and the break
 * set in `streamSessionWithAdvisor`. The message is rendered verbatim by
 * `src/stream.ts`, so it is the operator-facing diagnostic and names the clock,
 * its value, and that the session was stopped rather than that it ended.
 */
export function deadlineError(
  id: string,
  kind: DeadlineKind,
  deadlines: SessionDeadlines,
  stopped: boolean,
): SessionErrorEvent {
  const ms = kind === 'idle' ? deadlines.idleMs : deadlines.totalMs;
  const cause =
    kind === 'idle' ? `emitted no event for ${ms}ms` : `ran for its full ${ms}ms budget`;
  return {
    type: 'session.error',
    id,
    error: {
      type: `${kind}_timeout`,
      message:
        `session ${cause} and was stopped by the ${kind} bound (FAB_SESSION_${kind.toUpperCase()}_MS). ` +
        (stopped
          ? 'Any output above is partial.'
          : 'The stop request failed, so the underlying session may still be running. Any output above is partial.'),
    },
    processed_at: new Date().toISOString(),
  };
}

/** How long to wait for an abandoned source to run its own cleanup before moving on. */
const RELEASE_GRACE_MS = 5_000;

/**
 * Yields `source`'s events until one of the clocks expires, then stops the
 * session and ends the stream with {@link deadlineError}.
 *
 * The order on expiry is stop, then release, then report. `return()` on a
 * generator suspended at an `await` does not run its `finally` until the
 * generator resumes, and a hung transport is suspended on output that will not
 * arrive — so whatever it is waiting on has to die first, or the release waits
 * as long as the thing it is releasing.
 *
 * Releasing rather than abandoning matters beyond tidiness: the claude-cli
 * stream's `finally` is the only path that deletes an MCP config file holding a
 * gateway bearer token, and a `Promise.race` that walks away from the generator
 * never runs it.
 */
export async function* boundEvents(
  source: AsyncIterable<AgentEvent>,
  target: Stoppable,
  deadlines: SessionDeadlines,
): AsyncIterable<AgentEvent> {
  const iterator = source[Symbol.asyncIterator]();
  const total = new Clock('total', deadlines.totalMs);
  const idle = new Clock('idle', deadlines.idleMs);
  let released = false;

  try {
    for (;;) {
      const pull = iterator.next().then((result): Step => ({ kind: 'event', result }));
      // The losing arm of the race is abandoned. Without this a rejection that
      // arrives after the clock won would surface as an unhandled rejection and
      // take the process down on a path that is otherwise handled.
      pull.catch(() => undefined);

      const step = await Promise.race([pull, total.expiry, idle.expiry]);

      if (step.kind !== 'event') {
        const stopped = await stopQuietly(target);
        released = true;
        await release(iterator);
        yield deadlineError(target.id, step.kind, deadlines, stopped);
        return;
      }
      if (step.result.done) {
        released = true;
        return;
      }

      idle.reset();
      yield step.result.value;
    }
  } finally {
    idle.clear();
    total.clear();
    // A consumer that breaks out of its loop closes this generator, and that
    // close stops here unless it is passed on. The source's own `finally` is
    // the only path that deletes the claude-cli MCP config holding a gateway
    // bearer token, so a wrapper that keeps the close to itself turns a
    // released token into a leaked one on every session that ends normally.
    if (!released) await release(iterator);
  }
}

type Step = { kind: 'event'; result: IteratorResult<AgentEvent> } | { kind: DeadlineKind };

/**
 * A countdown whose timer never holds the process open.
 *
 * An armed `setTimeout` keeps the event loop alive on its own, so a clock that
 * outlives its session turns a bounded CLI run into a hang — the failure this
 * module closes, reintroduced by the thing that closes it.
 */
class Clock {
  private timer: NodeJS.Timeout | null = null;
  private fire!: (step: Step) => void;
  readonly expiry: Promise<Step>;

  constructor(
    private readonly kind: DeadlineKind,
    private readonly ms: number,
  ) {
    this.expiry = new Promise<Step>((resolve) => {
      this.fire = resolve;
    });
    this.arm();
  }

  reset(): void {
    this.clear();
    this.arm();
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    this.timer = setTimeout(() => this.fire({ kind: this.kind }), this.ms);
    this.timer.unref();
  }
}

/** True when the session acknowledged the stop. A refusal is reported, not swallowed. */
async function stopQuietly(target: Stoppable): Promise<boolean> {
  try {
    await target.stop();
    return true;
  } catch {
    // Releasing the iterator continues either way: one uncooperative session
    // must not also strand the stream it was feeding.
    return false;
  }
}

async function release(iterator: AsyncIterator<AgentEvent>): Promise<void> {
  if (!iterator.return) return;
  await Promise.race([
    iterator.return(undefined).then(
      () => undefined,
      () => undefined,
    ),
    unrefSleep(RELEASE_GRACE_MS),
  ]);
}

function unrefSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
