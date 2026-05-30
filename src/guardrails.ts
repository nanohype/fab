import { randomUUID } from 'node:crypto';

/**
 * Prompt-injection hardening for untrusted input.
 *
 * Two construction-time defenses applied before user-provided text (the
 * intake brief, repo URLs, source-dir paths) is inlined into a role's
 * prompt or the workflow context:
 *
 *   - {@link normalizeDelimiters} strips Claude reserved tags so a brief
 *     can't smuggle a `<system>` / `<tool_use>` span into the prompt.
 *   - {@link spotlight} fences the text in a per-call random delimiter the
 *     untrusted text can't forge, so the model can be told to treat the
 *     fenced span as data, never as instructions.
 *
 * Neither is something an inference-time content filter does — they harden
 * the prompt at assembly time, which is exactly the gap fab owns.
 */
const RESERVED_TAGS = ['thinking', 'system', 'user', 'assistant', 'tool_use', 'tool_result'] as const;

/** Strip Claude reserved tags from untrusted text, replacing each with a visible marker. */
export function normalizeDelimiters(text: string): string {
  let working = text;
  for (const tag of RESERVED_TAGS) {
    working = working.replace(new RegExp(`<\\s*/?\\s*${tag}\\s*[^>]*>`, 'gi'), `[stripped:${tag}]`);
  }
  return working;
}

/** A spotlighted span: the fenced text plus the random delimiter that fences it. */
export interface SpotlightResult {
  readonly wrapped: string;
  readonly delimiter: string;
}

/**
 * Fence untrusted text in a per-call random delimiter (`untrusted-<hex>`).
 *
 * The caller injects an instruction naming the delimiter so the model treats
 * the fenced content as data; the random suffix is unguessable by the fenced
 * text, so it can't close the fence early to break out into instructions.
 */
export function spotlight(text: string): SpotlightResult {
  const delimiter = `untrusted-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  return {
    delimiter,
    wrapped: `<${delimiter}>\n${text}\n</${delimiter}>`,
  };
}
