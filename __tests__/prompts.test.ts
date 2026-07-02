import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/prompts.js';
import { TEAM } from '../src/team.js';
import type { FabState } from '../src/types.js';

function makeState(overrides?: Partial<FabState>): FabState {
  return {
    agents: [],
    skillIds: {},
    environmentId: null,
    memory: { enabled: true, storeId: null },
    journal: { enabled: true, basePath: '/workspace/.fab/journal' },
    repos: [],
    modelOverrides: {},
    sprint: null,
    vaultIds: [],
    budgetLimit: null,
    projectLanguage: 'typescript',
    sourceDirs: [],
    ...overrides,
  };
}

function mockRepo() {
  return {
    type: 'github_repository' as const,
    url: 'https://github.com/test/repo',
    authorization_token: 'ghp_test',
    mount_path: '/workspace/repo',
  };
}

const product = TEAM.find((m) => m.role === 'product')!;
const nodeEngineer = TEAM.find((m) => m.role === 'node-engineer')!;
const buildVerifier = TEAM.find((m) => m.role === 'build-verifier')!;
const learner = TEAM.find((m) => m.role === 'learner')!;
const salesLead = TEAM.find((m) => m.role === 'sales-lead')!;

describe('buildSystemPrompt', () => {
  it('includes base system prompt', () => {
    const prompt = buildSystemPrompt(product, makeState());
    expect(prompt).toContain('You own what gets built and why');
  });

  it('appends journal section with role-specific path', () => {
    const prompt = buildSystemPrompt(product, makeState());
    expect(prompt).toContain('Personal Journal');
    expect(prompt).toContain('/workspace/.fab/journal/product.md');
  });

  it('appends self-evaluation block', () => {
    const prompt = buildSystemPrompt(product, makeState());
    expect(prompt).toContain('Self-Evaluation');
    expect(prompt).toContain('SELF-EVAL');
  });

  it('appends repo section for engineering with repos configured', () => {
    const state = makeState({
      repos: [mockRepo()],
    });
    const prompt = buildSystemPrompt(nodeEngineer, state);
    expect(prompt).toContain('Repository Access');
    expect(prompt).toContain('https://github.com/test/repo');
  });

  it('omits repo section when no repos', () => {
    const prompt = buildSystemPrompt(nodeEngineer, makeState());
    expect(prompt).not.toContain('Repository Access');
  });

  it('appends template scaffolding for engineering roles', () => {
    const engPrompt = buildSystemPrompt(nodeEngineer, makeState());
    const prodPrompt = buildSystemPrompt(product, makeState());
    expect(engPrompt).toContain('Template Scaffolding');
    expect(prodPrompt).not.toContain('Template Scaffolding');
  });

  it('appends build verification for engineering roles', () => {
    const prompt = buildSystemPrompt(nodeEngineer, makeState());
    expect(prompt).toContain('## Build Verification Protocol');
    expect(prompt).toContain('npm run build');
    expect(prompt).toContain('BUILD VERIFICATION');
  });

  it('omits build verification for non-engineering roles', () => {
    const prodPrompt = buildSystemPrompt(product, makeState());
    const verifierPrompt = buildSystemPrompt(buildVerifier, makeState());
    expect(prodPrompt).not.toContain('## Build Verification Protocol');
    expect(verifierPrompt).not.toContain('## Build Verification Protocol');
  });

  it('appends artifact commit protocol when repos configured', () => {
    const state = makeState({
      repos: [mockRepo()],
    });
    const prompt = buildSystemPrompt(product, state);
    expect(prompt).toContain('Artifact Commit Protocol');
    expect(prompt).toContain('project repo is the source of truth');
  });

  it('omits artifact commit protocol when no repos', () => {
    const prompt = buildSystemPrompt(product, makeState());
    expect(prompt).not.toContain('Artifact Commit Protocol');
  });

  it('includes role-specific self-eval checks for engineering', () => {
    const prompt = buildSystemPrompt(nodeEngineer, makeState());
    expect(prompt).toContain('All code compiles and tests pass');
    expect(prompt).toContain('No unused dependencies');
  });

  it('includes role-specific self-eval checks for gate roles', () => {
    const prompt = buildSystemPrompt(buildVerifier, makeState());
    expect(prompt).toContain('VERIFIED by running actual commands');
    expect(prompt).toContain('real installed API surface');
  });

  it('includes deploy target awareness for engineering with repos', () => {
    const state = makeState({
      repos: [mockRepo()],
    });
    const prompt = buildSystemPrompt(nodeEngineer, state);
    expect(prompt).toContain('Deployment Target');
    expect(prompt).toContain('Never assume a deployment platform');
  });

  it('injects Factory Production Standards for factory roles', () => {
    const prompt = buildSystemPrompt(nodeEngineer, makeState());
    expect(prompt).toContain('# Factory Production Standards');
    expect(prompt).toContain('IaC by deploy_target');
    expect(prompt).toContain('Platform tenant contract');
    expect(prompt).toContain('k8s-native');
    expect(prompt).toContain('LLM policy');
    expect(prompt).toContain('Production bar');
    expect(prompt).toContain('Merge gate');
    expect(prompt).toContain('AWS CDK');
    expect(prompt).toContain('Claude is the primary LLM');
  });

  it('omits Factory Production Standards for firm roles', () => {
    const prompt = buildSystemPrompt(salesLead, makeState());
    expect(prompt).not.toContain('# Factory Production Standards');
  });

  it('omits Factory Production Standards for lab roles', () => {
    const prompt = buildSystemPrompt(learner, makeState());
    expect(prompt).not.toContain('# Factory Production Standards');
  });

  it('appends source directory scope for engineering when sourceDirs is set', () => {
    const prompt = buildSystemPrompt(
      nodeEngineer,
      makeState({ sourceDirs: ['almanac/src/audit'] }),
    );
    expect(prompt).toContain('## Source Directory Scope');
    expect(prompt).toContain('almanac/src/audit');
  });

  it('shows source directory scope to gate roles but not to product, and omits it when unset', () => {
    const scoped = makeState({ sourceDirs: ['x/y'] });
    expect(buildSystemPrompt(buildVerifier, scoped)).toContain('## Source Directory Scope');
    expect(buildSystemPrompt(product, scoped)).not.toContain('## Source Directory Scope');
    expect(buildSystemPrompt(nodeEngineer, makeState())).not.toContain('## Source Directory Scope');
  });
});
