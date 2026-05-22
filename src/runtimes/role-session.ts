import type { ParsedArgs } from '../args.js';
import type { AgentEvent, TeamRole } from '../types.js';
import { SdkRuntime } from './sdk.js';

/**
 * The in-pod role-session entrypoint.
 *
 * An `AgentSandbox` pod — built by the eks-agent-platform operator — runs
 * one factory role-session as its main process. The pod execs
 * `node dist/bin/fab.js role-session`, which lands here; the role and the
 * message arrive through the pod environment (`FAB_ROLE` / `FAB_MESSAGE`).
 * The session runs in-process through the unmodified {@link SdkRuntime},
 * and every `AgentEvent` is written to stdout as one JSON line.
 *
 * The pod log is the wire: the k8s-dispatch runtime tails it and parses
 * each line back into an event stream, so the workflow layer sees a remote
 * pod session as just another `AgentSession`.
 *
 * This is not a user-facing command — the operator dispatches it, nobody
 * types it at a shell — so it stays out of `printHelp`. A `--role` flag and
 * a positional message override the environment for direct debugging.
 */

/** Encode one `AgentEvent` as a JSONL wire line, trailing newline included. */
export function serializeEvent(event: AgentEvent): string {
  return JSON.stringify(event) + '\n';
}

/**
 * Drain a role-session event stream onto a JSONL sink and resolve the
 * process exit code. The code is 0 once a `session.status_idle` terminal
 * is seen, and 1 otherwise — a `session.error` terminal, or a stream that
 * ends with no terminal event at all. Both are failures the dispatcher
 * must see reflected in the pod's exit code.
 */
export async function streamEventsToJsonl(
  events: AsyncIterable<AgentEvent>,
  write: (line: string) => void,
): Promise<number> {
  let exitCode = 1;
  for await (const event of events) {
    write(serializeEvent(event));
    if (event.type === 'session.status_idle') {
      exitCode = 0;
    } else if (event.type === 'session.error') {
      exitCode = 1;
    }
  }
  return exitCode;
}

/** Role from the `--role` flag, falling back to the `FAB_ROLE` environment. */
function resolveRole(args: ParsedArgs): string | undefined {
  if (typeof args.flags.role === 'string') return args.flags.role;
  return process.env.FAB_ROLE;
}

/** Message from the positional args, falling back to `FAB_MESSAGE`. */
function resolveMessage(args: ParsedArgs): string | undefined {
  const positional = [args.sub, ...args.positional].filter(Boolean).join(' ');
  return positional || process.env.FAB_MESSAGE;
}

/**
 * Run one role-session to completion, streaming JSONL events to stdout.
 * Returns the process exit code; `fab role-session` sets it as the pod's
 * exit status.
 */
export async function executeRoleSession(args: ParsedArgs): Promise<number> {
  const role = resolveRole(args);
  const message = resolveMessage(args);

  if (!role || !message) {
    process.stderr.write(
      'fab role-session: a role and a message are required.\n' +
        '  env:  FAB_ROLE=<role> FAB_MESSAGE=<message> fab role-session\n' +
        '  args: fab role-session --role <role> <message...>\n',
    );
    return 1;
  }

  const session = await new SdkRuntime().runRoleSession(role as TeamRole, message);
  return streamEventsToJsonl(session.events, (line) => {
    process.stdout.write(line);
  });
}
