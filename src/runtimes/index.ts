import type { AnthropicAgents } from '../api.js';
import type { AgentRuntime } from '../runtime.js';
import { ClaudeCliRuntime } from './claude-cli.js';
import { SdkRuntime } from './sdk.js';
import { ManagedAgentsRuntime } from './managed-agents.js';
import { SdkK8sRuntime } from './sdk-k8s.js';

export type RuntimeKind = 'managed-agents' | 'sdk' | 'sdk-k8s' | 'claude-cli';

const RUNTIME_KINDS: ReadonlySet<RuntimeKind> = new Set(['managed-agents', 'sdk', 'sdk-k8s', 'claude-cli']);

/**
 * Resolve the configured runtime from the `FAB_RUNTIME` env var.
 *
 * Default is `managed-agents`. Set `FAB_RUNTIME=sdk` to run workflows
 * against `@anthropic-ai/claude-agent-sdk` in-process, `FAB_RUNTIME=sdk-k8s`
 * to dispatch each role-session as its own isolated pod on the
 * eks-agent-platform substrate, or `FAB_RUNTIME=claude-cli` to drive the
 * `claude` CLI as a subprocess (subscription-billable via the user's
 * existing Claude Code auth). The trade-offs are documented in
 * `docs/transports.md`.
 *
 * The `api` argument is only consumed by `ManagedAgentsRuntime`; the other
 * runtimes accept it as a no-op so callers don't have to branch at the
 * call site.
 */
export function createRuntime(api: AnthropicAgents): AgentRuntime {
  switch (resolveRuntimeKind()) {
    case 'sdk':
      return new SdkRuntime();
    case 'sdk-k8s':
      return new SdkK8sRuntime();
    case 'claude-cli':
      return new ClaudeCliRuntime();
    case 'managed-agents':
      return new ManagedAgentsRuntime(api);
  }
}

export function resolveRuntimeKind(): RuntimeKind {
  const choice = (process.env.FAB_RUNTIME ?? 'managed-agents').trim();
  if (RUNTIME_KINDS.has(choice as RuntimeKind)) return choice as RuntimeKind;
  throw new Error(
    `Unknown FAB_RUNTIME value: "${choice}". Expected "managed-agents" (default), "sdk", "sdk-k8s", or "claude-cli".`,
  );
}

export { ClaudeCliRuntime, SdkRuntime, SdkK8sRuntime, ManagedAgentsRuntime };
