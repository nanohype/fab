import { AnthropicAgents } from './api.js';
import { resolveRuntimeKind } from './runtimes/index.js';

// ── Which client a caller gets, and what it costs to get one ────────
//
// Two callers want a client for different reasons, and only one of them is
// going to use it.
//
// A command that talks to the Managed Agents API is a managed-agents operation
// whatever `FAB_RUNTIME` says: exporting a session, listing agents, reading
// usage. Without a key it cannot do the thing it was asked to do, and the
// transport has nothing to do with that — so it is refused for the reason that
// actually applies. Keying the refusal on the transport instead would send an
// operator to change a variable that was never the problem, and would refuse a
// run that a stale variable made look wrong while the credential was there all
// along.
//
// The other caller hands its client to `createRuntime` and does nothing else
// with it — running a workflow, sending a revision, resuming a stream — and
// there the runtime decides whether the client is used at all: the default one
// is the API, and the sdk, pod and subprocess transports reach a model without
// it. The argument is carried rather than called, so a key is required on the
// default transport and nowhere else.
//
// What separates the two is the call site, not the command: a key is required
// exactly where it would be spent. Choosing wrong fails one way round — the
// carried constructor where the client is used defers the failure to an
// authentication error naming an endpoint the operator did not mean to call,
// and the used constructor where it is carried refuses a run that would have
// worked. The second is the one that says what happened.

/**
 * A missing credential, raised rather than exited on.
 *
 * `main` prints the message of whatever reaches it and exits 1, so this reads
 * to an operator the way every other failure does — and a caller that is not a
 * process, a test among them, can see the refusal instead of losing its
 * runner.
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not set');
    this.name = 'MissingApiKeyError';
  }
}

/**
 * A client for a caller that is going to use it.
 *
 * The key is required on every transport, because the request this client is
 * built for is a Managed Agents request on every transport.
 */
export function apiClient(): AnthropicAgents {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new MissingApiKeyError();
  return new AnthropicAgents(key);
}

/**
 * The client the workflow path hands to `createRuntime`.
 *
 * On the default transport the runtime is the API and this is the same client
 * as above, key and all. Away from it the argument is carried and never called,
 * so a run without a key is not a run that is missing anything — and the
 * placeholder names itself, in case a transport ever does reach for it and puts
 * the string on a wire.
 */
export function runtimeClient(): AnthropicAgents {
  if (resolveRuntimeKind() === 'managed-agents') return apiClient();
  return new AnthropicAgents('unused-in-non-managed-runtime');
}
