import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(PROJECT_ROOT, 'jaunty.schema.json');

interface SchemaProperty {
  type?: string;
  items?: { type: string };
  description?: string;
  properties?: Record<string, SchemaProperty>;
}

interface IntakeSchema {
  properties: {
    goal: SchemaProperty;
    workflow: SchemaProperty;
    constraints: SchemaProperty & {
      properties?: Record<string, SchemaProperty & { enum?: string[] }>;
    };
    context: SchemaProperty;
    roles: SchemaProperty & { items?: { type: string; enum?: string[] } };
    artifacts: SchemaProperty;
  };
  required: string[];
  examples: Array<Record<string, unknown>>;
}

const schema: IntakeSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

describe('jaunty.schema.json', () => {
  it('keeps goal as the only top-level required field', () => {
    expect(schema.required).toEqual(['goal']);
  });

  it('promotes success_criteria to a first-class context property typed as string[]', () => {
    const sc = schema.properties.context.properties?.success_criteria;
    expect(sc).toBeDefined();
    expect(sc?.type).toBe('array');
    expect(sc?.items?.type).toBe('string');
    expect(sc?.description).toMatch(/measurable|falsifiable/i);
  });

  it('promotes security_requirements to a first-class context property typed as string[]', () => {
    const sr = schema.properties.context.properties?.security_requirements;
    expect(sr).toBeDefined();
    expect(sr?.type).toBe('array');
    expect(sr?.items?.type).toBe('string');
    expect(sr?.description).toMatch(/anti-pattern/i);
  });

  it('promotes out_of_scope to a first-class context property typed as string[]', () => {
    const oos = schema.properties.context.properties?.out_of_scope;
    expect(oos).toBeDefined();
    expect(oos?.type).toBe('array');
    expect(oos?.items?.type).toBe('string');
    expect(oos?.description).toMatch(/scope.*fence/i);
  });

  it('keeps the original context fields (client, product, problem, audience, existing_systems)', () => {
    const props = schema.properties.context.properties;
    expect(props?.client).toBeDefined();
    expect(props?.product).toBeDefined();
    expect(props?.problem).toBeDefined();
    expect(props?.audience).toBeDefined();
    expect(props?.existing_systems).toBeDefined();
  });

  it('ships exactly one canonical example with every recommended field populated', () => {
    expect(schema.examples).toHaveLength(1);
    const ex = schema.examples[0] as {
      goal: string;
      workflow: string;
      constraints: {
        timeline: string;
        deploy_target: string;
        budget: string;
        language: string;
        language_versions: Record<string, string>;
      };
      context: {
        client: string;
        product: string;
        problem: string;
        audience: string;
        existing_systems: string[];
        success_criteria: string[];
        security_requirements: string[];
        out_of_scope: string[];
      };
      artifacts: string[];
      roles: string[];
    };

    expect(ex.goal.length).toBeGreaterThan(50);
    expect(ex.workflow).toBe('feature-build');
    expect(ex.constraints.timeline).toBeTruthy();
    expect(ex.constraints.deploy_target).toBe('aws');
    expect(ex.constraints.budget).toBeTruthy();
    expect(ex.constraints.language).toBe('typescript');
    expect(Object.keys(ex.constraints.language_versions).length).toBeGreaterThanOrEqual(1);
    expect(ex.context.client).toBeTruthy();
    expect(ex.context.product).toBeTruthy();
    expect(ex.context.problem.length).toBeGreaterThan(50);
    expect(ex.context.audience).toBeTruthy();
    expect(ex.context.existing_systems.length).toBeGreaterThanOrEqual(3);
    expect(ex.context.success_criteria.length).toBeGreaterThanOrEqual(3);
    expect(ex.context.security_requirements.length).toBeGreaterThanOrEqual(3);
    expect(ex.context.out_of_scope.length).toBeGreaterThanOrEqual(2);
    expect(ex.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(ex.roles.length).toBeGreaterThanOrEqual(4);
    expect(ex.roles.length).toBeLessThanOrEqual(15);
  });

  it('promotes constraints.language to a first-class enum with the seven supported languages', () => {
    const lang = schema.properties.constraints.properties?.language;
    expect(lang).toBeDefined();
    expect(lang?.type).toBe('string');
    expect(lang?.enum).toEqual(
      expect.arrayContaining(['typescript', 'go', 'python', 'rust', 'java', 'kotlin', 'csharp']),
    );
  });

  it('promotes constraints.language_versions to a first-class object for version pinning', () => {
    const versions = schema.properties.constraints.properties?.language_versions;
    expect(versions).toBeDefined();
    expect(versions?.type).toBe('object');
    expect(versions?.description).toMatch(/latest stable|current stable/i);
  });

  it('includes external-reviewer in the roles enum', () => {
    const rolesEnum = schema.properties.roles.items?.enum;
    expect(rolesEnum).toBeDefined();
    expect(rolesEnum).toContain('external-reviewer');
  });

  it('canonical example is rubric-clean (success_criteria are measurable-shaped)', () => {
    const sc = (schema.examples[0] as { context: { success_criteria: string[] } }).context.success_criteria;
    // Every criterion should be a falsifiable assertion — typically contains a number,
    // a comparison, an explicit "zero" / "every" quantifier, or a named test.
    const looksMeasurable = (s: string) => /\d|every|zero|≥|>|<|all\s+\w+\s+(must|are|include)/i.test(s);
    for (const c of sc) {
      expect(looksMeasurable(c), `criterion not measurable-shaped: "${c}"`).toBe(true);
    }
  });
});
