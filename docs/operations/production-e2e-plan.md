# Production E2E test plan (for a later checkpoint — not executed)

Purpose: prove, on the deployed system (`https://zesto-dev-2026.web.app`, Razorpay **Test Mode**),
that the full customer ↔ organization lifecycle works after the deployment in
[deployment-runbook.md](./deployment-runbook.md). Run it only after the runbook's smoke checks pass
and only on an explicit instruction.

## Ground rules

1. **No real money.** The deployed `RAZORPAY_KEY_ID` is `rzp_test_…`; confirm the log line
   `razorpay client initialised {mode: "test"}` before the first payment. If it ever says `live`,
   stop. Use only Razorpay's published Test Mode instruments (test cards, the test UPI IDs that
   succeed/fail, test netbanking) from the Razorpay docs at the time of the run.
2. **Fresh data only.** Never reuse, modify, cancel, refund or inspect-with-intent the protected orders
   `OpSIkzpFFP7kcGrNE75F` and `e60n23hMaxQo9FLYhCmt`. Every order in this plan is created during the run.
   Before any bulk action, filter by the test organization; abort a step if an unexpected order appears.
3. **Dedicated identities** (Descope), none of them a real person's account:
   - `e2e-customer-A` (primary), `e2e-customer-B` (isolation/ownership checks);
   - `e2e-owner`, `e2e-manager`, `e2e-staff` — members of one **dedicated test organization** with one
     outlet and a menu published for the run; plus `e2e-outsider` (owner of a second throwaway
     organization) for cross-tenant checks.
   - Prefer Descope *test users* (fixed OTP, no SMS) so sign-in never sends real SMS or depends on a phone.
4. **One operator, one browser profile per identity** (separate profiles or private windows) so sessions
   do not bleed; a second device (or throttled network profile) for interruption tests.
5. **Record evidence per step:** timestamp, order ID (test orders only), screenshot, and the relevant
   `requestId` from error envelopes. Capture the Functions logs for the window afterwards and scan for
   `unhandled api error`, `razorpay webhook reconciliation anomaly`, `A refund needs attention`.
6. **Stop conditions:** any unexpected `500`, any `anomaly`/`needs attention` log, any order changing state
   without an action, any protected order appearing in a result — stop, preserve logs, report.
7. **Cleanup:** archive the test menu; leave test orders in terminal states. Nothing is deleted.

## Setup (before the run)

- Create the test organization/outlet/menu through the organization UI as `e2e-owner`; add the other members
  (backend membership documents are written by the app's onboarding/membership flow — if a member cannot be
  added from the UI at this stage, record that as a finding rather than writing Firestore by hand).
- Publish a menu with 2 items, ordering open now, deadline comfortably in the future, pickup window open,
  prices small (e.g. ₹10–₹40).
- Confirm in the organization UI that the notification bell works for owner/manager/staff.
- Note the baseline of `reconcileRefunds` log lines and the Eventarc/Scheduler states.

## A. Customer journey (as `e2e-customer-A`)

| # | Step | Expect |
| - | ---- | ------ |
| A1 | Sign in via the Descope flow; reload the page | Lands signed in; reload keeps the session; no 401/503 loop |
| A2 | Explore → outlet → menu | Published menu and items shown; the outlet-menus request returns 200 (the new collection-scope index is READY) |
| A3 | Add items, change quantities, remove one | Cart reflects it; totals computed from displayed prices |
| A4 | Place the order | `pending_payment`; the order shows server-computed total |
| A5 | **Duplicate click** on Place order (rapid double click, and Enter+click) | Exactly one order (idempotency key); no second `pending_payment` |
| A6 | Pay with a Test Mode card (success) | Checkout opens with `rzp_test` key; payment verifies; order `confirmed` / `paid`; confirmation page shows no raw provider internals |
| A7 | Double-trigger verification (click pay twice quickly, then reload during verify) | One payment; order not double-confirmed; page recovers on reload |
| A8 | Cancellation eligibility on a `confirmed` order | "Cancel order" offered with the refund policy copy; deadline/stage logic as designed |
| A9 | Customer order history | The order appears; no other customer's data |
| A10 | Org advances the order (see B); customer sees notifications and the **ready** state | Bell increments once per event (no duplicates); status updates on refresh/poll |
| A11 | Pickup credential when `ready` | QR + backup code shown; not shown before `ready` or after pickup; refetching returns the same credential |
| A12 | After pickup | Order `picked_up` → `completed`; credential no longer offered; cancel not offered |

## B. Organization journey (as `e2e-owner` / `e2e-manager` / `e2e-staff`)

| # | Step | Expect |
| - | ---- | ------ |
| B1 | New paid order arrives | Appears in the orders list for the right outlet/menu; org bell shows `new_order` exactly once |
| B2 | `start-preparing` as staff | Allowed; order `preparing`; customer notified once |
| B3 | Repeat the click / two staff race | Idempotent: one transition, no duplicate notification |
| B4 | `mark-ready` | `ready`; customer notified once |
| B5 | Pickup by **scanning** the QR; then a second order by typing the **backup code** | `picked_up`; scan of the same QR again is refused with a clear 409; a wrong code → "No order awaiting pickup matches this code." |
| B6 | `complete` | `completed`; terminal |
| B7 | Staff attempts cancel / retry refund | `cancel`: per policy; **retry refund: 403** |

## C. Cancellation and refunds (fresh orders for each)

| # | Scenario | Expect |
| - | -------- | ------ |
| C1 | **Customer cancels** a paid `confirmed` order | Order `cancelled`; refund created `requested`, then `pending`/`processed` via the trigger; customer sees the safe refund status (amount/currency/times only); org sees `cancelledBy: customer` and refund state; **customer-cancellation notification** reaches the org; refund-requested/completed notifications reach the customer once each |
| C2 | Double-click **Cancel** / cancel from two tabs | One cancellation, one refund (deterministic ID); the second returns the same state |
| C3 | **Race: cancel while org marks ready** (two browsers, near-simultaneous) | Exactly one wins; the loser gets a 409 with a refresh hint; never both; refund exists iff the order is `cancelled` |
| C4 | **Outlet cancels** a paid order (owner/manager) | `cancelledBy: organization`; refund created; customer notified |
| C5 | Cancel an unpaid `pending_payment` order | Cancelled with **no refund**; no refund document |
| C6 | **Cancel then pay** (open Checkout, cancel in another tab, complete payment) | The late capture is refunded in full automatically (`payments.ts` late-capture path); order stays `cancelled`; log shows the reserved-refund warning, not an error |
| C7 | **Refund webhook handling**: watch `refund.created` / `refund.processed` | `razorpayWebhookEvents` records them; outcomes `refund_pending` / `refund_processed`; a Dashboard **redelivery** of the same event is a safe `duplicate` |
| C8 | **Refund reconciliation**: pause the webhook (Dashboard) or use a refund whose webhook has not arrived; wait for a scheduler tick | The sweep moves it to `processed` via status lookup; no second provider refund (verify in the Dashboard: one refund per cancellation) |
| C9 | **Retry on a non-failed refund** (owner/manager clicks *Retry refund* or sends the request) | 409 "hasn't failed"; **no second refund** — this is the deterministic check of the retry route in Test Mode |
| C10 | *Failed refund → retry* | **Cannot be forced on demand in Test Mode** (the provider cooperates). Coverage is the 1,000+ emulator tests with the fake gateway. If a failure occurs naturally (or via an operator-induced condition agreed beforehand), then verify: *Retry refund* creates `…-r2` for the remaining amount only, the failed `r1` is untouched, only owner/manager succeed. Record "not exercised" otherwise — do not fake it in production |
| C11 | Staff, other organization's owner (`e2e-outsider`), and customer B try to cancel/retry A's order via the UI/API | 403 / 404 / 404; no change |

## D. Robustness

| # | Scenario | Expect |
| - | -------- | ------ |
| D1 | **Logout/login recovery** mid-flow (log out during pending payment, log back in) | Order and its status intact; can resume payment or see confirmation; no stale credential cached (pickup credential not retained in browser storage) |
| D2 | **Network interruption**: go offline (devtools/throttle) after clicking Pay, and during Cancel; come back | UI shows a retryable error, never a false success; replay is safe (idempotent); the order ends in exactly one consistent state |
| D3 | **Refresh** on every page in A and B (esp. confirmation, pickup, org orders) | Page reloads from server state; no stuck spinner; deep links work (SPA fallback) |
| D4 | Expired session: wait out / clear the session token | One silent refresh; if refresh fails, clean sign-in prompt; a 503 from the backend does **not** sign the user out |
| D5 | Rate-limit sanity | Normal use never shows `429`. Optionally script ~25 `GET /api/notifications/unread-count` in a minute with a test token and expect none (limit 120); do **not** hammer payment/cancel routes |
| D6 | Notification duplication | Over the whole run, each logical event produced exactly one inbox entry per recipient (`{eventId}.{audience}` IDs); unread count matches |
| D7 | Headers and console | Page responses carry the security headers; no console errors; (if a CSP Report-Only header has been added) collect violations from Razorpay Checkout and Descope before enforcing |
| D8 | Mobile viewport | Core flows usable at 375 px; QR scanner asks for camera once and works after granting |

## E. Exit criteria

Pass when: A, B, C1–C9, C11, D1–D4, D6 all meet expectations; no `unhandled api error`,
`razorpay webhook reconciliation anomaly` or `A refund needs attention` in the logs for the window; the
Razorpay Dashboard shows exactly one refund per cancelled paid test order and no live-mode activity; the
two protected orders are untouched. Any deviation is a finding, not a retry-until-green.

## F. After the run

Export the log window, list every order created (IDs + final states) in the report, archive the test
menu, and leave the test identities in place for the next run.
