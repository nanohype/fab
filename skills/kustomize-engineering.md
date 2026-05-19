---
name: kustomize-engineering
description: Kustomize overlays, bases, components, generators, patches.
---

# Kustomize Engineering

You build Kustomize trees. Bases, overlays, components, generators, patches. Kustomize is the templating layer for plain manifests — favoured over Helm when the chart's templating engine gets in the way of declarative thinking.

## Ground in

- Kustomize docs: <https://kubectl.docs.kubernetes.io/references/kustomize/>
- The reference Kustomize project: <https://github.com/kubernetes-sigs/kustomize/tree/master/examples>

## When Kustomize vs Helm

| Need                                                      | Pick                                                  |
| --------------------------------------------------------- | ----------------------------------------------------- |
| Off-the-shelf chart from a vendor (cert-manager, kyverno) | **Helm**                                              |
| Plain manifests with env overlays                         | **Kustomize**                                         |
| Heavy conditional logic in templates                      | **Helm** (or rethink: usually means too many knobs)   |
| GitOps with strict declarative shape                      | **Kustomize**                                         |
| Both together                                             | Use Helm's `postRenderers` to apply Kustomize patches |

The nanohype factory leans toward Kustomize for first-party manifests, Helm for upstream addons.

## Layout

```
manifests/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── serviceaccount.yaml
│   ├── networkpolicy.yaml
│   └── pdb.yaml
├── components/
│   ├── otel/                # OpenTelemetry sidecar component
│   │   ├── kustomization.yaml
│   │   └── patch.yaml
│   ├── mtls/                # mTLS via service mesh
│   │   ├── kustomization.yaml
│   │   └── peerauth.yaml
│   └── irsa/                # IRSA annotation component
│       ├── kustomization.yaml
│       └── sa-patch.yaml
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml
    │   └── replica-patch.yaml
    ├── staging/
    └── prod/
        ├── kustomization.yaml
        ├── replica-patch.yaml
        ├── resources-patch.yaml
        └── pdb-patch.yaml
```

## Base

The base is the canonical, minimum-viable manifest set. No environment-specific values:

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

commonLabels:
  app.kubernetes.io/name: api
  app.kubernetes.io/part-of: marshal

resources:
  - deployment.yaml
  - service.yaml
  - serviceaccount.yaml
  - networkpolicy.yaml
  - pdb.yaml

images:
  - name: api
    newName: ghcr.io/nanohype/marshal-api
    digest: sha256:abc... # the base pins a known-good digest
```

## Components

Components are reusable, opt-in slices. They differ from bases — multiple components compose into one overlay:

```yaml
# components/otel/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

patches:
  - path: patch.yaml
    target:
      kind: Deployment
      labelSelector: app.kubernetes.io/name=api

configMapGenerator:
  - name: otel-config
    files: [otel-collector.yaml]
```

```yaml
# components/otel/patch.yaml
- op: add
  path: /spec/template/spec/containers/-
  value:
    name: otel-collector
    image: otel/opentelemetry-collector-contrib@sha256:def...
    args: ['--config=/etc/otel/otel-collector.yaml']
    volumeMounts:
      - { name: otel-config, mountPath: /etc/otel }
- op: add
  path: /spec/template/spec/volumes/-
  value:
    name: otel-config
    configMap: { name: otel-config }
```

Then overlays compose:

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base
components:
  - ../../components/otel
  - ../../components/mtls
  - ../../components/irsa

namespace: marshal

patches:
  - path: replica-patch.yaml
  - path: resources-patch.yaml
  - path: pdb-patch.yaml
```

## Patches

Three patch styles:

### Strategic merge

```yaml
# overlays/prod/replica-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  replicas: 5
```

Strategic merge is the default. It understands Kubernetes types: lists with merge keys (like containers by name) get merged correctly, not replaced.

### JSON 6902

```yaml
- op: replace
  path: /spec/replicas
  value: 5
- op: add
  path: /spec/template/spec/containers/0/env/-
  value: { name: NEW_FLAG, value: 'true' }
```

Use JSON 6902 for surgical edits (`replace`, `add`, `remove` at a specific path). Faster to read for one-line changes.

### Inline patches

```yaml
patches:
  - patch: |-
      - op: replace
        path: /spec/replicas
        value: 5
    target: { kind: Deployment, name: api }
```

Inline patches keep the change visible in `kustomization.yaml`. Best for one-liners.

## Generators

`configMapGenerator` + `secretGenerator` build resources from files:

```yaml
configMapGenerator:
  - name: app-config
    files:
      - config.yaml
      - schema.json
    options:
      disableNameSuffixHash: false # default true — hash suffix forces pod rotation on change
```

Hash suffixes are the magic: `app-config-7bf2c8d4` for v1, `app-config-9d3e1f8b` for v2. Pod references update via Kustomize name lookup, triggering a rolling update automatically.

Set `disableNameSuffixHash: true` for ConfigMaps that you mount as files and reload at runtime (via volume mount + watcher).

## Generators for secrets

Never commit secret values. Generators reference external sources:

```yaml
secretGenerator:
  - name: api-secrets
    type: Opaque
    envs: [secrets.env] # secrets.env in .gitignore; populated by CI from Vault
```

Or use ExternalSecret + external-secrets-operator (preferred — see `secrets-engineer`).

## Replacements

For cross-resource value sync:

```yaml
replacements:
  - source:
      kind: ConfigMap
      name: app-config
      fieldPath: data.db_host
    targets:
      - select: { kind: Deployment, name: api }
        fieldPaths: [spec.template.spec.containers.[name=api].env.[name=DB_HOST].value]
```

`replacements` lets you define a value once + sync it across resources. Cleaner than copy-paste patches.

## Validation

```sh
# Render
kustomize build overlays/prod/

# Validate against the cluster (server-side dry run)
kustomize build overlays/prod/ | kubectl apply --dry-run=server -f -

# Diff vs running state
kustomize build overlays/prod/ | kubectl diff -f -
```

CI runs the first two on every PR.

## Multi-cluster

For per-cluster overrides on top of per-env overlays:

```
overlays/prod/                # env base
overlays/prod-us-west-2/      # cluster-specific overlay extending prod
  └── kustomization.yaml
      resources: [../prod]
      patches: [region-patch.yaml]
```

ArgoCD ApplicationSet's cluster generator points at the cluster-specific overlay path.

## Common pitfalls

- **Patches in bases.** Bases are for canonical resources; overlays for variation. Putting patches in a base defeats the layering.
- **Components when bases would do.** Components shine when multiple unrelated overlays want the same slice. For one-overlay-one-slice, just patch inline.
- **`namespace:` in the base.** Sets a default namespace that overlays must override. Leave it off the base.
- **Strategic merge against custom resources without OpenAPI.** Kustomize doesn't know how to merge unknown CRDs. Use JSON 6902 for CRDs.
- **Hash suffix on a ConfigMap consumed by another tool.** Tools that reference ConfigMaps by exact name (not via Kustomize lookup) break when the hash changes. Disable the suffix for these.
- **`commonLabels` on Selectors.** Adds the label to `Selector` blocks too, which is usually fine but occasionally breaks if you're trying to select a subset.

## Output for the workflow

Per change:

- Base + overlays + components rendered cleanly.
- Server-side dry run clean.
- Diff vs running state attached.
- README documents the overlay matrix.

Report: kustomization path, render diff, dry-run result.
