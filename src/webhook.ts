/**
 * Deliver workflow results to a webhook URL.
 */
export async function deliverResult(
  url: string,
  payload: {
    session_id: string;
    status: 'complete' | 'error' | 'budget_exceeded';
    output: string;
    cost?: number;
  },
): Promise<void> {
  // Delivery to an operator-supplied URL is best-effort and the run is already
  // complete — bound it, and never let a slow/black-holing endpoint or a timeout
  // throw past here.
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`Webhook delivery failed (${res.status}): ${await res.text()}`);
    } else {
      console.log(`Webhook delivered to ${url} (${res.status})`);
    }
  } catch (err) {
    console.error(`Webhook delivery error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
