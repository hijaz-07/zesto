# Production deployment runbook and recovery plan

Status: **plan only — nothing in this document has been executed.** It is written for the
future deployment of the cancellation/refund work (7.x) plus the 4.5 hardening on top of what
checkpoint 6 already deployed. Do not run any step without an explicit instruction naming it. The `firebase deploy …` lines below are now
written as the guarded `npm run deploy:production …` wrapper; see [Safe deployment commands](#safe-deployment-commands-checkpoint-47).

Project `zesto-dev-2026` · Hosting `https://zesto-dev-2026.web.app` · Functions region
`asia-south1` · Node 24 · Razorpay **Test Mode** · Descope only.

Protected production orders `OpSIkzpFFP7kcGrNE75F` and `e60n23hMaxQo9FLYhCmt` must never be
modified, cancelled, refunded, reused or tested against — in any step below.

## Safe deployment commands (checkpoint 4.7)

Deploy **only** through the project's wrapper. It always passes the Firebase project explicitly (never the CLI's
"active project" or the `default` alias — the active project is remembered per machine in `~/.config/configstore`
and on this machine it **is** production), runs `npm run check:env` first, builds the frontend for the right
environment when hosting is deployed, and refuses on any doubt.

```bash
npm run deploy:staging    -- --only functions,hosting
npm run deploy:production -- --only functions:api --confirm-production zesto-dev-2026
npm run deploy:production -- --only hosting --confirm-production zesto-dev-2026 --dry-run   # checks + prints, changes nothing
```

| Rule | Enforced by |
| ---- | ----------- |
| `--only` is mandatory (no "deploy everything"; the order below matters) | `scripts/deploy-guard.mjs` `requireOnly` |
| Production needs the project id typed out: `--confirm-production zesto-dev-2026` | `resolveDeployTarget` |
| Staging uses the `staging` alias in `.firebaserc`; it is refused if missing, or equal to production; a staging deploy never accepts the production flag | `resolveDeployTarget` |
| The Firebase project is passed as `--project <id>` explicitly | `scripts/deploy.mjs` `buildPlan` |
| `check:env` must print OK before anything is built or deployed | `scripts/deploy.mjs` |
| A staging bundle that mentions the production project id is never deployed | `filesMentioningProduction` |
| **A bare `firebase deploy` (any project) is blocked by the CLI itself**: every deployable target in `firebase.json` (`firestore`, `functions`, `hosting`, `storage`) has `node scripts/deploy-guard.mjs --predeploy` as its FIRST `predeploy` hook, which aborts unless the wrapper approved exactly the project the CLI is about to use | `assertPredeployAllowed` |

Verified against the real Firebase CLI (in a throwaway directory whose Hosting folder does not exist, so nothing could
upload): a bare `firebase deploy --only hosting --project zesto-dev-2026` prints *"Direct `firebase deploy` is blocked…"*
and exits non-zero; the same with approval for a different project, or approval for production without the production
confirmation, is also refused; with the full approval the guard passes and the deploy proceeds to the next step. On
Windows, the CLI's hook runner then prints a harmless `spawn … ENOENT` stack trace after a refused hook — the deploy is
still aborted with `hosting predeploy error: Command terminated with non-zero exit code 1`.

This is an **accident guard, not access control**: someone who exports `ZESTO_DEPLOY_APPROVED_PROJECT` by hand can still
deploy. The real control is who holds IAM on the Firebase project. `.firebaserc` keeps its `default` and `production`
aliases for read-only commands (`firebase functions:log`, …). `functions/package.json`'s old `deploy` script was removed.
Other `firebase` commands that change a project (`firestore:delete`, `functions:secrets:set`, `hosting:disable`, …) are
**not** covered by the hook: always add `--project` to them and read the project the CLI prints first.

## What production holds today (from project history — confirm in preflight)

- Functions: `api`, `onNotificationEventCreated` (from commit `3cdffc1`). **Not yet deployed:**
  cancellation routes, refund domain, `onRefundCreated`, `reconcileRefunds`, the refund retry route, and — new in
  4.6 — `reconcilePayments` (the payment safety net; see [payment-reconciliation.md](./payment-reconciliation.md)).
- Indexes: the 11 from checkpoint 6, READY. **Not yet deployed:** `refunds (status, nextAttemptAt)`,
  the `payments.providerPaymentId` and `refunds.providerRefundId` collection-group field overrides, and — new in
  4.5 — `menus (status, menuDate, createdAt)` at collection scope, and — new in 4.6 — the `payments.reconciliation.nextAttemptAt`
  collection-group field override (the payment sweep's query).
- Rules: deployed in checkpoint 6A (locked down, all `if false`).
- Hosting: the checkpoint-6 frontend (old: no cancellation/refund UI).
- Razorpay webhook: subscribed to `payment.captured` and `payment.failed` only.

## Deterministic order and why

```
 0 preflight ─► 1 indexes ─► 2 rules ─► 3 functions (a→b→c→d) ─► 4 Eventarc check ─► 5 Scheduler check
                                                                                         │
 9 smoke checks ◄── 8 Razorpay webhook events ◄── 7 (gate: functions healthy) ◄── 6 hosting
```

| Step | Action | Depends on | Why this position |
| ---- | ------ | ---------- | ----------------- |
| 0 | Preflight | — | Never deploy blind |
| 1 | `deploy:production --only firestore:indexes` | 0 | Queries fail with `FAILED_PRECONDITION` until an index is **READY**; the refund trigger/reconciler and the webhook lookups use the new ones. Wait for every index to read READY before step 3. Additive; never needs `--force` |
| 2 | `deploy:production --only firestore:rules` | 0 | Independent of the Admin SDK paths, but cheap and must precede Hosting. Byte-identical to what 6A shipped unless `git diff` says otherwise |
| 3a | `functions:onRefundCreated` | 1 (READY) | Create the consumer *before* any producer exists. Creates the Eventarc trigger |
| 3b | `functions:reconcileRefunds`, `functions:reconcilePayments` | 1 (READY — incl. the `payments.reconciliation.nextAttemptAt` override), Cloud Scheduler API enabled | Creates the scheduler jobs. The payment sweep finds nothing until `api` (3d) starts scheduling payments, so deploying it earlier is harmless |
| 3c | `functions:onNotificationEventCreated` | 1 | The updated processor must understand refund events **before** the API starts writing them; an old processor receiving an unknown event type would fail it permanently |
| 3d | `functions:api` | 3a–3c | Last: this is what makes cancellation/refund-retry routes (the producers) and the refund webhook handlers live |
| 4 | Verify Eventarc triggers | 3a, 3c | See checks below |
| 5 | Verify Cloud Scheduler job | 3b | See checks below |
| 6 | `deploy:production --only hosting` | 3d healthy | The new frontend calls routes that exist only after 3d |
| 8 | Add `refund.created`, `refund.processed`, `refund.failed` to the Razorpay Test Mode webhook (Dashboard → Webhooks) | 3d | **Strictly after 3d.** Before it, the old `api` acknowledges unknown events with `200`, so Razorpay would stop redelivering and the events would be lost for good. The URL (`…/api/webhooks/razorpay`) and the signing secret do not change |
| 9 | Smoke checks | all | See below |

Step numbering matches the checkpoint brief (indexes, rules, functions, Eventarc, Scheduler, Hosting,
Razorpay webhook, smoke checks); 7 is the go/no-go gate between Hosting and the webhook.

### 0. Preflight (read-only)

1. Work from a clean checkout of the exact commit to release; record `git rev-parse HEAD`. 7.7–7.9 and 4.5
   are committed locally as `24eb4ff`; the 4.6 payment-reconciliation work is `b00b00a` on top of it, and the 4.7
   deployment guard follows it. Nothing is pushed — **pushing needs its own instruction**.
2. Run the gates: root `npm run lint`, `npm run typecheck`, `npm --prefix functions run typecheck`,
   `npx vitest run`, `npm run test:functions-emulator`, `npm run test:functions-trigger`,
   `npm run test:rules`, `npm run build`.
3. Run `npm run check:env -- --env production` (read-only): it must print OK — correct Firebase project, matching
   Descope ids, Razorpay **test** key. Then confirm the deploying machine's `.env.local` is the **production** frontend configuration
   (Firebase web config, `VITE_DESCOPE_PROJECT_ID`, `VITE_PUBLIC_SUPPORT_EMAIL`,
   `VITE_PUBLIC_OPERATOR_NAME`) — `vite build` bakes it in — and that `functions/.env.zesto-dev-2026`
   exists with `DESCOPE_PROJECT_ID` and a `RAZORPAY_KEY_ID` starting `rzp_test_`.
4. Confirm the three secrets exist in Secret Manager with an enabled latest version and are bound as
   in `index.ts` (list versions; **never print values**): `RAZORPAY_KEY_SECRET`,
   `RAZORPAY_WEBHOOK_SECRET`, `PICKUP_CREDENTIAL_SECRET` (≥ 32 chars).
5. Enable `cloudscheduler.googleapis.com` (and confirm `eventarc`, `run`, `cloudbuild`,
   `artifactregistry`, `secretmanager` are on).
6. Snapshot current state for rollback: `firebase functions:list`, the Cloud Run revision names for
   `api` and each function, `firebase hosting:channel:list`/the current release ID, the live ruleset
   name, and the index list (`firebase firestore:indexes`).
7. Compare the live index list with `firestore.indexes.json`; note whether `menus (status, menuDate,
   createdAt)` at collection scope already exists.
8. Take a Firestore backup/export (see Recovery plan) *before* the first change.
9. Decide a low-traffic window; announce it. There is no maintenance mode — the API stays up
   throughout, which is why the order above never exposes a producer before its consumer.

### 1–2. Indexes and rules

```bash
npm run deploy:production -- --only firestore:indexes --confirm-production zesto-dev-2026
# wait: every index READY (Console → Firestore → Indexes, or the Admin API)
npm run deploy:production -- --only firestore:rules --confirm-production zesto-dev-2026
```

If the CLI offers to delete indexes that exist live but not in the file, answer **no** (and never pass
`--force`): an unlisted live index may be one a query still needs.

### 3. Functions

```bash
npm run deploy:production -- --only functions:onRefundCreated --confirm-production zesto-dev-2026
npm run deploy:production -- --only functions:reconcileRefunds --confirm-production zesto-dev-2026
npm run deploy:production -- --only functions:reconcilePayments --confirm-production zesto-dev-2026
npm run deploy:production -- --only functions:onNotificationEventCreated --confirm-production zesto-dev-2026
npm run deploy:production -- --only functions:api --confirm-production zesto-dev-2026
```

Known behaviour from checkpoint 6: the first Firestore-trigger create can fail once with an Eventarc
service-agent propagation error — wait about four minutes and redeploy only that function.
`retry: true` triggers (`onRefundCreated`, `onNotificationEventCreated`) need `--force` in a non-interactive deploy: add `--force` to
that one command; the wrapper refuses it with any non-functions target. The `firebase-functions-cleanup`
Artifact Registry policy (7 days) is already set.

### 4. Eventarc check

Two triggers should be ACTIVE in `asia-south1`: one for
`notificationEvents/{eventId}` (create) and one for
`organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/orders/{orderId}/payments/{paymentId}/refunds/{refundId}` (create), each delivering to its function.

### 5. Scheduler check

Two jobs should exist — `reconcileRefunds` and `reconcilePayments` — each `ENABLED`, schedule `every 15 minutes`,
region `asia-south1`. After the first scheduled tick, their logs should show `Refund reconciliation finished.` and
`Payment reconciliation finished.` with `examined: 0` (nothing is scheduled yet).

### 6. Hosting

```bash
# the wrapper builds the frontend itself (production mode) before it deploys hosting
npm run deploy:production -- --only hosting --confirm-production zesto-dev-2026
```

Confirm `dist/` contains no `127.0.0.1` emulator host, then check the response headers on `/`.

### 7. Go/no-go gate

Proceed to the webhook subscription only if: the four functions show the new revision healthy, the
smoke checks 1–3 below pass, and the log shows `razorpay client initialised` with `mode: "test"` after the
first payment preparation (or skip that line and check it during the E2E).

### 8. Razorpay webhook

Dashboard (Test Mode) → Settings → Webhooks → the existing Zesto webhook → add
`refund.created`, `refund.processed`, `refund.failed` alongside `payment.captured` and
`payment.failed`. Do **not** add `order.paid` (it would deliver a second success event per payment).
Do not change the URL or the secret.

### 9. Smoke checks (no writes, no protected orders)

1. `GET /api/explore/outlets` → 200 envelope.
2. `GET /api/me` without a token → 401 with `WWW-Authenticate: Bearer`.
3. `POST /api/webhooks/razorpay` with no signature → 401; with a wrong signature → 401 (nothing written).
4. `/` response carries `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
   `Permissions-Policy` and `Content-Security-Policy-Report-Only` (and **no** enforcing `Content-Security-Policy`); `/api/**` carries `Cache-Control: private, no-store`.
5. Logs: no `unhandled api error`; the scheduler tick logged `examined: 0`.
6. Indexes all READY; Eventarc triggers ACTIVE; scheduler job ENABLED.
7. Then run the [production E2E](./production-e2e-plan.md) with a fresh test customer — that is the
   first thing allowed to create an order.

## Rollback

| Layer | Rollback | Notes |
| ----- | -------- | ----- |
| Hosting | `firebase hosting:rollback` (or promote the previous release in the Console) | Instant. Safe at any time; the old frontend simply lacks the new UI |
| `api` | Shift Cloud Run traffic back to the previous revision (`gcloud run services update-traffic api --region asia-south1 --to-revisions=<previous>=100`), or redeploy the previous commit | Firebase has no one-click function rollback; the revision shift is the fast path. Do this **before** unsubscribing webhook events if cancellation/refund routes misbehave |
| Triggers | Delete the new function (`firebase functions:delete onRefundCreated --region asia-south1`) | Refunds already created simply wait; the reconciler (if still deployed) picks them up |
| Scheduler | `gcloud scheduler jobs pause <job> --location asia-south1` | Stops provider calls from the sweep immediately without a deploy |
| Rules | Re-release the previous ruleset from the Console history (or redeploy the previous file) | Rules are deny-all; a rollback is only needed if a change is ever made |
| Indexes | **Do not roll back** | Additive and harmless. Deleting an index a deployed query needs is the only way to break things |
| Webhook events | Remove the three refund events in the Dashboard | Razorpay stops delivering them; pending refunds are still re-checked every 6 h by the reconciler, so nothing is lost — but do this only if the handlers are wrong, and prefer pausing the scheduler first |
| Secrets | Roll back by enabling the previous secret version and redeploying/restarting the function | Rotating `PICKUP_CREDENTIAL_SECRET` invalidates shown credentials (harmless: customers refetch) |

### Partial deployments

Every step is idempotent and individually safe; stopping between any two leaves a consistent system:

- After 1–2 only: no behaviour change.
- After 3a–3c, before 3d: consumers exist, no producer — nothing happens. Safe to stay here.
- After 3d, before 6: new backend, old frontend — cancellation routes exist but no customer UI calls
  them; the old UI is unaffected.
- After 6, before 8: full flow works; refund state is driven by the create response and the 6-hourly
  status check instead of the webhook; `pending` refunds will simply complete later.
- A failed `functions:api` leaves the previous revision serving; fix and redeploy.
- Never reverse the order of 3c and 3d, or of 3d and 8.

## Recovery plan

### Data (Firestore)

Not configured in the repo; **verify what exists before relying on it**, then set up (one-time,
requires project-owner permission):

```bash
# Point-in-time recovery (7 days of any-second restore)
gcloud firestore databases update --database='(default)' --enable-pitr
# Scheduled backups (daily, kept 14 days)
gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14d
# Ad-hoc export before a risky change (to a dedicated bucket)
gcloud firestore export gs://<backup-bucket>/pre-deploy-$(date +%F) --collection-ids=…   # or whole database
```

Restore is always into a **new** database (`gcloud firestore databases restore` / clone from a PITR
timestamp), then data is copied back or the application pointed at it — never an in-place overwrite
of production. The Firestore data is the system of record for *demand*; Razorpay is the system of
record for *money* — after any restore, reconcile the two (below). Consider adding TTL on
`notifications.expiresAt` and an expiry field on `razorpayWebhookEvents` / processed
`notificationEvents`, which otherwise grow without bound (a TTL policy is set per collection group in
the Console or `fieldOverrides`; it is not set today).

### Source and configuration

Code: GitHub (`origin/main` is **behind** local `main` — unpushed commits are a single point of failure;
pushing needs its own instruction). Secrets: Secret Manager keeps versions; record *where* each secret's
source of truth lives (Razorpay Dashboard, Descope console) outside the repo. Non-secret deploy params
(`functions/.env.zesto-dev-2026`) are gitignored — keep an offline copy of its two lines.

### After an outage or bad deploy

1. **Refunds.** Nothing to do manually: `reconcileRefunds` advances every `requested`/`pending` refund
   whose `nextAttemptAt` has passed (25 per 15-minute run, lease-safe, looking the refund up at the
   provider before ever re-creating it). Refunds flagged `attentionRequired` need a person: owner/manager
   sees them in the org orders list and can use *Retry refund* only when the latest refund is `failed`.
   Check logs for `A refund needs attention`.
2. **Payments.** Razorpay redelivers failed webhooks for a bounded period; deliveries are idempotent. For
   anything longer, `reconcilePayments` asks Razorpay what it holds for each unresolved payment's own provider
   order and adopts a confirmed capture through the same `markPaymentSucceeded` (25 per 15-minute run, oldest
   first, for 7 days from creation). Nothing to do manually unless it flags a payment: search the logs for
   `A payment needs attention.` and follow [payment-reconciliation.md §7](./payment-reconciliation.md#7-operator-procedures-for-a-flagged-payment).
   Any `A payment captured at the provider was recovered by reconciliation.` line means the primary paths
   missed a payment — find out why (webhook secret, subscription, outage). Payments created before 4.6 are
   not swept; compare the Dashboard's *captured* list with `pending_payment` orders for those.
3. **Notifications.** `notificationEvents` documents are the outbox; the trigger retries transient
   failures and marks exhausted ones `failed` (logged). Re-delivery of refund notifications is covered by
   `scripts/backfill-refund-notifications.mjs` (dry-run by default; real writes need the explicit flag and
   it skips the two protected orders). Order-lifecycle notifications have no equivalent replay tool.
4. **Webhook gaps.** After restoring service, look at Razorpay Dashboard → Webhooks → failed deliveries and
   replay them manually; duplicates are safe.
5. **Verify** with the smoke checks and a read-only review of orders in `pending_payment` / refunds in
   `requested|pending|attentionRequired`.

### Break-glass levers (no deploy needed)

- Pause the refund or payment sweep: pause its Scheduler job (`reconcileRefunds` / `reconcilePayments`).
- Stop new customer orders: archive the menu (organization UI) — existing orders are untouched.
- Stop all API writes quickly: shift `api` traffic to a known-good revision, or set the function's
  `max instances` to 0 in the Console (returns 5xx to everyone — last resort).
- Razorpay: disable the webhook in the Dashboard; payments still verify through `payment/verify`.
