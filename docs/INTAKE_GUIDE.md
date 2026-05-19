# Intake Brief Quality Guide

## What this is for

`fab.schema.json` defines the **shape** of an intake brief — which fields exist, what types they hold, what enums are valid. This document defines the **quality bar** — what each section needs to actually contain to produce a strong factory run.

Anyone authoring a brief — you writing JSON by hand, a Claude session drafting one with you, an external API caller, or the `intake-analyst` agent enriching a thin one — applies this rubric before the brief enters the workflow. Briefs that fail the rubric get either enriched or returned with specific questions; weak briefs do not enter the workflow.

A strong brief is what separates a B− factory run that the user has to argue with from an A run that ships on the first attempt. Most of the rubric came out of post-mortems on real factory output (PR #8, PR #11, the Almanac reviewer's feedback). The cost of a thin brief is real: 25 hours of agent compute, a non-mergeable PR, and the embarrassment of explaining to the reviewer why the bot tried to authenticate as `${userId}@nanocorp.com`.

---

## Anatomy of a strong brief

The schema fields plus three de-facto-required fields (`success_criteria`, `security_requirements`, `out_of_scope`) under `context`.

### `goal` (required)

**An outcome, not a feature list.** One paragraph. Names the user, the change in their behavior or environment, and how you'll know it worked.

- Strong: _"Ship Almanac — an internal Slack bot that answers employee questions grounded in Notion, Confluence, and Google Drive. Every answer cites sources with URLs and last-modified timestamps, and results are filtered to what the asking user has access to in the source system — no data leaks across private spaces. Users invoke the bot as @almanac in Slack channels and DMs."_
- Weak: _"Build a knowledge bot."_
- Anti-pattern: a bullet list of features (that's the PRD's job, not the brief's).

### `workflow` (recommended)

Pick one from the schema enum. If none fits, the brief should explain why in `goal` and propose a custom step sequence. Common picks:

- `feature-build` — most product builds; full factory loop with merge gate.
- `launch-prep` — full launch including marketing/sales/onboarding artifacts.
- `mobile-ship` — adds platform testing + accessibility passes.
- `infra-setup` — IaC-heavy, not application code.
- `security-audit` — read-only assessment workflow.
- `incident` — fix → test → postmortem.
- `automate` — internal tooling.

If the goal is doc-only (runbook, content), use `content-engine` so the docs gate (artifact-auditor + qa-security) runs instead of the full code gate.

### `constraints.timeline` (required)

Actual delivery window with units. _"3 weeks"_, _"Q3 2026"_, _"by 2026-05-15"_. **"Soon" or "ASAP" is rejected** — those words make sizing impossible.

### `constraints.deploy_target` (required for code workflows)

One of `aws | gcp | k8s | fly | vercel | cloudflare`. The factory's branch-creation hook and IaC defaults read this. Code-producing workflows without a `deploy_target` fail the merge gate's IaC dimension.

### `constraints.budget`

`minimal | moderate | generous`. Signals scope and tooling — affects whether the team picks boring (Postgres + ECS) or novel (Workers + Turso). Not a literal dollar figure. If unset, the team assumes `moderate`.

### `constraints.language` (required for code workflows)

One of `typescript | go | python | rust | java | kotlin | csharp`. Drives the factory's LANGUAGE_TOOLCHAIN — build / lint / test / docs commands, manifest file, version-lookup command, registry. The gate dispatches these per language:

| language   | build             | lint                           | test            | docs                  | manifest         |
| ---------- | ----------------- | ------------------------------ | --------------- | --------------------- | ---------------- |
| typescript | `npm run build`   | `npm run lint`                 | `npm test`      | `npm run docs`        | `package.json`   |
| go         | `go build ./...`  | `golangci-lint run`            | `go test ./...` | `go doc ./...`        | `go.mod`         |
| python     | `python -m build` | `ruff check && ruff format -c` | `pytest`        | `pdoc -o docs src`    | `pyproject.toml` |
| rust       | `cargo build`     | `cargo clippy && cargo fmt -c` | `cargo test`    | `cargo doc --no-deps` | `Cargo.toml`     |
| java       | `mvn compile`     | `mvn checkstyle:check`         | `mvn test`      | `mvn javadoc:javadoc` | `pom.xml`        |

If the build spans languages (e.g., Node backend + Go CLI in the same repo), pick the primary and list the others in `language_versions`. Omitting `language` on a code-producing workflow fails the pre-flight checklist — intake-analyst will refuse to pass the brief through.

### `constraints.language_versions` (required for code workflows)

Object mapping runtime / framework keys to their current stable version strings. Example: `{"node": "22", "typescript": "5.9"}` or `{"python": "3.13", "go": "1.24"}`. The idiom is **latest stable first** — don't inherit whatever the training-data default was. Chorus shipped with `eslint 8` (EOL), `vitest 1.x` (three majors behind), and `typescript 5.4` because nobody declared versions, and the factory picked stale defaults. Never again.

Intake-analyst rejects briefs that pin end-of-life versions (e.g., Python 3.7 or 3.8, Node 16 or 18 post-2025-04, Go 1.20 and older). When in doubt, consult the language's official release calendar before the brief is submitted.

### `context.client`, `product`, `problem`, `audience` (required for feature-build)

- **`client`** — who the build is for. Used for branding and tone.
- **`product`** — the build's name. Slugged into the branch name (`feat/<slug>`) and the project subdirectory (`protohype/<slug>/`). Pick something real, not "AcmeAsk."
- **`problem`** — one paragraph. The pain you're solving in the user's words. The team uses this to pick the right architecture and to write the PR description.
- **`audience`** — who uses the thing. Influences UX, security model, scaling assumptions.

### `context.existing_systems` (required for feature-build)

The integrations the new build must respect. SSO platform, source systems, data warehouse, payment processor, observability stack. Without this, the team has to guess and usually picks a stack that doesn't connect to the customer's reality.

Strong: `["Notion", "Confluence", "Google Drive", "Slack", "Okta SSO (SAML + SCIM for workforce identity)"]` — names the IdP and its features.

Weak: `["Slack"]` — too thin; the team will guess at everything else.

### `context.success_criteria` (required for feature-build)

Falsifiable, measurable assertions. Each one must be answerable with yes/no on a future date.

Strong:

- _"<3s median answer latency for @almanac queries"_
- _"≥80% of questions on a typical SOC 2-style questionnaire receive a high-confidence draft"_
- _"Every drafted answer includes ≥1 citation with source title, URL, last-modified date"_
- _"Zero cross-tenant / cross-space data leaks verified by red-team test"_

Weak:

- _"Fast"_ — by what measure?
- _"Reliable"_ — what's the SLO?
- _"Users love it"_ — how do you know?

If a criterion can't be measured, it's not a criterion. The factory's qa roles read this section to design tests; the merge gate's `build-verifier` looks for evidence the criteria are met.

### `context.security_requirements` (required for any user-facing or data-handling build)

**Named anti-patterns to avoid.** The factory's `PRODUCTION_BAR` covers generics (least-privilege IAM, secrets rotation, SAST in CI). This section specializes — name the surfaces this build must defend, drawn from the actual threat model and from past failures.

Strong:

- _"Per-user identity propagation via Okta `users.info` API — fabricated identity strings (e.g., `${userId}@${domain}`) are auto-REJECT"_
- _"Audit log writes are awaited (not fire-and-forget); transient failures retry, hard failures land in DLQ"_
- _"Every external client (Okta, Bedrock invoke + embeddings, OpenSearch, Redis, DynamoDB) has an explicit per-call timeout"_
- _"Correlation IDs generated at the request boundary and threaded through every log line and span"_
- _"Bedrock inference logging set to NONE for the deployment region in CDK (`PutModelInvocationLoggingConfiguration`), not just commented in the inference call"_
- _"Per-user OAuth tokens stored in DynamoDB + KMS envelope encryption — NOT one Secrets Manager secret per user (cost + scaling)"_

Weak:

- _"Secure"_ — every requirement is "secure"; that word is meaningless on its own.
- _"Encrypted"_ — what surface? at rest? in transit? per-user?
- _"Audit trail"_ — what failure mode does it survive?

### `context.out_of_scope` (required on any tight timeline)

A real fence with examples. If your timeline is 3 weeks, name 3-5 things that aren't in the cut. The fence protects the team from scope creep mid-workflow and tells the gates what NOT to flag as missing.

Strong:

- _"Auto-submitting responses back to the vendor (every export requires human approval)"_
- _"Voice and mobile SDK"_
- _"Cross-workspace federation (single Slack workspace only)"_
- _"Per-customer knowledge-base customization (single shared knowledge base in v1)"_

Weak:

- Empty array on a tight timeline (the team will overscope).
- _"We'll figure it out later"_ (not a fence).
- _"Phase 2 features"_ (vague — name them).

### `roles` (recommended)

Restrict which roles participate. **6-12 typical for `feature-build`.** A list of 1 means you're not delegating; a list of 30 means you don't know what you want. Workflow code narrows further at delegation time.

Strong (Almanac, Slack-bot shape):

```json
[
  "product",
  "product-research-curator",
  "node-engineer",
  "rag-engineer",
  "kubernetes-engineer",
  "qa-security",
  "eval-engineer",
  "compliance-curator",
  "content-engineer"
]
```

Strong (Brief, web-app shape — adds frontend + design):

```json
[
  "product",
  "product-research-curator",
  "design-lead",
  "ux-engineer",
  "next-engineer",
  "node-engineer",
  "rag-engineer",
  "kubernetes-engineer",
  "qa-security",
  "eval-engineer",
  "compliance-curator",
  "content-engineer"
]
```

See [`docs/roster.md`](roster.md) for the full role list (83 roles total, organized by factory phase).

Weak: a single engineer role (one role can't ship a feature) or omitting the field entirely on a feature-build (workflow engages all 40+ factory roles, output suffers from mixed signals).

### `artifacts` (recommended)

Specific deliverables to produce, from the schema enum. Common picks for `feature-build`:

```json
["prd", "architecture", "test-plan", "runbook", "onboarding-playbook", "compliance-checklist"]
```

If you don't list any, the workflow's default set runs — usually fine, but for a portfolio piece you want to control the deliverable set explicitly.

---

## Anti-patterns observed in past runs

Concrete things that produced weak factory output. All seen in real PRs.

- **"v1 / MVP / phase 1" language in the goal or scope.** Vague. Use `out_of_scope` instead — name what isn't in.
- **Goal as feature bullet list** rather than outcome paragraph. The team reverse-engineers the outcome and gets it wrong.
- **Success criteria written as "we should be fast"** or "users should love it". Not testable. The qa roles can't design tests against unfalsifiable claims.
- **Security requirements written as "secure" or "encrypted"** without naming the surface to defend. The factory ships a generic encrypted-at-rest answer and misses the actual risk (e.g., per-user token store, audit fire-and-forget).
- **`out_of_scope` left empty on a tight timeline.** Team overscopes, can't ship, gates reject for stub implementations of things that should never have been in scope.
- **Roles list of 1 or all 80+.** One = no delegation. All = no signal. Pick the 6-12 that matter.
- **No `existing_systems`** — team has to guess the stack and usually picks something that doesn't integrate with the real environment.
- **Fabricating client + product names that obviously aren't real** ("Acme Corp", "TestCo"). Acceptable for greenfield demos, but the team's tone shifts when it senses the brief is fake; they ship demo-quality work. Use a name with character even if it's still fictional.
- **Aspirational language in security_requirements that the factory then just transcribes into code comments.** _"Should opt out of Bedrock invocation logging"_ becomes `// FINDING-02: Opt out of Bedrock invocation logging` in the generated code, with no actual opt-out. Name the implementation: _"Bedrock inference logging set to NONE in CDK via PutModelInvocationLoggingConfiguration."_
- **Reference-repo copying without carving out versions.** When the brief says "match the X theme" or "clone the Y stack", engineers will copy the source repo's `package.json` / `go.mod` / `pyproject.toml` verbatim — including versions that were already stale when that repo was built. The merge gate then REJECTs on `VERSION_CURRENCY_POLICY`. Carve it out in the brief explicitly: "copy structure / components / styling from `<path>` — but look up current stable for every dep independently." The `FACTORY_PREAMBLE` enforces this at write-time, but the brief is the load-bearing place to flag the contradiction.

---

## Presentational / marketing site briefs

When the brief targets a presentational surface — landing page, marketing site, product index, public docs entry, anything where visual richness IS the deliverable — the standard sections aren't enough. The default factory output is sparse-but-correct (working components in a sea of dark space) unless the brief explicitly demands density.

Every presentational brief MUST add four sections to `context`:

### `density_target` (object)

Per-section content count. Concrete numbers, not "rich" or "full." Example:

```json
"density_target": {
  "hero": "headline + 2-sentence value prop + 2 CTAs + interactive command preview",
  "why_us": "3 problem/value cards + side-by-side comparison widget",
  "factory_roster": "interactive pipeline diagram + per-phase popouts",
  "runtimes": "tab selector + config-flow diagram per tab",
  "install": "command block + pixel-burst on copy",
  "social_proof": "3 animated stat counters",
  "footer": "nav links + brand element"
}
```

Fidelity-engineer reads this and audits component density against the targets. Sparse sections REJECT.

### `interaction_inventory` (array of strings)

The motion / interaction components the page must wire. Names map to your design system's palette. Every named component MUST be used somewhere on the page. Example:

```json
"interaction_inventory": [
  "Magnetic — on every CTA",
  "ScatterText — Hero headline + Footer brand",
  "ParallaxSection — every long section (Why, Roster, Runtimes, Install, Social)",
  "Particles — global background",
  "StatCounter — Why + Social sections (scroll-triggered)"
]
```

Fidelity-engineer cross-references this against the codebase. Unused entries = REJECT.

### `signature_widgets` (array of objects)

Custom interactive pieces beyond the standard hover/parallax kit. Each gets a name, section, and one-paragraph spec:

```json
"signature_widgets": [
  {
    "name": "FactoryPipeline",
    "section": "factory_roster",
    "spec": "SVG diagram of 6 phases connected by dashed lines. Hovering a phase highlights downstream connections + reveals role-specialist popout. Click to lock-open. Replaces the card grid."
  },
  {
    "name": "RuntimeSelector",
    "section": "runtimes",
    "spec": "Tab selector for Managed Agents / Local SDK / Claude CLI. Each tab swaps a config-flow diagram (auth source → runtime → execution surface)."
  }
]
```

Fidelity-engineer checks `src/components/<Name>.tsx` exists for each entry. Missing = REJECT.

### `visual_reference` (string, optional)

Path to a reference site or repo whose visual feel you want to match. Triggers the reference-repo anti-pattern guard automatically — engineers copy structure / palette / interaction patterns, never version pins. Example:

```json
"visual_reference": "/Users/bs/codes/rackctl/rackctl-beta — match palette, typography, motion vocabulary, pixel-utility aesthetic. Use current-stable versions for every dep regardless of what that repo pins."
```

---

## Annotated examples

### Example 1: Almanac — Slack bot, RAG-heavy

```json
{
  "goal": "Ship Almanac — an internal Slack bot for NanoCorp that answers employee questions grounded in Notion, Confluence, and Google Drive. Every answer cites sources with page/doc URLs and last-modified timestamps, and results are filtered to what the asking user has access to in the source system — no data leaks across private spaces. Users invoke the bot as @almanac in Slack channels and DMs.",
  "workflow": "feature-build",
  "constraints": {
    "timeline": "3 weeks",
    "deploy_target": "aws",
    "budget": "moderate"
  },
  "context": {
    "client": "NanoCorp",
    "product": "Almanac",
    "problem": "Employees waste hours hunting across Notion, Confluence, and Google Drive. Tribal knowledge isn't searchable. Existing Slack search is keyword-only and doesn't cross tools.",
    "audience": "NanoCorp employees (engineering, sales, ops) asking questions in Slack DMs and team channels",
    "existing_systems": [
      "Notion",
      "Confluence",
      "Google Drive",
      "Slack",
      "Okta SSO (SAML + SCIM for workforce identity)"
    ],
    "success_criteria": [
      "<3s median answer latency for @almanac queries",
      "Every answer includes at least one cited source with URL + freshness timestamp",
      "Zero cross-tenant / cross-space data leaks verified by red-team test",
      "Stale-source warning surfaces when Almanac cites a doc >90 days old"
    ],
    "security_requirements": [
      "Per-user identity propagation from Slack → Okta → source-system OAuth",
      "Answers must respect source-system ACLs end-to-end; Almanac falls back to 'I don't have access' on redacted hits — not a TODO",
      "Audit log of every Almanac query + retrieved doc IDs + user ID, retained 1 year, with retry and DLQ on transient failures",
      "No source content stored in model provider logs — prompt caching with PII scrubbing",
      "Rate limiter must use shared state (Redis or DynamoDB) — multi-instance deployment, no in-memory Maps",
      "Per-user OAuth token storage must scale to 10k+ users cost-effectively — shared-secret + DynamoDB token store, not one Secrets Manager secret per user"
    ],
    "out_of_scope": [
      "Writing back to source systems (read-only)",
      "Voice and mobile SDK",
      "Cross-workspace federation (single Slack workspace only)"
    ]
  },
  "artifacts": ["prd", "architecture", "test-plan", "runbook", "onboarding-playbook", "compliance-checklist"],
  "roles": [
    "product",
    "product-research-curator",
    "node-engineer",
    "rag-engineer",
    "kubernetes-engineer",
    "qa-security",
    "eval-engineer",
    "compliance-curator",
    "content-engineer"
  ]
}
```

**Why each section is shaped this way:**

- **`goal`** is one paragraph, names the user (NanoCorp employees), the change in their behavior (ask in Slack instead of hunting), and how you'll know it worked (citations + ACL enforcement). The last line names the invocation surface — answers the question "where do I type to use this?"
- **`workflow: feature-build`** because this is a code-producing build with the standard 4-role merge gate.
- **`deploy_target: aws`** triggers the CDK + Bedrock IaC defaults from `FACTORY_PREAMBLE`. Without it, the factory would have to ask.
- **`existing_systems`** specifies the SSO platform with its features (SAML + SCIM) — this tells `node-engineer` and `qa-security` exactly what identity primitives they have.
- **`success_criteria`** are all measurable. The 3s latency, the citation requirement, the zero-leak red-team test, the 90-day staleness threshold — each one a yes/no question on a future date.
- **`security_requirements`** name the specific surfaces: per-user identity propagation, ACL fallback message, audit log shape (with retry + DLQ), rate-limiter implementation, token storage cost model. Each is a thing the gate will verify.
- **`out_of_scope`** is short but real — three explicit fences, each protecting from a likely scope creep.
- **`roles`** has no design or frontend (Slack is the UI; design isn't the bottleneck) but includes `eval-engineer`, `qa-security`, and `compliance-curator` because this is an ACL-heavy build.
- No `artifacts` includes design-system or campaign because there's no UI surface to design and no marketing to do — internal tool.

### Example 2: Brief — web app, document-generation

```json
{
  "goal": "Ship Brief — a web app that autofills vendor security questionnaires for NanoCorp from a curated knowledge base of past responses, security policies, product documentation, and architecture diagrams. Sales engineers and CISO-office staff upload an incoming questionnaire (PDF, Excel, Word, or Google Form export); Brief drafts answers with inline citations to the source docs, routes the draft to a designated reviewer for per-question approve/edit/reject, and produces an export in the original format. Every approved answer is recorded with reviewer ID, timestamp, source citations, and an immutable audit trail for SOC 2 / ISO 27001 evidence.",
  "workflow": "feature-build",
  "constraints": {
    "timeline": "3 weeks",
    "deploy_target": "aws",
    "budget": "moderate"
  },
  "context": {
    "client": "NanoCorp",
    "product": "Brief",
    "problem": "Sales engineers and security-office staff at NanoCorp burn 25-40 hours per enterprise deal filling out vendor security questionnaires (SOC 2, CAIQ, SIG, SIG-Lite, custom). Every question has been answered before — usually multiple times — but the answers live scattered across past Google Drive uploads, Notion security pages, and the heads of three people. Sales velocity stalls on questionnaires; security review quality is uneven; audit evidence of who approved what is incomplete.",
    "audience": "NanoCorp sales engineers (primary uploaders), CISO-office reviewers (approve/edit answers), GRC manager (audit trail consumer)",
    "existing_systems": [
      "Notion (security policies, control evidence)",
      "Confluence (engineering docs)",
      "Google Drive (past questionnaires, customer-specific addenda)",
      "Salesforce (deal records — questionnaires attach to opportunities)",
      "Okta SSO (SAML + SCIM for workforce identity)",
      "Slack (notifications)",
      "DocuSign (questionnaires sometimes arrive via signing workflow)"
    ],
    "success_criteria": [
      "Median answer-draft latency per question < 8s",
      "≥80% of questions on a typical SOC 2-style questionnaire receive a high-confidence draft (model self-rates HIGH/MEDIUM/LOW; HIGH ≥ 80%)",
      "Every drafted answer includes ≥1 citation with source title, URL, last-modified date, and the specific section/paragraph quoted",
      "Stale-source warning surfaces when cited evidence is >180 days old",
      "Reviewer can approve / edit / reject per question; export marks each answer as 'human-approved' or 'AI-only' (latter only allowed on explicit waiver)",
      "Full immutable audit trail: every draft, every reviewer action, every export, retained 7 years",
      "Round-trip from PDF upload to first draft visible in dashboard < 90s for a 100-question questionnaire"
    ],
    "security_requirements": [
      "Per-user identity propagation via Okta users.info API — fabricated identity strings are auto-REJECT; uploader and reviewer identities verified against the IdP",
      "Bedrock inference logging set to NONE for the deployment region via PutModelInvocationLoggingConfiguration in CDK — not just a per-call comment",
      "All knowledge-base source documents fed to the LLM pass through a PII scrubber first; customer names, contract-confidential terms, and legal-entity identifiers are masked before the LLM sees them, then re-injected only into approved final answers",
      "Reviewer approval is enforced server-side; an unapproved draft cannot be exported even if the UI is bypassed",
      "Audit log writes are awaited (not fire-and-forget) and persist to DynamoDB with retry + DLQ",
      "Every external client call (Okta, Bedrock invoke + embeddings, OpenSearch, Notion, Confluence, Google Drive, S3, DynamoDB, Salesforce) has an explicit per-call timeout",
      "Correlation IDs generated at upload and threaded through every log line, span, and downstream call",
      "Per-user OAuth tokens for source systems stored in DynamoDB + KMS envelope encryption (NOT one Secrets Manager secret per user)",
      "Rate limiter uses shared Redis state (multi-instance ECS); no in-memory Maps",
      "ACL enforcement: a reviewer can only see questionnaires assigned to them or their team; cross-team data leaks are a hard REJECT condition validated by a red-team test"
    ],
    "out_of_scope": [
      "Auto-submitting responses back to the vendor (every export requires human approval — no closed-loop submission in v1)",
      "Negotiating or modifying customer contract redlines",
      "Questionnaires in unusual formats (images, voice memos, custom CRM-embedded forms) — v1 accepts PDF, Excel, Word, Google Form export only",
      "Per-customer knowledge-base customization (single shared knowledge base in v1; per-customer scoping deferred)",
      "Multi-region active-active deployment (single us-west-2 in v1)"
    ]
  },
  "artifacts": ["prd", "architecture", "test-plan", "runbook", "onboarding-playbook", "compliance-checklist"],
  "roles": [
    "product",
    "product-research-curator",
    "design-lead",
    "ux-engineer",
    "next-engineer",
    "node-engineer",
    "rag-engineer",
    "kubernetes-engineer",
    "qa-security",
    "eval-engineer",
    "compliance-curator",
    "content-engineer"
  ]
}
```

**Why this differs from Almanac:**

- **`goal`** describes the surface (web app), the input (PDF/Excel/Word), the human-in-the-loop (reviewer approval), and the deliverable (audit trail for SOC 2). Multi-paragraph because the problem is procedurally complex.
- **`audience`** names three distinct personas — that's a UX signal for `ux-engineer`.
- **`existing_systems`** is longer because the integration surface is wider (CRM, signing workflow, source systems).
- **`success_criteria`** includes a model-self-rated confidence threshold ("HIGH/MEDIUM/LOW; HIGH ≥ 80%") — gives `rag-engineer` + `eval-engineer` an explicit metric to instrument.
- **`security_requirements`** explicitly names the Bedrock-logging-via-CDK fix from the Almanac reviewer, the identity-fabrication anti-pattern, the awaited-audit pattern, and the timeouts-on-every-client requirement. Each one cites a known failure from prior work.
- **`out_of_scope`** is longer because the problem space invites scope creep — auto-submission, contract negotiation, custom CRM forms, multi-region.
- **`roles`** adds `design-lead`, `ux-engineer`, and `next-engineer` (web UI surface) and keeps the same security/compliance trio as Almanac.

---

## Pre-flight checklist

The `intake-analyst` agent applies this checklist before passing any brief into the workflow. You can apply it manually too.

1. **Goal is an outcome, not a feature list.** One paragraph naming user + change + how-you'll-know.
2. **Each `success_criterion` is measurable.** Yes/no on a future date with a number or named test.
3. **`security_requirements` name specific anti-patterns to avoid.** Drawn from this guide's strong examples and from past PR reviews.
4. **`out_of_scope` has at least 2 entries.** Real fences, not "phase 2 features."
5. **`roles` is 4-15.** Right-sized for the workflow type.
6. **`existing_systems` names every integration target.** Including SSO, source systems, observability, CRM, etc.
7. **`timeline` + `deploy_target` are present** for code-producing workflows.
8. **`language` is present** for code-producing workflows. One of the seven supported values (typescript, go, python, rust, java, kotlin, csharp). Drives LANGUAGE_TOOLCHAIN dispatch.
9. **`language_versions` declares current stable** for the runtime plus at least one framework/tool. EOL versions (Python ≤3.9, Node ≤18, Go ≤1.20) are REJECT at intake — latest stable is the idiom, not the exception.

For each NO:

- If recoverable from `goal` + memory + workflow type, the analyst drafts the missing section and surfaces the addition in the enrichment report. Example: missing `success_criteria` can be drafted by extracting measurable assertions from the `goal` text and the workflow's typical SLO patterns.
- If not recoverable (the goal is genuinely a feature list with no outcome; the user has to clarify), the analyst returns the brief to the caller with the specific question. **A weak brief is not passed through silently.**

The analyst's enrichment report explains: which checklist items the original brief failed, what was added, what was challenged, what the user must clarify before the workflow can proceed.

---

## When in doubt

If you're authoring a brief and not sure whether something belongs:

- **In `goal`?** Does it describe an outcome the user will recognize when it ships? Yes → keep. No → move to PRD (artifact, not brief).
- **In `success_criteria`?** Can it be answered yes/no with a number? Yes → keep. No → either rephrase to be measurable or move to `out_of_scope`.
- **In `security_requirements`?** Does it name a specific surface and the anti-pattern to avoid? Yes → keep. No → either specify the surface or trust the production-bar to cover it.
- **In `out_of_scope`?** Will someone on the team try to build this if you don't fence it? Yes → keep. No → drop.

The shortest strong brief is better than the longest weak one. If you hit "I'm not sure how to phrase this section," that uncertainty IS the signal — go back to the user (or the conversation that produced this brief) and ask the specific question.
