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
 * Options for starting a role session. The transport may treat some fields
 * differently — e.g., `resources` (workspace repos) is meaningful for
 * Managed Agents but maps to `cwd` + `addDir` for the sdk runtime.
 */
export interface RunRoleOptions {
  /** Human-readable session title — populated into the title field where the transport supports it. */
  title?: string;
  /** Repo resources to attach (for transports that support workspace mounts). */
  resources?: GitRepoResource[];
  /** Vault ids for MCP auth (Managed Agents) — for the sdk runtime, MCP auth lives in `mcpServers` config. */
  vaultIds?: string[];
  /** Per-session metadata; passed through to the transport for observability. */
  metadata?: Record<string, string>;
}

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
   * For ManagedAgents: trivial — server-side state lives at the session id.
   * For the sdk runtime: maps to the SDK's `resume: session_id` option.
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
