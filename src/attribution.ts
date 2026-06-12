/**
 * Per-session human attribution.
 *
 * By default every fab session — and so every Bedrock call and every `aws` /
 * `kubectl` the agent runs — acts as the pod's tenant IRSA role, bound to no
 * named human. That is the platform default, and it is exactly the
 * "production action that traces to no named human" gap an evidence engine
 * (crossbearing) surfaces. This module is the opt-in that closes it: name the
 * human a session acts for, and carry that identity into the cloud record so
 * the action attributes to a person.
 *
 * Two mechanisms, one operator:
 *
 *   - **AWS — STS SourceIdentity.** Assume a session role carrying the operator
 *     as `SourceIdentity`, using the pod's own IRSA credentials as the caller,
 *     and export the temporary credentials. Every subsequent AWS call — the
 *     Bedrock `InvokeModel` inference call AND any `aws` the Bash tool runs — is
 *     recorded in CloudTrail under `SourceIdentity=<operator>`. This is the
 *     strongest binding crossbearing reads (`AttrSTSSourceIdentity`).
 *   - **Kubernetes — impersonation.** Point `kubectl` at a kubeconfig that
 *     authenticates with the pod's ServiceAccount token but impersonates the
 *     operator, so the apiserver records the operator in the audit log's
 *     `impersonatedUser` field (`AttrK8sImpersonation`) — the same human as the
 *     AWS side.
 *
 * Why SourceIdentity and not Bedrock `requestMetadata`: the Agent SDK does not
 * expose the `InvokeModel` request, so fab cannot stamp Bedrock
 * `requestMetadata` from this path. SourceIdentity is reachable (it rides the
 * credentials, which the SDK resolves from the standard chain) and it is
 * crossbearing's strongest binding — it attributes the agent's `aws` and
 * `kubectl` tool-call records, which crossbearing actually corroborates. (The
 * Bedrock `InvokeModel` call carries the same SourceIdentity in CloudTrail too,
 * but crossbearing's corroborated findings come from the tool-call records, not
 * the model call.)
 *
 * No new dependency: like the `claude-cli` runtime, this shells to a CLI
 * already in the agent image (`aws`) via `node:child_process`.
 *
 * The required IAM (a session role whose trust policy lets the tenant IRSA role
 * `sts:AssumeRole` + `sts:SetSourceIdentity`) and the K8s `impersonate` RBAC
 * the session ServiceAccount needs are documented in `docs/attribution.md` —
 * they live on the platform side, not in fab.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const ENV_OPERATOR = 'FAB_OPERATOR';
const ENV_SESSION_ROLE = 'FAB_SESSION_ROLE_ARN';
const ENV_SESSION_DURATION = 'FAB_SESSION_DURATION';

/** In-cluster ServiceAccount paths the kubelet projects into every pod. */
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

const DEFAULT_DURATION_SECONDS = 3600;
const MIN_DURATION_SECONDS = 900;
const MAX_DURATION_SECONDS = 43200;

/** The resolved human a session acts on behalf of, and how long for. */
export interface SessionIdentity {
  /** the named human this session acts on behalf of */
  operator: string;
  /** the role assumed to carry the operator as STS SourceIdentity */
  roleArn: string;
  /** seconds the assumed credentials live (capped by the role's MaxSessionDuration) */
  durationSeconds: number;
}

/** A minimal `aws` runner — injectable so callers can test without the CLI. */
export type CliRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultRunner: CliRunner = (file, args) => execFileAsync(file, args, { timeout: 20_000 });

/**
 * Resolve the per-session operator from the environment, or `null` when
 * attribution is not configured (the session then runs unattributed — the
 * platform default).
 *
 * An operator with no session role is a misconfiguration, not a fallback:
 * there is nothing to carry the human into AWS, so fail loudly rather than
 * silently run as the tenant role.
 */
export function resolveSessionIdentity(env: NodeJS.ProcessEnv = process.env): SessionIdentity | null {
  const operator = env[ENV_OPERATOR]?.trim();
  if (!operator) return null;

  // The operator must already satisfy STS rules so the SAME string binds both
  // sides — AWS SourceIdentity and the Kubernetes impersonated user — with no
  // silent per-path sanitization that would split the human across streams.
  if (!isStsValid(operator)) {
    throw new Error(
      `${ENV_OPERATOR}="${operator}" must be 2–64 characters from [A-Za-z0-9+=,.@_-] ` +
        `(an email works) so the same identity binds AWS SourceIdentity and the Kubernetes impersonated user.`,
    );
  }

  const roleArn = env[ENV_SESSION_ROLE]?.trim();
  if (!roleArn) {
    throw new Error(
      `${ENV_OPERATOR}=${operator} is set but ${ENV_SESSION_ROLE} is not. ` +
        `Attribution needs a role to assume with the operator as STS SourceIdentity; ` +
        `set ${ENV_SESSION_ROLE} to that role's ARN, or unset ${ENV_OPERATOR} to run unattributed.`,
    );
  }

  const raw = env[ENV_SESSION_DURATION]?.trim();
  const durationSeconds = raw ? Number(raw) : DEFAULT_DURATION_SECONDS;
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < MIN_DURATION_SECONDS ||
    durationSeconds > MAX_DURATION_SECONDS
  ) {
    throw new Error(
      `${ENV_SESSION_DURATION} must be an integer ${MIN_DURATION_SECONDS}–${MAX_DURATION_SECONDS} seconds (got "${raw}").`,
    );
  }

  return { operator, roleArn, durationSeconds };
}

/** STS SourceIdentity / RoleSessionName rules: 2–64 chars from [A-Za-z0-9+=,.@_-]. */
const STS_IDENTITY_RE = /^[A-Za-z0-9+=,.@_-]{2,64}$/;

/** Whether a value already satisfies the STS SourceIdentity / RoleSessionName rules. */
export function isStsValid(value: string): boolean {
  return STS_IDENTITY_RE.test(value);
}

/**
 * Sanitize a free-form value to the STS `RoleSessionName` charset and length
 * (2–64), falling back when the result is too short. Used for the internally
 * generated role-session name; the operator is validated up front instead, so
 * it is never silently rewritten.
 */
export function sanitizeForSts(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9+=,.@_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned.length >= 2 ? cleaned : fallback;
}

interface StsCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
}

/**
 * Assume the session role carrying the operator as STS SourceIdentity, using
 * the pod's own (IRSA) credentials as the caller. Returns the temporary
 * credentials as the `AWS_*` env vars the agent's AWS calls will read.
 */
export async function assumeWithSourceIdentity(
  id: SessionIdentity,
  roleSessionName: string,
  run: CliRunner = defaultRunner,
): Promise<Record<string, string>> {
  const { stdout } = await run('aws', [
    'sts',
    'assume-role',
    '--role-arn',
    id.roleArn,
    '--role-session-name',
    sanitizeForSts(roleSessionName, 'fab-session'),
    '--source-identity',
    id.operator, // validated STS-clean by resolveSessionIdentity; used verbatim so AWS == K8s
    '--duration-seconds',
    String(id.durationSeconds),
    '--output',
    'json',
  ]);

  let creds: StsCredentials | undefined;
  try {
    creds = (JSON.parse(stdout) as { Credentials?: StsCredentials }).Credentials;
  } catch {
    throw new Error('aws sts assume-role returned unparseable output');
  }
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error('aws sts assume-role returned no usable credentials');
  }
  return {
    AWS_ACCESS_KEY_ID: creds.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
    AWS_SESSION_TOKEN: creds.SessionToken,
  };
}

/**
 * Write a kubeconfig that authenticates with the pod's ServiceAccount token
 * but impersonates the operator, and return its path. The session's
 * ServiceAccount must hold `impersonate` RBAC on the operator (see
 * `docs/attribution.md`). `operator` is JSON-encoded so it is always a safe
 * YAML scalar.
 */
export function writeImpersonationKubeconfig(operator: string, dir = mkdtempSync(join(tmpdir(), 'fab-kube-'))): string {
  const path = join(dir, 'config');
  const kubeconfig = [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '  - name: in-cluster',
    '    cluster:',
    '      server: https://kubernetes.default.svc',
    `      certificate-authority: ${SA_CA_PATH}`,
    'users:',
    '  - name: operator',
    '    user:',
    `      tokenFile: ${SA_TOKEN_PATH}`,
    `      as: ${JSON.stringify(operator)}`,
    'contexts:',
    '  - name: in-cluster',
    '    context:',
    '      cluster: in-cluster',
    '      user: operator',
    'current-context: in-cluster',
    '',
  ].join('\n');
  writeFileSync(path, kubeconfig, { mode: 0o600 });
  return path;
}

/**
 * Apply the operator's identity to `env` (defaults to `process.env`) so the
 * in-process agent and its tool subprocesses inherit it: assume the session
 * role with SourceIdentity (AWS) and point `kubectl` at an impersonating
 * kubeconfig (K8s). Returns the resolved identity, or `null` when attribution
 * is not configured.
 *
 * Throws on a configured-but-failed setup. Callers MUST fail the session on a
 * throw rather than continue: running unattributed after a human was named
 * would silently strip the binding the evidence depends on.
 */
export async function applySessionIdentity(
  roleSessionName: string,
  env: NodeJS.ProcessEnv = process.env,
  run: CliRunner = defaultRunner,
): Promise<SessionIdentity | null> {
  const id = resolveSessionIdentity(env);
  if (!id) return null;

  // Compute both bindings before mutating env, so a failure in either leaves
  // env untouched rather than half-attributed (AWS set, K8s not).
  const creds = await assumeWithSourceIdentity(id, roleSessionName, run);
  const kubeconfig = writeImpersonationKubeconfig(id.operator);

  Object.assign(env, creds);
  env.KUBECONFIG = kubeconfig;
  // Drop the pod's IRSA web-identity vars so exactly one credential mechanism
  // remains — the assumed SourceIdentity creds. Static keys already outrank the
  // web-identity provider; removing these makes that structural rather than a
  // matter of provider precedence, on a security-critical boundary.
  delete env.AWS_ROLE_ARN;
  delete env.AWS_WEB_IDENTITY_TOKEN_FILE;
  delete env.AWS_ROLE_SESSION_NAME;
  return id;
}
