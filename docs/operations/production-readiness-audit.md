# Production readiness audit (Checkpoint 4.5)

Scope: repository and configuration only. No production read or write, no deploy, no
Razorpay call was made for this audit. Everything below was established from source,
config files and the local test suites; anything that can only be known by looking at the
live project is listed as **"verify before deploy"**, never assumed.

Companion documents: [deployment-runbook.md](./deployment-runbook.md) (order, rollback,
recovery), [production-e2e-plan.md](./production-e2e-plan.md),
[mobile-store-readiness.md](./mobile-store-readiness.md).

## Summary of findings

| # | Severity | Finding | Status |
| - | -------- | ------- | ------ |
| 1 | Medium | **No payment reconciliation.** A payment captured while *both* the customer's `payment/verify` call and Razorpay's webhook deliveries fail leaves the order `pending_payment` with money taken. | **Built in 4.6, not deployed** — `reconcilePayments` (see [payment-reconciliation.md](./payment-reconciliation.md)) |
| 2 | Medium | **No separate staging environment.** One Firebase project (`zesto-dev-2026`) and one Descope project serve development *and* production; production builds read the deploying machine's `.env.local`; dev and production share one Razorpay Test namespace. | **Open — designed, not created.** Console-only steps; exact plan and a read-only guard (`npm run check:env`) in [environments.md](./environments.md). Required before Live Mode |
| 3 | Medium | **Backups and monitoring are not defined in the repo.** No PITR/scheduled-backup configuration, no TTL on growing operational collections, no alert policies. | Open — exact setup in the [runbook](./deployment-runbook.md#recovery-plan) and [Observability](#observability) |
| 4 | Medium | **No abuse limits on the API.** | **Mitigated in this checkpoint** — per-user best-effort limiter (`http/rateLimit.ts`); global limit remains future work |
| 5 | Medium | **Razorpay order create/fetch had no timeout** (the SDK sets none) — a hung connection held a customer request until the function's 60 s limit. | **Fixed** — 15 s bound, `PaymentProviderError` on expiry |
| 6 | Medium (probable) | **Missing collection-scope composite index** `menus (status, menuDate, createdAt)`. `listUpcomingPublishedMenusForOutlet` filters one outlet's `menus` collection by `status` + range on `menuDate`; only the *collection-group* variant was defined. The emulator does not enforce indexes, so no test could catch this. | **Fixed (additive)** — index added and pinned by `firestoreIndexes.test.ts`. Verify against the live index list; if the live project already has it the deploy is a no-op |
| 7 | Low | No baseline security headers on Hosting (clickjacking, MIME sniffing, referrer, camera scope). | **Fixed** — `firebase.json` headers, pinned by `hostingConfig.test.ts`. A **`Content-Security-Policy-Report-Only`** header was added in 4.6; enforcement waits for collected violations (see [Hosting headers](#hosting-headers-and-csp)) |
| 8 | Low | Organization membership is organization-wide: any active member can act on every outlet of the organization. By design today; relevant before multi-outlet SaaS. | Documented |
| 9 | Low | `POST /organizations` is open to any authenticated user (now capped at 10/hour/user per instance). | Documented |
| 10 | Low | Descope's browser SDK keeps session tokens in browser storage (its default). An XSS would expose them; a CSP is the compensating control. | Documented |
| 11 | Low | The pickup backup code is 40 bits and found by scanning the caller's own organization's `ready`/`picked_up` orders (≤ 500). Guessing needs an authenticated member of that organization and ~2⁴⁰/500 attempts; each attempt costs up to 501 document reads. | Mitigated by the 120/min pickup limit; documented |
| 12 | Low | `functions/package.json` `npm run lint` is broken (legacy `--ext` with flat config). Root `npm run lint` covers `functions/` and is the working check. | Pre-existing, unchanged |
| 13 | Info | No account-deletion capability, Contact/Privacy pages depend on `VITE_PUBLIC_*` values being set at build time. | Store-readiness item |

**Critical: none. High: none confirmed.** No secret, key or credential is committed, the
client has no path to payment, ownership or authorization state, and every Firestore rule
is `if false` — intentionally, and verified in 4.6 to match how the frontend works (see
[Firestore access architecture](#firestore-access-architecture)).

## 1. Environment and secrets

Checked: tracked files and full git history for key/token/PEM/service-account patterns,
`.gitignore` coverage, every `process.env` / `import.meta.env` / `defineString` /
`defineSecret` read, the compiled `dist/` bundle, and the scripts.

- **No secrets in source or history.** The only `rzp_test_…` strings are obviously fake
  fixtures in tests. No `rzp_live_`, PEM block, service-account JSON, Descope management
  key or JWT appears in any tracked file or in `git log -S`.
- **Where each value lives** (names only):

  | Variable | Kind | Home |
  | -------- | ---- | ---- |
  | `VITE_FIREBASE_*` (6), `VITE_DESCOPE_PROJECT_ID`, `VITE_PUBLIC_SUPPORT_EMAIL`, `VITE_PUBLIC_OPERATOR_NAME` | public, build time | `.env.local` (gitignored by `*.local`); template `.env.example` |
  | `DESCOPE_PROJECT_ID`, `RAZORPAY_KEY_ID` | public identifiers, deploy-time params | `functions/.env.zesto-dev-2026` (gitignored by `functions/.env.*`); template `functions/.env.example` |
  | `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PICKUP_CREDENTIAL_SECRET` | secrets | Cloud Secret Manager via `defineSecret`, bound to `api` (and `RAZORPAY_KEY_SECRET` also to `onRefundCreated` / `reconcileRefunds`); `functions/.secret.local` (gitignored) for the emulator |

  `RAZORPAY_WEBHOOK_SECRET` is deliberately distinct from the key secret (a leak of one does
  not compromise both directions); the pickup secret is a third, unrelated value.
- **Test vs Live Mode.** The deploy-time `RAZORPAY_KEY_ID` for `zesto-dev-2026` carries the
  `rzp_test_` prefix: production is currently wired to Razorpay **Test Mode**. The code has
  no concept of mode beyond the credentials supplied. This checkpoint adds
  `razorpayModeOf()` and a single `razorpay client initialised {mode}` log line at first use
  (mode only — a public prefix, never a key), so an operator can confirm from the logs which
  environment a deployment talks to. Going Live is a coordinated change of three things —
  `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (plus a Live Mode webhook
  in the Dashboard) — and must be its own checkpoint.
- **Local/emulator cannot reach production by accident.**
  - Frontend: `src/lib/firebase.ts` connects emulators when `import.meta.env.DEV`; the
    production bundle contains no emulator host (verified: no `127.0.0.1:<port>` in `dist/`).
    The Firebase client SDK is initialised but unused for data (all access goes through
    `/api`); Firebase Auth is not initialised.
  - Functions: `getAdminFirestore()` refuses to run in the Functions emulator without
    `FIRESTORE_EMULATOR_HOST`.
  - Tests use `demo-*` project IDs only.
  - Scripts: `seed-org-orders.mjs` is emulator-only (loopback `FIRESTORE_EMULATOR_HOST`
    mandatory); `backfill-refund-notifications.mjs` is dry-run by default, excludes the
    two protected orders, and refuses real writes without an explicit flag.
- **API URL.** The frontend calls the relative `/api`; production resolves it through the
  Hosting rewrite `/api/**` → function `api` in `asia-south1`; local dev proxies it to the
  Functions emulator (`vite.config.ts`). There is no hard-coded production URL in the client.
- **CORS is intentionally absent.** The API is same-origin through Hosting and authenticated
  by a `Authorization: Bearer` header, never cookies (so there is no CSRF surface). The
  function's own `*.run.app` URL is publicly invokable (an `onRequest` requirement) but, with no
  CORS headers, browsers cannot call it cross-origin.
- **No debug/test flags in production code.** No `console.*`, `debugger`, or `DEV`/`MODE`
  branches in non-test frontend code other than the emulator switch above.
- **Observation:** `vite build` bakes in whatever `.env.local` holds on the deploying machine.
  Deploy only from a machine whose `.env.local` is the production one (runbook preflight).

## 2. Firebase deployment readiness

- **Rules.** `firestore.rules`: every collection (`users` and subcollections, `organizations`
  and everything below it including `payments`/`refunds`, `razorpayWebhookEvents`,
  `notificationEvents`, slugs) is `allow read, write: if false`, with a final
  `match /{document=**}` deny. Rules never trust `request.auth` (Descope is the only
  identity provider). `storage.rules` denies everything. The Admin SDK bypasses rules, which
  is the only access path.
- **Indexes.** Every query in `functions/src` was mapped to `firestore.indexes.json`:

  | Query (file) | Index |
  | ------------ | ----- |
  | menus by `status`+`menuDate`≥, order `menuDate`,`createdAt` — group (`explore.ts:345`) | `menus` COLLECTION_GROUP ✓ |
  | same, one outlet's collection (`explore.ts:439`) | `menus` COLLECTION `status,menuDate,createdAt` — **added** |
  | items `enabled`==, order `displayOrder`,`createdAt` | ✓ |
  | orders by `userId` / `organizationId` / `+outletId` / `+status in`, `createdAt` desc | 4 ✓ (history, org list, pickup lookup) |
  | members by `userId`,`status`, `createdAt` | ✓ |
  | notifications `scope` [+`readAt`==null], `createdAt` desc, `__name__` desc | 2 ✓ (the implicit `__name__` follows the last field's direction) |
  | refunds `status in`, `nextAttemptAt` ≤ (reconciler) | ✓ (the one the 7.9 audit found misplaced in a comment block) |
  | `id`== on `orders` / `outlets`; `providerOrderId` / `providerPaymentId` on `payments`; `providerRefundId` on `refunds` (collection group) | 5 field overrides ✓ |
  | single-field equality (`members.status`, `refunds.providerRefundId` under one payment, backfill `type`+`status` ordered by `__name__`) | automatic single-field indexes |

  `firestoreIndexes.test.ts` strips the file's comments exactly as the CLI does, then pins all
  13 composites and 5 overrides, so a regression like the misplaced refund index cannot recur
  silently. The index set is additive; deploying it never needs `--force`.
- **Functions.** Four exports, all `asia-south1`, Node 24: `api` (HTTPS; secrets bound),
  `onNotificationEventCreated` (Firestore create trigger, `retry: true`, no secrets),
  `onRefundCreated` (Firestore create trigger on `…/payments/{id}/refunds/{id}`, `retry: true`,
  `RAZORPAY_KEY_SECRET`), `reconcileRefunds` (`every 15 minutes`, `maxInstances: 1`,
  timeout 540 s, `RAZORPAY_KEY_SECRET`). `index.registration.test.ts` fails if a route module is
  written but not registered, if a trigger/schedule export or its secrets binding is dropped,
  or if requests bypass the rate-limited route list. There is exactly one `onRequest` (the
  webhook shares `api`).
  - Global `maxInstances: 10` caps cost under attack; no `minInstances` (cold starts at an
    ordering-deadline rush — consider `minInstances: 1` on `api` once traffic justifies the cost).
  - Deploying `reconcileRefunds` requires the **Cloud Scheduler API** to be enabled; the first
    Firestore-trigger deploy can fail once with an Eventarc service-agent propagation error
    (known from checkpoint 6: wait ~4 minutes, redeploy that function only).
- **Hosting.** `public: dist`, `/api/**` rewrite to `api`, SPA fallback last, `no-cache` on the
  shell, immutable caching on `/assets/**`, `private, no-store` on `/api/**`. Security headers
  added (below). `hostingConfig.test.ts` pins this.

### Hosting headers and CSP

Added to every page: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(self), microphone=(), geolocation=()` (the camera stays available to
the app itself for the pickup QR scanner).

**Update (4.6):** a `Content-Security-Policy-Report-Only` header is now served on every page (see
[CSP status](#csp-status-checkpoint-46) below). It was originally recommended as follows: the page legitimately loads Razorpay Checkout
(script from `checkout.razorpay.com`, frames/connect to `api.razorpay.com` and
`lumberjack.razorpay.com`) and Descope's flow (`api.descope.com`, `static.descope.com`), plus
Ionic/Tailwind inline styles. A wrong enforced CSP would break payment or sign-in, and neither
can be exercised without the live services — so it belongs to the production E2E checkpoint,
where Report-Only violations can be collected and then enforced.

## 3. Razorpay

Audited by reading the integration (no network call, no Dashboard change):

| Concern | Finding |
| ------- | ------- |
| Checkout signature | HMAC-SHA256 of `{trusted server-stored order id}\|{payment id}` with the key secret, constant-time compare; the order ID is Zesto's own, never client-supplied. |
| Webhook signature | HMAC-SHA256 of the **raw** request bytes with the *separate* webhook secret, constant-time compare, checked before any parsing or Firestore access; missing/invalid → 401 with nothing recorded; missing secret → 500, never "invalid signature". |
| Webhook idempotency | `razorpayWebhookEvents/{evt_<event-id>}` (fallback: body SHA-256) with a 60 s lease; "processed" only *after* the transition; the same event id with a different body → 409 `event_id_conflict`; duplicates → 200 `duplicate`. |
| Webhook outcomes | 200 for processed/duplicate/ignored-by-design (no retry can fix them); 409/500 only for retryable cases so Razorpay redelivers; anomalies (amount/currency/provider mismatch, ambiguous match) acknowledged **and** logged at `error`. |
| Client authority | The browser never sets payment or order state: `payment/verify` re-derives the signature server-side; amounts come from the stored order; webhook cannot change totals, items, customer, menu or outlet. |
| Refund idempotency | Deterministic refund IDs (`{orderId}-r{seq}`) → deterministic `X-Refund-Idempotency` key; `create` semantics; a retry is a *new* document and key; concurrent retries serialize on the payment (the second is a 409). |
| Timeouts | Refund calls: explicit 10 s default (30 s cap) via `AbortSignal`, no automatic retry. **Order create/fetch: previously unbounded (SDK) — now 15 s.** |
| Ambiguous results | A refund timeout/network error/unreadable body/5xx is `ProviderOutcomeUnknownError` or retryable: never turned into `failed`; the next attempt *looks up first* (provider refund ID, then Zesto ID in receipt/notes — never amount alone) and flags rather than guesses. After 8 inconclusive attempts the refund is flagged `attentionRequired`, still not `failed`. |
| Reconciliation | `reconcileRefunds` (15 min, bounded 25, lease-safe, validated paths); `pending` refunds re-checked every 6 h as a backup to the webhook; a refund trigger that never fired is recovered by the +5 min safety net. |
| Failed webhook delivery | Razorpay redelivers non-2xx responses for a bounded period; every handler is idempotent. |
| Logging | Provider errors log `statusCode`/`code`/`description` only; the webhook body, signature, secrets and `Authorization` header are never logged. |

**Gap (Medium) — payments were not reconciled; closed in 4.6 (undeployed).** See
[payment-reconciliation.md](./payment-reconciliation.md). Original finding: if a payment is captured but both the
browser's `payment/verify` call and every webhook delivery fail (e.g. a long outage that
outlasts Razorpay's redelivery window), the order stays `pending_payment` and nothing polls
Razorpay for it. Recommended follow-up (not built here — it adds a second scheduled job that
calls the provider): a bounded sweep of `pending_payment` orders older than N minutes that
fetches the provider order's payments and routes any captured one through the existing
`markPaymentSucceeded`. Until then, the runbook's *post-outage payment check* (compare the
Razorpay Dashboard's captured payments with Zesto's `pending_payment` orders) covers it.

### CSP status (Checkpoint 4.6)

`firebase.json` now sends, on every page, `Content-Security-Policy-Report-Only` (it **enforces nothing**; a test asserts
there is no enforcing `Content-Security-Policy`). Built from what the shipped bundle actually references:

| Directive | Allows | Why |
| --------- | ------ | --- |
| `script-src` | `self`; `checkout.razorpay.com`; Descope (`static.descope.com`, `static2.descope.com`, `descopecdn.com`, `cdn.jsdelivr.net` fallback); `fpnpmcdn.net` (Descope fingerprint loader); `accounts.google.com` (Google sign-in, if the flow uses it) | The built `index.html` has **no inline script** and the bundle uses no WebAssembly, so no `unsafe-inline` / `unsafe-eval` |
| `connect-src` | `self` (the `/api` rewrite), `*.descope.com` (the API host is regional), Descope CDNs, `api.razorpay.com`, `lumberjack.razorpay.com`, `checkout.razorpay.com`, `accounts.google.com` | Sign-in and Checkout network calls |
| `frame-src` | `api.razorpay.com`, `checkout.razorpay.com`, `accounts.google.com` | Checkout renders in an iframe |
| `style-src` | `self`, `unsafe-inline`, Google Fonts | Ionic / Tailwind / web-component inline styles |
| `img-src`, `font-src` | `self`, `data:`, `blob:`, `cdn.razorpay.com`, Descope hosts, Google Fonts | Checkout and Descope assets; the pickup QR is inline SVG (no image source needed) |
| `object-src 'none'`, `base-uri 'self'`, `worker-src`, `media-src`, `manifest-src` | tight | no plugins, no `<base>` injection |
| **Deliberately absent** | `form-action` (Checkout redirects to banks), `frame-ancestors` (ignored in Report-Only; `X-Frame-Options: DENY` covers it), any Firebase data endpoint (the frontend uses none — see below), `report-uri` (see below) | |

**First measurement (4.6, local).** The built app was served by a throwaway local server that applies `firebase.json`'s
headers (the Firebase Hosting emulator does **not** apply custom headers at all — neither the existing security headers
nor this one — so the served header can only be confirmed after a real deploy; runbook smoke check 4). Loading `/login`
(no sign-in, nothing submitted) produced exactly one report: *"Evaluating a string as JavaScript violates … 'unsafe-eval'"*.
The app's own bundle contains no `eval`/`new Function`; **`@descope/web-components-ui@3.20.4`, which the Descope SDK injects
from `descopecdn.com`, contains one `new Function(`** — the likely source. Its allowed origin was loaded without any
other violation. **Consequence:** enforcing this policy as written might degrade the Descope sign-in UI; whether it
actually does cannot be known without a real sign-in. Do **not** add `'unsafe-eval'` pre-emptively (it weakens
`script-src` for the whole app); test an enforced policy on staging first, and add it only if sign-in breaks and
Descope offers no alternative. Razorpay Checkout has not been exercised, so its origins are unverified.

**Not enforced, and not fully measured.** There is deliberately **no report endpoint**: it would be a new unauthenticated write
surface. Violations show in the browser console as `[Report Only] Refused to …`. **Next step:** run the
[production E2E plan](./production-e2e-plan.md) (sign-in, order, Razorpay Checkout, pickup) with DevTools open, add any
legitimately blocked origin, and only then rename the header to `Content-Security-Policy`.

### Firestore access architecture

The rules are `allow read, write: if false` for **every** path (plus a final catch-all deny). Verified as intentional
and correct:

```
Frontend ──HTTPS /api/** (Hosting rewrite)──▶ Cloud Function `api`: verify Descope session, authorize, validate
                                              ──Admin SDK (bypasses rules)──▶ Firestore
```

- No application source imports Firestore, Storage, Functions or Auth from the Firebase SDK. `src/lib/firebase.ts`
  initialises the SDK but **nothing imports it** (dead code, left in place: removing it is unrelated to this
  checkpoint); the built bundle contains no Firebase data endpoint.
- The only network client for Zesto's own data is `src/lib/api/client.ts` (`/api/*`). Every feature (menus, orders,
  payments, notifications, organization tools) uses it.
- `src/lib/noDirectFirebaseAccess.test.ts` pins all of this, so adding a direct client read fails a test instead of
  quietly requiring a rules change. **No production feature depends on direct Firestore access: no blocker.** The
  rules were not modified.
- `storage.rules` is likewise `if false`; Storage is not used by the frontend.

## 4. Descope and sessions

- Descope is the sole provider. `firebase/auth` is not imported anywhere; `firebase.ts` says so
  and initialises Firestore/Functions/Storage only. The Functions code never calls Firebase
  Auth.
- Every protected route calls `authenticateRequest` → `verifyDescopeSession`: signature against
  Descope's published keys, expiry, issuer and **audience** (backend `DESCOPE_PROJECT_ID`, re-checked
  in code in case the SDK skips an empty audience). Identity comes only from the verified `sub`.
- Failure semantics: rejected token → 401 `unauthenticated`; inability to validate (key fetch
  failure) → 503, which the frontend must not treat as sign-out. Both are covered by
  `session.test.ts`.
- Organization role checks are server-side (`requireOrganizationRole`: active membership document
  keyed by the *verified* user, allowed role) on every organization route; customer ownership by
  `getOwnedOrder` (stored `userId` vs session) with a plain 404 for others' orders.
- Response hygiene: customer order responses never include `userId`; organization order rows carry
  no customer identity and no payment/provider IDs; refund summaries expose status, amount,
  currency and times only; the payment response (customer-only) carries the provider order id and
  public `key_id` that Checkout requires. Org-facing cancellation info is a role, never an identity.

## 5. Tenant isolation and the refund retry route

Isolation rests on three layers: Firestore rules deny all client access; every route derives the
caller from the verified session; every organization route requires an active membership in the
organization named by the path, and every order lookup is checked against that organization.

`POST /organizations/{organizationId}/orders/{orderId}/retry-refund`:

| Attack | Result | Evidence |
| ------ | ------ | -------- |
| Retry another organization's refund (own org id + foreign order id) | 404, indistinguishable from "no such order"; nothing created | existing emulator test |
| Retry another organization's refund (foreign org id + foreign order id) | 403 (no active membership there); nothing created | **new emulator test** |
| Retry an arbitrary refund / order | The order must be `cancelled`; the *latest* refund must be `failed`, non-external; otherwise 409 | existing tests |
| Choose an amount | The route reads no body; the amount is the whole remaining refundable amount computed inside the transaction from the stored payment | existing test ("nothing the caller sends is read") |
| Staff / unauthenticated | 403 / 401 | existing tests |
| Double click / race | Exactly one new refund; the repeat is a 409 | existing tests (incl. two simultaneous requests) |
| Malformed IDs (`a/b`, `..`, `__x__`, `%2e%2e`) | `isValidDocumentId` rejects before any lookup (400) | **new emulator test** |
| Privilege escalation via membership | Membership documents are written only by backend code; rules deny clients | rules + design |

Outlet isolation: membership is organization-wide (finding 8), so an owner/manager/staff member can
act on any outlet of their *own* organization — never another organization's. Pickup redemption
accepts an optional `outletId` that can only *narrow* a counter, never widen it.

Notification privacy: inbox documents live at `users/{userId}/notifications/…` and are only
reachable through the API with the verified session's own ID; organization notifications are
scoped `org:<organizationId>` and gated by membership. Outbox events hold coordinates only — no
PII, payment fields, credentials or item snapshots.

## 6. Error handling and observability

- Unhandled exceptions: `handleRequest` converts any throw into a generic `500 internal` (detail
  never reaches the response) and `logUnhandledError` logs `{requestId, route, error}`.
- Request log: one `api request` line per call with a **closed** field set (requestId, route, method,
  status, duration, Descope user id, route-curated safe context). No header, body, token, phone or
  email can be logged through it. Route paths contain document IDs, never credentials (the pickup
  credential travels in the POST body).
- No sensitive values found in any `logger.*` call in `functions/src`.
- Misleading outcomes: nothing reports success on failure (`createOrder`/`retry` return errors,
  refunds distinguish `failed` from "outcome unknown"); a payment-provider failure surfaces as a
  retryable error; refund retry failures say what is wrong (409 text) rather than "failed".
- Residual: a raw `Error` is passed to Cloud Logging by `logUnhandledError`. Firestore errors can
  include document paths (IDs, not secrets); `PaymentProviderError.cause` holds the SDK's
  normalised error (status/code/description). Neither carries credentials; keep it that way
  when adding new error types.

### Recommended alerts (Cloud Monitoring, log-based) — not configured

Create these before taking real traffic (all `resource.type="cloud_run_revision"` or `cloud_function`
in `asia-south1`; thresholds are starting points):

| Alert | Filter / metric | Why |
| ----- | --------------- | --- |
| Unhandled API error | `jsonPayload.message="unhandled api error"` ≥ 1 / 5 min | Any 500 path |
| Webhook anomaly | `jsonPayload.message="razorpay webhook reconciliation anomaly"` ≥ 1 | Zesto/Razorpay records disagree — needs a human |
| Refund needs attention | `jsonPayload.message:"A refund needs attention"` ≥ 1 | Customer money not returned |
| Refund credentials rejected | `jsonPayload.message="The refund provider's credentials are missing or were rejected."` ≥ 1 | Operator problem; refunds are stalled |
| Notification permanently failed | `jsonPayload.message="Notification event failed permanently."` ≥ 1 | Dropped customer notification |
| Webhook signature failures | `jsonPayload.context.outcome="invalid_signature"` ≥ 10 / 10 min | Misconfigured secret, or probing |
| Rate limiting active | `jsonPayload.context.outcome="rate_limited"` ≥ 20 / 10 min | Abuse or a client bug |
| Refund sweep not running | absence of `Refund reconciliation finished.` for 45 min | Scheduler/job broken |
| API 5xx / latency | Cloud Run request count by `5xx`, p95 latency | General health |
| Instances at cap | `api` instance count = 10 | Capacity or attack |
| Budget | Billing budget alerts | Cost-denial attacks |

Also: an uptime check on `GET /api/explore/outlets` (public, cheap), and Error Reporting is
automatic for the function logs.

## 7. Rate limiting and abuse

Realistic risks and what exists:

| Endpoint | Risk | Control |
| -------- | ---- | ------- |
| Sign-in (Descope) | OTP/SMS abuse | Owned by Descope (their flow rate limits and bot protection). **Verify** the Descope project's OTP/SMS throttling and fraud settings in its console before launch — not visible from this repo. |
| `GET /me` | Profile bootstrap spam | Authenticated; one small write at most |
| `POST /orders` | Floods of `pending_payment` orders; Razorpay budget exhaustion via payment preparation | 20/min/user; idempotency keys; auth required |
| `POST …/payment`, `…/payment/verify` | Repeated provider order creation | 20/min/user; one provider order per payment (re-used) |
| `POST /orders/{id}/cancel` | Spamming refunds | 10/min/user; cancellation is idempotent and refunds are deterministic |
| `POST …/retry-refund` | Repeated provider calls | 20/min/user; owner/manager only; 409 unless latest refund `failed` |
| `POST …/pickups` | Backup-code guessing; read amplification | org member only; 120/min/user |
| Notification reads | Polling loops | 120/min/user (poll is 30 s) |
| `POST /organizations` | Org spam | 10/hour/user |
| `POST /webhooks/razorpay` | Unauthenticated flood | HMAC checked before any Firestore access; not limited by design; global `maxInstances: 10` bounds cost |
| Public `GET /explore/*` | Scraping/read cost | Cheap, cacheable in future; bounded by `maxInstances`; consider Cloud Armor/CDN caching later |

Implemented: `functions/src/http/rateLimit.ts` — see
[http-api.md](../architecture/http-api.md#rate-limiting). It is explicitly best-effort and
per-instance. **Not done, on purpose:** IP-based limits (campus NAT), a shared-state global limiter,
CAPTCHAs, and per-user caps on open `pending_payment` orders (a product decision).

## 8. Changes made in this checkpoint

| File | Why |
| ---- | --- |
| `functions/src/http/rateLimit.ts` (+ `.test.ts`) | Per-user best-effort rate limiter and policy table |
| `functions/src/index.ts`, `index.registration.test.ts` | Dispatch through the limited route list; test that it cannot be bypassed |
| `functions/src/providers/razorpay.ts` (+ test) | 15 s timeout on order create/fetch; `razorpayModeOf` + mode log line |
| `firestore.indexes.json`, `functions/src/firestoreIndexes.test.ts` | Missing collection-scope `menus` composite |
| `firebase.json`, `functions/src/hostingConfig.test.ts` | Baseline security headers; pin rewrites/caching |
| `functions/src/routes/organizationOrderRefundRetry.emulator.test.ts` | Cross-organization and malformed-ID cases for the refund retry route |
| `docs/architecture/http-api.md` | `429` and the Rate limiting section |
| `docs/operations/*` | This audit, the runbook, the E2E plan, the store-readiness list |
