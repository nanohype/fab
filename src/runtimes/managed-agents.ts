import type { AnthropicAgents } from '../api.js';
import type { AgentRuntime, AgentSession, RunRoleOptions } from '../runtime.js';
import type { AgentEvent, SessionResource, TeamRole, UserEvent } from '../types.js';
import {
  getAgentByRole,
  getEnvironmentId,
  getMemoryResource,
  getRepos,
  getVaultIds,
  loadState,
} from '../state.js';
import { collectSessionMetrics } from '../perf.js';

/**
 * Agent runtime implementation against the Anthropic Managed Agents REST API.
 *
 * Wraps the {@link AnthropicAgents} client (`src/api.ts`). The caller
 * (`workflows.ts`) reaches the API through this thin layer instead of the
 * transport-specific session lifecycle calls (`createSession`,
 * `sendMessage`, `stream`); it receives an {@link AgentSession} that's the
 * same shape regardless of transport.
 *
 * Deployment ops (`createAgent`, `createEnvironment`, `createVault`) remain
 * on the underlying `AnthropicAgents` instance and the CLI's `deploy`
 * command. This runtime is the *per-session* layer only.
 */
export class ManagedAgentsRuntime implements AgentRuntime {
  constructor(private readonly api: AnthropicAgents) {}

  async runRoleSession(
    role: TeamRole,
    message: string,
    options?: RunRoleOptions,
  ): Promise<AgentSession> {
    const entry = await getAgentByRole(role);
    if (!entry) {
      throw new Error(`Role "${role}" is not deployed. Run: fab deploy`);
    }
    const envId = await getEnvironmentId();
    if (!envId) {
      throw new Error('No environment configured. Run: fab deploy');
    }

    // Repos + vaults come from the workspace state by default; allow caller
    // to override via options (useful for tests). The shared factory memory
    // store is attached to every session when one has been provisioned.
    const repos = options?.resources ?? (await getRepos());
    const vaultIds = options?.vaultIds ?? (await getVaultIds());
    const memory = await getMemoryResource();
    const resources: SessionResource[] = memory ? [...repos, memory] : repos;

    const sess = await this.api.createSession({
      agent: entry.agentId,
      environment_id: envId,
      ...(options?.title && { title: options.title }),
      ...(resources.length > 0 && { resources }),
      ...(vaultIds.length > 0 && { vault_ids: vaultIds }),
    });

    await this.api.sendMessage(sess.id, message);

    return new ManagedAgentSession(this.api, sess.id);
  }

  resumeSession(sessionId: string): AgentSession {
    return new ManagedAgentSession(this.api, sessionId);
  }

  /**
   * The managed-agents transport exposes the per-session usage + event history
   * (`getSession` / `listEvents`) that the per-role perf table needs. Loads the
   * workspace state to map the session's agent back to its role, then folds the
   * session into `.fab-perf.json`.
   */
  async collectSessionMetrics(sessionId: string): Promise<void> {
    const state = await loadState();
    await collectSessionMetrics(this.api, sessionId, state);
  }
}

class ManagedAgentSession implements AgentSession {
  constructor(
    private readonly api: AnthropicAgents,
    public readonly id: string,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    return this.api.stream(this.id);
  }

  async sendInput(input: UserEvent): Promise<void> {
    // Map the transport-agnostic UserEvent shape to the existing api.ts
    // helpers where they exist, fall through to the generic events endpoint
    // for any input shape the helpers don't cover.
    switch (input.type) {
      case 'user.message':
        await this.api.sendMessage(this.id, textOf(input.content));
        return;
      case 'user.tool_confirmation':
        await this.api.confirmTool(
          this.id,
          input.tool_use_id,
          input.result,
          'session_thread_id' in input ? input.session_thread_id : undefined,
        );
        return;
      case 'user.custom_tool_result':
        await this.api.sendCustomToolResult(
          this.id,
          input.custom_tool_use_id,
          textOf(input.content),
          input.is_error === true,
        );
        return;
      case 'user.interrupt':
        await this.api.interrupt(this.id);
        return;
      default:
        throw new Error(
          `ManagedAgentsRuntime: unhandled UserEvent type "${(input as { type: string }).type}"`,
        );
    }
  }

  async interrupt(): Promise<void> {
    await this.api.interrupt(this.id);
  }
}

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('');
}
