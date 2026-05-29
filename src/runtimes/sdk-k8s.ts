import type { AgentRuntime, AgentSession } from '../runtime.js';
import type { AgentEvent, TeamRole, UserEvent } from '../types.js';
import { TEAM } from '../team.js';
import { isTerminal } from './sdk-events.js';
import { K8sClient, apiVersionForKind, type AgentSandboxManifest, type AgentSandboxResource } from '../k8s.js';

/**
 * Kubernetes-dispatch SDK runtime.
 *
 * Where {@link SdkRuntime} runs every role-session inside fab's own process,
 * `sdk-k8s` dispatches each one as its own isolated, hardened pod on the
 * eks-agent-platform substrate. `runRoleSession` creates an `AgentSandbox`
 * CR; the operator turns that into a single-use pod that runs the unmodified
 * `sdk` loop via `fab role-session`. The pod's log is the wire — fab tails it
 * and parses each JSON line back into the event stream, so the workflow layer
 * sees a remote pod session as just another `AgentSession`.
 *
 * The session is one-way: the `sdk` role-loop emits a linear event stream and
 * never needs `sendInput`, so there is no channel back into the pod beyond
 * deleting the CR to interrupt it.
 *
 * Picked with `FAB_RUNTIME=sdk-k8s`. Must run inside the cluster — see
 * {@link K8sClient} and `deploy/rbac.yaml`. Inference still flows through the
 * `sdk` path inside the pod; pair it with `FAB_INFERENCE=bedrock` for the
 * Bedrock + per-session-isolation end state.
 */

const ENV_NAMESPACE = 'FAB_K8S_NAMESPACE';
const ENV_SESSION_IMAGE = 'FAB_K8S_SESSION_IMAGE';
const ENV_PLATFORM = 'FAB_K8S_PLATFORM';
const ENV_RUNTIME_CLASS = 'FAB_K8S_RUNTIME_CLASS';

/**
 * Dispatcher env vars forwarded onto the session pod so the in-pod `sdk`
 * runtime infers against the same backend the dispatcher was configured for.
 */
const FORWARDED_ENV = ['FAB_INFERENCE', 'AWS_REGION', 'ANTHROPIC_AWS_WORKSPACE_ID'] as const;

/** The session pod runs the in-pod role-session entrypoint. */
const SESSION_COMMAND = ['node', 'dist/bin/fab.js', 'role-session'];

const POLL_INTERVAL_MS = 2_000;
/** How long to wait for the operator to create the session pod object. */
const POD_SCHEDULE_TIMEOUT_MS = 120_000;
/** How long to wait for the pod's container to start — covers node provisioning + image pull. */
const POD_START_TIMEOUT_MS = 300_000;
/** Overall cap on a single session's log follow — bounds a hung pod. */
const LOG_FOLLOW_TIMEOUT_MS = 1_800_000;

/** Resolved dispatch target for the sdk-k8s runtime. */
export interface K8sDispatchConfig {
  /** Namespace holding the Platform CR — also where the AgentSandbox CRs land. */
  namespace: string;
  /** Container image the session pod runs (the fab image). */
  sessionImage: string;
  /** Name of the Platform the role-sessions run under. */
  platform: string;
  /** Optional RuntimeClass for the session pod — the gVisor/Kata isolation dial. */
  runtimeClassName?: string;
}

/** Resolve the sdk-k8s dispatch config from the environment, failing fast. */
export function resolveK8sDispatchConfig(): K8sDispatchConfig {
  const namespace = process.env[ENV_NAMESPACE]?.trim();
  const sessionImage = process.env[ENV_SESSION_IMAGE]?.trim();
  const platform = process.env[ENV_PLATFORM]?.trim();

  const missing: string[] = [];
  if (!namespace) missing.push(ENV_NAMESPACE);
  if (!sessionImage) missing.push(ENV_SESSION_IMAGE);
  if (!platform) missing.push(ENV_PLATFORM);
  if (missing.length > 0) {
    throw new Error(
      `The sdk-k8s runtime requires ${missing.join(', ')} to be set — ` +
        `${ENV_NAMESPACE} (the namespace holding the Platform CR), ` +
        `${ENV_SESSION_IMAGE} (the fab image the session pod runs), and ` +
        `${ENV_PLATFORM} (the Platform the sessions run under).`,
    );
  }
  return {
    namespace: namespace!,
    sessionImage: sessionImage!,
    platform: platform!,
    runtimeClassName: process.env[ENV_RUNTIME_CLASS]?.trim() || undefined,
  };
}

/** Build the `AgentSandbox` CR for one role-session. */
export function buildAgentSandboxManifest(role: string, message: string, cfg: K8sDispatchConfig): AgentSandboxManifest {
  const env = [
    { name: 'FAB_ROLE', value: role },
    { name: 'FAB_MESSAGE', value: message },
  ];
  for (const key of FORWARDED_ENV) {
    const value = process.env[key];
    if (value) env.push({ name: key, value });
  }
  return {
    apiVersion: apiVersionForKind('AgentSandbox'),
    kind: 'AgentSandbox',
    metadata: { generateName: `fab-${role}-` },
    spec: {
      platformRef: { name: cfg.platform },
      image: cfg.sessionImage,
      command: SESSION_COMMAND,
      env,
      ...(cfg.runtimeClassName ? { runtimeClassName: cfg.runtimeClassName } : {}),
    },
  };
}

/** Parse one pod-log line into an AgentEvent; null for blanks and non-JSON noise. */
export function parseLogLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as AgentEvent;
  } catch {
    return null;
  }
}

export class SdkK8sRuntime implements AgentRuntime {
  async runRoleSession(role: TeamRole, message: string): Promise<AgentSession> {
    if (!TEAM.some((m) => m.role === role)) {
      throw new Error(`Unknown role: "${role}"`);
    }
    const cfg = resolveK8sDispatchConfig();
    const k8s = new K8sClient();
    const created = await k8s.createAgentSandbox(cfg.namespace, buildAgentSandboxManifest(role, message, cfg));
    return new SdkK8sSession(k8s, cfg.namespace, cfg.platform, created.metadata.name);
  }

  resumeSession(sessionId: string): AgentSession {
    return new DetachedSdkK8sSession(sessionId);
  }
}

/**
 * A live remote session: an `AgentSandbox` CR plus the pod the operator built
 * for it. Iterating `events` resolves the tenant namespace, waits for the
 * pod, tails its log, and garbage-collects the CR when the stream ends.
 */
class SdkK8sSession implements AgentSession {
  public readonly id: string;
  private cleanedUp = false;
  private terminalSeen = false;

  constructor(
    private readonly k8s: K8sClient,
    private readonly namespace: string,
    private readonly platform: string,
    private readonly name: string,
  ) {
    this.id = name;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.stream();
  }

  async sendInput(input: UserEvent): Promise<void> {
    // The sdk role-session is one-way — there is no analogue for a follow-up
    // message, tool confirmation, or custom tool result. An interrupt is the
    // one input that maps: it tears the remote pod down.
    if (input.type === 'user.interrupt') await this.interrupt();
  }

  async interrupt(): Promise<void> {
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    try {
      await this.k8s.deleteAgentSandbox(this.namespace, this.name);
    } catch {
      // Already deleted, or the operator's TTL will garbage-collect it — fine.
    }
  }

  private syntheticError(message: string): AgentEvent {
    this.terminalSeen = true;
    return {
      type: 'session.error',
      id: this.name,
      error: { type: 'sdk_k8s_dispatch', message },
      processed_at: new Date().toISOString(),
    };
  }

  private async *stream(): AsyncGenerator<AgentEvent> {
    try {
      let tenantNs: string | undefined;
      try {
        tenantNs = (await this.k8s.getPlatform(this.namespace, this.platform)).status?.namespace;
      } catch (err) {
        yield this.syntheticError(`failed to read Platform "${this.platform}": ${errMessage(err)}`);
        return;
      }
      if (!tenantNs) {
        yield this.syntheticError(
          `Platform "${this.platform}" has no status.namespace — it must be reconciled and Ready before dispatch`,
        );
        return;
      }

      const podName = yield* this.waitForPod();
      if (!podName) return;

      yield* this.followLog(tenantNs, podName);
      if (!this.terminalSeen) {
        yield this.syntheticError('the session pod ended without emitting a terminal event');
      }
    } finally {
      await this.cleanup();
    }
  }

  private async *waitForPod(): AsyncGenerator<AgentEvent, string | undefined> {
    const deadline = Date.now() + POD_SCHEDULE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let box: AgentSandboxResource;
      try {
        box = await this.k8s.getAgentSandbox(this.namespace, this.name);
      } catch (err) {
        process.stderr.write(`[sdk-k8s] transient error reading the AgentSandbox: ${errMessage(err)}\n`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (box.status?.phase === 'Failed') {
        yield this.syntheticError(
          `the operator marked AgentSandbox ${this.name} Failed — the session pod could not be placed`,
        );
        return undefined;
      }
      if (box.status?.podName) return box.status.podName;
      await sleep(POLL_INTERVAL_MS);
    }
    yield this.syntheticError(`timed out after ${POD_SCHEDULE_TIMEOUT_MS}ms waiting for the session pod to be created`);
    return undefined;
  }

  private async *followLog(tenantNs: string, podName: string): AsyncGenerator<AgentEvent> {
    // The pod-log endpoint rejects a container that is still Waiting, so wait
    // for it to start (or already be terminal) before opening the stream.
    let started = false;
    const deadline = Date.now() + POD_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let phase: string | undefined;
      try {
        phase = (await this.k8s.getPod(tenantNs, podName)).status?.phase;
      } catch (err) {
        process.stderr.write(`[sdk-k8s] transient error polling the session pod: ${errMessage(err)}\n`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (phase === 'Running' || phase === 'Succeeded' || phase === 'Failed') {
        started = true;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (!started) {
      yield this.syntheticError(`the session pod ${podName} did not start within ${POD_START_TIMEOUT_MS}ms`);
      return;
    }

    try {
      const signal = AbortSignal.timeout(LOG_FOLLOW_TIMEOUT_MS);
      for await (const line of this.k8s.followPodLog(tenantNs, podName, signal)) {
        const event = parseLogLine(line);
        if (!event) {
          if (line.trim().startsWith('{')) {
            process.stderr.write(`[sdk-k8s] dropped malformed log line: ${line.trim().slice(0, 120)}\n`);
          }
          continue;
        }
        yield event;
        if (isTerminal(event)) {
          this.terminalSeen = true;
          return;
        }
      }
    } catch (err) {
      yield this.syntheticError(`session pod log stream failed: ${errMessage(err)}`);
    }
  }
}

/**
 * Stand-in for a resumed session id. A remote role-session runs in a
 * single-use pod (restartPolicy Never) — there is nothing to reattach to, so
 * resume is unsupported. Mirrors `SdkRuntime`'s resumed-session stance.
 */
class DetachedSdkK8sSession implements AgentSession {
  constructor(public readonly id: string) {}

  get events(): AsyncIterable<AgentEvent> {
    return (async function* () {
      // No live pod to attach to — an empty stream.
    })();
  }

  async sendInput(_input: UserEvent): Promise<void> {
    throw new Error(
      `SdkK8sRuntime: resuming a remote pod session by id is not supported (session "${this.id}"). ` +
        `Each role-session runs in a single-use AgentSandbox pod — start a fresh session via runRoleSession().`,
    );
  }

  async interrupt(): Promise<void> {
    // No live pod — nothing to interrupt.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
