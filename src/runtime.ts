import type { AgentEvent, GitRepoResource, TeamRole, UserEvent } from './types.js';

/**
 * Transport-agnostic agent runtime.
 *
 * Fab ships four transports, picked via `FAB_RUNTIME` (see
 * `src/runtimes/index.ts` and `docs/transports.md`):
 *
 *   - **ManagedAgentsRuntime** (`managed-agents`, default) — the Anthropic
 *     Managed Agents REST API. Agents are deployed cloud-side; sessions
 *     persist on Anthropic's infrastructure.
 *   - **SdkRuntime** (`sdk`) — the Claude Agent SDK in-process. Sessions live
 *     in fab's process; the inference seam (`src/inference.ts`) can point it
 *     at Bedrock or Claude Platform on AWS.
 *   - **SdkK8sRuntime** (`sdk-k8s`) — dispatches each role-session as its own
 *     isolated pod on the eks-agent-platform substrate; the pod runs the
 *     unmodified `sdk` loop via `fab role-session`.
 *   - **ClaudeCliRuntime** (`claude-cli`) — drives a `claude -p` subprocess
 *     per role session (subscription-billable via an existing Claude Code
 *     login).
 *
 * All four expose the same `AgentSession` shape: events flow out via an
 * async iterable; follow-up inputs (tool confirmations, custom tool results,
 * interrupts) flow in via `sendInput`. The workflow layer in `workflows.ts`
 * doesn't know which transport it's running on.
 *
 * There is no coordinator agent on any transport — Managed Agents caps a
 * multiagent roster at 20 unique agents and does not nest coordinators, so
 * each role runs in its own session and workflow code in `workflows.ts`
 * routes between sessions.
 */

/**
 * Stable handle for a running agent session.
 *
 * The caller iterates `events` to consume agent output and uses `sendInput` /
 * `interrupt` to drive the session. When the events iterable closes, the
 * session is over.
 */
export interface AgentSession {
  /** The transport-specific session id. Exposed for cross-cutting concerns (cost tagging, logging). */
  readonly id: string;
  /** Agent events streamed from the transport. */
  readonly events: AsyncIterable<AgentEvent>;
  /**
   * Send a follow-up user input — typically `user.tool_confirmation`,
   * `user.custom_tool_result`, or `user.message` for multi-turn flows.
   *
   * The transport delivers the input to the running agent. Returns when
   * the transport has accepted the input (not when the agent has acted on it).
   */
  sendInput(input: UserEvent): Promise<void>;
  /** Cooperatively interrupt the session. The agent's next iteration sees a stop signal. */
  interrupt(): Promise<void>;
}

/**
 * Options for starting a role session.
 *
 * A field a transport does not honour is ignored in silence, so which
 * transports read which field is part of the contract rather than a detail:
 * a caller who attaches repos to a transport that never reads them gets a
 * session that looks configured and is not. {@link RUN_ROLE_OPTION_SUPPORT} is
 * that answer, and it is data keyed by both derived axes rather than prose, so
 * a transport or an option added to the tree is one the matrix cannot omit.
 */
export interface RunRoleOptions {
  /** Human-readable session title, where the transport has one. */
  title?: string;
  /** Repo resources to attach, where the transport mounts a workspace. */
  resources?: GitRepoResource[];
  /** Vault ids for MCP auth. Elsewhere MCP auth travels in the server config. */
  vaultIds?: string[];
  /** Per-session metadata, for observability. */
  metadata?: Record<string, string>;
}

/**
 * Every transport, in the spelling `FAB_RUNTIME` accepts.
 *
 * The one list. `resolveRuntimeKind` validates against it, `createRuntime`
 * switches on the type derived from it, and the support matrix below is keyed
 * by that same type — so a transport added here is a transport every one of
 * them has to account for, and a transport added anywhere else does not
 * compile.
 */
export const RUNTIME_NAMES = ['managed-agents', 'sdk', 'sdk-k8s', 'claude-cli'] as const;

/** A transport, derived from {@link RUNTIME_NAMES} rather than restated. */
export type RuntimeName = (typeof RUNTIME_NAMES)[number];

/**
 * Which transports read each {@link RunRoleOptions} field.
 *
 * Each gap has its own reason. The sdk transport runs the agent loop against
 * the caller's own working directory and expects the repositories to be there
 * already, so it has nothing to mount `resources` into. The subprocess
 * transport does attach a repository directory, but sources it from workspace
 * state rather than from this field. The k8s transport runs in a pod, where
 * neither the caller's directory nor the operator's vault is reachable. MCP
 * auth on all three travels in the server config rather than from a vault.
 *
 * Both axes derive, and so does the check: `keyof RunRoleOptions` makes a new
 * option a compile error, `RuntimeName` makes a new transport one, and what a
 * transport reads is resolved from the program's own types rather than matched
 * in its text — so a read through a renamed parameter, or one module away, is
 * the same read.
 */
export const RUN_ROLE_OPTION_SUPPORT: Record<keyof RunRoleOptions, readonly RuntimeName[]> = {
  title: ['managed-agents', 'claude-cli'],
  resources: ['managed-agents'],
  vaultIds: ['managed-agents'],
  metadata: ['sdk'],
};

/**
 * The abstraction over agent runtimes.
 *
 * One method matters for orchestration: `runRoleSession`. The rest are
 * transport-specific deployment concerns (creating agents, vaults,
 * environments) that the CLI's `deploy` command handles directly against
 * `AnthropicAgents` — the runtime interface focuses on the per-session
 * runtime path so workflows can be transport-agnostic.
 */
export interface AgentRuntime {
  /**
   * Start a session against the deployed agent for `role`, send `message` as
   * the initial user input, and return an `AgentSession` the caller can
   * iterate + drive.
   *
   * Throws if the role has no deployed agent (the transport's deployment
   * step must run first — typically `fab deploy`).
   */
  runRoleSession(role: TeamRole, message: string, options?: RunRoleOptions): Promise<AgentSession>;

  /**
   * Reconstruct an `AgentSession` handle from an existing session id. Used
   * when the caller (e.g., the REPL, a revision-loop trigger) holds a session
   * id from a prior `runRoleSession` call and needs to drive the same session
   * again.
   *
   * The managed-agents transport reattaches for real: the session's state is
   * server-side and the id is the whole handle. The claude-cli transport
   * respawns `claude -p --resume <id>` on a first input that is a user message,
   * and does nothing for any other shape.
   *
   * The sdk and sdk-k8s transports do not reattach, for reasons of their own:
   * the Agent SDK's `resume` reopens a transcript in a fresh call rather than
   * handing back a live handle to a running loop, and an sdk-k8s role session
   * is a single-use pod its own stream has already collected. What they return
   * reports its id, streams no events, and throws on input. Only the input half
   * is visible to a caller — iterating the events of one yields nothing and
   * reads as a session that has gone idle.
   */
  resumeSession(sessionId: string): AgentSession;

  /**
   * Best-effort: record per-role performance metrics (sessions, tokens,
   * self-eval, advisor calls, revisions) for a completed session into
   * `.fab-perf.json`, which `fab perf` reads.
   *
   * Optional — only the managed-agents transport exposes the per-session usage
   * + event history this needs (`getSession` / `listEvents`). Other runtimes
   * omit it, so `fab perf` simply shows no rows for those runs.
   */
  collectSessionMetrics?(sessionId: string): Promise<void>;
}
