# The vendored standards

Each `.json` here is a byte-identical copy of the file of the same name in
[nanohype/nanohype](https://github.com/nanohype/nanohype)'s `standards/`
directory, at the commit recorded in `source.json`.

## Why these two

fab has no dependency on any nanohype package, deliberately: the reference
client has to be cloneable and runnable on its own. That means the standards it
needs at runtime have to travel with it.

Only the ones it *reads* travel with it:

- **`language-toolchain.json`** — `standards.ts` loads it to dispatch the
  four-phase contract per language.
- **`llm-policy.json`** — `standards.ts` reads `models` into `LLM_MODELS` and
  `MODEL_TIERS`. Those are not just prose: every role's `model` in `src/team/`,
  the escalation model in `src/advisor.ts`, and the tier list rendered into
  `LLM_POLICY` all resolve against them, and `__tests__/model-policy.test.ts`
  fails if any of the three disagrees.

The rest of the production bar reaches agents as prose in `FACTORY_PREAMBLE` and
`skills/quality-check.md`, which name the standards without loading them.

The rule is vendor what you load, name the rest — and the test enforces it, so
a copy cannot be added here without a call site. A copy nobody reads is a copy
nobody notices going stale, and this package publishes `src/`, so a stale one
would travel to every consumer.

`llm-policy.json` is here because the prose version was not holding. fab
restated the model tiers by hand, and the hand-written copy named a bare
`anthropic.`-prefixed foundation-model id as the default — a form the current
Claude family refuses outright — while the published standard had moved to
inference-profile ids. Nothing compared them, so nothing said so.

## Keeping the copy honest

Two ways it can become a lie, and both are closed:

1. **Tampering.** Someone edits the vendored file and fab dispatches build
   commands the org never published. `source.json` records a SHA-256 and
   `__tests__/standards-pin.test.ts` verifies it on every run.
2. **A stale or hand-moved pin.** `npm run standards:check` reads the file from
   upstream **at the pinned ref** and requires the bytes to match, so the ref and
   its contents cannot diverge.

Whether the pin is also the newest thing upstream has is a different question
with a different answer every day. `npm run standards:freshness` asks it
separately, on a schedule — never in pull-request CI, where a verdict about this
commit must not depend on a push to another repository.

## Re-vendoring

```sh
npm run standards:sync -- <upstream-sha>   # rewrites the copy and the pin together
npm test                                    # confirms the digest and the loader agree
```
