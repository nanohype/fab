import type { AgentRuntime, AgentSession, RunRoleOptions } from '../runtime.js';
import type { AgentEvent, FabState, TeamRole, UserEvent } from '../types.js';
import { TEAM } from '../team.js';
import { buildSystemPrompt } from '../prompts.js';
import { loadState, getBudgetLimit } from '../state.js';
import { inferenceEnv, resolveInferenceBackend, resolveModelId, type InferenceBackend } from '../inference.js';
import { isTerminal, textOf, translateSdkMessage } from './sdk-events.js';

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
  async runRoleSession(role: TeamRole, message: string, options?: RunRoleOptions): Promise<AgentSession> {
    const member = TEAM.find((m) => m.role === role);
    if (!member) {
      throw new Error(`Unknown role: "${role}"`);
    }

    const state = await loadState();
    const systemPrompt = buildSystemPrompt(member, state);

    const backend = resolveInferenceBackend();
    const model = resolveModelId(member.model, backend);
    // Native per-run budget: the SDK stops the loop with an error_max_budget_usd
    // result when this USD cap is exceeded. This is how budget enforcement
    // reaches the sdk/sdk-k8s transports — managed-agents enforces it via span
    // accumulation + interrupt in streamSessionWithAdvisor, which never fires
    // here (these transports emit no cost spans).
    const budgetUsd = await getBudgetLimit();

    const sdk = await loadSdk();
    const session = new SdkAgentSession(sdk, model, systemPrompt, options, backend, budgetUsd);
    await session.start(message);
    return session;
  }

  resumeSession(sessionId: string): AgentSession {
    // The SDK supports resume via `options.resume`, but resumption needs
    // a fresh `query()` call — there is no persistent handle to attach
    // to. We construct an empty session pointed at the SDK and wait for
    // the caller's first input to actually re-open it via `sendInput`.
    return new ResumedSdkAgentSession(sessionId);
  }
}

interface AgentSdkModule {
  query: (params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => SdkQuery;
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

class SdkAgentSession implements AgentSession {
  private inputQueue: { resolve: (value: IteratorResult<unknown>) => void }[] = [];
  private pendingInputs: unknown[] = [];
  private closed = false;
  private sdkQuery: SdkQuery | null = null;
  private capturedSessionId: string | null = null;

  constructor(
    private readonly sdk: AgentSdkModule,
    private readonly model: string,
    private readonly systemPrompt: string,
    private readonly options?: RunRoleOptions,
    private readonly backend: InferenceBackend = 'api',
    private readonly budgetUsd: number | null = null,
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
      options: {
        model: this.model,
        systemPrompt: this.systemPrompt,
        permissionMode: 'bypassPermissions',
        ...(this.budgetUsd != null && { maxBudgetUsd: this.budgetUsd }),
        ...(backendEnv && { env: { ...process.env, ...backendEnv } }),
        // Resources hint: the SDK uses cwd for filesystem-bound tools;
        // workflows.ts pre-creates branches on the cloud-mounted repos
        // for managed-agents mode. The sdk runtime operates against the
        // caller's cwd; the user is responsible for cloning the repos
        // beforehand.
        ...(this.options?.metadata && { metadata: this.options.metadata }),
      },
    });
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.translateEvents();
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
        throw new Error(`SdkRuntime: unhandled UserEvent type "${(input as { type: string }).type}"`);
    }
  }

  async interrupt(): Promise<void> {
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
    for await (const raw of this.sdkQuery) {
      const event = translateSdkMessage(raw, (id) => {
        this.capturedSessionId = id;
      });
      if (event) yield event;
      // After a terminal result the loop ends naturally; close the input
      // iterable so the SDK's process can shut down cleanly.
      if (event && isTerminal(event)) {
        this.closeInput();
      }
    }
  }
}

/**
 * Stand-in for a resumed session before its first input fires. Once input
 * arrives it transitions into a live `SdkAgentSession`. We keep this
 * separate from {@link SdkAgentSession} because the SDK requires a fresh
 * `query()` call with `options.resume` — there is no way to attach to an
 * already-running process by id.
 */
class ResumedSdkAgentSession implements AgentSession {
  constructor(public readonly id: string) {}

  get events(): AsyncIterable<AgentEvent> {
    return (async function* () {
      // Empty stream until the caller sends an input. Workflow code drives
      // resume through `runRoleSession`, not through standalone reattach,
      // so this is a deliberate no-op rather than a half-built reopen path.
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
