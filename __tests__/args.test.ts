import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/args.js';

// parseArgs drops argv[0..1] (node + script), so tests prepend two stubs.
const fab = (...args: string[]) => parseArgs(['node', 'fab', ...args]);

describe('parseArgs', () => {
  it('a boolean flag before a positional does not eat it', () => {
    const r = fab('workflow', '--no-gates', 'feature-build', 'build a thing');
    expect(r.command).toBe('workflow');
    expect(r.sub).toBe('feature-build');
    expect(r.positional).toEqual(['build a thing']);
    expect(r.flags['no-gates']).toBe(true);
  });

  it('a value flag consumes the following token', () => {
    const r = fab('session', 'product', '--title', 'Q2 planning');
    expect(r.command).toBe('session');
    expect(r.sub).toBe('product');
    expect(r.flags.title).toBe('Q2 planning');
  });

  it('a trailing boolean flag is true', () => {
    const r = fab('deploy', '--dry-run');
    expect(r.command).toBe('deploy');
    expect(r.flags['dry-run']).toBe(true);
  });

  it('boolean flags interleaved with positionals are all parsed', () => {
    const r = fab('workflow', 'feature-build', '--no-gates', 'build it', '--sequential');
    expect(r.sub).toBe('feature-build');
    expect(r.positional).toEqual(['build it']);
    expect(r.flags['no-gates']).toBe(true);
    expect(r.flags.sequential).toBe(true);
  });
});
