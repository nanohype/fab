import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AgentEvent } from '../src/types.js';
import { serializeEvent } from '../src/runtimes/role-session.js';
import {
  buildAgentSandboxManifest,
  parseLogLine,
  resolveK8sDispatchConfig,
  type K8sDispatchConfig,
} from '../src/runtimes/sdk-k8s.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveK8sDispatchConfig', () => {
  it('throws listing every missing required env var', () => {
    vi.stubEnv('FAB_K8S_NAMESPACE', undefined);
    vi.stubEnv('FAB_K8S_SESSION_IMAGE', undefined);
    vi.stubEnv('FAB_K8S_PLATFORM', undefined);
    expect(() => resolveK8sDispatchConfig()).toThrow(
      /FAB_K8S_NAMESPACE.*FAB_K8S_SESSION_IMAGE.*FAB_K8S_PLATFORM/s,
    );
  });

  it('resolves the config when the required env vars are set', () => {
    vi.stubEnv('FAB_K8S_NAMESPACE', 'eks-agent-platform');
    vi.stubEnv('FAB_K8S_SESSION_IMAGE', 'ghcr.io/nanohype/fab:1.2.3');
    vi.stubEnv('FAB_K8S_PLATFORM', 'acme');
    vi.stubEnv('FAB_K8S_RUNTIME_CLASS', undefined);
    expect(resolveK8sDispatchConfig()).toEqual({
      namespace: 'eks-agent-platform',
      sessionImage: 'ghcr.io/nanohype/fab:1.2.3',
      platform: 'acme',
      runtimeClassName: undefined,
    });
  });

  it('carries the optional runtime class through', () => {
    vi.stubEnv('FAB_K8S_NAMESPACE', 'eks-agent-platform');
    vi.stubEnv('FAB_K8S_SESSION_IMAGE', 'ghcr.io/nanohype/fab:1.2.3');
    vi.stubEnv('FAB_K8S_PLATFORM', 'acme');
    vi.stubEnv('FAB_K8S_RUNTIME_CLASS', 'gvisor');
    expect(resolveK8sDispatchConfig().runtimeClassName).toBe('gvisor');
  });
});

describe('buildAgentSandboxManifest', () => {
  const cfg: K8sDispatchConfig = {
    namespace: 'eks-agent-platform',
    sessionImage: 'ghcr.io/nanohype/fab:1.2.3',
    platform: 'acme',
  };

  it('builds an AgentSandbox CR that runs the role-session entrypoint', () => {
    vi.stubEnv('FAB_INFERENCE', undefined);
    vi.stubEnv('AWS_REGION', undefined);
    const manifest = buildAgentSandboxManifest('go-engineer', 'build the thing', cfg);
    expect(manifest.apiVersion).toBe('agents.nanohype.dev/v1alpha1');
    expect(manifest.kind).toBe('AgentSandbox');
    expect(manifest.metadata.generateName).toBe('fab-go-engineer-');
    expect(manifest.spec.platformRef).toEqual({ name: 'acme' });
    expect(manifest.spec.image).toBe('ghcr.io/nanohype/fab:1.2.3');
    expect(manifest.spec.command).toEqual(['node', 'dist/bin/fab.js', 'role-session']);
    expect(manifest.spec.env).toContainEqual({ name: 'FAB_ROLE', value: 'go-engineer' });
    expect(manifest.spec.env).toContainEqual({ name: 'FAB_MESSAGE', value: 'build the thing' });
    expect(manifest.spec.runtimeClassName).toBeUndefined();
  });

  it('carries no state-file variable onto the session pod', () => {
    // What reaches the pod decides which ceilings apply inside it. The Agent
    // SDK's own spend cap is read from the operator's state file, so a pod with
    // no variable naming that file has span-driven enforcement and nothing
    // else — which is what the runbook tells an operator. Asserted here so the
    // manifest and that sentence cannot part.
    for (const key of ['FAB_STATE_FILE', 'FAB_QUALITY_FILE', 'ANTHROPIC_API_KEY']) {
      vi.stubEnv(key, '/somewhere/state.json');
    }
    const manifest = buildAgentSandboxManifest('go-engineer', 'go', cfg);
    const names = (manifest.spec.env ?? []).map((e) => e.name);
    expect(names).not.toContain('FAB_STATE_FILE');
    expect(names).not.toContain('FAB_QUALITY_FILE');
    expect(names).not.toContain('ANTHROPIC_API_KEY');
  });

  it('carries the variables the in-pod session is bounded by', () => {
    // The wall clocks do reach the pod, and by this channel: a pod cannot read
    // the operator's state file, so anything the session must honour has to be
    // named here.
    vi.stubEnv('FAB_SESSION_IDLE_MS', '900000');
    vi.stubEnv('FAB_SESSION_TOTAL_MS', '1800000');
    const manifest = buildAgentSandboxManifest('go-engineer', 'go', cfg);
    expect(manifest.spec.env).toContainEqual({ name: 'FAB_SESSION_IDLE_MS', value: '900000' });
    expect(manifest.spec.env).toContainEqual({ name: 'FAB_SESSION_TOTAL_MS', value: '1800000' });
  });

  it('forwards the inference backend onto the session pod env', () => {
    vi.stubEnv('FAB_INFERENCE', 'bedrock');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    const manifest = buildAgentSandboxManifest('go-engineer', 'x', cfg);
    expect(manifest.spec.env).toContainEqual({ name: 'FAB_INFERENCE', value: 'bedrock' });
    expect(manifest.spec.env).toContainEqual({ name: 'AWS_REGION', value: 'us-east-1' });
  });

  it('forwards the per-session attribution vars onto the session pod env', () => {
    vi.stubEnv('FAB_OPERATOR', 'alice@acme.com');
    vi.stubEnv('FAB_SESSION_ROLE_ARN', 'arn:aws:iam::111111111111:role/fab-session');
    vi.stubEnv('FAB_SESSION_DURATION', '7200');
    const manifest = buildAgentSandboxManifest('go-engineer', 'x', cfg);
    expect(manifest.spec.env).toContainEqual({ name: 'FAB_OPERATOR', value: 'alice@acme.com' });
    expect(manifest.spec.env).toContainEqual({
      name: 'FAB_SESSION_ROLE_ARN',
      value: 'arn:aws:iam::111111111111:role/fab-session',
    });
    expect(manifest.spec.env).toContainEqual({ name: 'FAB_SESSION_DURATION', value: '7200' });
  });

  it('omits attribution vars when unset (unattributed default)', () => {
    vi.stubEnv('FAB_OPERATOR', undefined);
    vi.stubEnv('FAB_SESSION_ROLE_ARN', undefined);
    const manifest = buildAgentSandboxManifest('go-engineer', 'x', cfg);
    expect((manifest.spec.env ?? []).some((e) => e.name === 'FAB_OPERATOR')).toBe(false);
  });

  it('sets runtimeClassName when the config carries one', () => {
    vi.stubEnv('FAB_INFERENCE', undefined);
    vi.stubEnv('AWS_REGION', undefined);
    const manifest = buildAgentSandboxManifest('go-engineer', 'x', {
      ...cfg,
      runtimeClassName: 'gvisor',
    });
    expect(manifest.spec.runtimeClassName).toBe('gvisor');
  });
});

describe('parseLogLine', () => {
  it('round-trips an AgentEvent serialized by the role-session entrypoint', () => {
    const events: AgentEvent[] = [
      {
        type: 'agent.message',
        id: 'm1',
        content: [{ type: 'text', text: 'on it' }],
        processed_at: '2026-05-22T00:00:00Z',
      },
      { type: 'session.status_idle', id: 's1', processed_at: '2026-05-22T00:00:01Z' },
    ];
    for (const event of events) {
      expect(parseLogLine(serializeEvent(event))).toEqual(event);
    }
  });

  it('returns null for blank lines and non-JSON log noise', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('   ')).toBeNull();
    expect(parseLogLine('[sdk-k8s] a stderr diagnostic line')).toBeNull();
  });
});
