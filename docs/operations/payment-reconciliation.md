# Payment reconciliation (Checkpoint 4.6)

Status: **built and tested locally; not deployed.** Nothing here has run against Firebase
production or Razorpay. Deploying it needs the steps under [Deployment prerequisites](#deployment-prerequisites).

Code: [`paymentReconciliation.ts`](../../functions/src/domain/paymentReconciliation.ts) (driver, matching, sweep) ·
[`paymentReconciliationState.ts`](../../functions/src/domain/paymentReconciliationState.ts) (stored shape, schedule) ·
[`razorpayPayments.ts`](../../functions/src/providers/razorpayPayments.ts) (the one read-only Razorpay call) ·
`reconcilePayments` in [`index.ts`](../../functions/src/index.ts).

## 1. Audit: how a payment reaches `succeeded` today

A payment is one document per order (`…/orders/{orderId}/payments/{orderId}`). Only these paths change
its status; all three end in the same transition, `markPaymentSucceeded` / `markPaymentFailed`
(`domain/payments.ts`), which re-checks amount and currency against the **stored** payment:

| Path | Trigger | Authority |
| ---- | ------- | --------- |
| Checkout verification | `POST /orders/{id}/payment/verify` from the customer's browser | HMAC of `{stored providerOrderId}\|{paymentId}` with the API key secret |
| Webhook | `POST /webhooks/razorpay`, `payment.captured` / `payment.failed` | HMAC of the raw body with the separate webhook secret; payment found by `providerOrderId` |
| **Reconciliation (new)** | `reconcilePayments`, every 15 minutes | Razorpay's own answer to "which payments exist for this provider order?" |

### Realistic ways Razorpay captured and Zesto did not learn of it

Established from `routes/orders.ts`, `routes/webhooks.ts`, `domain/razorpayWebhooks.ts`, `domain/payments.ts`:

| # | Cause | Why nothing else recovers it | Covered now |
| - | ----- | ---------------------------- | ----------- |
| 1 | Browser closed / lost network after Razorpay succeeded, before `payment/verify` | Only the webhook is left | yes, if the webhook also failed (below) |
| 2 | `payment/verify` refused: 429 (per-user limiter), 5xx, expired/invalid Descope session (401/503) | Same | yes |
| 3 | Webhook never delivered or never accepted: endpoint down longer than Razorpay's retry window; **webhook secret rotated or wrong → 401 on every delivery**; webhook not subscribed to `payment.captured` | A webhook that is never accepted is never retried by Zesto | yes |
| 4 | Webhook accepted but **acknowledged without applying** (`200`, never redelivered): `ignored_status_mismatch`, `rejected_amount_mismatch`, `rejected_currency_mismatch`, `rejected_order_not_payable`, `rejected_missing_order`, `rejected_ambiguous_payment` | A `200` ends Razorpay's retries | recovered if the cause was transient; **flagged for a person** if the data disagrees (see §3) |
| 5 | Webhook answered 409 `event_in_progress` or 500 (a transient Firestore failure) on every redelivery until Razorpay's retries ran out | Same as 3 | yes |
| 6 | Captured **after the customer cancelled** the unpaid order, and the webhook was missed | `markPaymentSucceeded` handles a late capture only if told | yes: same late-capture path, refund reserved |
| 7 | Customer retried after a failed attempt; the later success was missed while an earlier `payment.failed` was recorded | `failed → succeeded` is allowed, but nothing triggers it | yes (`failed` payments stay under watch) |

**Not a gap:** a provider order created by `ensureProviderOrder` whose id was never stored (crash between
the Razorpay call and the Firestore write). Its id was never returned to the browser, so nobody can pay it.

**Not covered (by design):** a payment made outside a Zesto provider order (a Dashboard payment link, a
manual capture). There is nothing in Zesto to match it to; the runbook's Dashboard-vs-Zesto comparison remains
the control for that. And: payments created **before** this ships carry no schedule and are not swept
(see [Legacy payments](#legacy-payments)).

## 2. State machine

Payment status is unchanged: `pending | succeeded | failed`. Reconciliation adds bookkeeping in a
`reconciliation` map on the payment (internal, never in an API response):

```
                      ensureProviderOrder (claimProviderOrder)
 payment created ─────────────────────────────────────────────▶ SCHEDULED
 (no provider order:                          nextAttemptAt = +15 min          │
  never swept)                                                                 │ sweep: due, unleased
                                                                               ▼
                    ┌───────────── lease taken (2 min) ◀── CLAIM (transaction) ┘
                    │                 │ already succeeded ──▶ leaves the sweep (no provider call)
                    │                 │ flagged / inconsistent ──▶ ATTENTION (stops)
                    ▼
        provider lookup (no transaction, read-only)
                    │
   ┌────────────────┼───────────────────┬────────────────────┬───────────────────┐
   ▼                ▼                   ▼                    ▼                   ▼
 exactly one      only failed       created / authorized   nothing            lookup failed or
 matching         attempts          / no payments          listed             unusable
 CAPTURE
   │                │                   │                    │                   │
 markPayment-   markPayment-          not paid             not paid           nothing changes;
 Succeeded      Failed (pending      (authorized+window    next look in       retry in 2m, 4m … 1h
 (order →       only); order stays    end → flagged)       15m, 30m, 1h …     (config error: 15m)
 confirmed, or  payable; keep                              12h
 late-capture   watching
 refund)
   │                └────────────── SCHEDULED (next look) ──────────────────────┘
   ▼
 RESOLVED (leaves the sweep)                    window (7 days from creation) ends → CLOSED
 anomaly at any point → ATTENTION (flagged, stops, audit record)
```

`nextAttemptAt` is the **only** selector the sweep uses. It exists exactly while automatic work should
continue: set when the provider order is attached, moved by every claim and evaluation, and deleted
(a) in the same transaction as any `markPaymentSucceeded`, (b) when the window closes, (c) when a person is needed.

### Order / payment consistency (invariants the tests end on)

| Payment | Order | Refund |
| ------- | ----- | ------ |
| `succeeded`, captured amount = amount, provider payment id set, **no `nextAttemptAt`** | `confirmed` + `paid` | none |
| `succeeded` after the order was cancelled | stays `cancelled`, `paid` | exactly one, full amount, `late_capture_after_cancel` |
| `pending` / `failed` | `pending_payment` (or `cancelled`), `paymentStatus: pending` | none, no captured amount |

## 3. Matching: what may be adopted

The lookup is keyed by the payment's own **`providerOrderId`** — an identifier Zesto stored itself, before
the customer could pay. **Amount alone never identifies a payment.** `evaluateOrderPayments` is a pure function
over the provider's listing:

| Provider shows | Zesto does |
| -------------- | ---------- |
| Items whose `order_id` is **not** this payment's order | Ignored, never adopted; recorded in `reconciliationAudit` (`ignored_foreign_provider_payments_…`) and logged at error |
| **Exactly one** `captured` payment, same amount and currency as the stored payment, nothing refunded, id not on any other Zesto payment | **Adopt**: `markPaymentSucceeded` (confirms, or reserves the late-capture refund) |
| Captured payment, different amount or currency | **Flag** `captured_amount_mismatch`; nothing confirmed |
| Captured payment with money already refunded outside Zesto | **Flag** `captured_with_external_refund` |
| `refunded` payment | **Flag** `captured_then_refunded` |
| Two or more captured payments | **Flag** `multiple_captured_payments`; neither adopted |
| Captured id already stored on a *different* Zesto payment | **Flag** `provider_payment_claimed_elsewhere` |
| The payment already `succeeded` with a different provider payment id (e.g. a webhook won while the lookup ran) | **Never overwritten**; **flag** `conflicting_captured_payment` |
| The same provider payment id as already recorded | Recognised, resolved quietly |
| Only `failed` attempts | `markPaymentFailed` with the newest attempt's id (only from `pending`); order untouched; **keep watching** |
| `authorized` or `created` | Not paid. Next look scheduled. At the window end an `authorized` payment is **flagged** `authorized_not_captured` |
| Nothing listed | Nobody paid yet. Next look scheduled |
| A listing that contradicts itself (status/`captured` flag disagree, an id twice) | **Unusable**: treated as an inconclusive lookup, never acted on |
| Order not `pending_payment`/`cancelled`, or user/amount/currency disagree between order and payment, or malformed documents | **Flag** `inconsistent_documents` *before* asking the provider |

A flagged payment has `reconciliation.attentionRequired = true`, an `attentionCode`, no `nextAttemptAt`, an
audit record under `reconciliationAudit`, and an **error log line `A payment needs attention.`** carrying the
order id and code. Its status and its order are never touched by a flag.

## 4. Failures are not evidence

| Lookup result | Effect |
| ------------- | ------ |
| Timeout, network error, 429, 5xx, `408`, unreadable answer, any unexpected local error | Status and order unchanged; lease released; retry in 2m, 4m, 8m … capped at 1h; streak counted |
| 401/403 or missing credentials | Same, but a quiet 15-minute retry; error log; **not** counted as a lookup streak |
| 4xx other than auth (e.g. order id unknown to these keys — a Test/Live mismatch) | Treated as a failed lookup, never as "not paid" |
| 8+ consecutive inconclusive lookups | Keeps retrying hourly; every attempt logs at **error** (alertable). Never marks failed |
| No conclusive lookup before the window ends | Closed and **flagged** `window_closed_unverified` — never silently treated as unpaid |

## 5. Scheduler, bounds, safety

| Property | Value |
| -------- | ----- |
| Function | `reconcilePayments` — `onSchedule`, `every 15 minutes`, `asia-south1`, `maxInstances: 1`, timeout 540 s, secret `RAZORPAY_KEY_SECRET` |
| Selection | One collection-group query: `payments` where `reconciliation.nextAttemptAt <= now`, ordered by it ascending (**oldest first**), `limit 25` (max 100). Never scans tenant data; resolved, flagged and legacy payments carry no `nextAttemptAt` and are never returned |
| Time budget | 4 minutes of wall clock; the rest waits for the next run |
| Lease | 2 minutes per payment. A second worker (overlapping run, retried trigger) sees the lease and skips; a worker that died leaves the payment findable when the lease lapses, with no inference about the provider |
| Schedule | 15 min after the provider order is attached, then 15m, 30m, 1h, 2h, 4h, 8h, then every 12 h |
| Window | 7 days from the payment's creation; the evaluation that would be the last still looks, adopts a capture if there is one, then closes |
| Isolation | Provider calls never run inside a transaction; each payment is validated against its document path; one payment's error never stops the batch |
| Authority | Only `markPaymentSucceeded` / `markPaymentFailed` change money-bearing state — there is no second implementation of "paid" |
| Provider access | **Read-only**: `GET /v1/orders/{id}/payments`. Creates, captures and refunds nothing |

Capacity: 25 per run ≈ 2,400 evaluations/day. With the schedule above a payment costs ~15 evaluations over its
whole life, and most leave the sweep after the first (the customer paid, so `succeeded` removes the schedule).
Raise `DEFAULT_PAYMENT_RECONCILE_LIMIT` (and keep the 100 cap) before volumes approach that.

### Razorpay API facts relied on

Verified from the documentation page *Fetch Payments for an Order*: `GET /v1/orders/{id}/payments` →
`{entity: "collection", count, items[]}`; each item has `id`, `order_id`, `amount`, `amount_refunded`, `currency`,
`status` (`created | authorized | captured | refunded | failed`), `captured`, `created_at`. **No pagination or filter
parameters are documented**, so none is sent. **Unverified** (never exercised against Razorpay in this checkpoint —
no network call was made): behaviour for an order with a very large number of attempts; whether `authorized`-only
payments appear in every account configuration; the exact error body for an unknown order id. None of these can
mark a payment paid wrongly: only a provider-reported `captured` payment that matches is ever adopted.

## 6. Observability

Alert on these (Cloud Logging, severity ≥ ERROR unless noted):

| Log message | Meaning | Action |
| ----------- | ------- | ------ |
| `A payment needs attention.` (`orderId`, `code`) | An anomaly; automatic work stopped | §7 |
| `Payment reconciliation keeps failing to reach a conclusion.` | ≥ 8 failed lookups in a row for one payment | Check Razorpay status / credentials |
| `The payment provider's credentials are missing or were rejected.` | Key/secret wrong, rotated or wrong mode | Fix the secret; sweeps resume by themselves |
| `The provider listed payments of another order for a payment; they were ignored.` | Provider answer included foreign payments | Investigate; nothing was adopted |
| `Reconciling a payment failed.` | An unexpected local error for one payment | Look at the next line; it retries |
| `A payment captured at the provider was recovered by reconciliation.` (WARNING) | **Zesto missed a payment.** Find out why (webhook secret? endpoint outage? subscription?) | Treat every occurrence as a signal about the primary paths |
| `Payment reconciliation finished.` (INFO) | Per-run summary: `examined`, `results` by outcome, `stoppedForBudget` | A growing `deferred` count means the provider is unreachable |

## 7. Operator procedures for a flagged payment

Find it by the order id in the error log. Open the payment document
`organizations/{o}/outlets/{ou}/menus/{m}/orders/{orderId}/payments/{orderId}` and its `reconciliationAudit`
subcollection. **Check the Razorpay Dashboard before anything else.**

| `attentionCode` | Likely cause | Do |
| --------------- | ------------ | -- |
| `captured_amount_mismatch` | Order total changed after the provider order was created, or a tampering attempt | Decide: refund in the Dashboard, or reconcile manually. Do not edit the payment's amount |
| `captured_with_external_refund`, `captured_then_refunded` | Someone refunded in the Dashboard | Usually nothing: the customer has their money; the order stays unpaid |
| `multiple_captured_payments` | Two captured payments for one order | Refund the extra in the Dashboard |
| `conflicting_captured_payment` | A second, different payment captured after Zesto accepted one | Refund the extra in the Dashboard |
| `provider_payment_claimed_elsewhere` | Data anomaly | Investigate before anything else |
| `capture_not_applicable` | A capture that could not be applied (e.g. a cancelled order that cannot be refunded safely) | Refund in the Dashboard |
| `inconsistent_documents` | Order and payment disagree or are malformed | Inspect both documents |
| `authorized_not_captured` | Razorpay holds an authorized-only payment (auto-capture off?) | Capture or let it lapse in the Dashboard; check the account's auto-capture setting |
| `window_closed_unverified` | The provider could not be asked for 7 days | Compare the Dashboard with this order by hand |

To let automatic reconciliation look again after you have fixed the cause: in the Firestore Console delete
`reconciliation.attentionRequired`, `reconciliation.attentionCode`, `reconciliation.attentionAt`, and set
`reconciliation.nextAttemptAt` to now (and `reconciliation.resolution` / `resolvedAt` deleted if present).
There is deliberately no API for this.

## Legacy payments

Payments created before this change have no `reconciliation` map and are never selected by the sweep. No
backfill is provided on purpose: the only such payments in `zesto-dev-2026` are Test Mode end-to-end payments,
and the two **protected orders** (`OpSIkzpFFP7kcGrNE75F`, `e60n23hMaxQo9FLYhCmt`) must never be written to. If an
old unresolved payment ever has to be checked, call `reconcilePayment(db, gateway, location, {honorSchedule: false})`
for that one payment from an approved, supervised script; it will create a proper schedule.

## Deployment prerequisites

Not done; each needs an explicit instruction. Order matters (see [deployment-runbook.md](./deployment-runbook.md)):

1. `firebase deploy --only firestore:indexes` — adds the `payments.reconciliation.nextAttemptAt`
   collection-group field override. **Wait until it is READY**: the sweep's query fails with
   `FAILED_PRECONDITION` until then (the emulator does not enforce indexes).
2. Cloud Scheduler API enabled (already required by `reconcileRefunds`).
3. `firebase deploy --only functions:reconcilePayments` — then `functions:api` (the new `api` revision is what
   starts scheduling payments, via `ensureProviderOrder`). Deploying the sweep first is harmless: it finds nothing.
4. Check one scheduled tick logs `Payment reconciliation finished.` with `examined: 0` on an idle project.

## Tests

| File | What it proves |
| ---- | -------------- |
| `domain/paymentReconciliation.test.ts` | The matching rules as a pure function (every row of §3), path validation, schedule and backoff arithmetic |
| `providers/razorpayPayments.test.ts` | The adapter: read-only GET, normalised fields only, whole-listing failure on one bad item, every HTTP failure typed, no credential or customer data in logs, unsafe order ids never sent |
| `domain/paymentReconciliation.emulator.test.ts` | Against a real Firestore emulator: captured-but-webhook-missed, captured-but-verify-missed, failed-but-webhook-missed, provider pending/authorized, timeout/5xx/rate limit/auth, retry and backoff, duplicate and concurrent reconciliation, overlapping sweeps, conflicting ids, wrong-order payments, malformed provider results, already-succeeded, late capture, the window, bounds, and the order/payment consistency invariant |
| `domain/payments.emulator.test.ts` (additions) | `ensureProviderOrder` schedules once; success removes the schedule in the same transaction |
| `index.registration.test.ts`, `firestoreIndexes.test.ts` | The function is exported with its secret and single instance; the index override is in the real `fieldOverrides` array |
