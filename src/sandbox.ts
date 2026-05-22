import type { EnvironmentConfig } from './types.js';

/**
 * Where the Managed Agents tool sandbox runs.
 *
 * `cloud` (default) — Anthropic-managed sandbox containers. `self-hosted`
 * — the sandbox runs on the adopter's own infrastructure; Anthropic
 * dispatches tool-execution work to workers the adopter hosts (the
 * `eks-agent-platform` SandboxPool substrate). Only the `managed-agents`
 * transport reads this — the `sdk` and `claude-cli` runtimes do not use
 * Managed Agents environments.
 */
export type SandboxMode = 'cloud' | 'self-hosted';

const SANDBOX_MODES: ReadonlySet<SandboxMode> = new Set<SandboxMode>(['cloud', 'self-hosted']);

/** Resolve the sandbox mode from `FAB_SANDBOX` (default `cloud`). */
export function resolveSandboxMode(): SandboxMode {
  const choice = (process.env.FAB_SANDBOX ?? 'cloud').trim();
  if (SANDBOX_MODES.has(choice as SandboxMode)) return choice as SandboxMode;
  throw new Error(`Unknown FAB_SANDBOX value: "${choice}". Expected "cloud" (default) or "self-hosted".`);
}

/**
 * The `config` for `createEnvironment`. `cloud` provisions an
 * Anthropic-managed sandbox preloaded with the factory's package set;
 * `self-hosted` carries no networking or packages — the worker image the
 * adopter runs owns those.
 */
export function environmentConfig(mode: SandboxMode): EnvironmentConfig {
  if (mode === 'self-hosted') {
    return { type: 'self_hosted' };
  }
  return {
    type: 'cloud',
    networking: { type: 'unrestricted' },
    packages: { npm: ['typescript', '@nanohype/sdk'], pip: ['pandas'] },
  };
}
