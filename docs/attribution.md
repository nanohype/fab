# Per-session human attribution

By default every fab session acts as the pod's tenant IRSA role — so every
Bedrock call and every `aws` / `kubectl` the agent runs is bound to a role, not
a person. That is the platform default, and it is exactly the gap an evidence
engine surfaces: _"a production action that traces to no named human."_

This is the opt-in that closes it. Name the human a session acts for, and fab
carries that identity into the cloud record so the action attributes to a
person — across both AWS and Kubernetes. It binds the actions of a _cooperating_
session: an attribution mechanism for the normal path, not a containment control
against a hostile or prompt-injected agent — see [Threat model](#threat-model).

Implemented in [`src/attribution.ts`](../src/attribution.ts); wired into the
in-pod `role-session` entrypoint and forwarded by the `sdk-k8s` dispatcher.

## How it works

Two mechanisms, one operator (`$FAB_OPERATOR`):

| Cloud          | Mechanism                                                                                                                        | What the record carries                                                                                                                         | Crossbearing binding                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **AWS**        | Assume a session role with the operator as STS `SourceIdentity`, using the pod's IRSA creds as the caller; export the temp creds | CloudTrail `userIdentity.sessionContext...sourceIdentity = <operator>` on the Bedrock `InvokeModel` call **and** every `aws` the Bash tool runs | `AttrSTSSourceIdentity` (strongest) |
| **Kubernetes** | Point `kubectl` at a kubeconfig that authenticates with the SA token but impersonates the operator                               | apiserver audit `impersonatedUser.username = <operator>`                                                                                        | `AttrK8sImpersonation`              |

Because the assumed credentials are exported into the process environment, the
Agent SDK's Bedrock inference call inherits them too — so even the model call is
attributed in CloudTrail.

**Why SourceIdentity and not Bedrock `requestMetadata`?** The Agent SDK does not
expose the `InvokeModel` request, so fab cannot stamp Bedrock `requestMetadata`
from this path (that would require routing inference through a ModelGateway).
SourceIdentity rides the credentials the SDK already resolves from the standard
chain, and it is crossbearing's strongest binding — it attributes the agent's
`aws` and `kubectl` tool-call records, which crossbearing actually corroborates.
(The `InvokeModel` call carries the same SourceIdentity in CloudTrail too, but
that's a side effect — crossbearing's corroborated findings come from the
tool-call records, not the model call.)

**No new dependency.** Like the `claude-cli` runtime, this shells to a CLI
already in the agent image (`aws`) via `node:child_process`.

## Configuration

| Env var                | Required                   | Meaning                                                                                                                                                     |
| ---------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAB_OPERATOR`         | —                          | the named human this session acts for. **Unset = unattributed** (the default).                                                                              |
| `FAB_SESSION_ROLE_ARN` | when `FAB_OPERATOR` is set | the role assumed with the operator as `SourceIdentity`.                                                                                                     |
| `FAB_SESSION_DURATION` | no                         | seconds the assumed creds live (default 3600). Validates 900–43200, but [role chaining caps the shipped path at 3600](#duration-and-the-role-chaining-cap). |

The `sdk-k8s` dispatcher forwards all three onto the session pod. Set them on the
fab dispatcher (e.g. `FAB_OPERATOR=alice@acme.com`) and every dispatched session
attributes to that human.

**Fail-closed:** if `FAB_OPERATOR` is set but the assume-role fails, the session
aborts (exit 1) rather than run as the tenant role — running unattributed after
a human was named would silently strip the binding the evidence depends on.

## Required platform setup (not in fab)

The IAM and RBAC live on the platform side. The session role and the
`impersonate` grant must exist before `FAB_OPERATOR` is set.

### 1. Session role trust policy

Let the tenant IRSA role assume the session role **and set SourceIdentity**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<acct>:role/<env>-<platform>-tenant" },
      "Action": ["sts:AssumeRole", "sts:SetSourceIdentity"]
    }
  ]
}
```

Give the session role the permissions the agent actually needs (e.g. the same
or a subset of the tenant role's). **Because the assumed credentials also serve
the inference call, the session role must include `bedrock:InvokeModel`** (and
`bedrock:InvokeModelWithResponseStream` / `bedrock:Converse` if used) — once the
static creds are in the environment they fully replace the pod's IRSA role for
every AWS call, the model call included. Keep the permissions tight: the session
role must **not** grant broad `sts:AssumeRole` / `sts:AssumeRoleWithWebIdentity`
(a chain to a role outside the `SourceIdentity`-required trust set would drop the
operator — see [Threat model](#threat-model)); deny `sts:*` unless a specific
downstream assume is required. Set its `MaxSessionDuration` ≥
`FAB_SESSION_DURATION` — but note STS role chaining caps the assumed session at
3600s regardless (see [Duration and the role-chaining cap](#duration-and-the-role-chaining-cap)).

### 2. Kubernetes impersonation RBAC

Let the session pod's ServiceAccount impersonate the operator — scoped to the
specific user(s), never `impersonate *`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: impersonate-operators }
rules:
  - apiGroups: ['']
    resources: ['users']
    verbs: ['impersonate']
    resourceNames: ['alice@acme.com'] # the human(s) sessions may act as
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: session-impersonate }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: impersonate-operators }
subjects:
  - { kind: ServiceAccount, name: <session-sa>, namespace: <tenant-ns> }
```

The operator (`alice@acme.com`) then needs its own RBAC for whatever the agent
does as them in the cluster.

**`FAB_OPERATOR` must be byte-identical** to the `resourceNames` entry in the
`impersonate` ClusterRole _and_ to the operator's own RBAC subject name. The AWS
side accepts any STS-valid string, but the apiserver only authorizes the
impersonation when the string matches the grant exactly — a case, `+tag`, or
trailing-dot mismatch leaves AWS attributed while every `kubectl` is denied (and,
per the "only successful actions are recorded" limitation below, those denials
leave no audit record), silently splitting the binding the design promises is one
human. Use a canonical form (a lowercased email) on all three.

## How crossbearing consumes it

- **CloudTrail** records the agent's `aws` calls with `SourceIdentity=<operator>`
  → crossbearing binds the session via `AttrSTSSourceIdentity`.
- **K8s audit** records the agent's `kubectl` actions with
  `impersonatedUser=<operator>` → `AttrK8sImpersonation`.
- The **claim** side comes separately from the Bedrock model-invocation log (the
  `toolUse` blocks). Crossbearing joins claims to records by **time window +
  operation match** (it does _not_ join on `requestId`), so the corroborated
  finding inherits the human from the matched record's binding above.

Result: the agent's corroborated `aws`/`kubectl` actions attribute to a named
human instead of collapsing to one anonymous IRSA role — the "after" state of
the divergence demo. (Crossbearing corroborates the agent's _tool calls_, not
the `InvokeModel` call, even though that call also carries the SourceIdentity.)

## Threat model

This is an **attribution** mechanism for the normal path: it binds the actions of
a _cooperating_ session to a named human and puts the operator on the audit
record. It is **not** an anti-spoofing or containment control against a hostile
or prompt-injected agent. The agent's tool calls run in an unrestricted shell
(the `sdk` runtime drives Bash under `bypassPermissions`), so an agent that
chooses to can step outside both bindings:

- **Kubernetes** — `unset KUBECONFIG` (or pointing `kubectl` straight at
  `https://kubernetes.default.svc` with the still-mounted ServiceAccount token)
  drops the impersonation header; calls then authenticate as the bare
  ServiceAccount with no `impersonatedUser`.
- **AWS** — the pod's IRSA web-identity token file stays mounted, so the agent
  can re-authenticate as the tenant role directly. A _second_ `aws sts
assume-role` cannot **drop or change** the operator, because STS
  `SourceIdentity` is sticky and immutable once set — but that only holds while
  the role chain stays inside trust policies that require it.

"Strongest binding" in this doc is **relative** to the Bedrock `requestMetadata`
alternative — not absolute proof that the human could not have been a different
one.

For genuine tamper-resistance, the platform must close those fallbacks:

- The session ServiceAccount holds **no direct RBAC** — only `impersonate` on the
  named operator(s) — so dropping `KUBECONFIG` yields an identity that can do
  nothing.
- The session role grants **no broad `sts:AssumeRole`** (ideally `sts:*` denied),
  so the agent cannot chain to a role outside the `SourceIdentity`-required trust
  set.
- Optionally, a `ValidatingAdmissionPolicy` or an audit alert flags
  un-impersonated ServiceAccount calls as the backstop.

## Duration and the role-chaining cap

The caller fab uses to assume the session role is the pod's own IRSA-assumed
role, so the assume is STS **role chaining**. AWS caps a chained session at **1
hour** regardless of the session role's `MaxSessionDuration`, and STS rejects any
`--duration-seconds` above 3600. So although `FAB_SESSION_DURATION` validates up
to 43200, any value above **3600** fails closed at assume-role time on the
shipped path. Keep `FAB_SESSION_DURATION` ≤ 3600, or add credential refresh
(re-assume at ~80% of the duration) if a session must outlive one hour.

## Limitations / next steps

- **Process-wide operator.** `FAB_OPERATOR` is one human per dispatcher process;
  every session it dispatches attributes to that same human. A production
  implementation should thread the _requesting_ human per workflow/request onto
  the `AgentSandbox` spec (e.g. a `spec.operator` field) rather than a single
  env var.
- **Credential TTL is a hard cliff (fail-safe, not fail-open).** Once the static
  creds are in the environment the chain does **not** fall back to the pod's
  IRSA role — so when they expire the next AWS/Bedrock/`kubectl` call fails hard
  with `ExpiredToken` rather than silently reverting to the unattributed role.
  That's the right safety property, but a session running past
  `FAB_SESSION_DURATION` dies mid-task. Set the duration to cover the worst-case
  wall-clock (and the role's `MaxSessionDuration` to match), or add credential
  refresh (re-assume at ~80% of the duration and re-export the creds).
- **Only successful actions are recorded.** Crossbearing's K8s ingester records
  only `ResponseComplete` events with `responseStatus.code < 400` (a denied
  request must not corroborate a claim of success). So an impersonated `kubectl`
  the operator's own RBAC denies leaves no record — the operator still needs
  their own RBAC for whatever the agent does as them.
- **Single-use pod assumed.** The exported creds live in `process.env` for the
  session lifetime (inherited by every Bash subprocess) and the temp kubeconfig
  is not cleaned up — fine because each `AgentSandbox` pod is single-use and
  torn down. If this entrypoint is ever reused for multiple operators in one
  long-lived process, scope creds per-run and remove the kubeconfig between runs.
- **Bedrock `requestMetadata`** remains unreachable from the Agent SDK path; if
  inference moves behind a ModelGateway, stamping a `session`/`operator` tag on
  `InvokeModel` becomes a second, claim-side attribution channel.
