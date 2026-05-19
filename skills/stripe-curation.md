---
name: stripe-curation
description: Stripe products + pricing, billing flows, tax, payouts, webhook hygiene.
---

# Stripe Curation

You steward Stripe. Products + pricing model, billing flows, tax, payouts, webhook hygiene. Stripe is load-bearing for any SaaS — get it wrong and revenue goes off the rails.

## Ground in

- Stripe docs: <https://docs.stripe.com/>
- Billing guide: <https://docs.stripe.com/billing>
- Webhooks: <https://docs.stripe.com/webhooks>
- API reference: <https://docs.stripe.com/api>

## Products + pricing model

Stripe's billing data model:

```
Customer (1:1 with your user/account record)
├── PaymentMethod (card, ACH, etc.)
├── Subscription
│   ├── SubscriptionItem (one per Price)
│   │   └── Price
│   │       └── Product
│   └── Invoice (one per billing period)
│       └── InvoiceItem
└── Charge / PaymentIntent (for one-time)
```

Patterns:

- **Per-seat** — one SubscriptionItem with `quantity` = seat count.
- **Tiered** — Price with `tiers: [{up_to: 10, unit_amount: 1000}, {up_to: 100, unit_amount: 800}, ...]`.
- **Metered (usage-based)** — Price with `recurring.usage_type: metered`; report usage via Usage Records.
- **Hybrid** — Subscription with multiple SubscriptionItems (base seat fee + metered overages).

### Defaults to set

- **Currency** — pick at Product create. Multi-currency products use multiple Prices.
- **Tax behavior** — `exclusive` (tax added on top) or `inclusive` (tax part of the price). Set at Price create.
- **Billing cycle** — month vs year. Annual prices get a different `Price` object, not a flag.

## Subscriptions

### Trials

```
trial_period_days: 14
```

Or `trial_end: <unix-timestamp>` for explicit end.

Default trial behavior: no payment method required, no charge on trial start. Set `payment_settings.payment_method_collection: if_required` for trials that need a card upfront.

### Proration

Default: prorated charges/credits when items change mid-cycle.

```
proration_behavior: create_prorations  # default
proration_behavior: none               # no proration
proration_behavior: always_invoice     # immediate invoice for the prorated amount
```

Pick deliberately. Upgrades typically `always_invoice` (charge immediately); downgrades `create_prorations` (credit on next invoice).

### Cancellation

```
cancel_at_period_end: true   # subscription remains active until current period ends
cancel_at: <unix-timestamp>  # specific cancellation date
```

Hard cancel via DELETE on the subscription. Soft cancel (`cancel_at_period_end`) preserves access through the paid period.

## Dunning + retries

Stripe Billing handles failed payments via Smart Retries. Configure in Dashboard:

- **Retry schedule** — Stripe ML-optimized (default) or fixed schedule.
- **Email reminders** — failed payment email, upcoming renewal email.
- **Final action on failure** — cancel subscription, mark unpaid, do nothing (manual handling).

For high-value subscriptions, build your own dunning flow: webhook on `invoice.payment_failed` → custom email / Slack notification / customer-success handoff.

## Tax

Stripe Tax handles sales tax / VAT / GST:

- **Enable Stripe Tax** on the account.
- **Register** in jurisdictions where you have nexus. Stripe Tax registration helpers walk through this.
- **Set tax codes** on Products (e.g., `txcd_10000000` for SaaS).
- **Set tax behavior** on Prices (exclusive / inclusive).
- **Customer tax exemption** — for B2B tax-exempt customers, set `tax_exempt: exempt` + collect their VAT ID.

For complex tax needs (regulated industries, exotic jurisdictions), Anrok / Avalara plug in.

## Webhooks

Critical events:

| Event                           | Action                                          |
| ------------------------------- | ----------------------------------------------- |
| `checkout.session.completed`    | Provision access; create user account if new    |
| `customer.subscription.created` | Sync subscription state to your DB              |
| `customer.subscription.updated` | Sync state changes (upgrade, downgrade, cancel) |
| `customer.subscription.deleted` | Revoke access                                   |
| `invoice.payment_succeeded`     | Mark invoice paid; extend access                |
| `invoice.payment_failed`        | Notify customer-success; start dunning          |
| `payment_intent.succeeded`      | For one-time charges                            |
| `customer.created`              | Sync customer to your DB                        |
| `charge.dispute.created`        | Disputes; respond within window                 |

### Webhook hygiene

- **Signature verification** — always. Use Stripe's library to verify `Stripe-Signature` header. Without it, anyone can fake events to your endpoint.
- **Idempotency** — Stripe retries on non-200 responses. Your handler must be idempotent: re-processing the same event ID is a no-op.
- **Async processing** — return 200 fast (≤ 5s). Push the work to a queue.
- **Dead-letter queue** — events that fail processing N times go to a DLQ for manual review.

```typescript
import Stripe from 'stripe';

export async function handleWebhook(req: Request): Promise<Response> {
  const sig = req.headers.get('stripe-signature')!;
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    return new Response('Invalid signature', { status: 400 });
  }
  await queue.publish('stripe-events', event); // async handler picks it up
  return new Response('OK', { status: 200 });
}
```

## Payouts

- **Schedule** — daily, weekly, monthly. Default is daily (rolling).
- **Bank account** — verify via micro-deposits or Plaid.
- **Statement descriptor** — what shows on the customer's card statement. Set per-Product if needed.

For Connect-style platforms (you take a fee, pay out to sub-merchants), use Stripe Connect — different data model, OAuth-based onboarding.

## Reconciliation

- **Stripe Reports** — pre-built CSV exports for accounting.
- **Stripe Sigma** — SQL-queryable Stripe data warehouse (paid add-on).
- **Webhooks + your DB** — your DB is the source of truth for "what's been provisioned"; Stripe is the source of truth for "what's been paid."

Daily reconciliation job: compare Stripe's `invoice.payment_succeeded` events to your DB's `paid` flag for invoices. Discrepancies = stop-the-line investigation.

## PII + PCI scope

- **Never log card numbers**, even masked. Stripe.js / SDK handle card data in their iframe; raw PAN never touches your servers.
- **PCI SAQ-A** is achievable if you use Stripe Elements / Checkout — Stripe handles all card data, your scope is minimal.
- **Webhook payloads** contain customer email + name + address. Treat as PII per your privacy policy.
- **API keys**: restrict to specific scopes via Stripe's restricted keys. No root keys in app code; use restricted keys with the minimum required permissions.

## Common pitfalls

- **No webhook signature verification.** Anyone can fake events. Free path to unauthorized access.
- **Synchronous webhook processing.** A 30-second handler triggers retries + duplicates. Queue immediately.
- **Idempotency by hope.** Stripe retries; without idempotency, charges double-count or access duplicates.
- **Hardcoded prices.** Pricing changes mid-life. Reference Price IDs (`price_xxx`); update the Price, not the code.
- **Skipping the trial → paid transition handler.** `customer.subscription.updated` fires when trial ends and the first real charge happens. Make sure access remains continuous.
- **No dispute handling.** Stripe disputes have a window; missing it = automatic loss + funds withdrawn. Wire `charge.dispute.created` to immediate notification.
- **Tax compliance ignored.** "We don't owe tax in X" without registration + collection = potential audit liability.

## What this curator does NOT do

- Build the application's billing UI (engineers do, with Stripe Elements / Checkout).
- Negotiate pricing (sales + product own).
- Configure tax jurisdictions (finance + legal own).

## Output for the workflow

Per advisory:

- Pricing model recommendation with Price IDs + subscription shape.
- Webhook handler hygiene review.
- Tax configuration audit.
- PCI scope assessment.

Report: file paths in /workspace/artifacts/stripe-curator/, audit findings, recommended webhook handler structure.
