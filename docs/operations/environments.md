# Environments: current state and the staging plan (Checkpoints 4.6–4.7)

Status (updated in 4.7): **audit + plan + deployment guard. No Firebase, Descope or Razorpay resource was created or changed.**
A real staging environment does **not** exist (re-assessed in 4.7: see §3). This document says exactly what it needs.
What 4.7 *did* change is the repository: a deploy can no longer reach production by accident (§1, "Deployment guard").

Read-only tooling added: `npm run check:env -- --env <production|staging>` ([`scripts/check-environment.mjs`](../../scripts/check-environment.mjs))
states which environment the local config describes and refuses unsafe combinations. It prints only variable
names, payment-mode words and shortened public ids.

## 1. What exists today (from the repository)

| Area | Today | Evidence |
| ---- | ----- | -------- |
| Firebase projects | **One real project, `zesto-dev-2026`**, the `default` in `.firebaserc` — and it is production. Tests use `demo-*` projects that cannot reach Google | `.firebaserc`; `test:*` scripts use `demo-zesto-functions-test`, `demo-zesto-rules`, `demo-zesto-trigger` |
| Descope | **One project**, used by development and production. Frontend `VITE_DESCOPE_PROJECT_ID` (build time) and backend `DESCOPE_PROJECT_ID` (token audience) hold the same id — `check:env` verifies they match | `.env.local`, `functions/.env.zesto-dev-2026`, `functions/.env.local` (names inspected; ids not printed) |
| Razorpay | **One Test Mode account**; production's `RAZORPAY_KEY_ID` is `rzp_test_…`. Per checkpoint 7.5's notes, local development and the sandbox test used the same Test key pair, so **dev and production share one Razorpay Test namespace**. Live Mode is not configured anywhere | `functions/.env.zesto-dev-2026`; `check:env` reports `razorpayMode test` |
| Hosting | One site, `https://zesto-dev-2026.web.app`; no custom domain, no preview channels configured | `firebase.json` has a single `hosting` target |
| Functions | `api`, `onNotificationEventCreated` deployed; `onRefundCreated`, `reconcileRefunds`, **`reconcilePayments`** written, not deployed. Region `asia-south1`, Node 24 | `index.ts`; [deployment-runbook.md](./deployment-runbook.md) |
| Firestore | One default database in `zesto-dev-2026` holding production data, test data and the two protected orders together | — |
| Scheduler | None deployed. Two jobs will exist (`reconcileRefunds`, `reconcilePayments`), one per scheduled export | `index.ts` |
| Eventarc | Two Firestore triggers (`notificationEvents`, refunds), one deployed | runbook step 4 |
| Secrets | `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PICKUP_CREDENTIAL_SECRET` in the project's Secret Manager (`defineSecret`); locally `functions/.secret.local` (gitignored) | `providers/razorpay.ts`, `pickupCredential.ts`, `index.ts` |
| Env variables | Backend: `functions/.env.<projectId>` is loaded by the Firebase CLI for **that project only**; `functions/.env.local` only by the emulator. Frontend: Vite reads `.env.local` | `functions/.env.example`, `.env.example` |
| Build-time config | `vite build` bakes `VITE_*` from `.env.local` into `dist/`. There is no `--mode`-specific file today, so whichever machine builds decides which environment the bundle points at | `vite.config.ts`, `dist/` |
| Webhook endpoint | One Razorpay Test webhook → `https://zesto-dev-2026.web.app/api/webhooks/razorpay` | runbook step 8 |
| CI | No GitHub Actions workflows exist in the repository | no `.github/` |

### Local-safety audit

| Question | Finding |
| -------- | ------- |
| Can the emulators point at production? | **No, by construction.** (1) Every test script uses a `demo-*` project id: demo projects cannot contact Google. (2) `getAdminFirestore()` throws if the Functions emulator runs without `FIRESTORE_EMULATOR_HOST` — the one path that would silently use real Firestore. (3) The trigger test runs behind a network guard that refuses non-loopback connections and fails the run if anything but CLI telemetry was blocked |
| Can a script write to production by accident? | `seed-org-orders.mjs` refuses unless `FIRESTORE_EMULATOR_HOST` is loopback. `backfill-refund-notifications.mjs` is a dry run by default and needs `--project`, `--execute` **and** `--i-understand-this-writes-to-production`. `check-environment.mjs` is read-only |
| **Foot-gun (fixed in 4.7)** | `.firebaserc`'s `default` is production **and** the Firebase CLI remembers `zesto-dev-2026` as this directory's *active project* (`~/.config/configstore/firebase-tools.json`), so a bare `firebase deploy` used to deploy to production. Now every deployable target in `firebase.json` runs `scripts/deploy-guard.mjs --predeploy` first and aborts unless `npm run deploy:<env>` approved that exact project. See [the runbook](./deployment-runbook.md#safe-deployment-commands-checkpoint-47) |
| Are production secrets in local test files? | No. Searched tracked files and the committed diff for key-shaped strings: only obviously fake literals in tests. `.env*.local`, `functions/.env.*` and `functions/.secret.local` are gitignored. Test suites stub their own secrets (`vi.stubEnv`) |
| Can staging credentials point at production? | Today nothing is staging. `check:env --env staging` is the guard that will refuse: staging sharing production's Firebase project, Descope project or Razorpay key, a staging bundle built for the production project, any Live key in staging |
| Does the dev server proxy hit production? | `vite.config.ts` proxies `/api` to **`127.0.0.1:5001`** (the local Functions emulator) using the project id from `.env.local`; it never targets the hosted API |
| Is Live Mode reachable by accident? | `check:env --env production` fails on a `rzp_live_` key unless `--allow-live` is passed. The server logs the mode (`razorpay client initialised`) at first use |

## 2. Target model

```
 Development  ──▶  Staging  ──▶  Production
 emulators        real, Test      real; Test until the Live-Mode
 + demo-* ids     Mode, own       checkpoint, then Live
                  everything
```

| Dimension | Development | Staging | Production |
| --------- | ----------- | ------- | ---------- |
| Firebase project | none (emulators, `demo-*` ids) | `zesto-staging-<suffix>` — its own project | `zesto-dev-2026` (name is legacy; do not rename) |
| Firestore data | emulator, disposable | own database; **never** a copy of production customer data | own database |
| Descope project | a development project, or the staging one for manual tests | **its own project** (own users, own sessions, own allowed domains) | its own project |
| Hosting / domain | `localhost` | `<staging-project>.web.app` (or `staging.<domain>`) | `zesto-dev-2026.web.app` (later the custom domain) |
| Functions / Scheduler / Eventarc | emulated | own deployments of every function and its own Scheduler jobs and Eventarc triggers | own |
| Razorpay | Test Mode keys, local secrets only | Test Mode — **its own API key pair and its own webhook** (URL = staging, own webhook secret) | Test now; **Live keys + a Live webhook** at the Live-Mode checkpoint, never reused anywhere else |
| Secrets | `functions/.secret.local` | staging Secret Manager: `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PICKUP_CREDENTIAL_SECRET` (a **different** value from production's) | production Secret Manager |
| Functions params | `functions/.env.local` | `functions/.env.<staging-project>` | `functions/.env.zesto-dev-2026` |
| Frontend config | `.env.local` | `.env.staging.local`, built with `vite build --mode staging` | `.env.production.local` (legacy `.env.local` still accepted), `vite build` |
| Webhook endpoint | none | `https://<staging-host>/api/webhooks/razorpay` | `https://<prod-host>/api/webhooks/razorpay` |

**Invariants.** Production and staging never share a Firebase project, Firestore database, Descope project, Razorpay
key pair, webhook secret, pickup-credential secret or Hosting site. Staging never holds a Live key. A bundle is
built for exactly one environment and is never copied between them. `check:env` enforces what a script can.

## 3. Should a staging project be created now? — No

| Factor | Assessment |
| ------ | ---------- |
| Effort | Small once started (~half a day), but **every step needs a console or interactive action** that cannot be completed safely from here (below) |
| Firebase limits | A new project counts against the account's project quota (typically 10 by default; check the console). Staging needs the **Blaze** plan: Functions v2, Secret Manager, Cloud Scheduler and Eventarc require billing |
| Cost | An idle staging project is close to free on Blaze (free tiers for Functions, Firestore, Hosting). Cloud Scheduler gives 3 free jobs per billing account; production's two plus staging's two exceed that — expect a few cents per month. Secret Manager charges per active secret version beyond a small free allowance. *These figures are from general knowledge of Google's pricing and were not re-verified here; confirm on the billing page* |
| Descope | A second Descope project must be created **in the Descope console**: sign-in flow copied from production, allowed/redirect domains, then its project id |
| Razorpay | Needs a second Test API key pair and a second webhook with its own secret, **in the Razorpay Dashboard**. Changing the Dashboard was explicitly out of scope for this checkpoint |
| Operational value | **High, and a prerequisite for Live Mode**: today every experiment (a new function revision, a webhook change, an index) lands on the only environment that has real users, and dev/prod share one Razorpay Test namespace |

It was **not created**: project creation with billing, the Descope project and the Razorpay key/webhook are console-only
steps, and doing a partial job would give a false sense of separation. Everything it needs follows.

## 4. Staging setup — exact steps (do not run without an explicit instruction)

Replace `STG` with the staging project id, e.g. `zesto-staging-2026`.

**A. Accounts (consoles, by a human)**

1. Firebase console → *Add project* `STG`; link the billing account (**Blaze**).
2. Descope console → *Create project* "Zesto Staging"; recreate the sign-in flow; add the staging Hosting origin as an allowed domain; note its project id (`P2…`).
3. Razorpay Dashboard (**Test Mode**) → generate a **new** API key pair (key id + secret); *Webhooks → add*
   `https://STG.web.app/api/webhooks/razorpay`, a **new** webhook secret, events `payment.captured`, `payment.failed`,
   `refund.created`, `refund.processed`, `refund.failed` (**not** `order.paid`).

**B. Project resources (CLI, after A)**

```bash
firebase use --add            # alias it "staging" -> STG  (then .firebaserc has a "staging" alias; `deploy:staging` reads it)
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com \
  eventarc.googleapis.com firestore.googleapis.com --project STG
firebase firestore:databases:create "(default)" --location asia-south1 --project STG    # same region as Functions
firebase functions:secrets:set RAZORPAY_KEY_SECRET     --project STG   # paste at the prompt only
firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET --project STG
firebase functions:secrets:set PICKUP_CREDENTIAL_SECRET --project STG  # a NEW random value, >= 32 chars
```

**C. Local config files (gitignored; values never committed)**

```text
functions/.env.STG        DESCOPE_PROJECT_ID=<staging Descope id>
                          RAZORPAY_KEY_ID=rzp_test_<staging key id>
.env.staging.local        VITE_FIREBASE_API_KEY / _AUTH_DOMAIN / _PROJECT_ID=STG / _STORAGE_BUCKET /
                          _MESSAGING_SENDER_ID / _APP_ID   (from the STG web app)
                          VITE_DESCOPE_PROJECT_ID=<staging Descope id>
                          VITE_PUBLIC_SUPPORT_EMAIL, VITE_PUBLIC_OPERATOR_NAME
```

**D. Gate, then deploy in the runbook's order (`--project staging` on every command)**

```bash
npm run check:env -- --env staging     # must print OK; fails on any shared id/key or a Live key
# `npm run deploy:staging -- --only hosting` builds with `--mode staging` itself and refuses a bundle that names production
npm run deploy:staging -- --only firestore:indexes     # then wait for READY, then rules, functions, hosting
```

**E. After staging works**

1. Point `.firebaserc`'s `default` at `staging` (read-only commands then default to the safe side; deploys are already guarded).
2. Run the [production E2E plan](./production-e2e-plan.md) against staging first.
3. Add a GitHub Actions workflow with two **environments** (`staging`, `production`), each with its own
   secrets, `production` requiring a reviewer, and `npm run check:env` as the first step of each deploy job.

### How a deploy distinguishes the environments

| Mechanism | Staging | Production |
| --------- | ------- | ---------- |
| Firebase CLI target | `--project staging` | `--project production` |
| Backend config | `functions/.env.<STG>` (loaded only for that project) | `functions/.env.zesto-dev-2026` |
| Secrets | STG Secret Manager | production Secret Manager |
| Frontend bundle | `vite build --mode staging` ← `.env.staging.local` | `vite build` ← `.env.production.local` |
| Pre-deploy gate | `npm run check:env -- --env staging` | `npm run check:env -- --env production` |

## 5. Production and Live Mode (not part of this checkpoint)

Live Mode is a later, separate step. Before it: staging exists and has passed the E2E plan; Live keys and a
**separate Live webhook** (own secret) are created in the Dashboard; production's `functions/.env.zesto-dev-2026`
gets the `rzp_live_` key id and the secrets are replaced in Secret Manager; `check:env --env production --allow-live`
is the only command that will accept it.

## 6. Checkpoint 4.7 findings

**Staging was not created.** Re-checked with the CLI: the logged-in Google account sees eight Firebase projects, one of which is
`zesto-dev-2026`; there is no staging project. Creating one needs (a) a billing account linked for Blaze — console only,
(b) a second Descope project and (c) a second Razorpay Test key pair and webhook in the Dashboard. Two of the three cannot
be done with any tool available here, and a Firebase project without them would look like staging while still sharing
Descope users and Razorpay's account with production. Nothing was half-created.

**The shared Razorpay Test account cannot safely take a real Checkout payment.** Production's Test Mode webhook is
account-wide: any `payment.captured` / `payment.failed` for *any* order in the account is delivered to
`https://zesto-dev-2026.web.app/api/webhooks/razorpay`. That route, after verifying the signature, **writes a webhook-event
record to production Firestore** (`razorpayWebhooks.ts`, `tx.create`) even for an order Zesto has never heard of. So
capturing a disposable Test payment here would mutate production data. Real captured-payment validation therefore waits for
the staging key pair and webhook (§4). Order creation and the read-only order-payments lookup fire no subscribed event and
were exercised for real — see [payment-reconciliation.md](./payment-reconciliation.md#checkpoint-47-validation).

**`vite build --mode staging` inherits `.env.local`.** Vite loads `.env.local` in every mode and only *overrides* it with
`.env.staging.local`, so a `VITE_*` variable staging forgot to define would silently take the legacy (production) value.
`check:env --env staging` now fails when `.env.local` defines a `VITE_*` name that `.env.staging.local` does not.
When staging exists, also rename `.env.local` to `.env.production.local` (both are accepted today) to remove the overlap.

**Descope separation.** Staging users, sessions and allowed domains are separate only if staging has its own Descope project.
The backend verifies the session token's audience against `DESCOPE_PROJECT_ID`; with different projects a production token is
rejected by staging and vice versa. `check:env` fails if staging reuses production's Descope project id, Razorpay key id or
Firebase project, or holds a Live key. No production user or customer data is to be copied into staging; seed it with
`scripts/seed-org-orders.mjs`-style synthetic data against staging's own project.
