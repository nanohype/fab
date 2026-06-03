import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveInferenceBackend, resolveModelId, inferenceEnv } from '../src/inference.js';

describe('inference backend resolution', () => {
  const ORIGINAL = process.env.FAB_INFERENCE;

  beforeEach(() => {
    delete process.env.FAB_INFERENCE;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.FAB_INFERENCE;
    } else {
      process.env.FAB_INFERENCE = ORIGINAL;
    }
  });

  it('defaults to api when FAB_INFERENCE is unset', () => {
    expect(resolveInferenceBackend()).toBe('api');
  });

  it('honors FAB_INFERENCE=bedrock', () => {
    process.env.FAB_INFERENCE = 'bedrock';
    expect(resolveInferenceBackend()).toBe('bedrock');
  });

  it('honors FAB_INFERENCE=api explicitly', () => {
    process.env.FAB_INFERENCE = 'api';
    expect(resolveInferenceBackend()).toBe('api');
  });

  it('honors FAB_INFERENCE=anthropic-aws', () => {
    process.env.FAB_INFERENCE = 'anthropic-aws';
    expect(resolveInferenceBackend()).toBe('anthropic-aws');
  });

  it('tolerates surrounding whitespace', () => {
    process.env.FAB_INFERENCE = '  bedrock  ';
    expect(resolveInferenceBackend()).toBe('bedrock');
  });

  it('errors loudly on unknown FAB_INFERENCE values', () => {
    process.env.FAB_INFERENCE = 'vertex';
    expect(() => resolveInferenceBackend()).toThrow(/Unknown FAB_INFERENCE/);
  });
});

describe('model id resolution', () => {
  it('passes canonical ids through unchanged for the api backend', () => {
    expect(resolveModelId('claude-sonnet-4-6', 'api')).toBe('claude-sonnet-4-6');
    expect(resolveModelId('claude-opus-4-6', 'api')).toBe('claude-opus-4-6');
  });

  it('maps canonical ids to Bedrock ids for the bedrock backend', () => {
    expect(resolveModelId('claude-sonnet-4-6', 'bedrock')).toBe('anthropic.claude-sonnet-4-6');
    expect(resolveModelId('claude-opus-4-8', 'bedrock')).toBe('anthropic.claude-opus-4-8');
    expect(resolveModelId('claude-opus-4-7', 'bedrock')).toBe('anthropic.claude-opus-4-7');
    expect(resolveModelId('claude-opus-4-6', 'bedrock')).toBe('anthropic.claude-opus-4-6-v1');
    expect(resolveModelId('claude-haiku-4-5', 'bedrock')).toBe('anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('passes an already-Bedrock id through unchanged on the bedrock backend', () => {
    expect(resolveModelId('anthropic.claude-opus-4-7', 'bedrock')).toBe('anthropic.claude-opus-4-7');
  });

  it('passes a cross-region inference-profile id through unchanged', () => {
    expect(resolveModelId('us.anthropic.claude-sonnet-4-6', 'bedrock')).toBe('us.anthropic.claude-sonnet-4-6');
    expect(resolveModelId('eu.anthropic.claude-opus-4-7', 'bedrock')).toBe('eu.anthropic.claude-opus-4-7');
  });

  it('fails fast on a model with no Bedrock mapping', () => {
    expect(() => resolveModelId('claude-sonnet-9-9', 'bedrock')).toThrow(/No AWS Bedrock model id/);
  });

  it('does not touch unmapped models on the api backend', () => {
    expect(resolveModelId('claude-sonnet-9-9', 'api')).toBe('claude-sonnet-9-9');
  });

  it('passes canonical ids through unchanged for the anthropic-aws backend', () => {
    expect(resolveModelId('claude-sonnet-4-6', 'anthropic-aws')).toBe('claude-sonnet-4-6');
    expect(resolveModelId('claude-opus-4-7', 'anthropic-aws')).toBe('claude-opus-4-7');
  });
});

describe('inference env overlay', () => {
  const SAVED = {
    ANTHROPIC_AWS_WORKSPACE_ID: process.env.ANTHROPIC_AWS_WORKSPACE_ID,
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
  };
  beforeEach(() => {
    delete process.env.ANTHROPIC_AWS_WORKSPACE_ID;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  });
  afterEach(() => {
    if (SAVED.ANTHROPIC_AWS_WORKSPACE_ID === undefined) delete process.env.ANTHROPIC_AWS_WORKSPACE_ID;
    else process.env.ANTHROPIC_AWS_WORKSPACE_ID = SAVED.ANTHROPIC_AWS_WORKSPACE_ID;
    if (SAVED.CLAUDE_CODE_USE_BEDROCK === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = SAVED.CLAUDE_CODE_USE_BEDROCK;
    if (SAVED.CLAUDE_CODE_USE_FOUNDRY === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY;
    else process.env.CLAUDE_CODE_USE_FOUNDRY = SAVED.CLAUDE_CODE_USE_FOUNDRY;
  });

  it('returns no overlay for the api backend', () => {
    expect(inferenceEnv('api')).toBeUndefined();
  });

  it('sets CLAUDE_CODE_USE_BEDROCK for the bedrock backend', () => {
    expect(inferenceEnv('bedrock')).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1' });
  });

  it('sets CLAUDE_CODE_USE_ANTHROPIC_AWS + workspace id for the anthropic-aws backend', () => {
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_01ABCDEF';
    expect(inferenceEnv('anthropic-aws')).toEqual({
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
      ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_01ABCDEF',
    });
  });

  it('throws when anthropic-aws is selected without a workspace id', () => {
    expect(() => inferenceEnv('anthropic-aws')).toThrow(/ANTHROPIC_AWS_WORKSPACE_ID/);
  });

  it('throws when anthropic-aws conflicts with a precedence-taking provider flag', () => {
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_01ABCDEF';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    expect(() => inferenceEnv('anthropic-aws')).toThrow(/CLAUDE_CODE_USE_BEDROCK/);
  });
});
