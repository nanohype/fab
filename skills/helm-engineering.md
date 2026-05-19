---
name: helm-engineering
description: Helm charts — values schema, templates, hooks, dependencies, OCI distribution.
---

# Helm Engineering

You author Helm charts. Templates, values, dependencies, hooks, OCI distribution.

## Ground in

- Helm docs: <https://helm.sh/docs/>
- Best practices: <https://helm.sh/docs/chart_best_practices/>
- Values schema: <https://helm.sh/docs/topics/charts/#schema-files>
- OCI registry: <https://helm.sh/docs/topics/registries/>

## Chart layout

```
chart/
├── Chart.yaml               # name, version (semver), appVersion, dependencies
├── values.yaml              # default values, must be a working config
├── values.schema.json       # JSON Schema validates values at install time
├── templates/
│   ├── _helpers.tpl         # named templates, shared values fragments
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── serviceaccount.yaml
│   ├── configmap.yaml
│   ├── networkpolicy.yaml
│   ├── pdb.yaml
│   ├── hpa.yaml
│   └── tests/               # helm test resources
├── crds/                    # CRDs installed before templates (Helm 3 only on first install)
├── README.md                # generated via helm-docs
├── README.md.gotmpl         # template for helm-docs
└── examples/
    └── basic-values.yaml    # working consumer overrides
```

## Chart.yaml

```yaml
apiVersion: v2
name: marshal-api
description: API service for the Marshal tenant.
type: application
version: 1.2.3 # chart version — bump on EVERY change
appVersion: 'v2024.11.03' # app version — bump when the image changes
kubeVersion: '>= 1.28.0'
keywords: [marshal, api]
home: https://github.com/nanohype/protohype/tree/main/marshal
maintainers:
  - { name: marshal-team, email: marshal@nanohype.io }
dependencies:
  - name: postgresql
    version: 14.x.x
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: postgresql.enabled
    alias: db
```

Pin dependencies tightly. `14.x.x` allows patch + minor updates of major 14; `^14.0.0` does not. Use `condition` so consumers can disable subcharts; use `alias` when the subchart's release name should differ from its chart name.

## Values design

Lead with sensible defaults that produce a working deployment:

```yaml
# values.yaml
replicaCount: 3
image:
  repository: ghcr.io/nanohype/marshal-api
  digest: '' # required; no default
  pullPolicy: IfNotPresent
resources:
  requests: { cpu: 100m, memory: 256Mi }
  limits: { cpu: 1000m, memory: 1Gi }
networkPolicy:
  enabled: true
  ingressFrom: # explicit, no default-allow
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ingress-nginx } }
postgresql:
  enabled: true
  auth: { database: marshal }
```

Required values (like `image.digest`) get an empty default + a `required` template helper that fails with a clear message:

```gotemplate
{{- $digest := required "image.digest is required" .Values.image.digest -}}
image: "{{ .Values.image.repository }}@{{ $digest }}"
```

## values.schema.json

Validates at `helm install/upgrade` time. Catches typos, wrong types, missing required fields before they hit the API server:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["image", "resources"],
  "properties": {
    "replicaCount": { "type": "integer", "minimum": 1 },
    "image": {
      "type": "object",
      "required": ["repository", "digest"],
      "properties": {
        "repository": { "type": "string" },
        "digest": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" }
      }
    }
  }
}
```

Strict pattern on `digest` blocks `latest` accidents.

## Templates

Use `_helpers.tpl` for shared fragments. Standard helpers from `helm create`:

```gotemplate
{{- define "marshal-api.fullname" -}}
{{- if .Values.fullnameOverride }}{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}{{- end }}

{{- define "marshal-api.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "marshal-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ .Chart.Name }}
{{- end }}

{{- define "marshal-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "marshal-api.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
```

Then in each manifest:

```gotemplate
metadata:
  name: {{ include "marshal-api.fullname" . }}
  labels: {{- include "marshal-api.labels" . | nindent 4 }}
```

## Hooks

Lifecycle hooks via annotations:

| Hook           | When            | Use                             |
| -------------- | --------------- | ------------------------------- |
| `pre-install`  | Before install  | Bootstrap resources, validation |
| `post-install` | After install   | Smoke test, seed data           |
| `pre-upgrade`  | Before upgrade  | Migrations                      |
| `post-upgrade` | After upgrade   | Validation Job                  |
| `pre-rollback` | Before rollback | Backup current state            |

Hook weights order execution within a phase. Hook deletion policies:

- `hook-succeeded` — clean up after successful run (Jobs that should disappear).
- `hook-failed` — keep on failure (for debugging).
- `before-hook-creation` — replace prior run (re-runnable).

Pre-upgrade migration Job pattern:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "marshal-api.fullname" . }}-migrate
  annotations:
    helm.sh/hook: pre-upgrade,pre-install
    helm.sh/hook-weight: "-5"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  activeDeadlineSeconds: 600
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: {{ include "marshal-api.fullname" . }}-migrate
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}@{{ .Values.image.digest }}"
          command: [./migrate, up]
```

`activeDeadlineSeconds` prevents the hook from blocking the upgrade indefinitely.

## CRD handling

CRDs in `crds/` install once on first `helm install` and are NEVER updated by Helm afterward. Two patterns:

1. **Ship CRDs in the chart's `crds/` directory.** Simple, but CRD updates require manual `kubectl apply`. Best for first-party charts.
2. **Ship CRDs in a separate chart.** Consumer applies it first; main chart depends on the CRDs being present. Works for shared CRDs across multiple charts (cert-manager pattern).

In ArgoCD, set `ServerSideApply=true` on Applications that install CRDs to avoid `annotations-too-long` errors.

## OCI distribution

Charts publish to OCI registries (ECR, GHCR, etc.):

```sh
helm package chart/
helm push marshal-api-1.2.3.tgz oci://ghcr.io/nanohype/charts
```

Cosign-sign the chart for prod registries:

```sh
cosign sign --key cosign.key oci://ghcr.io/nanohype/charts/marshal-api:1.2.3
```

Consumers verify via Kyverno admission policies.

## Testing

In CI:

- `helm lint` — basic syntax + chart standards.
- `helm template` — render with default values + at least one consumer-values overlay. Fail on rendering errors.
- `helm-docs` — README drift check.
- `chart-testing` (`ct`) — `ct lint` + `ct install` against a kind cluster. Catches manifest issues that linting misses.
- `kyverno test` if the chart includes policies.

```yaml
# .github/workflows/chart-ci.yml — sketch
- run: helm lint chart/
- run: helm template chart/ --values examples/basic-values.yaml | kubectl apply --dry-run=server -f -
- uses: helm/chart-testing-action@v2
  with: { command: install, target_branch: main }
```

## Common pitfalls

- **Forking upstream charts.** Don't. Use `extraManifests`, `postRenderers`, or open a PR upstream. Forks rot fast.
- **`{{ .Release.Name }}` in label selectors.** Fine for new resources, but changing a release name on upgrade breaks the selector → existing pods orphaned.
- **Missing `nindent` in YAML.** Wrong indentation = silent template error. `nindent` (newline + indent) over `indent` for multi-line blocks.
- **Updating CRDs via Helm.** Helm 3 won't update CRDs in `crds/`. Either re-apply manually or move to a separate CRD chart.
- **Skipping `values.schema.json`.** Saves debugging time. The schema catches mistakes before they hit the API server.
- **Hooks without `activeDeadlineSeconds`.** A stuck migration blocks every future upgrade.
- **Hardcoded namespaces.** Use `{{ .Release.Namespace }}`.

## Output for the workflow

Per chart:

- `helm template` diff vs prior version.
- `helm lint` clean.
- README generated from helm-docs.
- Chart version bumped per semver rules.
- `values.schema.json` covers required fields.

Report: chart path, version delta, lint result, render diff highlights.
