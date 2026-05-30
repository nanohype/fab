import { readFileSync } from 'node:fs';

/**
 * Minimal in-cluster Kubernetes API client — `fetch`-based, no new
 * dependency, mirroring the shape of {@link AnthropicAgents} in `src/api.ts`.
 *
 * It speaks just enough of the API for the `sdk-k8s` runtime: create / read /
 * delete `AgentSandbox` CRs, read the owning `Platform` to resolve its tenant
 * namespace, and tail a session pod's log.
 *
 * Auth is the pod's projected ServiceAccount token, re-read per request so a
 * rotated token is picked up. TLS trust for the cluster's own CA is expected
 * via `NODE_EXTRA_CA_CERTS` on fab's Deployment (see `deploy/rbac.yaml`) —
 * keeping this client a plain `fetch` caller with nothing to configure.
 */

const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CRD_VERSION = 'v1alpha1';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Per-kind CRD group taxonomy on the `nanohype.dev` domain. Each kind lives in
 * one of three groups; the version stays `v1alpha1` across all of them.
 *
 *   - `platform.nanohype.dev`   — Tenant, Platform
 *   - `agents.nanohype.dev`     — AgentFleet, ModelGateway, AgentSandbox, SandboxPool
 *   - `governance.nanohype.dev` — BudgetPolicy, EvalSuite
 */
export const CRD_GROUP_BY_KIND = {
  Tenant: 'platform.nanohype.dev',
  Platform: 'platform.nanohype.dev',
  AgentFleet: 'agents.nanohype.dev',
  ModelGateway: 'agents.nanohype.dev',
  AgentSandbox: 'agents.nanohype.dev',
  SandboxPool: 'agents.nanohype.dev',
  BudgetPolicy: 'governance.nanohype.dev',
  EvalSuite: 'governance.nanohype.dev',
} as const;

/** A CRD kind fab knows the group for. */
export type CrdKind = keyof typeof CRD_GROUP_BY_KIND;

/** Resolve the CRD group for a kind. */
export function groupForKind(kind: CrdKind): string {
  return CRD_GROUP_BY_KIND[kind];
}

/** Build the `apiVersion` (`<group>/<version>`) for a kind. */
export function apiVersionForKind(kind: CrdKind): string {
  return `${groupForKind(kind)}/${CRD_VERSION}`;
}

/** A session-pod environment entry — the literal-value form of `corev1.EnvVar`. */
export interface EnvVar {
  name: string;
  value: string;
}

/** The `AgentSandbox` CR body fab POSTs to create one role-session pod. */
export interface AgentSandboxManifest {
  apiVersion: string;
  kind: string;
  metadata: { generateName?: string; name?: string; namespace?: string };
  spec: {
    platformRef: { name: string };
    image: string;
    command?: string[];
    args?: string[];
    env?: EnvVar[];
    runtimeClassName?: string;
  };
}

/** An `AgentSandbox` as read back — only the fields the runtime consumes. */
export interface AgentSandboxResource {
  metadata: { name: string; namespace: string };
  status?: { phase?: string; podName?: string; podPhase?: string };
}

/** A `Platform` as read back — `status.namespace` is the tenant namespace. */
export interface PlatformResource {
  metadata: { name: string; namespace: string };
  status?: { namespace?: string; phase?: string };
}

/** A `Pod` as read back — only `status.phase`, used to wait for container start. */
export interface PodResource {
  metadata: { name: string; namespace: string };
  status?: { phase?: string };
}

export class K8sClient {
  private readonly base: string;

  constructor() {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    if (!host) {
      throw new Error(
        'K8sClient: KUBERNETES_SERVICE_HOST is not set. The sdk-k8s runtime must run inside a Kubernetes pod.',
      );
    }
    const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
    this.base = `https://${host}:${port}`;
  }

  // ── AgentSandbox ──────────────────────────────────────────────────

  async createAgentSandbox(namespace: string, manifest: AgentSandboxManifest): Promise<AgentSandboxResource> {
    return this.request('POST', this.agentSandboxPath(namespace), manifest);
  }

  async getAgentSandbox(namespace: string, name: string): Promise<AgentSandboxResource> {
    return this.request('GET', `${this.agentSandboxPath(namespace)}/${name}`);
  }

  async deleteAgentSandbox(namespace: string, name: string): Promise<void> {
    await this.request('DELETE', `${this.agentSandboxPath(namespace)}/${name}`);
  }

  // ── Platform ──────────────────────────────────────────────────────

  async getPlatform(namespace: string, name: string): Promise<PlatformResource> {
    const group = groupForKind('Platform');
    return this.request('GET', `/apis/${group}/${CRD_VERSION}/namespaces/${namespace}/platforms/${name}`);
  }

  // ── Pods ──────────────────────────────────────────────────────────

  async getPod(namespace: string, name: string): Promise<PodResource> {
    return this.request('GET', `/api/v1/namespaces/${namespace}/pods/${name}`);
  }

  /**
   * Stream a pod's container log, following until the container exits. The
   * caller passes an `AbortSignal` to bound the overall wait — a `follow`
   * connection has no natural timeout.
   */
  async *followPodLog(namespace: string, name: string, signal?: AbortSignal): AsyncGenerator<string> {
    const path = `/api/v1/namespaces/${namespace}/pods/${name}/log?follow=true&timestamps=false`;
    const res = await fetch(`${this.base}${path}`, { headers: this.headers(), signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${body}`);
    }
    if (!res.body) throw new Error('pod log stream returned no body');

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as BufferSource, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) yield line;
    }
    if (buffer) yield buffer;
  }

  // ── internals ─────────────────────────────────────────────────────

  private agentSandboxPath(namespace: string): string {
    const group = groupForKind('AgentSandbox');
    return `/apis/${group}/${CRD_VERSION}/namespaces/${namespace}/agentsandboxes`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${readServiceAccountToken()}`,
      Accept: 'application/json',
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = this.headers();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
}

/** Read the projected ServiceAccount token, fresh each call to survive rotation. */
function readServiceAccountToken(): string {
  try {
    return readFileSync(TOKEN_PATH, 'utf-8').trim();
  } catch (err) {
    throw new Error(
      `K8sClient: cannot read the in-cluster ServiceAccount token at ${TOKEN_PATH}. ` +
        `The sdk-k8s runtime must run in a pod with a mounted ServiceAccount token.`,
      { cause: err },
    );
  }
}
