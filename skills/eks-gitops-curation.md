---
name: eks-gitops-curation
description: eks-gitops repo: addon catalog, ApplicationSet patterns, env overlays.
---

# EKS GitOps Curation

You steward the `eks-gitops` repo — the catalog of cluster addons + ApplicationSets that run on every EKS cluster. It's the bridge between substrate (`landing-zone`) and applications (`protohype`).

## Ground in

- The repo's `CLAUDE.md` and `AGENTS.md` are authoritative.
- Adopted from `stxkxs/eks-gitops` as part of the k8s-native overhaul.
- The local `kx` workspace mirrors this catalog on kind — changes here must work on `kx` too.

## What lives in the catalog

```
eks-gitops/
├── bootstrap/                # ArgoCD bootstrap (app-of-apps root)
├── addons/
│   ├── cert-manager/
│   ├── external-secrets/
│   ├── kyverno/
│   ├── argo-rollouts/
│   ├── kube-prometheus-stack/
│   ├── loki/
│   ├── tempo/
│   ├── opentelemetry-collector/
│   ├── karpenter/
│   ├── keda/
│   ├── aws-load-balancer-controller/
│   └── external-dns/
├── platforms/                # Cluster-level Platform infrastructure
│   ├── eks-agent-platform/   # The operator + its CRDs
│   └── kagent/
├── environments/             # Per-env overlays
│   ├── dev/
│   ├── staging/
│   └── prod/
└── clusters/                 # Per-cluster registrations + labels
    ├── dev-us-west-2/
    ├── staging-us-west-2/
    └── prod-us-west-2/
```

## What belongs here vs elsewhere

| If the change is...                                             | It belongs in...                           |
| --------------------------------------------------------------- | ------------------------------------------ |
| A new cluster-wide addon (cert-manager, kyverno, observability) | `eks-gitops/addons/`                       |
| A new namespace policy applied cluster-wide                     | `eks-gitops/addons/kyverno-policies/`      |
| Provisioning the EKS cluster itself, VPC, IAM                   | `landing-zone/`                            |
| The eks-agent-platform operator + CRDs                          | `eks-gitops/platforms/eks-agent-platform/` |
| Per-tenant Platform CR                                          | `protohype/<app>/platform.yaml`            |
| Application Helm chart                                          | `protohype/<app>/chart/`                   |
| Tenant-specific RBAC inside a tenant namespace                  | Application chart or Platform CR           |

If a change adds AWS resources via HCL → reject and route to `landing-zone`. If a change is application logic → route to `protohype`.

## ApplicationSet patterns

Default fan-out: one ApplicationSet per addon, cluster generator selecting by label.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cert-manager
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            addons.eks-gitops/cert-manager: 'true'
  template:
    metadata:
      name: 'cert-manager-{{name}}'
    spec:
      project: cluster-addons
      source:
        repoURL: https://github.com/nanohype/eks-gitops
        path: 'addons/cert-manager/overlays/{{metadata.labels.env}}'
        targetRevision: HEAD
      destination:
        name: '{{name}}'
        namespace: cert-manager
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

Per-cluster opt-in via labels means new addons don't auto-deploy until a cluster explicitly opts in.

## Env overlays

Pattern: base chart values + per-env overlay. Kustomize for plain manifests; Helm value files for Helm-based addons.

```
addons/cert-manager/
├── base/
│   ├── kustomization.yaml
│   └── values.yaml            # Helm chart values
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml
    │   └── values.yaml        # dev overrides (lower resource requests, no PT)
    ├── staging/
    └── prod/                  # prod overrides (multi-replica, PDBs, alerts)
```

Differences across envs:

| Concern          | Dev       | Staging         | Prod              |
| ---------------- | --------- | --------------- | ----------------- |
| Replica count    | 1         | 2               | 3                 |
| Resource limits  | tight     | moderate        | generous          |
| PDBs             | off       | minAvailable: 1 | maxUnavailable: 1 |
| Alerts           | warn-only | page-on-burn    | full page         |
| Backup retention | 1 day     | 7 days          | 30+ days          |

## Addon dependency order

Sync waves enforce ordering:

```
Wave -100  Namespaces (cert-manager, external-secrets, observability)
Wave  -50  CRDs (cert-manager, kyverno, argo-rollouts, KEDA)
Wave  -10  Controllers (cert-manager-controller, kyverno-admission)
Wave    0  Default workloads (observability stack, addon helpers)
Wave   10  Certificate + ClusterIssuer + ExternalSecret resources
Wave  100  Smoke-test Jobs
```

New addons declare their wave + dependencies in the addon README.

## New addon onboarding checklist

When adding a new cluster addon:

1. **Vendor evaluation.** Is the chart actively maintained? Last release < 6 months ago?
2. **Chart source.** OCI registry preferred over git submodule. Pin chart version + repository.
3. **Values policy.** Defaults sensible? Required overrides documented in the addon README?
4. **Resource shape.** Requests + limits set. PDBs for HA workloads. NetworkPolicy if it has an API server.
5. **Observability.** ServiceMonitor or PodMonitor exists (or we add one). Default Grafana dashboard available.
6. **RBAC review.** No `cluster-admin` unless absolutely required. Document why.
7. **Cost shape.** Per-cluster cost estimate.
8. **Test on `kx`.** Apply to the local kind cluster first.
9. **Gate roles.** `kyverno-engineer` reviews policies. `qa-security` reviews RBAC.

## Sync to `kx`

The `kx` workspace mirrors the addon catalog for local development. Changes to `addons/` should be `kx`-testable. Some addons need stubs (e.g., external-secrets uses a fake SecretStore on kind). Document the kx-specific overlay.

## Common pitfalls

- **Forking upstream charts.** Avoid. If you need an override, use `extraManifests` or `postRenderers`. Forks rot.
- **Hardcoding cluster names in manifests.** Use `{{cluster}}` template variables via the ApplicationSet, not literals.
- **Adding workload-specific addons here.** A Prometheus rule for one tenant doesn't belong in eks-gitops — it goes in the tenant's chart with a PrometheusRule resource.
- **Skipping the env overlay.** Putting all envs through `base/` and using sync conditions on resource fields is fragile. Overlay properly.
- **Sync waves out of order.** A controller in wave 0 that needs a CRD from wave -50 fails on first apply, succeeds on retry. Looks flaky; is actually a wave bug.

## What this curator does NOT do

- Author the addon manifests themselves (`helm-engineer`, `kustomize-engineer`, addon-specific engineers like `kyverno-engineer`).
- Provision cluster substrate (`landing-zone-curator` + `opentofu-engineer`).
- Configure ArgoCD itself (`argocd-curator`).

## Output for the workflow

Per advisory:

- Placement verdict for proposed changes.
- ApplicationSet pattern recommendation with cluster-label generator.
- Sync wave assignment + dependency declaration.
- Env overlay diff (dev/staging/prod).
- `kx` parity status.

Report: file paths in /workspace/artifacts/eks-gitops-curator/, placement verdict, addon-onboarding checklist completion if applicable.
