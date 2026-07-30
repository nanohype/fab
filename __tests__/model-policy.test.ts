import { describe, expect, it } from 'vitest';
import { ADVISOR_MODEL } from '../src/advisor.js';
import { resolveModelId } from '../src/inference.js';
import { LLM_MODELS, LLM_POLICY, MODEL_TIERS } from '../src/standards.js';
import { TEAM } from '../src/team.js';

// The roster, held to the model policy it claims to follow.
//
// A model id is a plain string. No compiler, linter or type checker has an
// opinion about it, so a roster pointed at a model the policy does not name —
// or at an id Bedrock refuses — is invisible until a session fails at
// invocation time, in whichever phase happened to run first.
//
// Two representations are in play and both have to hold. The policy declares
// cross-region inference-profile ids (`us.anthropic.claude-sonnet-5`), which is
// the only form the current Claude family accepts. Roles declare the canonical
// short id (`claude-sonnet-5`), which is what the Anthropic API takes and what
// `resolveModelId` maps to the profile form for the bedrock backend. The tests
// below pin each representation and the mapping between them.

describe('roster models', () => {
  const TIERS = new Set(Object.values(MODEL_TIERS));

  it('finds a roster to check', () => {
    // Every assertion below iterates TEAM; an empty roster would satisfy all of
    // them without comparing anything.
    expect(TEAM.length).toBeGreaterThan(50);
  });

  it('declares only models the policy names', () => {
    const offenders = TEAM.filter((m) => !TIERS.has(m.model)).map((m) => `${m.role} -> ${m.model}`);
    expect(
      offenders,
      `these roles invoke a model the LLM policy does not name (${[...TIERS].join(', ')})`,
    ).toEqual([]);
  });

  it('declares no role on a bare Bedrock foundation-model id', () => {
    // The failure this repo shipped one level up, in the policy prose: the
    // current Claude family is INFERENCE_PROFILE-only, so a bare `anthropic.`
    // id is refused with a ValidationException on the first call. A role set to
    // a full `<geo>.anthropic.` profile id is fine — resolveModelId passes it
    // through — but a bare one is not.
    const bare = TEAM.filter((m) => /^anthropic\./.test(m.model)).map((m) => m.role);
    expect(bare).toEqual([]);
  });

  it('escalates the advisor to the policy escalation tier', () => {
    expect(ADVISOR_MODEL).toBe(MODEL_TIERS.escalation);
  });
});

describe('policy tiers resolve on every backend', () => {
  for (const [tier, canonical] of Object.entries(MODEL_TIERS)) {
    it(`maps the ${tier} tier to a cross-region profile id on bedrock`, () => {
      // The half that a roster bump quietly breaks: BEDROCK_MODEL_IDS is a
      // separate table, so bumping the policy without adding the mapping throws
      // "No AWS Bedrock model id is mapped" at session start under
      // FAB_INFERENCE=bedrock — the regulated path.
      const resolved = resolveModelId(canonical, 'bedrock', 'us-west-2');
      expect(resolved).toMatch(/^us\.anthropic\./);
    });

    it(`passes the ${tier} tier through unchanged on the api backend`, () => {
      expect(resolveModelId(canonical, 'api')).toBe(canonical);
      expect(resolveModelId(canonical, 'anthropic-aws')).toBe(canonical);
    });
  }

  it('resolves the default tier to the exact id the policy declares', () => {
    // Ties the two representations together end to end: canonicalising the
    // policy's profile id and mapping it back must return the policy's id. A
    // wrong suffix in either table breaks this and nothing else.
    expect(resolveModelId(MODEL_TIERS.default, 'bedrock', 'us-west-2')).toBe(LLM_MODELS.default);
    expect(resolveModelId(MODEL_TIERS.escalation, 'bedrock', 'us-west-2')).toBe(
      LLM_MODELS.escalation,
    );
    expect(resolveModelId(MODEL_TIERS.light, 'bedrock', 'us-west-2')).toBe(LLM_MODELS.light);
  });
});

describe('LLM_POLICY prose', () => {
  it('names each tier in the invokable profile form', () => {
    for (const id of Object.values(LLM_MODELS)) {
      expect(LLM_POLICY).toContain(id);
    }
  });

  it('prescribes no bare foundation-model id', () => {
    // What the hand-written blob did: it named `anthropic.claude-sonnet-4-6` as
    // the default. Every factory agent received that as instruction, and an app
    // built to it fails on its first Bedrock call.
    //
    // Scoped to the tier list rather than the whole blob, because the
    // `inference-profile-required` requirement below it names the bare form on
    // purpose — "a bare ID such as anthropic.claude-sonnet-5 is refused" is the
    // counter-example, and a check that cannot tell prescription from
    // counter-example would force the standard to stop explaining itself.
    const tierList = LLM_POLICY.slice(
      LLM_POLICY.indexOf('- Models'),
      LLM_POLICY.indexOf('- SDK per language'),
    );
    expect(tierList).not.toBe('');
    const bare = tierList.match(/(?<![a-z-]\.)\banthropic\.claude-[\w.:-]+/g) ?? [];
    expect(bare).toEqual([]);
  });

  it('carries the inference-profile requirement', () => {
    // The requirement the blob was missing entirely, which is why the drift went
    // unnoticed: nothing in fab's own prose said the profile form was mandatory.
    expect(LLM_POLICY).toContain('inference-profile-required');
  });
});
