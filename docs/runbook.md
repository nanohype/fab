# fab runbook

Operator guide for running fab workflows in a cluster and reading what fab
tells you when something stops. Everything here is derived from the code —
file references point at the behavior described.

## Running workflows as Kubernetes Jobs

The manifests under `deploy/` run one workflow per Job. The in-cluster path
uses the `sdk` runtime with inference served from AWS Bedrock: the agent loop
executes inside the pod, and Bedrock auth comes from the ServiceAccount's
IRSA role, not a static key (`deploy/job.yaml`).

```sh
# 1. Build and push the image (pin a digest in production, not a moving tag)
docker build -t <registry>/fab:<tag> .
docker push <registry>/fab:<tag>

# 2. Namespace + IRSA ServiceAccount — set the role ARN first
kubectl apply -f deploy/serviceaccount.yaml

# 3. Copy deploy/job.yaml, set the image + workflow name + intake JSON, apply
kubectl apply -f deploy/job.yaml
kubectl -n fab wait --for=condition=complete job/fab-feature-build --timeout=2h
```

Shape of the Job (`deploy/job.yaml`):

- `args: ['workflow', '<name>', '<intake-json>']` — one workflow per Job.
- `backoffLimit: 0` — a failed run is not retried blindly; read the logs,
  fix the cause, submit a new Job.
- `ttlSecondsAfterFinished: 86400` — the Job (and its pod logs) are garbage
  collected after 24 h. Retrieve logs before then or rely on your cluster
  log aggregation.
- `readOnlyRootFilesystem: true` with `emptyDir` volumes at `/work` and
  `/tmp`; `FAB_STATE_FILE=/work/.fab-state.json` points fab's state at the
  writable volume.
- `AWS_REGION` is load-bearing for Bedrock: roles resolve to that region's
  cross-region inference profile (e.g. `us-west-2` → `us.anthropic.*`). Set
  it to a region your Bedrock model access covers (`src/inference.ts`).
- `ANTHROPIC_API_KEY` (Secret `fab-anthropic`, `optional: true`) — Bedrock
  serves the role sessions, but the Opus advisor escalation still calls the
  Anthropic API (`src/advisor.ts`). Create the Secret if your roles
  escalate; otherwise the var is skipped.

### Seeding state for code workflows

Repo configuration and the budget kill-switch both live in the state file
(`src/state.ts`), and the Job's `/work` emptyDir starts empty. A
code-producing workflow with no configured repo halts up front (see
[failure modes](#missing-repo-config-fail-fast)), so seed the state with an
initContainer running the same image against the same `FAB_STATE_FILE`:

```yaml
initContainers:
  - name: seed-state
    image: ghcr.io/nanohype/fab:latest # same image as the main container
    command: ['sh', '-c']
    args:
      - >-
        node dist/bin/fab.js repo add https://github.com/<org>/<repo>
        --token "$GITHUB_TOKEN" &&
        node dist/bin/fab.js budget set 25
    env:
      - name: FAB_STATE_FILE
        value: /work/.fab-state.json
      - name: GITHUB_TOKEN
        valueFrom: { secretKeyRef: { name: fab-github, key: token } }
    volumeMounts:
      - { name: work, mountPath: /work }
```

### Per-session pod isolation (sdk-k8s)

`FAB_RUNTIME=sdk-k8s` dispatches each role-session as its own `AgentSandbox`
CR; the eks-agent-platform operator turns it into a hardened single-use pod
(`src/runtimes/sdk-k8s.ts`). Requirements beyond the Job path:

- `deploy/rbac.yaml` — fab creates/deletes AgentSandbox CRs in the
  management namespace (`FAB_K8S_NAMESPACE`) and reads pods + pod logs in
  the tenant namespace (`tenants-<platform>`).
- `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`
  on fab's pod so the plain-`fetch` K8s client (`src/k8s.ts`) verifies TLS.
- `FAB_K8S_NAMESPACE`, `FAB_K8S_SESSION_IMAGE`, `FAB_K8S_PLATFORM` — all
  three required; fab fails fast with the missing names otherwise
  (`resolveK8sDispatchConfig`).

Built-in timeouts (`src/runtimes/sdk-k8s.ts`): 120 s for the operator to
create the session pod, 300 s for the container to start (covers node
provisioning + image pull), and a 30-minute cap on a single session's log
follow to bound a hung pod. Interrupting a session deletes its AgentSandbox
CR — that is the only channel back into the pod.

## Bedrock / IRSA prerequisites

From `deploy/serviceaccount.yaml`:

1. Bedrock model access enabled in `AWS_REGION` for the Claude models the
   roster uses.
2. A workload IAM role: trust policy scoped to the `fab/fab` ServiceAccount
   via the cluster's OIDC provider; permission policy granting
   `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream` on those
   models. Provision it in your cloud-infra layer.
3. The role ARN in the `eks.amazonaws.com/role-arn` annotation on the
   ServiceAccount. That is the credential `FAB_INFERENCE=bedrock`
   authenticates with — there is no static key.

`FAB_INFERENCE=bedrock` rejects a missing/empty `AWS_REGION` and maps
canonical model ids to the region's inference profile (`src/inference.ts`).

## Cost controls

### Budget kill-switch

- **What it is** — a per-session cost limit in USD, stored as `budgetLimit`
  in the state file. Set with `fab budget set <dollars>`, clear with
  `fab budget clear`, inspect with `fab budget` (`src/bin/fab.ts`).
- **What fires it** — `streamSessionWithAdvisor` (`src/workflows.ts`)
  accumulates session cost from `span.model_request_end` events (priced via
  the model+cache-aware estimator in `src/pricing.ts`) and interrupts the
  session the moment the running total exceeds the limit.
- **What you see** — `BUDGET EXCEEDED: $<cost> / $<limit> — interrupting
session` in red, then the stream ends. If the interrupt itself fails you
  get `Failed to interrupt on budget breach (session <id> may still be
running): <error>` — at that point kill the session manually (managed
  agents: interrupt via the API/REPL; sdk-k8s: delete the AgentSandbox CR).
- **Transport scope** — cost spans are a managed-agents feature, so
  mid-session enforcement fires on the managed-agents transport. The `sdk` /
  `claude-cli` transports report a single `total_cost_usd` on the final
  idle event — fab records it (`session cost: $…`) but the session is
  already done, so the kill-switch cannot cut those off mid-run.
- **How to adjust** — `fab budget set <dollars>` against the same
  `FAB_STATE_FILE` the run reads (in-cluster: the seed initContainer above).
  Unset (`fab budget clear`) means no limit.

### Advisor call caps

- **What it is** — a hard cap on Opus `consult_advisor` escalations per
  session: `StreamOptions.maxAdvisorCalls`, default 3 (`src/workflows.ts`).
  Only phase leads + key gate roles have the tool at all (`ADVISOR_ROLES`,
  `src/advisor.ts`); specialists never escalate.
- **What fires it** — the stream loop counts consultations; once the count
  reaches the cap, further `consult_advisor` calls are denied.
- **What you see** — each consult logs `consulting advisor (opus) [n/3]...`;
  on exhaustion, `advisor budget exhausted (3/3) — denying consult`, and the
  agent receives an error tool-result telling it to decide with the context
  it has and document its reasoning. The session continues — this cap never
  kills a session.
- **How to adjust** — the default lives in code; callers of
  `streamWithAdvisor` / `streamSessionWithAdvisor` can pass
  `maxAdvisorCalls`. Workflow runs use the default 3 — there is no env/CLI
  override, deliberately (Opus distribution stays in check).

## SSE reconnect behavior (managed-agents)

`AnthropicAgents.streamSSE` (`src/api.ts`):

- Tracks the last seen event id and resumes with a `Last-Event-ID` header,
  so a reconnect replays from where the stream dropped — no lost events.
- Retries network errors and HTTP 429/5xx up to 3 times with capped
  exponential backoff (1 s · 2^attempt, capped at 10 s) plus equal jitter so
  fleets of clients don't reconnect in lockstep. You see
  `warning: stream disconnected, reconnecting in <n>ms (attempt x/3)...` on
  stderr.
- Does **not** retry the per-stream timeout (default 300 s of silence,
  `AbortSignal.timeout`) — that abort propagates as an error.
- Malformed SSE payloads are skipped with
  `warning: malformed SSE event: …`; the stream keeps going.

## Log retrieval

- **Workflow Job** — `kubectl -n fab logs job/fab-feature-build` (add `-f`
  to follow). Everything fab prints — step banners, role output, gate
  verdicts, cost lines — is on the Job pod's stdout. Remember the 24 h
  `ttlSecondsAfterFinished`.
- **sdk-k8s session pods** — run in the tenant namespace, named
  `fab-<role>-*` (`generateName` on the AgentSandbox):
  `kubectl -n tenants-<platform> logs <pod>`. Each line is one JSON
  `AgentEvent` — the pod log is the wire fab itself tails and parses
  (`parseLogLine`, `src/runtimes/sdk-k8s.ts`).
- **Managed agents sessions** — events persist server-side:
  `fab events <session-id>` lists them, `fab stream <session-id>`
  re-attaches live, `fab threads <session-id>` lists multiagent threads.
- **Per-role perf metrics** — `fab perf` reads `.fab-perf.json`, recorded
  per completed session on the managed-agents transport only.

## Common failure modes

### Missing repo config (fail-fast)

Code-producing workflows (`gateProfile: 'code'`) pre-create the feature
branch before any agent runs. If that fails, the run halts up front with:

```
Halted: code-producing workflow "<name>" requires a pre-created feature branch.
```

plus a pointer to the specific cause — missing intake JSON, missing
`context.product`, no primary repo, or GitHub API failure — and the fix:
`fab repo add <github-url> --token <github-pat>` (`executeWorkflow`,
`src/workflows.ts`). This is deliberate: silent degradation here produces
agents inventing repos or pushing to the wrong place. In-cluster, this is
the failure you get when the state seed (above) is missing.

### Gate REJECT / revision loops

`runMergeGate` (`src/workflows.ts`) runs the gate roles sequentially and
merges their verdicts:

- **REJECT** from any role ends the gate immediately —
  `Merge gate REJECTED: <workflow>`.
- **REQUEST_CHANGES** appends the feedback to context and re-runs, up to 3
  attempts; exhaustion prints
  `Merge gate requested revisions after 3 attempts — stopping.`
- Verdicts **fail safe**: an APPROVE/REQUEST_CHANGES without `TRANSCRIPTS:`
  - `CITATIONS:` blocks auto-downgrades to REJECT (`parseGateVerdict`,
    `src/gate.ts`); citation fragments are verified against the feature
    branch via the GitHub Contents API, and fabricated fragments downgrade to
    REJECT; a gate role whose session crashes yields no verdict, which also
    counts as REJECT.
- After unanimous APPROVE (code profile), the cold `external-reviewer`
  calibration can still block: >1-letter grade drift on any dimension
  synthesizes a REJECT naming the diverged role.

If a run keeps rejecting: read the `GATE_FEEDBACK` blocks in the log — the
merged feedback names the failing role and criterion. Evidence-less verdicts
usually mean the role couldn't run its build/test commands (check repo
mounts and the `constraints.language` toolchain), not that the work is bad.

### Session terminated vs rescheduled

Two different status events, two different responses
(`streamSessionWithAdvisor`, `src/workflows.ts`; formatting in
`src/stream.ts`):

- `session.status_rescheduled` — **transient**. You see
  `session rescheduled — transient error, retrying automatically...` and the
  stream continues. No action needed.
- `session.status_terminated` — **unrecoverable**. You see
  `session terminated — unrecoverable error` and the stream ends. The
  workflow records that role's slot as a gap and keeps going (below); a new
  run or the revision loop re-executes the work.

### Role session gaps

A role whose session fails doesn't abort the workflow: its output slot is
recorded as `[ROLE SESSION FAILED: <role> — <message>]`
(`roleSessionGap`, `src/workflows.ts`) and the console shows
`Role <role> failed: <msg> — continuing with a gap`. Producers degrade to a
visible gap the gates then judge; gate roles fail safe as REJECT. Grep the
log for `ROLE SESSION FAILED` to find which sessions to investigate.

### sdk-k8s dispatch failures

- Missing `FAB_K8S_NAMESPACE` / `FAB_K8S_SESSION_IMAGE` /
  `FAB_K8S_PLATFORM` — immediate error naming exactly which are unset.
- Pod never scheduled within 120 s or container not started within 300 s —
  the session errors; check the operator logs and the tenant namespace
  events (`kubectl -n tenants-<platform> get events`). Image pull and node
  provisioning are the usual suspects.
- TLS errors from the K8s client — `NODE_EXTRA_CA_CERTS` isn't set on fab's
  pod (see `deploy/rbac.yaml` header).

### claude-cli binary missing

`FAB_RUNTIME=claude-cli` spawns `claude`; if it isn't on PATH you get
`[claude-cli] "claude" not found on PATH. Install Claude Code … or set
FAB_CLAUDE_PATH.` (`src/runtimes/claude-cli.ts`).
