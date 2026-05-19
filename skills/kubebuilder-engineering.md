---
name: kubebuilder-engineering
description: Kubebuilder + controller-runtime — CRDs, reconcilers, webhooks, finalizers.
---

# Kubebuilder Engineering

You extend the eks-agent-platform operator. Add CRDs, reconcilers, webhooks, finalizers via kubebuilder + controller-runtime.

## Ground in

- Kubebuilder book: <https://book.kubebuilder.io/>
- controller-runtime docs: <https://pkg.go.dev/sigs.k8s.io/controller-runtime>
- The Operator pattern: <https://kubernetes.io/docs/concepts/extend-kubernetes/operator/>
- The existing operator structure in `eks-agent-platform/`.

## Project layout

```
eks-agent-platform/
├── PROJECT                       # kubebuilder project config
├── api/
│   └── v1alpha1/
│       ├── platform_types.go     # Platform CRD types
│       ├── agentfleet_types.go   # AgentFleet CRD types
│       ├── groupversion_info.go  # API group registration
│       └── zz_generated_*.go     # generated DeepCopy methods
├── internal/
│   ├── controller/
│   │   ├── platform_controller.go
│   │   ├── platform_controller_test.go
│   │   └── agentfleet_controller.go
│   └── webhook/
│       ├── platform_webhook.go   # admission webhook
│       └── platform_conversion.go # version conversion webhook
├── config/                       # kustomize configs for deploy
│   ├── crd/                      # CRDs (generated from types)
│   ├── rbac/                     # operator's own RBAC
│   ├── manager/                  # operator Deployment
│   ├── webhook/                  # webhook configurations
│   └── default/                  # the default overlay
├── cmd/main.go                   # entry point: manager setup
└── Makefile                      # generate, build, test, deploy targets
```

## Adding a new CRD

```sh
operator-sdk create api --group agents.stxkxs.io --version v1alpha1 --kind PlatformQuota
```

This scaffolds `api/v1alpha1/platformquota_types.go` + `internal/controller/platformquota_controller.go`.

## CRD type definition

```go
// api/v1alpha1/platformquota_types.go
type PlatformQuotaSpec struct {
    // Platform is the name of the Platform this quota override applies to.
    // +kubebuilder:validation:Required
    // +kubebuilder:validation:MinLength=1
    Platform string `json:"platform"`

    // CPU overrides the base ResourceQuota CPU allocation.
    // +kubebuilder:validation:Pattern=`^[0-9]+m?$`
    // +optional
    CPU string `json:"cpu,omitempty"`

    // Memory overrides the base ResourceQuota memory allocation.
    // +kubebuilder:validation:Pattern=`^[0-9]+(Ki|Mi|Gi|Ti)?$`
    // +optional
    Memory string `json:"memory,omitempty"`

    // Reason documents why this override exists. Required for audit.
    // +kubebuilder:validation:Required
    // +kubebuilder:validation:MinLength=10
    Reason string `json:"reason"`

    // Expires is the date after which this override is invalid.
    // +optional
    Expires *metav1.Time `json:"expires,omitempty"`
}

type PlatformQuotaStatus struct {
    // Conditions represents the latest available observations.
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // Applied is true when the override is reflected in the namespace's ResourceQuota.
    Applied bool `json:"applied"`

    // LastReconcileTime is the timestamp of the last successful reconcile.
    LastReconcileTime *metav1.Time `json:"lastReconcileTime,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Platform",type=string,JSONPath=`.spec.platform`
// +kubebuilder:printcolumn:name="Applied",type=boolean,JSONPath=`.status.applied`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type PlatformQuota struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec   PlatformQuotaSpec   `json:"spec,omitempty"`
    Status PlatformQuotaStatus `json:"status,omitempty"`
}
```

Notes:

- Kubebuilder markers (`+kubebuilder:...`) generate the OpenAPI schema embedded in the CRD.
- Pattern validation runs at admission time — invalid values get rejected before they hit the controller.
- `printcolumn` controls `kubectl get` output.
- Always include `Conditions` + `LastReconcileTime` in Status — standard observability pattern.

Run `make manifests` to regenerate `config/crd/bases/`.

## Reconciler

```go
// internal/controller/platformquota_controller.go
func (r *PlatformQuotaReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    log := log.FromContext(ctx)

    var pq agentsv1alpha1.PlatformQuota
    if err := r.Get(ctx, req.NamespacedName, &pq); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Handle deletion
    if !pq.DeletionTimestamp.IsZero() {
        if controllerutil.ContainsFinalizer(&pq, finalizerName) {
            if err := r.finalize(ctx, &pq); err != nil {
                return ctrl.Result{}, err
            }
            controllerutil.RemoveFinalizer(&pq, finalizerName)
            return ctrl.Result{}, r.Update(ctx, &pq)
        }
        return ctrl.Result{}, nil
    }

    // Add finalizer if missing
    if !controllerutil.ContainsFinalizer(&pq, finalizerName) {
        controllerutil.AddFinalizer(&pq, finalizerName)
        if err := r.Update(ctx, &pq); err != nil {
            return ctrl.Result{}, err
        }
    }

    // Check expiration
    if pq.Spec.Expires != nil && pq.Spec.Expires.Before(&metav1.Time{Time: time.Now()}) {
        log.Info("PlatformQuota expired", "name", pq.Name)
        meta.SetStatusCondition(&pq.Status.Conditions, metav1.Condition{
            Type: "Expired", Status: metav1.ConditionTrue, Reason: "PastExpiry",
            Message: "Override has expired and is no longer applied",
        })
        pq.Status.Applied = false
        return ctrl.Result{RequeueAfter: 1 * time.Hour}, r.Status().Update(ctx, &pq)
    }

    // Apply the override
    if err := r.applyOverride(ctx, &pq); err != nil {
        meta.SetStatusCondition(&pq.Status.Conditions, metav1.Condition{
            Type: "Applied", Status: metav1.ConditionFalse, Reason: "ApplyFailed",
            Message: err.Error(),
        })
        if updateErr := r.Status().Update(ctx, &pq); updateErr != nil {
            log.Error(updateErr, "failed to update status")
        }
        return ctrl.Result{}, err
    }

    pq.Status.Applied = true
    pq.Status.LastReconcileTime = &metav1.Time{Time: time.Now()}
    meta.SetStatusCondition(&pq.Status.Conditions, metav1.Condition{
        Type: "Applied", Status: metav1.ConditionTrue, Reason: "OverrideApplied",
        Message: "PlatformQuota override reflected in namespace ResourceQuota",
    })

    return ctrl.Result{RequeueAfter: 10 * time.Minute}, r.Status().Update(ctx, &pq)
}
```

Key invariants:

- **Idempotent**. Re-running the reconcile against the same desired state must produce the same observed state.
- **Level-triggered**. Don't rely on edge events ("got an Add, now do Y"). The controller may miss events; always reconcile against current state.
- **Status subresource**. Separates spec (user intent) from status (controller output). Update status via `r.Status().Update()`.
- **RequeueAfter** for time-based work (expiration checks, periodic re-sync). Faster than waiting for the next event.
- **Finalizers** for cleanup. Always remove finalizers in the same controller that added them.

## Webhooks

### Validating admission webhook

```go
func (v *PlatformQuotaValidator) ValidateCreate(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
    pq := obj.(*agentsv1alpha1.PlatformQuota)
    if pq.Spec.Expires != nil && pq.Spec.Expires.Before(&metav1.Time{Time: time.Now()}) {
        return nil, fmt.Errorf("spec.expires must be in the future")
    }
    return nil, nil
}
```

Validating webhooks catch shape problems that OpenAPI markers can't express (cross-field validation, temporal constraints).

### Conversion webhook

When promoting from `v1alpha1` to `v1beta1`, ship a conversion webhook that translates between versions. controller-runtime's `Convertible` interface:

```go
func (src *PlatformQuota) ConvertTo(dstRaw conversion.Hub) error {
    dst := dstRaw.(*v1beta1.PlatformQuota)
    dst.ObjectMeta = src.ObjectMeta
    dst.Spec.Platform = src.Spec.Platform
    dst.Spec.CPU = src.Spec.CPU
    dst.Spec.Memory = src.Spec.Memory
    dst.Spec.Reason = src.Spec.Reason
    dst.Spec.ExpiresAt = src.Spec.Expires  // renamed field
    return nil
}
```

## Testing with envtest

```go
func TestPlatformQuotaReconcile(t *testing.T) {
    testEnv := &envtest.Environment{
        CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd", "bases")},
    }
    cfg, err := testEnv.Start()
    require.NoError(t, err)
    defer testEnv.Stop()

    k8sClient, err := client.New(cfg, client.Options{Scheme: scheme.Scheme})
    require.NoError(t, err)

    reconciler := &PlatformQuotaReconciler{Client: k8sClient, Scheme: scheme.Scheme}

    pq := &agentsv1alpha1.PlatformQuota{...}
    require.NoError(t, k8sClient.Create(ctx, pq))

    result, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: types.NamespacedName{...}})
    require.NoError(t, err)
    require.True(t, result.RequeueAfter > 0)

    // Verify side effects
    var rq corev1.ResourceQuota
    require.NoError(t, k8sClient.Get(ctx, types.NamespacedName{...}, &rq))
    require.Equal(t, "32", rq.Spec.Hard["cpu"].String())
}
```

envtest spins up a real etcd + apiserver locally; no kubelet. Fast + realistic.

## Common pitfalls

- **Edge-triggered logic.** Relying on watch events alone misses replays. Reconcile from current state every time.
- **Mutating during admission.** Mutating webhooks add cluster-wide failure modes. Prefer validating + reconciliation.
- **Updating status from spec.** Don't use `r.Update()` on the main resource for status changes — use `r.Status().Update()`.
- **Missing finalizer removal.** The resource hangs in `Terminating` forever. Always remove the finalizer after cleanup succeeds.
- **Reconciling on every event.** A reconcile that schedules a `RequeueAfter` of 10s on success creates a busy loop. Use longer requeue intervals + watches for actual changes.
- **Hardcoded RBAC.** The operator's RBAC lives in `config/rbac/`. Add new permissions there + run `make manifests`.
- **Skipping `make manifests` after type changes.** CRDs go out of sync with code; admission fails or accepts wrong shapes.

## What this engineer does NOT do

- Write Helm charts (`helm-engineer`).
- Configure ArgoCD Applications (`argocd-curator`).
- Author Platform CRs (`eks-agent-platform-curator` advises, application teams write).

## Output for the workflow

Per change:

- Type definitions with kubebuilder markers.
- Reconciler with idempotency + finalizer + status updates.
- Webhook definitions if cross-field validation needed.
- envtest unit tests.
- `make manifests` clean.
- RBAC delta documented.

Report: file paths, controller name, test coverage, CRD diff.
