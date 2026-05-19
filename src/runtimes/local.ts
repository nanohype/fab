import type { AgentRuntime, AgentSession, RunRoleOptions } from '../runtime.js';
import type { AgentEvent, FabState, TeamRole, UserEvent } from '../types.js';
import { TEAM } from '../team.js';
import { buildSystemPrompt } from '../prompts.js';
import { loadState } from '../state.js';
import { isTerminal, textOf, translateSdkMessage } from './sdk-events.js';

/**
 * Local agent runtime backed by `@anthropic-ai/claude-agent-sdk`.
 *
 * Runs the same role definitions in-process via Claude Code's Agent SDK
 * instead of the Managed Agents REST API. The SDK is loaded dynamically so
 * fab remains installable without it (it ships as an optional
 * dependency); a clear error fires if local mode is selected without the
 * package present.
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
 *   - Memory: handled via SDK MCP server configuration (same gateway URLs
 *     as managed-agents mode).
 *   - Threading: SDK does not expose Anthropic threading; multi-thread
 *     events are not emitted locally.
 *
 * Picked by setting `FAB_RUNTIME=local` at startup. See
 * `src/runtimes/index.ts` for the selection logic.
 */
export class LocalRuntime implements AgentRuntime {
  async runRoleSession(role: TeamRole, message: string, options?: RunRoleOptions): Promise<AgentSession> {
    const member = TEAM.find((m) => m.role === role);
    if (!member) {
      throw new Error(`Unknown role: "${role}"`);
    }

    const state = await loadState();
    const systemPrompt = buildSystemPrompt(member, state);

    const sdk = await loadSdk();
    const session = new LocalAgentSession(sdk, member.model, systemPrompt, options);
    await session.start(message);
    return session;
  }

  resumeSession(sessionId: string): AgentSession {
    // The SDK supports resume via `options.resume`, but resumption needs
    // a fresh `query()` call — there is no persistent handle to attach
    // to. We construct an empty session pointed at the SDK and wait for
    // the caller's first input to actually re-open it via `sendInput`.
    return new ResumedLocalAgentSession(sessionId);
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
      `LocalRuntime requires "@anthropic-ai/claude-agent-sdk" to be installed.\n` +
        `Run: npm install @anthropic-ai/claude-agent-sdk`,
      { cause: err },
    );
  }
}

class LocalAgentSession implements AgentSession {
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
  ) {}

  get id(): string {
    return this.capturedSessionId ?? 'local-session-pending';
  }

  async start(initialMessage: string): Promise<void> {
    const inputs = this.makeInputIterable();
    // Seed the first user message so the agent has something to process.
    void this.enqueueInput({
      type: 'user',
      message: { role: 'user', content: initialMessage },
      parent_tool_use_id: null,
    });

    this.sdkQuery = this.sdk.query({
      prompt: inputs,
      options: {
        model: this.model,
        systemPrompt: this.systemPrompt,
        permissionMode: 'bypassPermissions',
        // Resources hint: the SDK uses cwd for filesystem-bound tools;
        // workflows.ts pre-creates branches on the cloud-mounted repos
        // for managed-agents mode. Local mode operates against the
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
        // does not depend on them in local mode.
        return;
      default:
        throw new Error(`LocalRuntime: unhandled UserEvent type "${(input as { type: string }).type}"`);
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
      throw new Error('LocalRuntime: cannot send input after the session is closed');
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
      throw new Error('LocalRuntime: session has not been started');
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
 * arrives it transitions into a live `LocalAgentSession`. We keep this
 * separate from {@link LocalAgentSession} because the SDK requires a fresh
 * `query()` call with `options.resume` — there is no way to attach to an
 * already-running process by id.
 */
class ResumedLocalAgentSession implements AgentSession {
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
      `LocalRuntime: resuming an existing local session by id is not supported (session "${this.id}"). ` +
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
export function _buildLocalSystemPrompt(role: TeamRole, state: FabState): string {
  const member = TEAM.find((m) => m.role === role);
  if (!member) throw new Error(`Unknown role: "${role}"`);
  return buildSystemPrompt(member, state);
}
