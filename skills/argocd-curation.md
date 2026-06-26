---
name: argocd-curation
description: ArgoCD Applications, ApplicationSets, AppProjects, sync waves, RBAC.
---

# ArgoCD Curation

You steward ArgoCD — the GitOps engine that takes the gitops repo (`eks-gitops`) and reconciles it into the cluster.

## Ground in

- ArgoCD docs: <https://argo-cd.readthedocs.io/>
- ApplicationSet generators: <https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Generators/>
- Sync waves + hooks: <https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/>

## Core concepts

- **Application** — one deployed workload. Points at a git path + revision + destination cluster/namespace.
- **ApplicationSet** — generator pattern. Emits N Applications from one definition. Used heavily in `eks-gitops` for multi-cluster, multi-env fan-out.
- **AppProject** — RBAC + scope boundary. Restricts source repos, destinations, allowed resource kinds. Every Application belongs to a Project.
- **Sync waves** — ordering annotation (`argocd.argoproj.io/sync-wave`). Lower numbers sync first. Drives CRDs-before-controllers-before-workloads.
- **Sync hooks** — lifecycle phases: `PreSync`, `Sync`, `PostSync`, `SyncFail`. Run Jobs that handle migrations, bootstraps, smoke tests.

## ApplicationSet patterns

### Cluster generator

Fan out one app to every registered cluster:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cert-manager
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            tier: production
  template:
    spec:
      project: cluster-addons
      source:
        repoURL: https://github.com/nanohype/eks-gitops
        path: addons/cert-manager
        targetRevision: HEAD
      destination:
        name: '{{name}}'
        namespace: cert-manager
```

### List generator

Explicit fan-out for tenant apps:

```yaml
generators:
  - list:
      elements:
        - tenant: marshal
          env: prod
        - tenant: gauntlet
          env: prod
```

### Git generator (app-of-apps)

The bootstrap pattern — one root Application points at a directory of ApplicationSets, each of which fans out further.

### Matrix generator

Combine generators. `clusters × list` produces every (cluster, tenant) pair.

## AppProject design

One AppProject per logical scope:

| Project            | Purpose                                              | Source repos                  | Destinations                 |
| ------------------ | ---------------------------------------------------- | ----------------------------- | ---------------------------- |
| `cluster-addons`   | Cluster-wide infrastructure                          | eks-gitops                    | All clusters, all namespaces |
| `platform-tenants` | Application tenants reconciled by eks-agent-platform | protohype, eks-agent-platform | Per-tenant namespaces        |
| `default`          | Catch-all for ad-hoc                                 | (none — keep empty)           | (none)                       |

Set `roles` on the project for RBAC:

```yaml
roles:
  - name: addon-operators
    policies:
      - p, proj:cluster-addons:addon-operators, applications, sync, cluster-addons/*, allow
    groups:
      - eks-ops@company.com
```

## Sync waves

Standard ordering for cluster bootstrap:

| Wave   | What                                                                   |
| ------ | ---------------------------------------------------------------------- |
| `-100` | Namespaces                                                             |
| `-50`  | CRDs (cert-manager, kyverno, argo-rollouts)                            |
| `-10`  | Controllers (cert-manager-controller, kyverno-admission)               |
| `0`    | Default — most workloads                                               |
| `10`   | Workloads that depend on controllers (Certificates after cert-manager) |
| `100`  | Smoke tests + verification                                             |

Use `argocd.argoproj.io/sync-options: SkipDryRunOnMissingResource=true` for resources whose CRDs are installed in an earlier wave.

## Sync policies

- **Automated sync** for non-prod and cluster-addons. `selfHeal: true` repairs drift; `prune: true` deletes resources removed from git.
- **Manual sync** for prod application releases. Promotion is a deliberate action via the UI or CLI.
- **Retry** with backoff for transient failures: `retry.limit: 5`, `backoff.duration: 5s`, `backoff.maxDuration: 3m`, `backoff.factor: 2`.

## RBAC

- **Tenant operators** can sync their tenant's project, no others.
- **Cluster operators** can sync cluster-addons, plus override-sync any project.
- **Read-only** for everyone else (incident response, audits).
- Bind to OIDC groups. ArgoCD's `dex` connector supports the org's IdP.

## Multi-cluster

- **Cluster secrets** register each target cluster in ArgoCD's `argocd` namespace. Each secret has type `Argo CD cluster` and includes the cluster's API endpoint + a service-account token.
- **Per-cluster labels** drive ApplicationSet generators. Label clusters with `tier` (dev/staging/prod), `region`, `tenant-affinity` (if dedicated).
- **App-of-apps cluster bootstrap** runs from the management cluster. New clusters get registered → ApplicationSets pick them up → addons + tenants reconcile.

## Common pitfalls

- **Cluster-wide resources without project guard.** A misconfigured Application can patch CRDs cluster-wide. Lock down `clusterResourceWhitelist` per AppProject.
- **Drift you can't see.** `selfHeal: false` + manual sync hides drift. Use the UI's "OutOfSync" filter + alerts on the metric.
- **Slow sync waves.** Each wave waits for the previous to be Healthy. If a controller takes 5 minutes to become healthy, the bootstrap takes 5+ minutes. Tune readiness probes.
- **Resource hooks that never finish.** A `PreSync` Job that hangs blocks the entire sync. Set `argocd.argoproj.io/hook-delete-policy: BeforeHookCreation` and `activeDeadlineSeconds` on the Job spec.
- **Helm + Kustomize hybrid.** Each tool has its own templating; mixing them in one Application via Helm Chart + Kustomize plugin gets confusing fast. Pick one per Application.

## Output for the workflow

Per advisory:

- ApplicationSet shape with chosen generator + rationale.
- AppProject placement + RBAC policy delta.
- Sync wave assignment for new resources.
- Sync policy (automated vs manual) per env.
- Multi-cluster topology if new clusters are registering.

Report: file paths in /workspace/artifacts/argocd-curator/, ApplicationSet diff if applicable, RBAC delta.
