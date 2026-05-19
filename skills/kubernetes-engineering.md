---
name: kubernetes-engineering
description: Kubernetes manifests, NetworkPolicy, RBAC, PDBs, HPAs, probes.
---

# Kubernetes Engineering

You author Kubernetes. Deployments, StatefulSets, Services, NetworkPolicies, RBAC, PodDisruptionBudgets, HorizontalPodAutoscalers, probes.

## Ground in

- Kubernetes API reference: <https://kubernetes.io/docs/reference/>
- Production patterns: <https://kubernetes.io/docs/concepts/workloads/>
- Network policies: <https://kubernetes.io/docs/concepts/services-networking/network-policies/>

## Resource shape (every workload)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: marshal
  labels:
    app.kubernetes.io/name: api
    app.kubernetes.io/instance: marshal-api
    app.kubernetes.io/component: backend
    app.kubernetes.io/part-of: marshal
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app.kubernetes.io/name: api
  template:
    metadata:
      labels: { app.kubernetes.io/name: api }
    spec:
      serviceAccountName: api
      automountServiceAccountToken: true
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile: { type: RuntimeDefault }
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector: { matchLabels: { app.kubernetes.io/name: api } }
      containers:
        - name: api
          image: ghcr.io/nanohype/marshal-api@sha256:abc... # always digest-pinned, never `latest`
          imagePullPolicy: IfNotPresent
          ports:
            - { name: http, containerPort: 8080, protocol: TCP }
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { cpu: 1000m, memory: 1Gi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            initialDelaySeconds: 10
            periodSeconds: 30
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            initialDelaySeconds: 2
            periodSeconds: 5
            failureThreshold: 2
          startupProbe:
            httpGet: { path: /healthz, port: http }
            failureThreshold: 30
            periodSeconds: 2
          env:
            - { name: POD_NAME, valueFrom: { fieldRef: { fieldPath: metadata.name } } }
            - { name: POD_NAMESPACE, valueFrom: { fieldRef: { fieldPath: metadata.namespace } } }
          envFrom:
            - secretRef: { name: api-secrets } # delivered by external-secrets-operator
```

## Required companions

Every Deployment ships with:

- **Service** (ClusterIP). Named ports match container ports.
- **ServiceAccount**. Per-workload, not shared.
- **NetworkPolicy** — default deny + explicit allow.
- **PodDisruptionBudget** for `replicas ≥ 2`. `maxUnavailable: 1` or `minAvailable: <N-1>`.
- **HPA** (or KEDA `ScaledObject`) for autoscaling workloads.
- **ServiceMonitor** / **PodMonitor** if Prometheus scrapes it.

## NetworkPolicy

Default deny in every namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: marshal }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

Then explicit allows:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-allow, namespace: marshal }
spec:
  podSelector: { matchLabels: { app.kubernetes.io/name: api } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: argocd } }
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: observability } }
        - podSelector: { matchLabels: { app.kubernetes.io/name: ingress-nginx } }
      ports: [{ port: 8080 }]
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
      ports: [{ port: 53, protocol: UDP }, { port: 53, protocol: TCP }]
    - to:
        - podSelector: { matchLabels: { app.kubernetes.io/name: postgres } }
      ports: [{ port: 5432 }]
```

## Probes

| Probe         | Purpose                             | Tuning                                                                         |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| **liveness**  | Restart if dead                     | Loose — only fire on truly stuck states. False positives = pointless restarts. |
| **readiness** | Take out of rotation if not healthy | Tight — every dependency check, every queue connection, sub-second response.   |
| **startup**   | Give slow boots time                | Use when initialization > liveness `initialDelaySeconds`                       |

Common mistake: liveness probe that's actually a readiness probe. If the check depends on a downstream service, use readiness.

## RBAC

Least privilege per ServiceAccount. Use Roles (namespace-scoped) before ClusterRoles. Never grant `cluster-admin` to application workloads.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: api-leader-election, namespace: marshal }
rules:
  - apiGroups: ['coordination.k8s.io']
    resources: ['leases']
    verbs: ['get', 'create', 'update']
    resourceNames: ['api-leader']
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: api-leader-election, namespace: marshal }
subjects: [{ kind: ServiceAccount, name: api, namespace: marshal }]
roleRef: { kind: Role, name: api-leader-election, apiGroup: rbac.authorization.k8s.io }
```

`resourceNames` shrinks blast radius further. Most RBAC reviews catch missing `resourceNames`.

## Resource shaping

- **requests** = guaranteed compute. Set to typical steady-state usage. The scheduler uses this for placement.
- **limits** = cap. CPU limits throttle; memory limits OOM-kill. Set memory limit ≈ 1.5x request. CPU limits often hurt more than help — consider omitting for latency-sensitive workloads, keep them for batch.
- **QoS class** = Guaranteed (requests == limits), Burstable (requests < limits), or BestEffort (neither). Production workloads should be Guaranteed or Burstable. BestEffort gets killed first under pressure.

## HPA

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: api, namespace: marshal }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  minReplicas: 3
  maxReplicas: 30
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies: [{ type: Percent, value: 100, periodSeconds: 30 }]
    scaleDown:
      stabilizationWindowSeconds: 300
      policies: [{ type: Percent, value: 50, periodSeconds: 60 }]
```

For event-driven autoscaling (queue depth, Pub/Sub backlog, Prometheus query), use KEDA `ScaledObject` (see `keda-engineer`).

## Labels

Standard label set on every resource:

- `app.kubernetes.io/name` — the application name (e.g., `api`).
- `app.kubernetes.io/instance` — instance identifier (e.g., `marshal-api`).
- `app.kubernetes.io/component` — role (`backend`, `frontend`, `db`).
- `app.kubernetes.io/part-of` — top-level app (`marshal`).
- `app.kubernetes.io/managed-by` — `helm` / `argocd` / `kustomize`.

These are the labels Prometheus, Grafana dashboards, and ArgoCD pivot on.

## Common pitfalls

- **`latest` image tag.** Non-reproducible. Always pin to digest.
- **No PDB on multi-replica workloads.** Cluster upgrades drain nodes; without a PDB everything goes to 0.
- **`hostNetwork: true` or `hostPID: true`.** Privileged. Reject unless there's a specific reason.
- **Privileged containers.** Reject. If a tool truly needs root, it lives in a DaemonSet with explicit `securityContext`.
- **Volumes mounted writable that don't need to be.** Set `readOnlyRootFilesystem: true` and write to `emptyDir` mounts.
- **Liveness probe that hits a database.** A database hiccup restarts every replica simultaneously. Probes are local-only.
- **Resource requests set to `0`.** Scheduler crams pods onto nodes, OOM kills follow.

## Output for the workflow

Per chart or manifest set:

- All required companions present (Service, SA, NetPol, PDB, HPA where applicable).
- Probes set deliberately, not copy-paste.
- securityContext + capabilities locked down.
- Labels standardized.
- Image pinned to digest.

Report: file paths, manifest count, gate-relevant findings (missing PDB, missing NetPol, etc.).
