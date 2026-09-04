import type { AgentRuntime, AgentSession, RunRoleOptions } from '../runtime.js';
import type { AgentEvent, EffortLevel, FabState, TeamRole, UserEvent } from '../types.js';
import { TEAM } from '../team.js';
import { buildSystemPrompt } from '../prompts.js';
import { loadState, getBudgetLimit } from '../state.js';
import {
  inferenceEnv,
  resolveInferenceBackend,
  resolveModelId,
  type InferenceBackend,
} from '../inference.js';
import { isTerminal, textOf, translateSdkMessage } from './sdk-events.js';
import { boundEvents, resolveSessionDeadlines } from './deadline.js';
import { buildHttpMcpServers, type HttpMcpServer } from '../mcp.js';

/**
 * SDK agent runtime backed by `@anthropic-ai/claude-agent-sdk`.
 *
 * Runs the same role definitions in-process via Claude Code's Agent SDK
 * instead of the Managed Agents REST API. The SDK is loaded dynamically so
 * fab remains installable without it (it ships as an optional
 * dependency); a clear error fires if the sdk runtime is selected without
 * the package present.
 *
 * Parity model vs {@link ManagedAgentsRuntime}:
 *   - Sessions: in-memory `Query` objects vs Anthropic-hosted sessions.
 *   - Tools: SDK Claude Code toolset (Read/Write/Edit/Bash/Grep/Glob/etc.)
 *     vs Managed Agents `agent_toolset_20260401`. Functional overlap is
 *     large; differences are documented in `docs/transports.md`.
 *   - System prompt: built on-demand from `buildSystemPrompt(member, state)`
 *     since there is no deploy step.
 *   - Tool confirmation: SDK uses permission modes. Workflow execution
 *     uses `bypassPermissions` to match the `always_allow` policy on
 *     deployed agent toolsets in managed-agents mode.
 *   - Memory: managed-agents-only; the sdk runtime has no shared memory.
 *   - Threading: SDK does not expose Anthropic threading; multi-thread
 *     events are not emitted by the sdk runtime.
 *
 * Picked by setting `FAB_RUNTIME=sdk` at startup. See
 * `src/runtimes/index.ts` for the selection logic. The inference backend
 * is independent — `FAB_INFERENCE=bedrock` routes inference through AWS
 * Bedrock (see `src/inference.ts`); the default is the Anthropic API.
 */
export class SdkRuntime implements AgentRuntime {
  /**
   * How the Agent SDK is obtained. Defaulted to the real loader, so production
   * takes it; a caller supplies one to observe what `runRoleSession` hands the
   * query, which is the only place the configured spend ceiling is read and
   * passed down.
   */
  constructor(private readonly loadSdkModule: () => Promise<AgentSdkModule> = loadSdk) {}

  async runRoleSession(
    role: TeamRole,
    message: string,
    options?: RunRoleOptions,
  ): Promise<AgentSession> {
    const member = TEAM.find((m) => m.role === role);
    if (!member) {
      throw new Error(`Unknown role: "${role}"`);
    }

    const state = await loadState();
    const systemPrompt = buildSystemPrompt(member, state);

    const backend = resolveInferenceBackend();
    const model = resolveModelId(member.model, backend);
    // Native per-run budget: the SDK stops the loop with an error_max_budget_usd
    // result when this USD cap is exceeded. It is a second ceiling, independent
    // of the one the pipeline applies — streamSessionWithAdvisor accumulates the
    // per-request cost spans this transport emits and interrupts on breach, and
    // that path reaches every transport that emits them.
    const budgetUsd = await getBudgetLimit();
    // Wire the role's MCP servers into the in-process loop. Without this the sdk
    // transport ran with NO MCP tools — roles lost github/linear/etc. and could
    // not push commits — making it a degraded transport. Mirrors claude-cli's
    // --mcp-config; the same gateway-bearer logic lives in buildHttpMcpServers.
    const { servers: mcpServers, skipped } = buildHttpMcpServers(member.mcpServers, process.env);
    if (skipped.length > 0) {
      process.stderr.write(
        `[sdk] MCP_GATEWAY_TOKEN not set — dropping gateway server(s): ${skipped.join(', ')}.\n`,
      );
    }

    const sdk = await this.loadSdkModule();
    const session = new SdkAgentSession(
      sdk,
      model,
      systemPrompt,
      options,
      backend,
      budgetUsd,
      mcpServers,
      member.effort,
    );
    await session.start(message);
    return session;
  }

  resumeSession(sessionId: string): AgentSession {
    // Reattaching to a session by id is not supported on this transport.
    // The SDK's `options.resume` reopens a transcript in a fresh `query()`
    // call; it does not hand back a live handle to a session already
    // running, and this runtime holds its sessions as in-memory `Query`
    // objects that end with the process. The returned stand-in exists to
    // fail loudly on first use rather than hand back a silent no-op.
    return new ResumedSdkAgentSession(sessionId);
  }
}

interface AgentSdkModule {
  query: (params: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }) => SdkQuery;
}

interface SdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
}

async function loadSdk(): Promise<AgentSdkModule> {
  try {
    const mod = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as AgentSdkModule;
    return mod;
  } catch (err) {
    throw new Error(
      `SdkRuntime requires "@anthropic-ai/claude-agent-sdk" to be installed.\n` +
        `Run: npm install @anthropic-ai/claude-agent-sdk`,
      { cause: err },
    );
  }
}

/** Inputs to {@link buildSdkQueryOptions} — everything the query call varies on. */
export interface SdkQueryOptionsInput {
  readonly model: string;
  readonly systemPrompt: string;
  readonly budgetUsd?: number | null;
  readonly mcpServers?: Record<string, HttpMcpServer>;
  readonly effort?: EffortLevel;
  readonly backendEnv?: NodeJS.ProcessEnv | null;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The `options` bag handed to the Agent SDK's `query()`.
 *
 * Split out from the call so the shape is assertable without starting a
 * session — the same reason `buildClaudeArgs` is separate in the claude-cli
 * transport. Every field but `model`, `systemPrompt` and `permissionMode` is
 * conditional, and a key present with an undefined value is not the same as
 * an absent key to the SDK, so the omissions are the part worth testing.
 */
export function buildSdkQueryOptions(input: SdkQueryOptionsInput): Record<string, unknown> {
  const mcpServers = input.mcpServers ?? {};
  return {
    model: input.model,
    systemPrompt: input.systemPrompt,
    permissionMode: 'bypassPermissions',
    ...(input.budgetUsd != null && { maxBudgetUsd: input.budgetUsd }),
    // Role's MCP servers, scoped strictly to fab's set (not the user's
    // ambient ~/.claude MCP config) — matches claude-cli's --strict-mcp-config.
    ...(Object.keys(mcpServers).length > 0 && { mcpServers, strictMcpConfig: true }),
    ...(input.effort && { effort: input.effort }),
    ...(input.backendEnv && { env: { ...process.env, ...input.backendEnv } }),
    // Resources hint: the SDK uses cwd for filesystem-bound tools;
    // workflows.ts pre-creates branches on the cloud-mounted repos
    // for managed-agents mode. The sdk runtime operates against the
    // caller's cwd; the user is responsible for cloning the repos
    // beforehand.
    ...(input.metadata && { metadata: input.metadata }),
  };
}

export class SdkAgentSession implements AgentSession {
  private inputQueue: { resolve: (value: IteratorResult<unknown>) => void }[] = [];
  private pendingInputs: unknown[] = [];
  private closed = false;
  private sdkQuery: SdkQuery | null = null;
  private capturedSessionId: string | null = null;
  /** Turns already charged for; one API turn arrives as several messages. */
  private readonly seenTurns = new Set<string>();

  constructor(
    private readonly sdk: AgentSdkModule,
    private readonly model: string,
    private readonly systemPrompt: string,
    private readonly options?: RunRoleOptions,
    private readonly backend: InferenceBackend = 'api',
    private readonly budgetUsd: number | null = null,
    private readonly mcpServers: Record<string, HttpMcpServer> = {},
    private readonly effort?: EffortLevel,
  ) {}

  get id(): string {
    return this.capturedSessionId ?? 'sdk-session-pending';
  }

  async start(initialMessage: string): Promise<void> {
    const inputs = this.makeInputIterable();
    // Seed the first user message so the agent has something to process.
    void this.enqueueInput({
      type: 'user',
      message: { role: 'user', content: initialMessage },
      parent_tool_use_id: null,
    });

    const backendEnv = inferenceEnv(this.backend);
    // Context compaction is automatic here, so there is nothing to wire: the
    // Agent SDK runs the Claude Code agent loop, which auto-compacts when the
    // window fills (surfaced as a `compacting` status + Pre/PostCompact hooks).
    // It is NOT a query() option — there is no `context_management` knob, and
    // the SDK's `betas` option only accepts `context-1m-2025-08-07`, never
    // `compact-2026-01-12` — so the raw Messages-API compaction config does not
    // apply to this runtime. managed-agents handles long context via its durable
    // session log. Verified against the installed @anthropic-ai/claude-agent-sdk
    // 0.3.x types, 2026-06.
    this.sdkQuery = this.sdk.query({
      prompt: inputs,
      options: buildSdkQueryOptions({
        model: this.model,
        systemPrompt: this.systemPrompt,
        budgetUsd: this.budgetUsd,
        mcpServers: this.mcpServers,
        effort: this.effort,
        backendEnv,
        metadata: this.options?.metadata,
      }),
    });
  }

  get events(): AsyncIterable<AgentEvent> {
    // The bound is structural rather than a parameter a caller may omit.
    // `maxBudgetUsd` is a spend cap and is opt-in; neither answers how long a
    // stalled loop may sit here, so the only way to iterate it is bounded.
    return boundEvents(this.translateEvents(), this, resolveSessionDeadlines(process.env));
  }

  async sendInput(input: UserEvent): Promise<void> {
    switch (input.type) {
      case 'user.message':
        await this.enqueueInput({
          type: 'user',
          message: { role: 'user', content: textOf(input.content) },
          parent_tool_use_id: null,
        });
        return;
      case 'user.interrupt':
        await this.interrupt();
        return;
      case 'user.tool_confirmation':
      case 'user.custom_tool_result':
        // SDK handles tool confirmation via permission hooks (PreToolUse)
        // and tool results via its internal loop, so explicit user-side
        // confirmations have no analogue at this layer. Workflow code
        // does not depend on them in the sdk runtime.
        return;
      default:
        throw new Error(
          `SdkRuntime: unhandled UserEvent type "${(input as { type: string }).type}"`,
        );
    }
  }

  async interrupt(): Promise<void> {
    await this.stop();
  }

  /**
   * End the agent loop and let the SDK's process shut down.
   *
   * Closing the input iterable is what releases that process; interrupting the
   * query alone leaves it waiting for a message that will not arrive.
   */
  async stop(): Promise<void> {
    if (this.sdkQuery) {
      await this.sdkQuery.interrupt();
    }
    this.closeInput();
  }

  private makeInputIterable(): AsyncIterable<unknown> {
    const nextInput = (): Promise<IteratorResult<unknown>> => this.nextInput();
    const closeInput = (): void => this.closeInput();
    return {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next: nextInput,
          return: async () => {
            closeInput();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  private nextInput(): Promise<IteratorResult<unknown>> {
    if (this.pendingInputs.length > 0) {
      const value = this.pendingInputs.shift()!;
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<unknown>>((resolve) => {
      this.inputQueue.push({ resolve });
    });
  }

  private async enqueueInput(payload: unknown): Promise<void> {
    if (this.closed) {
      throw new Error('SdkRuntime: cannot send input after the session is closed');
    }
    const waiter = this.inputQueue.shift();
    if (waiter) {
      waiter.resolve({ value: payload, done: false });
    } else {
      this.pendingInputs.push(payload);
    }
  }

  private closeInput(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.inputQueue.length > 0) {
      const waiter = this.inputQueue.shift()!;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  private async *translateEvents(): AsyncIterable<AgentEvent> {
    if (!this.sdkQuery) {
      throw new Error('SdkRuntime: session has not been started');
    }
    try {
      for await (const raw of this.sdkQuery) {
        const events = translateSdkMessage(
          raw,
          (id) => {
            this.capturedSessionId = id;
          },
          this.seenTurns,
        );
        for (const event of events) {
          yield event;
          // After a terminal result the loop ends naturally; close the input
          // iterable so the SDK's process can shut down cleanly.
          if (isTerminal(event)) {
            this.closeInput();
          }
        }
      }
    } finally {
      // A consumer that stops reading leaves the input iterable open and the
      // SDK's process with it, so closing cannot depend on reaching a terminal
      // event.
      this.closeInput();
    }
  }
}

/**
 * What `SdkRuntime.resumeSession` returns: a session that reports its id,
 * streams nothing, and throws on input. It does not become a live session.
 *
 * Reattaching by id has no implementation on this transport — the SDK
 * offers no handle to an already-running `query()`, and workflow code drives
 * continuation by starting a new role session with the prior transcript as
 * context rather than by reattaching. This type keeps that a stated refusal
 * instead of an empty stream a caller could mistake for an idle session.
 */
export class ResumedSdkAgentSession implements AgentSession {
  constructor(public readonly id: string) {}

  get events(): AsyncIterable<AgentEvent> {
    return (async function* () {
      // Nothing to stream — there is no session behind this id on this
      // transport. `sendInput` is where the refusal surfaces.
    })();
  }

  async sendInput(_input: UserEvent): Promise<void> {
    throw new Error(
      `SdkRuntime: resuming an existing session by id is not supported (session "${this.id}"). ` +
        `Start a new session via runRoleSession() and pass the previous transcript as context if continuation is required.`,
    );
  }

  async interrupt(): Promise<void> {
    // No-op — there is no live SDK Query to interrupt.
  }
}

/**
 * Convenience export so the test suite can verify the FabState plumbing
 * without spinning up an SDK process. Re-exporting allows callers to mock
 * `buildSystemPrompt` if they want to assert prompt contents.
 */
export function _buildSdkSystemPrompt(role: TeamRole, state: FabState): string {
  const member = TEAM.find((m) => m.role === role);
  if (!member) throw new Error(`Unknown role: "${role}"`);
  return buildSystemPrompt(member, state);
}
