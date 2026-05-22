import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveSandboxMode, environmentConfig } from '../src/sandbox.js';

describe('sandbox mode resolution', () => {
  const ORIGINAL = process.env.FAB_SANDBOX;

  beforeEach(() => {
    delete process.env.FAB_SANDBOX;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.FAB_SANDBOX;
    } else {
      process.env.FAB_SANDBOX = ORIGINAL;
    }
  });

  it('defaults to cloud when FAB_SANDBOX is unset', () => {
    expect(resolveSandboxMode()).toBe('cloud');
  });

  it('honors FAB_SANDBOX=self-hosted', () => {
    process.env.FAB_SANDBOX = 'self-hosted';
    expect(resolveSandboxMode()).toBe('self-hosted');
  });

  it('honors FAB_SANDBOX=cloud explicitly', () => {
    process.env.FAB_SANDBOX = 'cloud';
    expect(resolveSandboxMode()).toBe('cloud');
  });

  it('tolerates surrounding whitespace', () => {
    process.env.FAB_SANDBOX = '  self-hosted  ';
    expect(resolveSandboxMode()).toBe('self-hosted');
  });

  it('errors loudly on unknown FAB_SANDBOX values', () => {
    process.env.FAB_SANDBOX = 'byo-cloud';
    expect(() => resolveSandboxMode()).toThrow(/Unknown FAB_SANDBOX/);
  });
});

describe('environment config', () => {
  it('builds a cloud config with networking and the factory package set', () => {
    const cfg = environmentConfig('cloud');
    expect(cfg.type).toBe('cloud');
    if (cfg.type === 'cloud') {
      expect(cfg.networking).toEqual({ type: 'unrestricted' });
      expect(cfg.packages?.npm).toContain('@nanohype/sdk');
    }
  });

  it('builds a bare self_hosted config', () => {
    expect(environmentConfig('self-hosted')).toEqual({ type: 'self_hosted' });
  });
});
