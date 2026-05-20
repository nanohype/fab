import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendOverlays, loadSkillWithOverlay } from './overlay.js';
import type { TeamRole } from './types.js';

// ── Skill definition mapping ────────────────────────────────────────

interface SkillDef {
  name: string;
  description: string;
  type: 'brief' | 'composed' | 'generated';
  briefTemplate?: string; // for type: brief — template dir name
  referencePaths?: string[]; // for type: composed — additional files
}

const SKILL_DEFS: Record<TeamRole, SkillDef> = {
  // ── Discovery ───────────────────────────────────────────────────────
  'intake-analyst': {
    name: 'intake-analysis',
    description: 'Intake JSON validation, constraint feasibility, ambiguity resolution, workflow suggestion.',
    type: 'generated',
  },
  product: {
    name: 'prd-brief',
    description:
      'Framework for drafting product requirements documents: problem decomposition, user stories, success metrics, and scope boundaries.',
    type: 'brief',
    briefTemplate: 'brief-prd',
  },
  'product-research-curator': {
    name: 'product-research',
    description: 'User research, competitive analysis, market sizing, and discovery.',
    type: 'generated',
  },
  // ── Design ──────────────────────────────────────────────────────────
  'design-lead': {
    name: 'design-review-brief',
    description:
      'Methodology for systematic design audits: visual consistency, token coverage, component coherence, and accessibility compliance.',
    type: 'brief',
    briefTemplate: 'brief-design-review',
  },
  'ux-engineer': {
    name: 'ux-research',
    description: 'Usability testing, user journey mapping, wireframes, and interaction design.',
    type: 'generated',
  },
  'accessibility-engineer': {
    name: 'accessibility',
    description: 'WCAG compliance, screen reader testing, keyboard navigation, and a11y audits.',
    type: 'generated',
  },
  'ux-writer': {
    name: 'ux-writing',
    description: 'Microcopy, UI text, error messages, onboarding copy.',
    type: 'generated',
  },
  // ── Build · Frontend ────────────────────────────────────────────────
  'react-engineer': {
    name: 'react-engineering',
    description: 'React component design, hooks, composition, performance, accessibility.',
    type: 'generated',
  },
  'next-engineer': {
    name: 'next-engineering',
    description: 'Next.js app router, server components, streaming, edge runtime, ISR.',
    type: 'generated',
  },
  'mobile-engineer': {
    name: 'mobile-engineering',
    description: 'React Native, cross-platform, mobile UX, app store deployment.',
    type: 'generated',
  },
  // ── Build · Backend ─────────────────────────────────────────────────
  'node-engineer': {
    name: 'node-engineering',
    description: 'Node.js HTTP services, workers, queues, reliability patterns.',
    type: 'generated',
  },
  'python-engineer': {
    name: 'python-engineering',
    description: 'Python FastAPI services, async pipelines, data workloads.',
    type: 'generated',
  },
  'go-engineer': {
    name: 'go-engineering',
    description: 'Go HTTP services, CLIs, infra components, context-driven design.',
    type: 'generated',
  },
  // ── Build · AI ──────────────────────────────────────────────────────
  'rag-engineer': {
    name: 'rag-engineering',
    description:
      'Retrieval pipelines: chunking, embedding, vector storage, hybrid search, re-ranking, retrieval evals.',
    type: 'generated',
  },
  'agent-engineer': {
    name: 'agent-engineering',
    description: 'Agent loops, tool integration, MCP servers, multi-agent orchestration.',
    type: 'generated',
  },
  'eval-engineer': {
    name: 'eval-engineering',
    description: 'LLM eval harnesses, golden sets, regression suites, model-graded judges.',
    type: 'generated',
  },
  'bedrock-curator': {
    name: 'bedrock-curation',
    description: 'AWS Bedrock model access, IAM, cross-region routing, provisioned throughput, guardrails.',
    type: 'generated',
  },
  'claude-curator': {
    name: 'claude-curation',
    description: 'Claude model family — picking, prompt-caching, tool use, extended thinking, vision.',
    type: 'generated',
  },
  // ── Build · Data ────────────────────────────────────────────────────
  'postgres-engineer': {
    name: 'postgres-engineering',
    description: 'Postgres schemas, indexes, migrations, replication, partitioning, pgvector.',
    type: 'generated',
  },
  'opensearch-engineer': {
    name: 'opensearch-engineering',
    description: 'OpenSearch / Elasticsearch indices, hybrid search, k-NN, ingest pipelines.',
    type: 'generated',
  },
  'dynamodb-curator': {
    name: 'dynamodb-curation',
    description: 'DynamoDB single-table design, access patterns, GSIs, streams, capacity mode.',
    type: 'generated',
  },
  // ── Build · Substrate ───────────────────────────────────────────────
  'aws-curator': {
    name: 'aws-curation',
    description: 'AWS services, Well-Architected pillars, account topology, IAM patterns, networking.',
    type: 'generated',
  },
  'gcp-curator': {
    name: 'gcp-curation',
    description: 'GCP services, project topology, workload identity, Vertex AI.',
    type: 'generated',
  },
  'azure-curator': {
    name: 'azure-curation',
    description: 'Azure services, management groups, RBAC, networking, Azure OpenAI.',
    type: 'generated',
  },
  'opentofu-engineer': {
    name: 'opentofu-engineering',
    description: 'OpenTofu / Terraform modules, state backends, providers, plan/apply lifecycle.',
    type: 'generated',
  },
  'terragrunt-engineer': {
    name: 'terragrunt-engineering',
    description: 'Terragrunt environment composition, dependency graph, DRY module reuse.',
    type: 'generated',
  },
  'landing-zone-curator': {
    name: 'landing-zone-curation',
    description: 'Landing-zone repo: substrate components, conventions, dependency layers.',
    type: 'generated',
  },
  // ── Build · Cluster Platform ────────────────────────────────────────
  'eks-curator': {
    name: 'eks-curation',
    description: 'EKS cluster topology, node strategy, managed addons, Pod Identity / IRSA.',
    type: 'generated',
  },
  'gke-curator': {
    name: 'gke-curation',
    description: 'GKE Standard vs Autopilot, node pools, workload identity, GKE addons.',
    type: 'generated',
  },
  'aks-curator': {
    name: 'aks-curation',
    description: 'AKS node pools, AAD integration, workload identity, addons.',
    type: 'generated',
  },
  'kubernetes-engineer': {
    name: 'kubernetes-engineering',
    description: 'Kubernetes manifests, NetworkPolicy, RBAC, PDBs, HPAs, probes.',
    type: 'generated',
  },
  'helm-engineer': {
    name: 'helm-engineering',
    description: 'Helm charts: values schema, templates, hooks, dependencies, OCI distribution.',
    type: 'generated',
  },
  'kustomize-engineer': {
    name: 'kustomize-engineering',
    description: 'Kustomize overlays, bases, components, generators, patches.',
    type: 'generated',
  },
  'karpenter-curator': {
    name: 'karpenter-curation',
    description: 'Karpenter NodePools, NodeClasses, consolidation, disruption budgets, spot.',
    type: 'generated',
  },
  // ── Build · Cluster Addons ──────────────────────────────────────────
  'argocd-curator': {
    name: 'argocd-curation',
    description: 'ArgoCD Applications, ApplicationSets, AppProjects, sync waves, RBAC.',
    type: 'generated',
  },
  'eks-gitops-curator': {
    name: 'eks-gitops-curation',
    description: 'eks-gitops repo: addon catalog, ApplicationSet patterns, env overlays.',
    type: 'generated',
  },
  'kyverno-engineer': {
    name: 'kyverno-engineering',
    description: 'Kyverno policies: admission, validation, mutation, generation, image verification.',
    type: 'generated',
  },
  'cert-manager-curator': {
    name: 'cert-manager-curation',
    description: 'cert-manager ClusterIssuers, ACME, private CAs, rotation.',
    type: 'generated',
  },
  'secrets-engineer': {
    name: 'secrets-engineering',
    description: 'external-secrets-operator, SecretStores, refresh, scoping, RBAC.',
    type: 'generated',
  },
  'observability-engineer': {
    name: 'observability-engineering',
    description: 'OpenTelemetry, Prometheus / Grafana / Loki / Tempo, SLOs, alerts, dashboards.',
    type: 'generated',
  },
  'keda-engineer': {
    name: 'keda-engineering',
    description: 'KEDA ScaledObjects, ScaledJobs, scalers, TriggerAuthentication.',
    type: 'generated',
  },
  // ── Build · Agent Platform ──────────────────────────────────────────
  'eks-agent-platform-curator': {
    name: 'eks-agent-platform-curation',
    description: 'eks-agent-platform operator: Platform CRDs, IRSA, per-tenant scaffolding.',
    type: 'generated',
  },
  'kagent-curator': {
    name: 'kagent-curation',
    description: 'kagent: agent CRDs, runtime knobs, lifecycle, composition with agentgateway.',
    type: 'generated',
  },
  'agentgateway-curator': {
    name: 'agentgateway-curation',
    description: 'agentgateway: ingress / egress for agent traffic, auth, routing, observability.',
    type: 'generated',
  },
  'kubebuilder-engineer': {
    name: 'kubebuilder-engineering',
    description: 'Kubebuilder + controller-runtime: CRDs, reconcilers, webhooks, finalizers.',
    type: 'generated',
  },
  // ── Verify ──────────────────────────────────────────────────────────
  'fidelity-engineer': {
    name: 'fidelity-engineering',
    description:
      'Visual density + interactive coverage + design-system completeness audit-and-fix pass. Sits between build and merge gate on UI workflows.',
    type: 'generated',
  },
  'pr-reviewer': {
    name: 'pr-review',
    description: 'Diff-level code review: architecture, patterns, frontend, code_quality dimensions.',
    type: 'generated',
  },
  'qa-security': {
    name: 'security-review',
    description: 'Security review: OWASP top 10, CVEs, auth boundaries, secret hygiene, systems.',
    type: 'generated',
  },
  'build-verifier': {
    name: 'build-verification',
    description: 'Four-phase contract + version currency + CI presence verification.',
    type: 'generated',
  },
  'artifact-auditor': {
    name: 'artifact-auditing',
    description: 'Artifact completeness, scope ledger correctness, link integrity, doc-impl alignment.',
    type: 'generated',
  },
  'compliance-curator': {
    name: 'compliance-curation',
    description: 'SOC 2 / GDPR / HIPAA / ISO 27001 framework scoping, audit evidence, policy-as-code.',
    type: 'generated',
  },
  // ── Ship ────────────────────────────────────────────────────────────
  'release-manager': {
    name: 'release-management',
    description: 'Scope-ledger release notes, version bumps, post-gate PR creation, deploy handoff.',
    type: 'generated',
  },
  'deploy-engineer': {
    name: 'deploy-engineering',
    description: 'GitOps sync, Helm rollouts, canary, rollback, deploy verification.',
    type: 'generated',
  },
  'migration-engineer': {
    name: 'migration-engineering',
    description: 'Reversible schema + data migrations safe under concurrent writes.',
    type: 'generated',
  },
  // ── Operate ─────────────────────────────────────────────────────────
  'ops-sre': {
    name: 'site-reliability',
    description: 'SLO definition, burn-rate alerting, capacity planning, on-call rotation.',
    type: 'generated',
  },
  'ops-incident': {
    name: 'incident-response',
    description: 'Incident commander practice: triage, comms, mitigation, postmortems.',
    type: 'generated',
  },
  'ops-finops': {
    name: 'finops',
    description: 'Cloud + LLM cost optimization, forecasting, waste audit.',
    type: 'generated',
  },
  'ops-automation': {
    name: 'ops-automation',
    description: 'ChatOps, scheduled jobs, integration glue, internal automation.',
    type: 'generated',
  },
  // ── Customer ────────────────────────────────────────────────────────
  'cs-success': {
    name: 'customer-success',
    description: 'Onboarding playbooks, adoption tracking, health scoring, QBR practice.',
    type: 'generated',
  },
  'cs-support': {
    name: 'technical-support',
    description: 'Technical triage, bug reproduction, diagnostics gathering, KB articles.',
    type: 'generated',
  },
  'cs-renewals': {
    name: 'renewals',
    description: 'Renewal forecasting, expansion plays, churn prevention, contract negotiation.',
    type: 'generated',
  },
  // ── Business · Sales ────────────────────────────────────────────────
  'sales-lead': {
    name: 'proposal-brief',
    description:
      'Framework for drafting client proposals: needs analysis, solution design, pricing structure, timeline, and success criteria.',
    type: 'brief',
    briefTemplate: 'brief-proposal',
  },
  'sales-solutions': {
    name: 'solutions-engineering',
    description: 'Pre-sales technical scoping, demos, POC scoping, integration planning.',
    type: 'generated',
  },
  'sales-ops': {
    name: 'sales-operations',
    description: 'CRM hygiene, pipeline reporting, sales process automation, comp design.',
    type: 'generated',
  },
  // ── Business · Marketing ────────────────────────────────────────────
  'marketing-lead': {
    name: 'campaign-plan-brief',
    description:
      'Framework for campaign planning: goal refinement, audience analysis, channel strategy, messaging, budget allocation, and KPI definition.',
    type: 'brief',
    briefTemplate: 'brief-campaign-plan',
  },
  'content-engineer': {
    name: 'content-engineering',
    description: 'Blog, case studies, technical content, email sequences, editorial calendar.',
    type: 'generated',
  },
  'seo-engineer': {
    name: 'seo-engineering',
    description: 'Technical SEO audits, keyword strategy, content optimization, rank tracking.',
    type: 'generated',
  },
  'brand-strategist': {
    name: 'brand-strategy',
    description: 'Brand voice, narrative positioning, messaging architecture, brand guidelines.',
    type: 'generated',
  },
  // ── Business · Lead Gen ─────────────────────────────────────────────
  'lead-research-curator': {
    name: 'lead-research',
    description: 'Account research, ICP matching, technographic profiling, intent signals.',
    type: 'generated',
  },
  'lead-outbound': {
    name: 'outbound-prospecting',
    description: 'Cold email + LinkedIn + multi-touch cadences, partnership outreach.',
    type: 'generated',
  },
  'lead-events': {
    name: 'event-leads',
    description: 'Webinars, conferences, dinners, demo days — acquisition and follow-up.',
    type: 'generated',
  },
  // ── System Curators ─────────────────────────────────────────────────
  'github-curator': {
    name: 'github-curation',
    description: 'GitHub repo settings, branch protections, Actions, CODEOWNERS, security features.',
    type: 'generated',
  },
  'jira-curator': {
    name: 'jira-curation',
    description: 'Jira project schemes, workflows, custom fields, JQL patterns.',
    type: 'generated',
  },
  'notion-curator': {
    name: 'notion-curation',
    description: 'Notion workspace structure, databases, permissions, templates.',
    type: 'generated',
  },
  'slack-curator': {
    name: 'slack-curation',
    description: 'Slack channel conventions, workflow apps, notification routing, retention.',
    type: 'generated',
  },
  'linear-curator': {
    name: 'linear-curation',
    description: 'Linear workspace shape, projects, cycles, labels, automations.',
    type: 'generated',
  },
  'figma-curator': {
    name: 'figma-curation',
    description: 'Figma file structure, libraries, tokens, branching, dev mode handoff.',
    type: 'generated',
  },
  'stripe-curator': {
    name: 'stripe-curation',
    description: 'Stripe products + pricing, billing flows, tax, payouts, webhook hygiene.',
    type: 'generated',
  },
  // ── Staff ───────────────────────────────────────────────────────────
  'chief-of-staff': {
    name: 'chief-of-staff',
    description: 'Cross-team coordination, status rollups, blocker resolution, operational rhythm.',
    type: 'generated',
  },
  'legal-curator': {
    name: 'legal-curation',
    description: 'Contracts, ToS, privacy policies, IP protection, vendor reviews.',
    type: 'generated',
  },
  'data-analyst': {
    name: 'data-analysis',
    description: 'Product / business analytics, metrics, dashboards, LLM cost analysis, experiments.',
    type: 'generated',
  },
  // ── Lab ─────────────────────────────────────────────────────────────
  'external-reviewer': {
    name: 'quality-rubric-cold',
    description:
      'Cold-context code audit against the 9-dimension quality rubric. No upstream verdicts — grades the post-merge tree against the intake brief and outputs letter grades as the calibration signal.',
    type: 'generated',
  },
  'prompt-optimizer': {
    name: 'prompt-optimizer',
    description: 'Agent output analysis, prompt failure detection, prompt improvement recommendations.',
    type: 'generated',
  },
  learner: {
    name: 'cross-project-learning',
    description: 'Project pattern extraction, company memory curation, anti-pattern documentation.',
    type: 'generated',
  },
};

// ── Public API ──────────────────────────────────────────────────────

export function getSkillDef(role: string): SkillDef | undefined {
  return SKILL_DEFS[role as TeamRole];
}

export function getAllSkillDefs(): [TeamRole, SkillDef][] {
  return Object.entries(SKILL_DEFS) as [TeamRole, SkillDef][];
}

/**
 * Load skill content for a role, ready for API upload.
 *
 * Resolution order:
 *
 *   1. Skill overlay (`$JAUNTY_SKILLS_DIR` → `~/.jaunty/skills/` →
 *      `<cwd>/.jaunty/skills/` → bundled `jaunty/skills/`). If a skill
 *      `<def.name>.md` lives in any of those layers it wins as the base.
 *   2. Type-specific loader (brief → nanohype template, composed →
 *      nanohype references, generated → built at runtime). Used when no
 *      overlay base is present.
 *
 * Either way, `<def.name>.append.md` files from every layer are concatenated
 * onto the resolved content (low-priority appends first), so additive
 * overlays work regardless of where the base came from.
 *
 * Returns the SKILL.md content and optional reference files.
 */
export async function loadSkillContent(
  role: TeamRole,
  nanohypePath: string,
): Promise<{ content: string; referenceFiles: { name: string; content: string }[] }> {
  const def = SKILL_DEFS[role];

  // Try the overlay first — a `<def.name>.md` anywhere in the chain
  // replaces the default loader entirely.
  const overlaid = await loadSkillWithOverlay(def.name);
  if (overlaid !== null) {
    return { content: overlaid, referenceFiles: [] };
  }

  // Fall through to the type-specific loader, then layer any appends
  // (so a user can ADD voice/style tweaks to a nanohype-backed brief
  // without replacing the brief itself).
  const baseline = await loadByType(def, nanohypePath);
  const content = await appendOverlays(baseline.content, def.name);
  return { content, referenceFiles: baseline.referenceFiles };
}

async function loadByType(
  def: SkillDef,
  nanohypePath: string,
): Promise<{ content: string; referenceFiles: { name: string; content: string }[] }> {
  switch (def.type) {
    case 'brief':
      return loadBriefSkill(def, nanohypePath);
    case 'composed':
      return loadComposedSkill(def, nanohypePath);
    case 'generated':
      // Specialist roles — skill content is a thin wrapper around the
      // SkillDef description. The deep expertise lives in the system
      // prompt + any overlay at `jaunty/skills/<def.name>.md`.
      return {
        content: `---\nname: ${def.name}\ndescription: ${def.description}\n---\n\n${def.description}`,
        referenceFiles: [],
      };
  }
}

/**
 * Preview skill content without reference files (for `skills show`).
 */
export async function previewSkillContent(role: TeamRole, nanohypePath: string): Promise<string> {
  const { content } = await loadSkillContent(role, nanohypePath);
  return content;
}

/**
 * Resolve the nanohype repo path from flags, env, or default.
 */
export function resolveNanohypePath(flagValue?: string): string {
  if (flagValue) return resolve(flagValue);
  if (process.env.NANOHYPE_PATH) return resolve(process.env.NANOHYPE_PATH);
  // Default: sibling directory (nanohype/nanohype alongside nanohype/jaunty)
  // From dist/skills.js → jaunty/ → parent (nanohype monorepo root) → nanohype/
  const thisDir = fileURLToPath(new URL('.', import.meta.url));
  return resolve(thisDir, '..', '..', 'nanohype');
}

// ── Brief skill loading ─────────────────────────────────────────────

interface TemplateVariable {
  name: string;
  placeholder: string;
  description: string;
}

async function loadBriefSkill(
  def: SkillDef,
  nanohypePath: string,
): Promise<{ content: string; referenceFiles: { name: string; content: string }[] }> {
  const templateDir = join(nanohypePath, 'templates', def.briefTemplate!);
  const briefPath = join(templateDir, 'skeleton', 'brief.md');
  const yamlPath = join(templateDir, 'template.yaml');

  const [briefRaw, yamlRaw] = await Promise.all([readFile(briefPath, 'utf-8'), readFile(yamlPath, 'utf-8')]);

  const variables = parseVariables(yamlRaw);
  const content = wrapAsSkillMd(def, stripPlaceholders(briefRaw, variables));

  return { content, referenceFiles: [] };
}

/**
 * Replace __PLACEHOLDER__ tokens with bracketed descriptions.
 * e.g., __PROBLEM_STATEMENT__ → [the core problem this product addresses]
 */
function stripPlaceholders(content: string, variables: TemplateVariable[]): string {
  let result = content;
  for (const v of variables) {
    if (!v.placeholder) continue;
    const replacement = `[${v.description.toLowerCase()}]`;
    result = result.replaceAll(v.placeholder, replacement);
  }
  return result;
}

/**
 * Parse variable definitions from template.yaml without a YAML library.
 * Extracts name, placeholder, and description fields.
 */
function parseVariables(yaml: string): TemplateVariable[] {
  const variables: TemplateVariable[] = [];
  const lines = yaml.split('\n');
  let current: Partial<TemplateVariable> | null = null;

  for (const line of lines) {
    if (line.match(/^\s{2}- name:\s*/)) {
      if (current?.name && current.placeholder && current.description) {
        variables.push(current as TemplateVariable);
      }
      current = { name: line.replace(/^\s{2}- name:\s*/, '').trim() };
    } else if (current && line.match(/^\s{4}placeholder:\s*/)) {
      current.placeholder = line
        .replace(/^\s{4}placeholder:\s*/, '')
        .trim()
        .replace(/^"|"$/g, '');
    } else if (current && line.match(/^\s{4}description:\s*/)) {
      current.description = line
        .replace(/^\s{4}description:\s*/, '')
        .trim()
        .replace(/^"|"$/g, '');
    }
  }

  if (current?.name && current.placeholder && current.description) {
    variables.push(current as TemplateVariable);
  }

  return variables;
}

// ── Composed skill loading ──────────────────────────────────────────

async function loadComposedSkill(
  def: SkillDef,
  nanohypePath: string,
): Promise<{ content: string; referenceFiles: { name: string; content: string }[] }> {
  const referenceFiles: { name: string; content: string }[] = [];

  for (const relPath of def.referencePaths ?? []) {
    const absPath = join(nanohypePath, relPath);
    const fileContent = await readFile(absPath, 'utf-8');
    const fileName = relPath.split('/').pop()!;
    referenceFiles.push({ name: fileName, content: fileContent });
  }

  const content = buildEngineeringSkill(referenceFiles.map((f) => f.name));

  return { content, referenceFiles };
}

function buildEngineeringSkill(referenceFileNames: string[]): string {
  const refs = referenceFileNames.map((f) => `- **${f}**`).join('\n');

  return `---
name: engineering-catalog
description: Template selection decision matrix and production readiness checklist for composing nanohype templates into production systems.
---

# Engineering Decision Guide

You have access to the nanohype template catalog — a library of production-ready templates for building AI systems, applications, infrastructure, and composable modules.

## How to Use This Skill

When asked to build something:
1. Consult the decision matrix in **catalog.md** to identify the right starting template
2. Layer in composable modules based on technical requirements (auth, database, caching, etc.)
3. Select infrastructure for the deployment target
4. If 3+ templates are needed, wrap in monorepo
5. Always add eval-harness alongside AI system templates
6. Verify against the production readiness checklist before shipping

## Key Composition Rules

- AI systems provide intelligence, applications provide the interface
- Modules are never standalone — they plug into applications or AI systems
- Pick one deploy target per project
- monorepo wraps multi-template projects (3+ templates)

## Reference Files

${refs}

Consult these reference files for the full decision matrix, template profiles, module descriptions, and composition patterns.`;
}

// ── SKILL.md wrapper ────────────────────────────────────────────────

function wrapAsSkillMd(def: SkillDef, briefContent: string): string {
  return `---
name: ${def.name}
description: ${def.description}
---

${briefContent}`;
}
