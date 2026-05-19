import { describe, it, expect } from 'vitest';
import {
  LANGUAGE_TOOLCHAIN,
  FOUR_PHASE_CONTRACT,
  VERSION_CURRENCY_POLICY,
  EVIDENCE_CONTRACT,
  QUALITY_RUBRIC,
  PRODUCTION_BAR,
  MERGE_GATE_CONTRACT,
  FACTORY_PREAMBLE,
  CODE_GATE_ROLES,
  DOCS_GATE_ROLES,
} from '../src/standards.js';
import type { Language } from '../src/types.js';

const SUPPORTED_LANGUAGES: Language[] = ['typescript', 'go', 'python', 'rust', 'java', 'kotlin', 'csharp'];

describe('LANGUAGE_TOOLCHAIN', () => {
  it('has an entry for every supported language', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(LANGUAGE_TOOLCHAIN[lang]).toBeDefined();
    }
  });

  it('each toolchain exposes install + build + lint + test + docs + lockfile + versionLookup + manifest + registry', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const tc = LANGUAGE_TOOLCHAIN[lang];
      expect(tc.install, `${lang}.install`).toBeTruthy();
      expect(tc.build, `${lang}.build`).toBeTruthy();
      expect(tc.lint, `${lang}.lint`).toBeTruthy();
      expect(tc.test, `${lang}.test`).toBeTruthy();
      expect(tc.docs, `${lang}.docs`).toBeTruthy();
      expect(tc.lockfile, `${lang}.lockfile`).toBeTruthy();
      expect(tc.versionLookup, `${lang}.versionLookup`).toBeTruthy();
      expect(tc.manifest, `${lang}.manifest`).toBeTruthy();
      expect(tc.registry, `${lang}.registry`).toBeTruthy();
    }
  });

  it('typescript toolchain uses npm + tsc + eslint-style commands', () => {
    const tc = LANGUAGE_TOOLCHAIN.typescript;
    expect(tc.install).toContain('npm');
    expect(tc.manifest).toBe('package.json');
    expect(tc.lockfile).toBe('package-lock.json');
    expect(tc.typecheck).toMatch(/tsc/);
  });

  it('go toolchain uses go tooling', () => {
    const tc = LANGUAGE_TOOLCHAIN.go;
    expect(tc.build).toContain('go build');
    expect(tc.test).toContain('go test');
    expect(tc.manifest).toBe('go.mod');
    expect(tc.lockfile).toBe('go.sum');
  });

  it('python toolchain uses pip + ruff + pytest + pdoc', () => {
    const tc = LANGUAGE_TOOLCHAIN.python;
    expect(tc.install).toContain('pip install');
    expect(tc.lint).toMatch(/ruff/);
    expect(tc.test).toBe('pytest');
    expect(tc.manifest).toBe('pyproject.toml');
    expect(tc.typecheck).toMatch(/mypy|pyright/);
  });

  it('rust toolchain uses cargo with --locked for reproducibility', () => {
    const tc = LANGUAGE_TOOLCHAIN.rust;
    expect(tc.build).toContain('--locked');
    expect(tc.test).toContain('--locked');
    expect(tc.lint).toMatch(/clippy/);
    expect(tc.manifest).toBe('Cargo.toml');
    expect(tc.lockfile).toBe('Cargo.lock');
  });

  it('java toolchain uses maven compile/test/checkstyle/javadoc', () => {
    const tc = LANGUAGE_TOOLCHAIN.java;
    expect(tc.build).toContain('mvn');
    expect(tc.test).toContain('mvn test');
    expect(tc.lint).toMatch(/checkstyle|spotbugs/);
    expect(tc.docs).toContain('javadoc');
  });
});

describe('FOUR_PHASE_CONTRACT', () => {
  it('names the four phases — build, lint, test, docs', () => {
    expect(FOUR_PHASE_CONTRACT).toMatch(/\bbuild\b/i);
    expect(FOUR_PHASE_CONTRACT).toMatch(/\blint\b/i);
    expect(FOUR_PHASE_CONTRACT).toMatch(/\btest\b/i);
    expect(FOUR_PHASE_CONTRACT).toMatch(/\bdocs\b/i);
  });

  it('requires exit 0 from a clean checkout and references LANGUAGE_TOOLCHAIN', () => {
    expect(FOUR_PHASE_CONTRACT).toMatch(/exit(s|-code)?\s*0/i);
    expect(FOUR_PHASE_CONTRACT).toContain('LANGUAGE_TOOLCHAIN');
  });

  it('requires transcripts on phase output', () => {
    expect(FOUR_PHASE_CONTRACT).toMatch(/transcript/i);
  });
});

describe('VERSION_CURRENCY_POLICY', () => {
  it('names the canonical registries per language', () => {
    expect(VERSION_CURRENCY_POLICY).toMatch(/npm/i);
    expect(VERSION_CURRENCY_POLICY).toMatch(/PyPI/);
    expect(VERSION_CURRENCY_POLICY).toMatch(/crates\.io/);
    expect(VERSION_CURRENCY_POLICY).toMatch(/maven|Maven Central/i);
    expect(VERSION_CURRENCY_POLICY).toMatch(/proxy\.golang\.org|go/i);
  });

  it('establishes "current stable" as the idiom', () => {
    expect(VERSION_CURRENCY_POLICY).toMatch(/current stable|latest stable/i);
  });

  it('names EOL runtimes as auto-REJECT', () => {
    expect(VERSION_CURRENCY_POLICY).toMatch(/EOL|end.?of.?life/i);
  });

  it('defines the @pin escape hatch for legitimate version holds', () => {
    expect(VERSION_CURRENCY_POLICY).toMatch(/@pin/);
  });
});

describe('EVIDENCE_CONTRACT', () => {
  it('requires TRANSCRIPTS and CITATIONS blocks for APPROVE/REQUEST_CHANGES', () => {
    expect(EVIDENCE_CONTRACT).toMatch(/TRANSCRIPTS:/);
    expect(EVIDENCE_CONTRACT).toMatch(/CITATIONS:/);
    expect(EVIDENCE_CONTRACT).toMatch(/APPROVE/);
    expect(EVIDENCE_CONTRACT).toMatch(/REQUEST_CHANGES/);
  });

  it('exempts REJECT verdicts from the evidence requirement', () => {
    expect(EVIDENCE_CONTRACT).toMatch(/REJECT/);
    expect(EVIDENCE_CONTRACT).toMatch(/fail fast|without.*TRANSCRIPTS\/CITATIONS/i);
  });

  it('requires verbatim quoted fragments in citations', () => {
    expect(EVIDENCE_CONTRACT).toMatch(/verbatim/i);
    expect(EVIDENCE_CONTRACT).toMatch(/quoted_fragment|fragment/);
  });
});

describe('QUALITY_RUBRIC', () => {
  it('names all 9 dimensions from /quality-check', () => {
    const dims = [
      'Architecture',
      'Patterns',
      'Systems Thinking',
      'Testing',
      'Frontend',
      'Security',
      'Code Quality',
      'Documentation',
      'Consistency',
    ];
    for (const d of dims) {
      expect(QUALITY_RUBRIC).toMatch(new RegExp(d, 'i'));
    }
  });

  it('assigns dimensions across the four gate roles', () => {
    expect(QUALITY_RUBRIC).toMatch(/pr-reviewer/);
    expect(QUALITY_RUBRIC).toMatch(/qa-security/);
    expect(QUALITY_RUBRIC).toMatch(/build-verifier/);
    expect(QUALITY_RUBRIC).toMatch(/artifact-auditor/);
  });

  it('ships a QUALITY_GRADES: template example', () => {
    expect(QUALITY_RUBRIC).toMatch(/QUALITY_GRADES:/);
  });

  it('uses snake_case keys named in the rubric', () => {
    expect(QUALITY_RUBRIC).toMatch(/code_quality/);
  });
});

describe('PRODUCTION_BAR', () => {
  it('covers all 9 numbered dimensions', () => {
    for (let i = 1; i <= 9; i++) {
      expect(PRODUCTION_BAR).toMatch(new RegExp(`\\b${i}\\.\\s`, 'm'));
    }
  });

  it('includes the ninth dimension on versions', () => {
    expect(PRODUCTION_BAR).toMatch(/9\..*Versions/);
    expect(PRODUCTION_BAR).toMatch(/VERSION_CURRENCY_POLICY/);
  });

  it('references the four-phase contract for CI', () => {
    expect(PRODUCTION_BAR).toMatch(/FOUR_PHASE_CONTRACT/);
  });

  it('keeps the stubs-dont-count-as-done rule', () => {
    expect(PRODUCTION_BAR).toMatch(/Stubs don't count/i);
  });

  it('generalizes test framework guidance across languages', () => {
    expect(PRODUCTION_BAR).toMatch(/vitest/i);
    expect(PRODUCTION_BAR).toMatch(/pytest/);
    expect(PRODUCTION_BAR).toMatch(/go test/);
    expect(PRODUCTION_BAR).toMatch(/cargo test/);
    expect(PRODUCTION_BAR).toMatch(/JUnit|mvn test/);
  });
});

describe('MERGE_GATE_CONTRACT', () => {
  it('describes the pre-gate four-phase and external-reviewer steps', () => {
    expect(MERGE_GATE_CONTRACT).toMatch(/four-phase|four phase/i);
    expect(MERGE_GATE_CONTRACT).toMatch(/external-reviewer/i);
    expect(MERGE_GATE_CONTRACT).toMatch(/calibration/i);
  });

  it('requires TRANSCRIPTS + CITATIONS + QUALITY_GRADES blocks', () => {
    expect(MERGE_GATE_CONTRACT).toMatch(/TRANSCRIPTS:/);
    expect(MERGE_GATE_CONTRACT).toMatch(/CITATIONS:/);
    expect(MERGE_GATE_CONTRACT).toMatch(/QUALITY_GRADES:/);
  });
});

describe('FACTORY_PREAMBLE', () => {
  it('assembles all the sections in order', () => {
    const sections = [
      'IaC',
      'Platform tenant contract',
      'LLM policy',
      'Production bar',
      'Four-phase contract',
      'Latest versions first',
      'Evidence contract',
      'Quality rubric',
      'Commit',
      'Merge gate',
    ];
    let cursor = 0;
    for (const s of sections) {
      const idx = FACTORY_PREAMBLE.indexOf(s, cursor);
      expect(idx, `section missing or out of order: ${s}`).toBeGreaterThan(-1);
      cursor = idx;
    }
  });
});

describe('gate role arrays', () => {
  it('code gate has 4 roles', () => {
    expect(CODE_GATE_ROLES).toHaveLength(4);
    expect(CODE_GATE_ROLES).toContain('pr-reviewer');
    expect(CODE_GATE_ROLES).toContain('qa-security');
    expect(CODE_GATE_ROLES).toContain('build-verifier');
    expect(CODE_GATE_ROLES).toContain('artifact-auditor');
  });

  it('docs gate has 2 roles', () => {
    expect(DOCS_GATE_ROLES).toHaveLength(2);
    expect(DOCS_GATE_ROLES).toContain('artifact-auditor');
    expect(DOCS_GATE_ROLES).toContain('qa-security');
  });

  it('external-reviewer is NOT a gate role (it is post-gate calibration)', () => {
    expect(CODE_GATE_ROLES).not.toContain('external-reviewer');
    expect(DOCS_GATE_ROLES).not.toContain('external-reviewer');
  });
});
