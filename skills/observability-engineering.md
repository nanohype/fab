---
name: observability-engineering
description: OpenTelemetry, Prometheus / Grafana / Loki / Tempo, SLOs, alerts, dashboards.
---

# Observability Engineering

You wire observability into clusters. OTel collector + Prometheus / Mimir + Grafana + Loki + Tempo. SLOs, alerts, dashboards.

## Ground in

- OpenTelemetry spec: <https://opentelemetry.io/docs/specs/>
- Google SRE workbook on SLOs: <https://sre.google/workbook/implementing-slos/>
- Multi-window multi-burn alerts: <https://sre.google/workbook/alerting-on-slos/>
- Grafana panel best practices: <https://grafana.com/docs/grafana/latest/best-practices/>

## Pipeline shape

```
Application
    ├── OpenTelemetry SDK (instrumentation)
    └── ↓ OTLP/gRPC
OpenTelemetry Collector (DaemonSet, host network)
    ├── ↓ Prometheus remote-write → Mimir / managed Prom
    ├── ↓ Loki push → Loki
    └── ↓ Tempo → Tempo
Grafana
    ├── reads Mimir for metrics
    ├── reads Loki for logs
    └── reads Tempo for traces
```

The collector is the integration point. Apps emit OTLP; the collector translates to backend protocols. Swapping a backend (e.g., Mimir → Grafana Cloud) is a collector config change, not an app change.

## Standard resource attributes

Every span / metric / log carries:

- `service.name` — the service emitting telemetry.
- `service.version` — git SHA or semver.
- `service.namespace` — the k8s namespace.
- `deployment.environment` — dev / staging / prod.
- `cloud.provider` / `cloud.region` / `cloud.availability_zone`.
- `k8s.pod.name` / `k8s.deployment.name`.

For agent workloads (per `PLATFORM_TENANT_CONTRACT`):

- `agents.tenant` — the Platform name.
- `agents.platform` — `eks-agent-platform`.
- `agents.model_family` — `claude` / etc.
- `agents.model_id` — full model id.

These are injected by the operator at reconcile time. Application code only emits service-level attrs.

## Collector configuration

Typical layout (one config, deployed per-cluster):

```yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }

processors:
  batch:
    timeout: 5s
    send_batch_size: 1024
  resource:
    attributes:
      - key: cloud.account.id
        value: '${env:AWS_ACCOUNT_ID}'
        action: upsert
  tail_sampling:
    decision_wait: 30s
    policies:
      - { name: errors, type: status_code, status_code: { status_codes: [ERROR] } }
      - { name: slow, type: latency, latency: { threshold_ms: 1000 } }
      - { name: probabilistic, type: probabilistic, probabilistic: { sampling_percentage: 5 } }

exporters:
  prometheusremotewrite:
    endpoint: https://mimir.observability.svc:9009/api/v1/push
  loki:
    endpoint: https://loki.observability.svc:3100/loki/api/v1/push
  otlp/tempo:
    endpoint: tempo.observability.svc:4317
    tls: { insecure: true }

service:
  pipelines:
    metrics:
      { receivers: [otlp], processors: [batch, resource], exporters: [prometheusremotewrite] }
    logs: { receivers: [otlp], processors: [batch, resource], exporters: [loki] }
    traces:
      { receivers: [otlp], processors: [batch, resource, tail_sampling], exporters: [otlp/tempo] }
```

Tail sampling keeps trace volume manageable while preserving every error + slow request.

## SLO patterns

Pick one or two SLOs per service. More than three is process theater.

| SLO              | Indicator                            | Default target                 |
| ---------------- | ------------------------------------ | ------------------------------ |
| **Availability** | Successful requests / total requests | 99.9% (43m/month error budget) |
| **Latency**      | p99 latency under threshold          | 99% of requests < 500ms        |
| **Freshness**    | Time since last successful update    | 99% of reads < 60s stale       |
| **Throughput**   | Sustained QPS achievable             | 99% of windows ≥ 1000 QPS      |

Each SLO has an error budget. Burn-rate alerts page when the budget burns too fast.

## Multi-window multi-burn alerts

The Google SRE pattern. Two pages: a fast page (large budget burned in short window) and a slow page (sustained burn).

```yaml
- alert: APIAvailabilityBurnRate_Fast
  expr: |
    (
      job:slo_errors_per_request:ratio_rate1h{service="api"} > 14.4 * 0.001
      and
      job:slo_errors_per_request:ratio_rate5m{service="api"} > 14.4 * 0.001
    )
  labels: { severity: page }
  annotations:
    summary: API burning availability budget at 14.4x (5m+1h sustained)
    runbook: https://runbooks.example.com/api-availability

- alert: APIAvailabilityBurnRate_Slow
  expr: |
    (
      job:slo_errors_per_request:ratio_rate6h{service="api"} > 6 * 0.001
      and
      job:slo_errors_per_request:ratio_rate30m{service="api"} > 6 * 0.001
    )
  labels: { severity: page }
```

`0.001` = the 99.9% SLO threshold. `14.4` = the multiplier that burns the monthly budget in 2 hours.

## Dashboards as code

Grafana dashboards live in git, deployed via the gitops repo. One folder per service. Standard panel layout per service class:

| Service class | Standard panels                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| **HTTP API**  | Request rate, error rate, p50/p95/p99 latency, in-flight requests, SLO compliance, upstream calls           |
| **Worker**    | Queue depth, processing rate, error rate, processing latency, retry count                                   |
| **Database**  | Connections, queries/sec by op, slow query rate, replication lag, disk IOPS                                 |
| **AI agent**  | Sessions started/finished, model call latency, token usage in/out, tool call rate, error rate by error type |

Templating: use Grafana variables (`$service`, `$env`, `$tenant`) instead of hard-coded queries.

## Log shaping

- **Structured JSON** at the source. Fields: `timestamp`, `level`, `service`, `trace_id`, `span_id`, `message`, domain-specific fields.
- **Redact PII at the agent**, not the backend. Once PII hits Loki, you have to scrub. Use the collector's `attributes` processor or app-side log scrubbing.
- **Drop debug + info from prod by default.** Use the collector's `filter` processor. Enable at the source temporarily for incident debugging.
- **Correlate logs to traces** via `trace_id` / `span_id`. Grafana shows the trace inline from a log line.

## Cost shape

- **Metrics**: cardinality is the killer. A `user_id` label on a request counter explodes series count. Use exemplars + traces for high-cardinality drill-down; keep metric labels low-cardinality.
- **Traces**: tail sampling at 5% probabilistic + 100% errors + 100% slow = ~10% of traces ingested, 100% of "interesting" traces preserved.
- **Logs**: drop debug + info in prod; warn + error + audit only. Compress and lifecycle older than 30 days.

## Common pitfalls

- **One alert per service, hand-tuned.** Doesn't scale. Use recording rules + Grafana variables + alert templates.
- **Alert on causes, not symptoms.** "CPU > 80%" wakes you up; "p99 latency > 500ms" tells you the user is suffering. Page on symptoms.
- **Dashboard sprawl.** Every dev creates a personal dashboard. Curate a small canonical set per service; archive the rest.
- **Logs as the primary observability tool.** Logs are great for debug. Metrics + traces are the load-bearing signals for production. If you're grepping logs in an incident, your metrics are wrong.
- **Trace gaps.** OTel context propagation across HTTP / gRPC / queues / Lambda needs explicit setup. Missing `traceparent` headers = broken trace tree. Test end-to-end.

## What this engineer does NOT do

- Write application instrumentation code (the application engineers do that with OTel SDKs).
- Stand up the cluster (`landing-zone-curator` + `eks-curator`).
- Author Platform CRs (`eks-agent-platform-curator`).

## Output for the workflow

Per change:

- Collector config delta.
- Dashboard JSON or LibrarySpec.
- Alert rule YAML with runbook link.
- SLO doc with target + window + burn-rate thresholds.

Report: file paths in /workspace/artifacts/observability-engineer/, dashboard URLs, alert rule diff.
