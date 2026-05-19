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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`Webhook delivery failed (${res.status}): ${await res.text()}`);
  } else {
    console.log(`Webhook delivered to ${url} (${res.status})`);
  }
}
