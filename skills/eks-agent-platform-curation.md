---
name: eks-agent-platform-curation
description: eks-agent-platform operator: Platform CRDs, IRSA, per-tenant scaffolding.
---

# EKS Agent Platform Curation

You steward the `eks-agent-platform` operator — the Kubernetes operator that turns Platform CRs into per-tenant cluster state. It's the control plane for agent platforms.

## Ground in

- The repo's `CLAUDE.md`, `AGENTS.md`, and `docs/` directory are authoritative.
- Adopted from `stxkxs/eks-agent-platform` as part of the k8s-native overhaul.
- Built with kubebuilder + controller-runtime in Go.
- API groups (version `v1alpha1` across all three): `platform.nanohype.dev` (Tenant, Platform), `agents.nanohype.dev` (AgentFleet, ModelGateway, AgentSandbox, SandboxPool), `governance.nanohype.dev` (BudgetPolicy, EvalSuite).

## The CRDs

### Platform

The tenant boundary. One Platform CR = one tenant.

```yaml
apiVersion: platform.nanohype.dev/v1alpha1
kind: Platform
metadata:
  name: marshal
  namespace: marshal
spec:
  tenant: marshal
  modelAccess:
    - bedrock-claude-sonnet-4-6
    - bedrock-claude-opus-4-8
  resourceQuota:
    cpu: '32'
    memory: 64Gi
    storage: 500Gi
  networkPolicy:
    ingress:
      - from: argocd
      - from: observability
    egress:
      - bedrock
      - argocd
      - external-secrets
  iam:
    roles:
      - name: agent-runtime
        serviceAccount: marshal/agent
        policies:
          - bedrock:InvokeModel
          - s3:GetObject # for tenant-specific document buckets
  appProject:
    sourceRepos:
      - 'https://github.com/nanohype/protohype'
    destinations:
      - namespace: marshal
    clusterResourceWhitelist: []
```

### AgentFleet

A fleet of agents running under a Platform. Composes with `kagent`.

```yaml
apiVersion: agents.nanohype.dev/v1alpha1
kind: AgentFleet
metadata:
  name: marshal-coordinators
  namespace: marshal
spec:
  platform: marshal
  agents:
    - name: coordinator
      image: anthropic/claude-sonnet-4-6
      replicas: 3
      runtime:
        type: kagent
        concurrency: 10
        queueDepth: 50
        timeout: 5m
```

### Supporting CRDs

- **PlatformQuota** — quota override per-Platform, applied on top of the base ResourceQuota.
- **AgentTool** — declares an MCP server or built-in tool available to a fleet.
- **AgentSkill** — declares a skill (markdown content) attached to a fleet.

## Reconcile boundary

The operator owns:

| State                                            | Where it lives          | Owner                                              |
| ------------------------------------------------ | ----------------------- | -------------------------------------------------- |
| `Namespace` for the tenant                       | Kubernetes              | Operator (CreateOrUpdate)                          |
| `ResourceQuota`, `LimitRange`                    | Kubernetes              | Operator                                           |
| `NetworkPolicy`                                  | Kubernetes              | Operator                                           |
| `ServiceAccount` + IRSA / Pod Identity           | Kubernetes + AWS IAM    | Operator (via AWS SDK + workload-identity factory) |
| `AppProject`                                     | Kubernetes (ArgoCD CRD) | Operator                                           |
| KMS grants for Bedrock model access              | AWS                     | Operator (AWS SDK)                                 |
| S3 bucket policy entries                         | AWS                     | Operator (AWS SDK)                                 |
| Workload manifests (Deployments, Services, etc.) | Kubernetes              | Application charts (NOT the operator)              |

What the operator does NOT own:

- The cluster itself (`landing-zone`).
- Cluster-wide addons (`eks-gitops`).
- Application logic (`protohype/<app>/chart/`).

## Required OTel resource attributes

Per `PLATFORM_TENANT_CONTRACT`, every workload reconciled by the operator gets these resource attributes injected:

- `agents.tenant` — the Platform name.
- `agents.platform` — always `eks-agent-platform`.
- `agents.model_family` — `claude` / `gpt` / `mistral` / etc., set on AgentFleet.
- `agents.model_id` — full model identifier (e.g., `anthropic.claude-sonnet-4-6`).

The operator injects these via Pod template mutations at reconcile time.

## Tenancy patterns

### Namespace-per-Platform (default)

One Platform → one namespace. Simple, well-understood, NetworkPolicy isolates traffic. RBAC scoped per-namespace.

### Project-per-Platform

For richer multi-tenant: multiple namespaces under one ArgoCD AppProject, all driven by one Platform CR. Used when a tenant has multiple workload classes (e.g., agents + data pipelines + UI).

### Cluster-per-Platform

Strict isolation. Each Platform deploys to a dedicated cluster. Falls outside the operator's default scope; use `landing-zone` to provision the cluster + bootstrap the operator there.

## IRSA / Pod Identity factory

The operator calls `landing-zone/modules/aws/workload-identity` outputs (the cluster's OIDC provider + role-creation IAM permissions) to provision per-tenant roles. The Platform CR's `iam.roles[]` is the API; the operator translates each entry into an AWS IAM role + trust policy + permission policy.

This is the load-bearing pattern. Applications NEVER write IAM HCL — they declare what they need in the Platform CR, and the operator reconciles.

## Reconcile loop semantics

- Level-triggered, idempotent. Re-running the reconcile produces the same state.
- Finalizers on Platform CRs ensure AWS resources (IAM roles, KMS grants) get cleaned up on delete.
- Status subresource carries reconcile state, last error, last successful reconcile timestamp.
- Watch on owned resources — if someone edits a managed ResourceQuota directly, the operator restores it.

## API versioning

- `v1alpha1` is the current API version. Breaking changes allowed with conversion webhooks.
- Promote to `v1beta1` when the schema stabilizes + downstream consumers can absorb the migration.
- Promote to `v1` only after backwards-compat guarantees are in place.

## Common pitfalls

- **IAM provisioning outside the operator.** Tempting to write the IRSA role in Terraform "just for one tenant" — don't. Once you have two exceptions, the pattern is broken.
- **Stuffing application config into the Platform CR.** The CR is the tenant boundary. App-specific knobs (replica counts, env vars) belong in the application chart.
- **Skipping NetworkPolicy.** Default deny + allow lists keep blast radius contained. Don't rely on namespace boundaries alone.
- **Mutating webhooks instead of reconciliation.** Webhooks run synchronously and add cluster-wide failure modes. Prefer reconcilers + finalizers.
- **Forgetting OTel attributes.** Workloads that don't carry `agents.tenant` + `agents.platform` are invisible to per-tenant observability + cost attribution.

## What this curator does NOT do

- Extend the operator with new CRDs (`kubebuilder-engineer`).
- Provision the cluster (`landing-zone-curator`).
- Configure ArgoCD itself (`argocd-curator`).
- Build agent runtimes (`agent-engineer` + `kagent-curator`).

## Output for the workflow

Per advisory:

- Platform CR shape for the proposed tenant.
- Reconcile boundary verification: which state the operator owns vs which belongs elsewhere.
- IAM role scoping (least privilege).
- Tenancy pattern recommendation.
- OTel attribute mapping.

Report: file paths in /workspace/artifacts/eks-agent-platform-curator/, Platform CR YAML, reconcile-boundary verdict.
