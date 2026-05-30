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
    expect(() => resolveK8sDispatchConfig()).toThrow(/FAB_K8S_NAMESPACE.*FAB_K8S_SESSION_IMAGE.*FAB_K8S_PLATFORM/s);
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

  it('forwards the inference backend onto the session pod env', () => {
    vi.stubEnv('FAB_INFERENCE', 'bedrock');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    const manifest = buildAgentSandboxManifest('go-engineer', 'x', cfg);
    expect(manifest.spec.env).toContainEqual({ name: 'FAB_INFERENCE', value: 'bedrock' });
    expect(manifest.spec.env).toContainEqual({ name: 'AWS_REGION', value: 'us-east-1' });
  });

  it('sets runtimeClassName when the config carries one', () => {
    vi.stubEnv('FAB_INFERENCE', undefined);
    vi.stubEnv('AWS_REGION', undefined);
    const manifest = buildAgentSandboxManifest('go-engineer', 'x', { ...cfg, runtimeClassName: 'gvisor' });
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
