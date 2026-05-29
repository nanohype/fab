/**
 * Inference-backend seam.
 *
 * `FAB_RUNTIME` selects the transport — how the agent loop runs.
 * `FAB_INFERENCE` selects the inference backend — where tokens are served
 * from. The two are orthogonal, but only the `sdk` runtime reads
 * `FAB_INFERENCE`: it hosts the agent loop in fab's own process and can
 * point the underlying Agent SDK at a non-Anthropic backend. The
 * `managed-agents` transport always infers on Anthropic's infrastructure,
 * and `claude-cli` inherits whatever the user's Claude Code install is
 * configured for.
 *
 * `api` (default) serves inference from the Anthropic API. `bedrock`
 * serves it from AWS Bedrock — the agent loop still runs in fab's process,
 * but no inference token leaves the adopter's AWS account. `anthropic-aws`
 * serves it from Claude Platform on AWS — Anthropic's first-party Claude API
 * reached through the adopter's AWS account (IAM/SigV4 auth, AWS Marketplace
 * billing), with the same canonical model ids as the `api` path. It runs on
 * Anthropic infrastructure outside the AWS security boundary, so it is opt-in
 * per intake and never the default for compliance-flagged tenants; Bedrock
 * stays the regulated path.
 */
export type InferenceBackend = 'api' | 'bedrock' | 'anthropic-aws';

const INFERENCE_BACKENDS: ReadonlySet<InferenceBackend> = new Set<InferenceBackend>([
  'api',
  'bedrock',
  'anthropic-aws',
]);

/** Resolve the inference backend from `FAB_INFERENCE` (default `api`). */
export function resolveInferenceBackend(): InferenceBackend {
  const choice = (process.env.FAB_INFERENCE ?? 'api').trim();
  if (INFERENCE_BACKENDS.has(choice as InferenceBackend)) return choice as InferenceBackend;
  throw new Error(`Unknown FAB_INFERENCE value: "${choice}". Expected "api" (default), "bedrock", or "anthropic-aws".`);
}

/**
 * fab's canonical model ids -> AWS Bedrock model ids.
 *
 * Roles declare canonical Anthropic ids (`claude-sonnet-4-6`); the
 * Anthropic API accepts those directly, but Bedrock requires its own
 * `anthropic.`-prefixed ids. Values are the "AWS Bedrock ID" column of the
 * Claude models overview — https://platform.claude.com/docs/en/about-claude/models/overview —
 * pinned snapshots that turn over between model generations.
 */
const BEDROCK_MODEL_IDS: Readonly<Record<string, string>> = {
  'claude-opus-4-7': 'anthropic.claude-opus-4-7',
  'claude-sonnet-4-6': 'anthropic.claude-sonnet-4-6',
  'claude-opus-4-6': 'anthropic.claude-opus-4-6-v1',
  'claude-haiku-4-5': 'anthropic.claude-haiku-4-5-20251001-v1:0',
};

/** A Bedrock model id, optionally carrying a cross-region inference-profile prefix (`us.`, `eu.`, ...). */
function isBedrockModelId(model: string): boolean {
  return /^(?:[a-z]{2}\.)?anthropic\./.test(model);
}

/**
 * Resolve a role's model id for the active inference backend.
 *
 * `api` passes through — the Anthropic API takes fab's canonical ids
 * directly. `bedrock` maps to the Bedrock id; an id that is already a
 * Bedrock id (e.g. a cross-region inference-profile id set straight on a
 * role) passes through untouched. An unmapped model fails fast rather than
 * sending an id Bedrock will reject.
 */
export function resolveModelId(model: string, backend: InferenceBackend): string {
  if (backend !== 'bedrock') return model;
  if (isBedrockModelId(model)) return model;
  const bedrockId = BEDROCK_MODEL_IDS[model];
  if (!bedrockId) {
    throw new Error(
      `No AWS Bedrock model id is mapped for "${model}". ` +
        `Known: ${Object.keys(BEDROCK_MODEL_IDS).join(', ')}. ` +
        `Add the mapping to BEDROCK_MODEL_IDS in src/inference.ts, or set the role's model to a full Bedrock id.`,
    );
  }
  return bedrockId;
}

/**
 * Environment overlay the `sdk` runtime hands the Agent SDK so it targets
 * the chosen backend. `bedrock` sets `CLAUDE_CODE_USE_BEDROCK`; the AWS
 * region and credentials resolve through the standard AWS chain (env vars,
 * shared config, IRSA, instance role). `anthropic-aws` sets
 * `CLAUDE_CODE_USE_ANTHROPIC_AWS` plus the required `ANTHROPIC_AWS_WORKSPACE_ID`
 * (read from the environment; the request base URL derives from `AWS_REGION`,
 * and auth is SigV4 through the same AWS chain). Bedrock and Foundry provider
 * flags take precedence in Claude Code's routing, so selecting `anthropic-aws`
 * while either is set is a misconfiguration we fail fast on rather than
 * silently infer against the wrong backend. `api` needs no overlay.
 */
export function inferenceEnv(backend: InferenceBackend): Record<string, string> | undefined {
  if (backend === 'bedrock') return { CLAUDE_CODE_USE_BEDROCK: '1' };
  if (backend === 'anthropic-aws') {
    const workspaceId = (process.env.ANTHROPIC_AWS_WORKSPACE_ID ?? '').trim();
    if (!workspaceId) {
      throw new Error(
        'FAB_INFERENCE=anthropic-aws requires ANTHROPIC_AWS_WORKSPACE_ID (e.g. "wrkspc_..."), ' +
          'the Claude Platform on AWS workspace id sent on every request.',
      );
    }
    for (const conflicting of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY'] as const) {
      if ((process.env[conflicting] ?? '').trim()) {
        throw new Error(
          `FAB_INFERENCE=anthropic-aws conflicts with ${conflicting}, which takes precedence in ` +
            `Claude Code provider routing. Unset ${conflicting} to infer against Claude Platform on AWS.`,
        );
      }
    }
    return { CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', ANTHROPIC_AWS_WORKSPACE_ID: workspaceId };
  }
  return undefined;
}
