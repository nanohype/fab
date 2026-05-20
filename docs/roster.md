# Jaunty Roster

The roster is 83 specialists organized around factory phases. Workflow code in `src/workflows.ts` fans out across phase-scoped multiagent sessions; there is no top-level coordinator agent. Anthropic's Managed Agents caps a multiagent roster at 20 unique agents and does not nest coordinators, so each phase runs as its own session and workflow code orchestrates across them.

## Naming convention

- **`-curator`** — stewards knowledge of a system, service, or platform. Curators know about something deeply; they consult, review, advise. Examples: `aws-curator`, `landing-zone-curator`, `claude-curator`, `notion-curator`.
- **`-engineer`** — produces code or configuration with a tool, framework, or language. Engineers build with something. Examples: `react-engineer`, `opentofu-engineer`, `helm-engineer`, `kyverno-engineer`.
- **process names** — no suffix. Gate / checkpoint roles owned by the merge gate. Examples: `pr-reviewer`, `build-verifier`, `artifact-auditor`, `release-manager`, `external-reviewer`.

The split exists so we can compose a knowledge expert with a production engineer on the same task. An `aws-curator` advises on Well-Architected pillars and service selection; an `opentofu-engineer` writes the HCL that implements the recommendation.

## Hierarchy

```
Workflow code (src/workflows.ts) — top-level routing
│
├── Discovery (3)
│   intake-analyst · product · product-research-curator
│
├── Design (4)
│   design-lead · ux-engineer · accessibility-engineer · ux-writer
│
├── Build — 8 parallel sub-area sessions
│   ├── Frontend (3)
│   │   react-engineer · next-engineer · mobile-engineer
│   ├── Backend (3)
│   │   node-engineer · python-engineer · go-engineer
│   ├── AI (5)
│   │   rag-engineer · agent-engineer · eval-engineer ·
│   │   bedrock-curator · claude-curator
│   ├── Data (3)
│   │   postgres-engineer · opensearch-engineer · dynamodb-curator
│   ├── Substrate (6)
│   │   aws-curator · gcp-curator · azure-curator ·
│   │   opentofu-engineer · terragrunt-engineer · landing-zone-curator
│   ├── Cluster Platform (7)
│   │   eks-curator · gke-curator · aks-curator ·
│   │   kubernetes-engineer · helm-engineer · kustomize-engineer ·
│   │   karpenter-curator
│   ├── Cluster Addons (7)
│   │   argocd-curator · eks-gitops-curator · kyverno-engineer ·
│   │   cert-manager-curator · secrets-engineer ·
│   │   observability-engineer · keda-engineer
│   └── Agent Platform (4)
│       eks-agent-platform-curator · kagent-curator ·
│       agentgateway-curator · kubebuilder-engineer
│
├── Verify (5)
│   pr-reviewer · qa-security · build-verifier · artifact-auditor ·
│   compliance-curator
│
├── Ship (3)
│   release-manager · deploy-engineer · migration-engineer
│
├── Operate (4)
│   ops-sre · ops-incident · ops-finops · ops-automation
│
├── Customer (3)
│   cs-success · cs-support · cs-renewals
│
├── Business — 3 parallel sub-area sessions
│   ├── Sales (3)
│   │   sales-lead · sales-solutions · sales-ops
│   ├── Marketing (4)
│   │   marketing-lead · content-engineer · seo-engineer ·
│   │   brand-strategist
│   └── Lead Gen (3)
│       lead-research-curator · lead-outbound · lead-events
│
├── System Curators (7) — cross-cutting SaaS knowledge
│   github-curator · jira-curator · notion-curator · slack-curator ·
│   linear-curator · figma-curator · stripe-curator
│
├── Staff (3)
│   chief-of-staff · legal-curator · data-analyst
│
└── Lab (3)
    external-reviewer · prompt-optimizer · learner
```

Group assignment (`group` field on each `TeamMember`):

- **factory** — Discovery, Design, Build, Verify, Ship. Output is shippable artifacts. Gets `FACTORY_PREAMBLE` injected by `buildSystemPrompt`.
- **firm** — Operate, Customer, Business, System Curators, Staff. Runs the business.
- **lab** — Lab. Meta-work: calibration, prompt analysis, pattern extraction.

## File layout

`src/team.ts` is a barrel that re-exports from per-phase files. Each file declares ≤ 8 specialists so it stays readable.

```
src/team/
├── discovery.ts
├── design.ts
├── build/
│   ├── frontend.ts
│   ├── backend.ts
│   ├── ai.ts
│   ├── data.ts
│   ├── substrate.ts
│   ├── cluster-platform.ts
│   ├── cluster-addons.ts
│   └── agent-platform.ts
├── verify.ts
├── ship.ts
├── operate.ts
├── customer.ts
├── business/
│   ├── sales.ts
│   ├── marketing.ts
│   └── lead-gen.ts
├── system-curators.ts
├── staff.ts
└── lab.ts
```

## Gate roles

The merge gate uses four specialist roles plus an out-of-band calibration:

- `pr-reviewer` — architecture, patterns, frontend craft, code quality dimensions of the quality rubric.
- `qa-security` — security + systems dimensions.
- `build-verifier` — testing + devops + version_currency dimensions; runs the four-phase contract.
- `artifact-auditor` — documentation + consistency dimensions; verifies scope-ledger + link integrity.
- `external-reviewer` — cold-context calibration. Grades all 9 dimensions without seeing internal verdicts. Drift > 1 letter blocks the merge.

`compliance-curator` joins the Verify phase for regulated workloads; its findings are advisory unless the brief explicitly gates on compliance.

## Skill overlay

Every role's skill resolves through the overlay chain documented in `skills/README.md`:

```
$JAUNTY_SKILLS_DIR → ~/.jaunty/skills/ → <cwd>/.jaunty/skills/ → bundled jaunty/skills/
```

Curators and engineers have bundled baselines at `jaunty/skills/<def.name>.md`. Override any of them via `~/.jaunty/skills/<def.name>.md` (replace) or `<def.name>.append.md` (append). The brief-typed roles (`product`, `design-lead`, `sales-lead`, `marketing-lead`) resolve to nanohype brief templates by default.
