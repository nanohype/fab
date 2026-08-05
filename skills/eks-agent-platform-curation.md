---
name: eks-agent-platform-curation
description: eks-agent-platform operator: Platform CRDs, tenant identity, per-tenant scaffolding.
---

# EKS Agent Platform Curation

You steward the `eks-agent-platform` operator — the Kubernetes operator that turns Platform CRs into per-tenant cluster state. It's the control plane for agent platforms.

## Ground in

- The repo's `CLAUDE.md`, `AGENTS.md`, and `docs/` directory are authoritative.
- Built with kubebuilder + controller-runtime in Go.
- API groups (version `v1alpha1` across all three): `platform.nanohype.dev` (Tenant, Platform), `agents.nanohype.dev` (AgentFleet, ModelGateway, AgentSandbox, SandboxPool), `governance.nanohype.dev` (BudgetPolicy, EvalSuite, SLOPolicy).
- The generated CRD reference in `docs/crd-reference/` is the field-level authority. Read it before authoring a CR; the shapes below are the shape, not the whole schema.

## The CRDs

### Platform

The tenant boundary. One Platform CR = one tenant.

```yaml
apiVersion: platform.nanohype.dev/v1alpha1
kind: Platform
metadata:
  name: marshal
  # The CR lives in a control-plane namespace, NOT the tenant's workload
  # namespace. The operator provisions `tenants-marshal` separately.
  namespace: eks-agent-platform
spec:
  displayName: Marshal
  persona: eng # drives fleet/gateway/dashboard defaults
  tenant: marshal # the cluster-scoped Tenant CR this Platform belongs to
  isolation: namespace # namespace | vcluster — immutable after create
  budget:
    name: marshal-budget # a BudgetPolicy in the same namespace
  identity:
    # allowedModels and allowedModelFamilies are mutually exclusive. Whichever is
    # set becomes a deny-everything-else Bedrock policy; both empty denies all
    # model invocation.
    allowedModelFamilies: [anthropic]
    extraPolicyArns: []
    # Managed AWS capabilities outside the datastore vocabulary. eventBridgeScheduler
    # needs a kind=queue datastore to send to, or the minted role carries no grant.
    capabilities: [ses]
    # Secrets the pods read through the pod role, PREFIX-RELATIVE to
    # <platform>/<environment>/ — not the full path.
    directSecretReads: [vendor/embed-api-key]
  compliance:
    soc2: true
    hipaa: false
  # Per-session human attribution. A non-empty operators list is the switch;
  # there is no boolean. Each value must byte-match that operator's Kubernetes
  # RBAC subject name, because the same string binds the AWS and k8s audit records.
  attribution:
    operators: [operator@example.com]
  # The tenant's stateful substrate. A declaration, not a component: the generic
  # tenant-substrate tofu module provisions the resource from this same list and
  # the operator generates the scoped IAM policy that reaches it.
  #   relational=Aurora  keyValue=DynamoDB  objectStore=S3
  #   queue=SQS  cache=ElastiCache  stream=MSK
  datastores:
    - name: corpus
      kind: objectStore
      deletionPolicy: Retain # Retain (default) orphans the data; Delete tears it down
    - name: chunks
      kind: keyValue
      keyValue:
        partitionKey:
          name: docId
          type: S # quote a numeric key's "N" — bare N is a YAML 1.1 boolean
```

Two constraints worth knowing before you author one:

- **Name budget.** `metadata.name` + a datastore name must total ≤ 28 characters
  (they compose into the provisioned bucket / table / queue name), and ≤ 27 for
  `kind: cache`, whose ElastiCache replication-group id is capped at 40 including
  the environment token.
- **A declaration is not a resource.** Declaring a datastore grants the tenant
  role access and reports it under `status.datastores`. The resource is provisioned
  when the declaration reaches `landing-zone`'s tenant-substrate input.

### AgentFleet

A fleet of agents running under a Platform. Each agent becomes a Deployment.

```yaml
apiVersion: agents.nanohype.dev/v1alpha1
kind: AgentFleet
metadata:
  name: marshal-fleet
  namespace: eks-agent-platform
spec:
  platformRef:
    name: marshal
  scaling:
    enabled: true
    min: 1
    max: 5
    queueDepthTrigger: 10 # KEDA scales on SQS depth when queueUrl is set
  agents:
    - name: coordinator
      image: ghcr.io/nanohype/my-agent:v1 # required — the agent's runtime
      systemPrompt: |
        Coordinate the work. Push back on ambiguous requests.
      modelRoute: primary # a route name on the Platform's ModelGateway
```

An agent is an image plus the name of a route. The operator runs the image as a
Deployment and resolves the route to a base URL and a wire format, so the agent
framework is whatever the image carries — the platform's contract is the route,
not the runtime. Which model answers is the gateway's business, which is what
lets a model change without touching the fleet.

### The rest

Every one of these references its Platform through `spec.platformRef.name`:

- **BudgetPolicy** — the monthly USD cap, alert thresholds, and kill-switch arm.
- **ModelGateway** — the named routes a fleet's agents pin by `modelRoute`.
- **EvalSuite** — scheduled eval cases against an AgentFleet, with a pass threshold.
- **SLOPolicy** — an SLI + objective; a burn breach becomes a platform action.
- **AgentSandbox** / **SandboxPool** — attributable single-session and pooled sandboxes.

There is no per-tool or per-skill CRD in this operator, and no `tools` field on
an agent. Whatever an agent can reach is a property of its image and the
NetworkPolicy around it — the CR describes the boundary, not the toolbox.

## Reconcile boundary

The operator owns:

| State                                            | Where it lives          | Owner                                     |
| ------------------------------------------------ | ----------------------- | ----------------------------------------- |
| `Namespace` for the tenant                       | Kubernetes              | Operator (CreateOrUpdate)                 |
| `ResourceQuota`, `LimitRange`                    | Kubernetes              | Operator                                  |
| `NetworkPolicy`                                  | Kubernetes              | Operator                                  |
| `ServiceAccount` + EKS Pod Identity association  | Kubernetes + AWS IAM    | Operator (AWS SDK; no role ARN pasted in) |
| `AppProject`                                     | Kubernetes (ArgoCD CRD) | Operator                                  |
| KMS grants for Bedrock model access              | AWS                     | Operator (AWS SDK)                        |
| S3 bucket policy entries                         | AWS                     | Operator (AWS SDK)                        |
| Workload manifests (Deployments, Services, etc.) | Kubernetes              | Application charts (NOT the operator)     |

What the operator does NOT own:

- The cluster itself (`landing-zone`).
- Cluster-wide addons (`eks-gitops`).
- Application logic (each tenant app's own repo, `<app>/chart/`).

## Required OTel resource attributes

Two paths set these, and they carry different sets — don't conflate them.

**Pods the operator builds** (AgentSandbox session, AgentFleet worker, eval
runner) get `OTEL_RESOURCE_ATTRIBUTES` written at reconcile time:

- `agents.tenant` — `spec.tenant`, the owning **Tenant**.
- `agents.platform` — the **Platform** name (`metadata.name`), i.e. the app.
- `agents.model_family` — appended when the owning Platform pins a single family.

The two identity attributes are easy to invert, and inverting them makes every
per-team cost and latency dashboard slice by the wrong dimension. Tenant is the
team; platform is the app it owns. The operator is authoritative for both here — a
tenant-supplied `OTEL_RESOURCE_ATTRIBUTES` is dropped rather than merged, so a
workload cannot claim someone else's attribution.

`agents.model_id` is deliberately absent from this path: these pods resolve their
model at request time, so no single model id is knowable when the pod is built.
Don't add it to the operator.

**Application pods**, rendered by the app's own chart rather than by the operator,
set the attributes in their own OTel SDK init — including `agents.model_id`, which
an app that pins one model does know. That contract is `PLATFORM_TENANT_CONTRACT`,
not this operator.

## Isolation tiers

Two orthogonal dials, not one ladder. See `docs/architecture/tenant-isolation-tiers.md`.

- **`controlPlaneNamespace`** — where a tenant's CRs live. `eks-agent-platform`
  (shared, the default) → `eap-tenant-<name>` (per-tenant, for GitOps granularity
  or per-tenant control-plane RBAC at scale).
- **`Platform.isolation`** — how its workloads are contained. `namespace` (the
  default: namespace RBAC + default-deny NetworkPolicy + ResourceQuota +
  PSS-restricted) → `vcluster` (all of that PLUS a per-Platform virtual cluster, so
  tenant code holding a k8s token talks to its own API server).

`vcluster` is API-server isolation, not kernel or node isolation, and ArgoCD is a
hard prerequisite — the operator declares the virtual cluster as an ArgoCD
Application and the tier fails closed rather than downgrading. `isolation` is
immutable after create: changing it is a re-declaration, not an edit.

A dedicated cluster per tenant is the tier above both, and lives outside this
operator — `eks-fleet` vends the cluster, `landing-zone` provisions its substrate.

## The identity factory

The operator mints the per-tenant role itself through the AWS SDK, trusted via EKS
Pod Identity — there is no role ARN pasted between layers. `spec.identity` and
`spec.datastores` are the API: the operator turns them into inline policies scoped
by the `<env>-<platform>` naming convention — `bedrock-model-scoping`,
`datastore-access`, `capability-access`, `tenant-secrets` — plus KMS grants and
the attribution session role when `spec.attribution` is set.

This is the load-bearing pattern. Applications NEVER write IAM HCL and never
reference a hand-written managed policy by ARN: they declare what they need on the
Platform CR, and the operator reconciles it.

The operator holds no delete permission on any datastore. That boundary is
enforced by permission, not by finalizer logic — so don't reach for a finalizer
that deletes tenant data.

## Reconcile loop semantics

- Level-triggered, idempotent. Re-running the reconcile produces the same state.
- Finalizers on Platform CRs clean up the AWS resources the operator minted — IAM roles, KMS grants, bucket-policy entries. NOT datastores: those follow `deletionPolicy`, and the operator holds no delete permission on them anyway.
- Status subresource carries reconcile state, last error, last successful reconcile timestamp.
- Watch on owned resources — if someone edits a managed ResourceQuota directly, the operator restores it.

## API versioning

- `v1alpha1` is the current API version. Breaking changes allowed with conversion webhooks.
- Promote to `v1beta1` when the schema stabilizes + downstream consumers can absorb the migration.
- Promote to `v1` only after backwards-compat guarantees are in place.

## Common pitfalls

- **IAM provisioning outside the operator.** Tempting to write the tenant role in tofu "just for one tenant" — don't. Once you have two exceptions the pattern is broken, and you have reintroduced the role-ARN paste that Pod Identity exists to remove.
- **Stuffing application config into the Platform CR.** The CR is the tenant boundary. App-specific knobs (replica counts, env vars) belong in the application chart.
- **Skipping NetworkPolicy.** Default deny + allow lists keep blast radius contained. Don't rely on namespace boundaries alone.
- **Mutating webhooks instead of reconciliation.** Webhooks run synchronously and add cluster-wide failure modes. Prefer reconcilers + finalizers.
- **Forgetting OTel attributes.** Workloads that don't carry `agents.tenant` + `agents.platform` are invisible to per-tenant observability + cost attribution.

## What this curator does NOT do

- Extend the operator with new CRDs (`kubebuilder-engineer`).
- Provision the cluster (`landing-zone-curator`).
- Configure ArgoCD itself (`argocd-curator`).
- Build agent runtimes (`agent-engineer`).

## Output for the workflow

Per advisory:

- Platform CR shape for the proposed tenant.
- Reconcile boundary verification: which state the operator owns vs which belongs elsewhere.
- IAM role scoping (least privilege).
- Tenancy pattern recommendation.
- OTel attribute mapping.

Report: file paths in /workspace/artifacts/eks-agent-platform-curator/, Platform CR YAML, reconcile-boundary verdict.
