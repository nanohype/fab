---
name: quality-check
description: Grade a codebase across the nine production-bar dimensions with file:line evidence. Read-only audit. Pattern-aware — each dimension carries a lens, canonical reading, pattern-to-solution catalog, domain-specific frames, anti-pattern grep, good-pattern grep, and cross-refs.
version: 1
---

# /quality-check

Run a thorough quality check on this codebase. Assess every dimension below, report findings with `file:line` evidence, and assign a letter grade (A–F) per dimension.

This is a **read-only audit**. Do not edit files. Launch up to 4 parallel agents for data collection, then synthesize into a single scored report.

Always approach the code as a production build being appended to, never as a cookie-cutter starter. The codebase IS the work product — it must reflect real engineering, not boilerplate.

**Grading honesty.** A is exceptional. B is solid. C is adequate. D has significant issues. F is broken. Most production code is B-/C+ — grade inflation helps no one.

Each dimension below has eight evaluator inputs:

1. **Lens** — the named framing to evaluate through
2. **Canonical reading** — books that earn quoting authority
3. **Pattern-to-solution map** — problem shape → patterns that fit + anti-patterns
4. **Domain-specific frames** — how the dimension applies for web app / pipeline / ML / agent system / realtime
5. **What to look for** — concrete behaviors that earn marks
6. **Anti-pattern grep** — strings/shapes a reviewer can grep for to flag failures
7. **Good-pattern grep** — strings/shapes a passing implementation produces
8. **Cross-references** — related dimensions

A consolidated bibliography is at the end.

---

## 1. Architecture & Domain Modeling

**Lens.** Evaluate through Eric Evans's bounded-contexts framing and Vaughn Vernon's aggregate-design rules. The question is: does the code shape match the _business_ shape, or is it shaped around technical layers and framework affordances?

**Canonical reading:**

- Eric Evans, _Domain-Driven Design_ — bounded contexts, ubiquitous language, aggregates
- Vaughn Vernon, _Implementing Domain-Driven Design_ — practical aggregate sizing and invariant enforcement
- Martin Fowler, _Patterns of Enterprise Application Architecture_ — the layering taxonomy and trade-offs
- Robert C. Martin, _Clean Architecture_ — dependency direction, the dependency rule

**Pattern-to-solution map:**

| Problem shape                  | Patterns that fit                                                | Anti-patterns                                                          |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Domain-rich modeling           | Bounded contexts, ubiquitous language, aggregates, value objects | Anemic models, DTO-passing services, framework-coupled domain          |
| CRUD over relational data      | Repository, Unit of Work, Active Record (simple cases)           | Anemic models, "services" with all logic and no domain types           |
| Hexagonal / clean architecture | Ports/adapters, dependency inversion, use cases                  | Framework leaking into domain, ORM entities as domain objects          |
| Multi-bounded-context system   | Anti-corruption layer, context map, published interfaces         | Shared database tables across contexts, direct foreign-key coupling    |
| Plugin / extensibility surface | Provider registry, strategy via interfaces                       | Switch statements scattered across modules, hardcoded provider lookups |

**Domain-specific frames:**

- **Web app** — bounded contexts per business capability (Orders, Inventory, Pricing). Watch for "every feature is a CRUD route" sprawl.
- **Data pipeline** — bounded contexts per stage (Ingestion, Enrichment, Aggregation, Serving). Each stage owns its schema.
- **ML service** — separate the model lifecycle (Train, Eval, Serve) from the inference surface. Don't fuse them.
- **Agent system** — bounded contexts per agent role (Coordinator, Specialist, Reviewer). Each agent owns its prompt + tools + outputs.
- **Realtime UI** — bounded contexts per user-perceptible feature (Presence, Editing, Sync). Don't let networking concerns leak into render code.

**What to look for:**

- Bounded contexts: module boundaries drawn around business capabilities, not technical layers
- Ubiquitous language: type/function/directory names reflect the domain (`OrderFulfillment`, not `DataProcessor`)
- Aggregates and entities: clear ownership of mutable state; invariants enforced at aggregate boundaries
- Separation of concerns: business logic isolated from infrastructure; swappable DB/API clients
- Integration: explicit system boundaries — message passing, ACLs, published interfaces
- Layered vs modular: intentional + consistent
- Idiomatic per language (Go stdlib, Python protocols, TS native ESM)

**Anti-pattern grep:**

- `class .*Service` whose methods are 80% transactional script with no domain types in the signature → anemic model
- `import .* from '.*orm'` inside `domain/` or `core/` → framework leaking into domain
- Files matching `**/utils.{ts,py,go}` over 300 lines → god module
- Circular `import` graph between two `domain/` modules → broken context boundary

**Good-pattern grep:**

- Domain types in function signatures (`function fulfillOrder(order: Order, inventory: Inventory): FulfillmentResult`) — not `(input: any)`
- A `ports/` or `adapters/` directory with interfaces matching the inverted dependencies
- Per-context `package.json` or `go.mod` sub-modules drawn around business capabilities

**Cross-references:** see also Patterns (for how the architecture is realized in code shape), Systems Thinking (for how bounded contexts behave under load).

---

## 2. Design Patterns & Reuse

**Lens.** Evaluate through Hickey's "Simple Made Easy" frame: distinguish _simple_ (one concept, one role) from _easy_ (familiar, near to hand). Patterns earn their keep when they make the design simpler — fewer concepts intertwined — not just when they look professional.

**Canonical reading:**

- Rich Hickey, "Simple Made Easy" (talk) — the simple-vs-easy lens that separates good patterns from cargo-cult ones
- Gamma, Helm, Johnson, Vlissides, _Design Patterns_ — the foundational catalog
- Gregor Hohpe & Bobby Woolf, _Enterprise Integration Patterns_ — when integration is the design

**Pattern-to-solution map:**

| Problem shape                                   | Patterns that fit                                   | Anti-patterns                                                               |
| ----------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| Pluggable provider seam (LLM, DB, auth)         | Provider registry, factory, strategy via interfaces | Switch on string in every call site, factory imports concrete types         |
| Cross-cutting concern (logging, metrics, retry) | Decorator, middleware pipeline, observer            | Logging hardwired into every function, copy-pasted retry blocks             |
| Complex object construction                     | Builder with required-fields-in-types               | Optional-everywhere constructor + runtime asserts                           |
| External API integration                        | Adapter at the boundary, anti-corruption layer      | Adapter that leaks raw response shapes, mapping spread across business code |
| Behavioral variation by type                    | Strategy via interface, polymorphism                | `if (type === ...) else if (type === ...)` scattered across modules         |
| Cross-module event flow                         | Event bus, observer with typed events               | Direct calls between modules with no boundary, callbacks-from-anywhere      |

**Domain-specific frames:**

- **Web app** — middleware (decorator stack), repository per aggregate, strategy for auth providers
- **Data pipeline** — pipes-and-filters, each stage a pure transformer over a stream
- **ML service** — strategy for inference backends; decorator for batching/caching wrapping the model
- **Agent system** — registry for tools, strategy for model providers, observer for cost/usage hooks
- **Realtime UI** — observer for state updates, command pattern for user actions, optimistic-then-reconcile strategy

**What to look for:**

- Registry/Factory for pluggable seams (not switch-on-string)
- Strategy for behavioral variation (not scattered conditionals)
- Decorator/middleware for cross-cutting concerns (not duplicated try/except)
- Builder where construction is non-trivial (multi-step or many optional fields)
- Adapter at every external API boundary
- Consistent pattern application across the codebase (not factory here, manual there)

**Anti-pattern grep:**

- Three or more `if (kind === 'foo')` blocks across different files for the same kind dimension → missing strategy
- `try { ... } catch (e) { logger.error(e); throw e }` repeated 5+ times → missing decorator/middleware
- Premature abstraction: a "framework" with one implementation and no foreseeable second
- Abstract interface with only one concrete class + no mock in tests → fake interface

**Good-pattern grep:**

- A `registry.ts` or `providers/index.ts` exporting a `getProvider(name)` function over self-registering modules
- A `middleware/` or `interceptors/` directory composing cross-cutting concerns
- Tests that swap a provider via the same factory the production code uses (proof the seam works)

**Cross-references:** Architecture (for where the patterns _should_ sit), Code Quality (for whether the pattern application is consistent).

---

## 3. Systems Thinking

**Lens.** Evaluate through Martin Kleppmann's _Designing Data-Intensive Applications_ lens — the system must remain understandable, debuggable, and recoverable under failure, partial failure, and load.

**Canonical reading:**

- Martin Kleppmann, _Designing Data-Intensive Applications_ — failure modes, replication, batching, watermarks, the whole stack
- Michael Nygard, _Release It!_ — stability patterns (bulkheads, circuit breakers, steady state)
- Brendan Gregg, _Systems Performance_ — observability that survives production

**Pattern-to-solution map:**

| Problem shape                      | Patterns that fit                                                         | Anti-patterns                                                           |
| ---------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| High-throughput stream             | Backpressure, batching, watermarks, idempotent consumers                  | Sync calls in hot path, no DLQ, missing dedup, unbounded buffering      |
| Fallible external dependency       | Circuit breaker, timeout, retry with jitter, fallback                     | No timeout, retry-with-no-jitter (thundering herd), retry-on-everything |
| Bursty load with capacity ceilings | Bulkhead, rate limit, shed-and-degrade, queue with bound                  | Unbounded work queue, "auto-scale will save us"                         |
| Distributed state mutation         | Idempotency keys, optimistic concurrency, event sourcing                  | Last-write-wins on shared state, no idempotency on retried writes       |
| Multi-step workflow with failure   | Saga with compensators, process manager, durable workflows                | Chained webhooks with no compensator, ad-hoc retry                      |
| Operational debuggability          | Structured logging with correlation IDs, distributed tracing, RED metrics | Single-line logs, no trace IDs, untyped key-value bags                  |

**Domain-specific frames:**

- **Web app** — circuit breakers on every external call, idempotency on POSTs, RED metrics per endpoint
- **Data pipeline** — watermarks for late data, exactly-once semantics via dedup keys, schema evolution policy
- **ML service** — timeouts on inference (model can hang), cost+latency tail metrics, fallback to cheaper model
- **Agent system** — per-call timeout on every LLM call, eval-loop with failure modes (refusal, format-drift, hallucination), kill-switch on budget breach
- **Realtime UI** — backpressure on user actions, optimistic updates with reconcile-on-divergence, presence heartbeat

**What to look for:**

- Feedback loops: observable system behavior + mechanisms to adjust (circuit breakers, adaptive retry)
- Failure modes: explicit handling of slow/down/garbage dependency responses
- Emergent behavior: thundering herd / retry storm / cache stampede mitigation
- Back-pressure: bounded queues, rate limiting, graceful degradation
- Observability: structured logs, distributed tracing, metric cardinality bounded
- Operational affordances: debuggable, restartable, scalable without heroics

**Anti-pattern grep:**

- `fetch(` or `client.<call>(` without `AbortSignal.timeout` / equivalent timeout → unbounded external call
- `setTimeout(... , Math.random() * ...)` for retry without max-attempt cap → unbounded retry loop
- `catch {}` or `catch (e) {}` with empty body → swallowed error
- `console.error(e); throw e` pattern → log-and-throw (duplicate noise)
- Per-request unique fields in metric tags (`user_id`, `request_id`) → metric cardinality explosion

**Good-pattern grep:**

- `AbortSignal.timeout(<ms>)` on every fetch
- `CircuitBreaker` class import or per-dependency breaker wiring
- `correlation_id` / `trace_id` threaded through every log line
- DLQ + visibility timeout on every queue consumer
- `RED` metrics: `requests_total`, `errors_total`, `request_duration_seconds_histogram`

**Cross-references:** Code Quality (timeouts + error handling), Security (failure-mode security), Performance (load handling).

---

## 4. Testing Strategy (Testing Trophy)

**Lens.** Evaluate through Kent C. Dodds's Testing Trophy: prioritize _integration tests_ over both heavy unit-test pyramids and brittle end-to-end suites. The trophy from base to top: **static analysis** (typecheck, lint) — **unit** (pure functions) — **integration (largest tier)** — **end-to-end (smallest tier)**.

**Canonical reading:**

- Kent C. Dodds, "The Testing Trophy" — the shape: confidence-per-effort, integration-heavy
- Kent Beck, _Test-Driven Development by Example_ — the red-green-refactor loop, what makes tests load-bearing
- Michael Feathers, _Working Effectively with Legacy Code_ — seams, sprout-method, untangling untested code

**Pattern-to-solution map:**

| Problem shape                         | Patterns that fit                                                                            | Anti-patterns                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Pure function                         | Unit test, property-based test (fast-check / hypothesis)                                     | Mock-heavy units, snapshot tests as assertions          |
| Orchestration over 3+ sibling modules | Integration test with real dependencies (testcontainers / aws-sdk-client-mock + nock / moto) | Pure-mock unit tests claiming coverage of orchestration |
| External API integration              | Contract test against a recorded fixture or test double                                      | Live-API tests that go red randomly                     |
| User-perceivable flow                 | E2E (Playwright / Cypress) — keep small                                                      | E2E for every feature                                   |
| Concurrency / timing-sensitive code   | Deterministic-clock fake, scheduler injection                                                | `setTimeout` in tests, `await sleep(100)` rituals       |
| Stateful workflow                     | Integration with real persistence (testcontainers), property tests for invariants            | Mock the database — the bugs hide there                 |

**Domain-specific frames:**

- **Web app** — integration tests at the HTTP boundary (supertest + real DB via testcontainers); e2e for top critical user flows only
- **Data pipeline** — integration tests over real stages with synthetic input fixtures; property tests on idempotency + ordering
- **ML service** — eval suite as the regression test; unit tests on glue code; integration tests on inference path
- **Agent system** — eval harness (input → expected behavior), integration on tool-use flow, prompt regression on golden outputs
- **Realtime UI** — integration tests on state transitions; e2e for two-client sync scenarios

**What to look for:**

- Distribution: roughly 5% static, 25% unit, 60% integration, 10% e2e (vary by domain — strict trophy targets confidence-per-effort)
- Integration tests for any module orchestrating 3+ siblings or making 2+ external calls
- Property tests for code with mathematical invariants
- Coverage threshold enforced in CI (≥75% on production-critical surfaces, 100% branch on security-critical)
- Tests run in CI on every PR, distinct job per phase

**Anti-pattern grep:**

- `jest.mock(...)` or `vi.mock(...)` of external SDK packages (`@aws-sdk/...`, `pg`, etc.) at module level — module-level SDK mocking is rubric-enforced REJECT
- `toMatchSnapshot()` as the only assertion → snapshot-as-assertion (brittle, no semantic meaning)
- `await new Promise(r => setTimeout(r, 100))` in tests → flaky waits
- Tests that read implementation details (private function calls) rather than observed behavior

**Good-pattern grep:**

- `import { mockClient } from 'aws-sdk-client-mock'` (client-level injection)
- `testcontainers` or `pg-mem` for hermetic DB tests
- `fast-check` / `hypothesis` for property tests
- Coverage thresholds in `vitest.config.ts` / `pyproject.toml` set above 70%

**Cross-references:** Security (100% branch on security-critical code), Code Quality (no test = no merge).

---

## 5. Frontend Architecture & Design Systems

**Lens.** Evaluate through the React + design-system tradition: composition over inheritance, token-driven theming, accessibility as a first-class constraint. For non-React stacks, the principles transfer — replace component model + token system with the equivalent.

**Canonical reading:**

- Brad Frost, _Atomic Design_ — component hierarchy from atoms to templates
- Eric Eliott, _Composing Software_ — function/component composition principles
- Sara Soueidan / Heydon Pickering, on accessibility — `aria-*`, focus management, semantic HTML

**Pattern-to-solution map:**

| Problem shape          | Patterns that fit                                                            | Anti-patterns                                                   |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Reusable UI component  | Composition (children, slots), typed props, design-token consumption         | Inheritance, props-soup-of-30, magic-number styling             |
| App-wide state         | Server state (TanStack Query) + scoped client state (Zustand / signals)      | Redux for everything, prop drilling, ref-passing as state       |
| Form handling          | Schema-validated form (Zod + react-hook-form / similar)                      | Hand-rolled state with ad-hoc validation                        |
| Theming                | Design tokens (color, space, type, motion) as CSS vars or token object       | Hardcoded `#fff`, `12px` magic numbers, inline styles           |
| Accessibility          | Semantic HTML + focused tab order + `aria-*` only where semantic falls short | `div onClick={}` as a button, missing focus rings, no skip-link |
| Loading + error states | Suspense / explicit loading state types                                      | Race-conditional `if (data) ...` ladders                        |

**Domain-specific frames:**

- **Web app** — React + design system; SSR via Next.js or remix for content-heavy pages
- **Realtime UI** — optimistic updates, presence indicators, conflict resolution UI
- **Agent system UI** — streaming UI for token-by-token output, tool-call visualization, eval-result tables
- N/A for headless services (data pipelines, backends-only)

**What to look for:**

- Component API: composable (children, slots), typed props, no `any`
- Composition pattern: small components composing larger ones, not God components
- State management: matches problem scale (local for forms, server for cache, global only when justified)
- Accessibility: semantic HTML first, keyboard nav, focus management, color contrast, no traps
- Design tokens: a single source of truth for color/space/type/motion; no magic numbers
- Animation: purposeful (reveals state change, guides attention), respects `prefers-reduced-motion`

**Anti-pattern grep:**

- `<div onClick=` for what should be a `<button>` → accessibility failure
- Inline styles `style={{ color: '#fff' }}` → magic-number theming
- A component with 15+ props → likely missing composition seam
- `useEffect(() => { fetch(...) }, [])` for server state → reinvented data layer
- `console.log` calls in components → debugging residue

**Good-pattern grep:**

- `import { Button } from '~/ui/Button'` consumed from a shared component library
- Design tokens in CSS vars (`--color-primary`) or a `tokens.ts` object
- `useQuery` / `useSWR` for server state, `useState` / `useReducer` for local
- `aria-label`, `aria-describedby`, `role` attributes where semantic HTML doesn't suffice
- `prefers-reduced-motion` media query honored in animation code

**Cross-references:** Code Quality (component complexity), Performance (bundle size, render perf).

---

## 6. Security

**Lens.** Evaluate through Adam Shostack's _Threat Modeling_ lens — STRIDE (Spoofing, Tampering, Repudiation, Info disclosure, DoS, Elevation). Every external boundary is a trust boundary; every trust boundary needs an explicit check.

**Canonical reading:**

- Adam Shostack, _Threat Modeling: Designing for Security_ — STRIDE, trust boundaries, the four questions
- Bruce Schneier, _Applied Cryptography_ / _Cryptography Engineering_ (with Ferguson + Kohno) — what crypto does and doesn't do
- OWASP Top 10 — current iteration as a checklist baseline

**Pattern-to-solution map:**

| Problem shape        | Patterns that fit                                                | Anti-patterns                                                       |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Auth                 | OIDC / SAML / OAuth via vetted libraries, IRSA for AWS workloads | Custom JWT verification, API keys in code, "we'll fix auth later"   |
| Identity propagation | Real upstream IdP (Okta SCIM, WorkOS Directory)                  | Constructing email from user ID, trusting Slack user_id as identity |
| Secrets              | KMS-envelope, secrets manager, IAM-role auth                     | Secrets in env vars, secrets in code, secrets in logs               |
| Input validation     | Zod / Pydantic / JSON Schema at every boundary                   | Trusting client input shape, manual `if (typeof x === ...)` checks  |
| SQL queries          | Parameterized queries, ORM with prepared statements              | String concat / template literals into SQL                          |
| File uploads         | Strict MIME + size cap + virus scan + segregated bucket          | Trust client `Content-Type`, no size limit                          |
| Supply chain         | SBOM, signed builds, dependency scanning that FAILS the build    | Audit-warn-only, never updating deps                                |

**Domain-specific frames:**

- **Web app** — CSRF tokens on state-changing routes, CSP headers, HttpOnly cookies, OWASP Top 10 baseline
- **Data pipeline** — encryption at rest + in transit, PII redaction at the edge, audit log on every access
- **ML service** — prompt injection defense (system prompt protection), output filter (PII / secrets), eval suite includes adversarial inputs
- **Agent system** — tool authorization per role, IAM least-privilege for every external call, kill-switch on budget breach, identity propagation per user
- **Realtime UI** — message origin validation, rate limiting per connection, presence-spoofing defenses

**What to look for:**

- IAM least-privilege: no `*` on resources or actions; per-tenant scoping
- Secrets rotation documented + IAM-role auth in code (no API keys)
- SAST + dependency scanning that FAILS the build on findings (not warn-only)
- Threat model in the architecture artifact: top 5 risks + mitigations
- Real-upstream identity (not fabricated)
- Audit writes that are BLOCKING (awaited, not fire-and-forget)
- Compliance-relevant operations have audit trails

**Anti-pattern grep:**

- `` `SELECT ... ${variable} ...` `` in any DB call → SQL injection surface
- `email: \`${userId}@${domain}\`` or similar identity construction → fabricated identity
- `process.env.<X>_API_KEY` referenced from code that ships to clients (instead of IAM role) → API key in code path
- `.catch(() => {})` after `audit.write(...)` → fire-and-forget audit (compliance failure)
- `npm audit` with `|| true` or `--audit-level=critical` only → soft-fail security gate

**Good-pattern grep:**

- `getValidToken(userId, provider)` from a token-store with KMS envelope
- `oktaClient.users.getByEmail(claim.email)` or equivalent IdP roundtrip
- `await audit.write(...)` (blocking)
- Parameterized queries: `db.query('SELECT ... WHERE id = $1', [id])`
- `npm audit --audit-level=high` in CI with no `|| true`

**Cross-references:** Code Quality (no fabricated identity, blocking audit, explicit timeouts), Documentation (runbook + threat model).

---

## 7. Code Quality & Craft

**Lens.** Evaluate through John Ousterhout's _A Philosophy of Software Design_ — deep modules over shallow ones, information hiding, _and_ through Robert C. Martin's clean-code naming. The two together cover both interface depth and identifier clarity.

**Canonical reading:**

- John Ousterhout, _A Philosophy of Software Design_ — deep modules, complexity, the cost of change
- Robert C. Martin, _Clean Code_ — naming, function size, abstraction levels
- Brian Goetz, _Java Concurrency in Practice_ (and equivalents per language) — concurrency without surprises
- Edsger Dijkstra, "Go To Statement Considered Harmful" — control flow discipline (still applicable)

**Pattern-to-solution map:**

| Problem shape       | Patterns that fit                                        | Anti-patterns                                                           |
| ------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Function size       | Small enough to fit in head, single level of abstraction | 200-line functions, mixed levels of abstraction                         |
| Naming              | Domain-language nouns/verbs, no abbreviations            | `data`, `info`, `handle`, `process`, `manager`, abbreviations           |
| Error handling      | Errors at boundaries, domain types in the middle         | `throw new Error('bad')`, panics in library code, error-as-control-flow |
| Concurrency         | Channels/queues, immutable shared state                  | Shared mutable maps, ad-hoc locks                                       |
| Configuration       | Validated at start (Zod / Pydantic), single source       | Env vars referenced ad-hoc, no validation                               |
| Resource management | RAII / try-with-resources / context managers             | Forgotten close/release, double-free risk                               |
| Dead code           | Delete it                                                | Comment-out, `if (false)`, "we might need this"                         |

**Domain-specific frames:**

- **Web app** — explicit timeouts everywhere, idempotency on POSTs, error boundaries in UI
- **Data pipeline** — idempotent stages, deterministic processing, deduplication keys
- **ML service** — model versioning in code, eval criteria as code, prompt versioning
- **Agent system** — typed tool inputs/outputs, no string-typed routing, prompt as a first-class artifact
- **Realtime UI** — no race conditions in state transitions, deterministic conflict resolution

**What to look for:**

- Naming: domain-rich, no `data`/`info`/`handle`/`process` placeholder names
- Function size: most functions ≤ 30 lines; complex orchestrators broken into named stages
- Complexity: cyclomatic complexity bounded; deep nesting refactored
- Error handling: errors thrown at boundaries with typed error classes, not strings; middle code stays clean
- Explicit timeouts on every external call (HTTP, DB, SDK)
- Dead code removed (no commented-out blocks, no `if (false)`)
- Type safety: TypeScript strict, no `any`; Python type hints; Go vet clean
- No aspirational comments (comments must match what code does)

**Anti-pattern grep:**

- `// TODO:` referenced in shipped code without ticket linkage → silent debt
- `function .*(input: any)` → untyped boundary
- `// Replace with actual X` / `// Hardcoded for demo` → aspirational comment
- `console.log` outside `*.test.*` files → debugging residue
- `try { ... } catch (e: any) { ... }` (Java/TS) → too-broad catch
- `function fooHandler` over 80 lines → uncovered orchestrator

**Good-pattern grep:**

- Typed error classes per domain: `class OrderNotFoundError extends Error`
- Explicit timeout on every external call: `AbortSignal.timeout(<ms>)`, `db.query(..., { timeout: <ms> })`
- Pipeline pattern with named stages over 70-line procedural orchestrators
- Discriminated unions / sum types for state ("unverified" vs "verified" vs "redacted")
- Per-project `CLAUDE.md` (or equivalent) inheriting + scoping parent conventions

**Cross-references:** Architecture (deep modules), Testing (typed boundaries), Security (explicit timeouts).

---

## 8. Documentation & Developer Experience

**Lens.** Evaluate through Daniele Procida's _Diátaxis_ framework — four documentation types (Tutorials, How-to guides, Reference, Explanation), each serving a different reader need. Conflating them produces docs that serve no one.

**Canonical reading:**

- Daniele Procida, _Diátaxis_ — the four-quadrant doc framework (diataxis.fr)
- Andrew Hunt & David Thomas, _The Pragmatic Programmer_ — the "DRY for docs" principle and rubber-ducking
- Yevgeniy Brikman, _Hello, Startup_ — runbooks and how to write them

**Pattern-to-solution map:**

| Problem shape         | Patterns that fit                                               | Anti-patterns                                               |
| --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Onboarding            | Tutorial: "make it work in 5 minutes"                           | Reference dumped at the new reader, "read everything first" |
| Specific task         | How-to guide: "to do X, run Y"                                  | Tutorial-style "context first" when reader wants steps      |
| API surface           | Reference: comprehensive, structured, no narrative              | Narrative explanations in API docs                          |
| Why it works this way | Explanation: bounded contexts of _understanding_, not procedure | Reference docs that try to also be explanation              |
| Production runbook    | Failure modes, dashboards, runbook steps, on-call playbook      | "We'll figure it out when it breaks"                        |
| API docs              | Regenerated from source, kept in sync with the docs phase       | Hand-maintained docs that drift                             |

**Domain-specific frames:**

- **Web app** — README + how-to per feature + API reference (regenerated) + runbook
- **Data pipeline** — schema doc + how-to per stage + runbook with reprocessing playbook
- **ML service** — model card + eval results + how-to-retrain + runbook
- **Agent system** — role manifest + skill registry + tool docs + cost runbook
- **Realtime UI** — sync semantics + presence docs + reconnection playbook

**What to look for:**

- README with local-dev + deploy instructions (the tutorial layer)
- Runbook with dashboard links, common failure modes + remediation
- `.env.example` listing every env var the code reads
- Per-project `CLAUDE.md` declaring inherited conventions
- PR descriptions explain WHY (not what — diff shows what)
- API docs regenerated by the `docs` phase, kept in sync with source
- Diagrams as code (Mermaid / PlantUML / Excalidraw source) so they don't rot

**Anti-pattern grep:**

- `README.md` with only one section ("Installation") → missing how-to + runbook
- `.env.example` missing → no onboarding
- API docs hand-written → will drift
- Comments referencing function callers ("called by X") → rot-bait (callers change without comment updates)
- Comments explaining WHAT the code does ("increment counter") → noise

**Good-pattern grep:**

- A `docs/` directory with at least `runbook.md`, `architecture.md`, and `threat-model.md`
- README has Installation + Usage + Configuration + Contributing + License
- API docs in `docs/api/` regenerated by the build (TypeDoc / godoc / pdoc / rustdoc output)
- PR descriptions follow a template with "Why" / "What changed" / "How tested"

**Cross-references:** Code Quality (docs phase is one of the four phases), Consistency (docs match the code state).

---

## 9. Consistency & Polish

**Lens.** Evaluate through the broken-windows theory — one inconsistency tolerates two, two tolerate four. The codebase reads as a coherent product, not a patchwork.

**Canonical reading:**

- George Kelling & James Wilson, "Broken Windows" (theory applies broadly) — small inconsistencies invite more
- Andrew Hunt & David Thomas, _The Pragmatic Programmer_ — the camp-site rule + DRY
- Donald Knuth, _Literate Programming_ — code as communication

**Pattern-to-solution map:**

| Problem shape      | Patterns that fit                                                                | Anti-patterns                                                    |
| ------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Naming consistency | One naming convention per language, enforced by linter                           | `camelCase`, `snake_case`, `kebab-case` mixed in the same module |
| File layout        | Predictable per project type, parent-inherited conventions                       | Each subdirectory invents its own layout                         |
| Imports            | Sorted (eslint-plugin-import or equivalent), grouped (std / third-party / local) | Random order, mixed default + named imports for the same module  |
| Errors             | One error-handling pattern across the codebase                                   | `throw` here, return-tuple there, panic over there               |
| Tests              | One test layout (`__tests__/` vs `*.test.ts` vs `_test.go`) per project          | Mixed layouts across modules                                     |
| Comments           | "WHY" comments only; auto-generated docstrings deleted                           | Aspirational comments, restating the code, dead `// TODO:`       |

**Domain-specific frames:**

- **Web app** — UI component file naming consistent, route file naming consistent, design tokens single-source
- **Data pipeline** — stage naming, schema versioning, error handling consistent across stages
- **ML service** — model artifact naming, eval result naming, version pinning consistent
- **Agent system** — role naming, prompt structure, tool naming consistent
- **Realtime UI** — event naming, state-transition naming, error-payload shape consistent

**What to look for:**

- Conventions inherited from parent CLAUDE.md (not silently overridden)
- One linter + formatter config, no per-subdirectory overrides
- One test framework, one assertion style
- One import ordering
- File layout matches project-type conventions
- No aspirational comments (every comment matches reality)
- No dead code or commented-out blocks
- All public APIs have docs regenerated

**Anti-pattern grep:**

- Multiple `.prettierrc` / `.eslintrc` / `pyproject.toml` files at varying levels with conflicting rules → split-brain formatting
- `// FINDING-02: <claim>` adjacent to code that doesn't deliver the claim → aspirational comment
- Both `it(...)` and `test(...)` for tests in the same file → mixed style
- `// Replace with actual X` / `// Mock for now` → known-broken claim

**Good-pattern grep:**

- One `.prettierrc` / `.eslintrc` / `tsconfig.json` at the repo root
- One test layout per project (all `*.test.ts` colocated, or all in `__tests__/`)
- A "lint-staged" or pre-commit hook enforcing the conventions on every commit
- Per-project `CLAUDE.md` that links back to (or inherits from) the parent's conventions

**Cross-references:** Documentation (consistency of doc structure), Code Quality (consistency of code shape), Architecture (consistency of layering).

---

## Output format

When you run this skill, end the report with this exact block (parsed by the merge gate):

```
QUALITY_GRADES:
  architecture: <A|A-|B+|B|B-|C+|C|C-|D|F|N/A>
  patterns: <grade>
  systems: <grade>
  testing: <grade>
  frontend: <grade>
  security: <grade>
  code_quality: <grade>
  documentation: <grade>
  consistency: <grade>
```

For each dimension that earns < B, include a one-paragraph rationale + file:line citations. For dimensions that earn ≥ A-, briefly note what makes the implementation exemplary (so the team learns from successes, not just failures).

---

## Bibliography (consolidated)

Per-dimension canonical reading. When grading, cite specific books to ground claims — readers can verify the lens.

**Architecture & Domain Modeling:**

- Evans, _Domain-Driven Design_ (2003) — the bounded-context vocabulary
- Vernon, _Implementing Domain-Driven Design_ (2013) — practical DDD application
- Fowler, _Patterns of Enterprise Application Architecture_ (2002) — the layering taxonomy
- Martin, _Clean Architecture_ (2017) — the dependency rule

**Design Patterns & Reuse:**

- Hickey, "Simple Made Easy" (2011 InfoQ talk) — simple vs. easy
- GoF, _Design Patterns_ (1994) — the foundational catalog
- Hohpe & Woolf, _Enterprise Integration Patterns_ (2003) — when integration _is_ the design

**Systems Thinking:**

- Kleppmann, _Designing Data-Intensive Applications_ (2017) — the modern systems bible
- Nygard, _Release It!_ (2007 / 2018 2nd ed.) — stability patterns
- Gregg, _Systems Performance_ (2013 / 2020 2nd ed.) — observability

**Testing Strategy:**

- Dodds, "The Testing Trophy" (blog/talk) — the shape
- Beck, _Test-Driven Development by Example_ (2002) — the loop
- Feathers, _Working Effectively with Legacy Code_ (2004) — seams

**Frontend Architecture & Design Systems:**

- Frost, _Atomic Design_ (2016) — component hierarchy
- Eliott, _Composing Software_ (2018) — function/component composition
- WCAG 2.1 (W3C) — accessibility baseline; supplement with Soueidan + Pickering writing

**Security:**

- Shostack, _Threat Modeling: Designing for Security_ (2014) — STRIDE
- Schneier et al., _Cryptography Engineering_ (2010) — what crypto does and doesn't do
- OWASP Top 10 — current iteration

**Code Quality & Craft:**

- Ousterhout, _A Philosophy of Software Design_ (2018) — deep modules, complexity, information hiding
- Martin, _Clean Code_ (2008) — naming, function size
- Goetz, _Java Concurrency in Practice_ (2006) — concurrency without surprises (the principles transfer)

**Documentation & DX:**

- Procida, _Diátaxis_ (diataxis.fr) — four-quadrant docs
- Hunt & Thomas, _The Pragmatic Programmer_ (1999 / 2019 2nd ed.) — DRY, rubber-ducking
- Various, "How to Write a Runbook" (industry talks) — on-call ergonomics

**Consistency & Polish:**

- Kelling & Wilson, "Broken Windows" (1982 Atlantic article) — theory applied to codebases
- Hunt & Thomas — camp-site rule
- Knuth, _Literate Programming_ (1992) — code as communication

The user's private overlay at `~/.jaunty/skills/quality-check.md` may deepen any dimension further — additional architects, additional anti-pattern catalogs, additional taste. This baseline is the floor.
