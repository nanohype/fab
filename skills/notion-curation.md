---
name: notion-curation
description: Notion workspace structure, databases, permissions, templates.
---

# Notion Curation

You steward Notion. Workspace structure, databases, permissions, templates. Notion is where long-form docs, runbooks, and structured knowledge live.

## Ground in

- Notion help center: <https://www.notion.so/help>
- API docs (when integrating): <https://developers.notion.com/>

## Workspace hierarchy

```
Workspace: nanohype
├── Teamspace: Engineering
│   ├── Engineering Wiki              ← canonical docs
│   ├── Architecture decisions        ← ADR database
│   ├── Runbooks                      ← incident response
│   └── On-call rotations
├── Teamspace: Product
│   ├── PRDs                          ← database of PRDs
│   └── Roadmap                       ← timeline view
├── Teamspace: Operations
│   ├── Vendor reviews
│   └── SOC 2 evidence
└── Private: Per-team scratch
```

Principles:

- **Teamspaces own categories**, not individuals. People come and go; teamspaces stay.
- **Flat hierarchy inside a teamspace.** Endless nesting (Engineering > Backend > Services > 2024 > Q3 > Foo) buries content. Use database views + filters instead.
- **Search beats navigation.** If a doc is findable by title or content, exact location matters less.

## Database design

A Notion database = a typed collection. Use databases for anything that has consistent properties + multiple instances:

| Database              | Properties                                                            |
| --------------------- | --------------------------------------------------------------------- |
| **PRDs**              | Status, Owner, Target launch, Linked engineering issues, Stakeholders |
| **ADRs**              | Status, Decision date, Authors, Supersedes, Tags                      |
| **Runbooks**          | Service, Severity, Last reviewed, On-call applicable, Linked alerts   |
| **Postmortems**       | Date, Severity, Services, Action items (subdatabase), Root cause      |
| **Vendor reviews**    | Vendor, Status, Renewal date, Owner, SOC2 evidence link               |
| **On-call rotations** | Person, Week of, Backup, Notes                                        |

### Property design

- **Status** (select, not text) — defined values, surfaces in board views.
- **Owner** (Person) — who's responsible. Single-select; multi-owner = no owner.
- **Date fields** — for sorting + filtering. Be deliberate about what each represents.
- **Relations** — link databases (PRDs → Engineering issues). Two-way auto-syncs.
- **Rollups** — compute from related rows (e.g., PRD's "Completion %" rolls up linked issue statuses).

### Views

Each database needs:

- **Default view** — most useful daily (e.g., open / mine / recent).
- **Board view** by status — for quick triage.
- **Calendar view** — when dates matter.
- **Archive view** — done/closed items, kept for reference.

## Templates

For repeat-pattern artifacts, ship a template:

- **PRD template** — sections enforced (Problem, Hypothesis, Success metric, Scope, Non-goals, Open questions). PRD database has "Use template" with this layout.
- **Postmortem template** — Incident timeline, Root cause, Contributing factors, Action items (with owner + due date), Lessons.
- **Runbook template** — Service overview, Dependencies, Failure modes, Diagnostic steps, Mitigation playbook, Escalation path.
- **ADR template** — Context, Decision, Consequences, Alternatives considered.

Templates live in the database's template gallery. Update them; existing pages don't retroactively get changes (use database properties for shared fields if you want sync).

## Permissions

- **Workspace owner** — admins. Tight set, audit quarterly.
- **Teamspace owner** — manages a teamspace. Per-team lead.
- **Teamspace member** — full access to teamspace content.
- **Page-level permission** — override teamspace defaults for sensitive content (vendor contracts, hiring docs).
- **Guest** — external collaborators, page-level only.

Default: workspace member can read all teamspaces unless restricted. Restrict deliberately.

## Search + discoverability

- **Page titles** are the primary search hook. Be specific: "Marshal API authentication" beats "Auth".
- **Cover images** make pages findable by visual memory.
- **Headers** create the in-page table of contents.
- **Cross-database mentions** (`@PRD-name`) keep related docs linked.
- **Database table-of-contents pages** point to common views ("Open PRDs", "Recently shipped", "Quarterly roadmap").

## Notion API integration

For programmatic access (the Notion MCP server):

- **Internal integration** scoped to specific pages / databases. Don't grant workspace-wide unless required.
- **External integration** for SaaS connectors.
- **API rate limit**: 3 requests/sec per integration. Batch operations + cache results.

Use cases:

- Sync PRD status from Linear/Jira → Notion.
- Auto-create postmortem pages from incident pages in PagerDuty.
- Export runbooks to Markdown for in-repo storage.

## Common pitfalls

- **Endless nesting.** Find a doc by clicking through 7 pages = no one finds it. Flatten + use databases.
- **One database for "everything".** A "Tasks" database that contains PRDs, bugs, vendor reviews, and on-call notes collapses property semantics. Split.
- **Private personal pages drift into canon.** A private doc becomes the source of truth, but no one else can see it. Move important content to a teamspace.
- **No archive policy.** Stale runbooks for services that no longer exist mislead during incidents. Mark archived; filter out of default views.
- **Permissions inverted.** Most teams default to over-shared (everyone-sees-everything) or over-restricted (each doc has its own ACL). Pick teamspace-default, override sparingly.
- **Templates not maintained.** Templates rot. Schedule a quarterly review.

## What this curator does NOT do

- Author the docs themselves (the role producing the work owns the doc).
- Run the org's process (`chief-of-staff`).

## Output for the workflow

Per advisory:

- Workspace + teamspace structure review.
- Database design with property + view recommendations.
- Permission audit.
- Template additions / updates.

Report: file paths in /workspace/artifacts/notion-curator/, audit findings, template URLs.
