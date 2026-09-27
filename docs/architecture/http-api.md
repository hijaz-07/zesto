# HTTP API

Zesto's backend HTTP surface is one Cloud Function, `api`, fronting a small
internal router. There is no Express dependency — the router is plain
TypeScript, chosen so it stays easy to unit test (see
`functions/src/http/router.test.ts`) without an HTTP server.

## Architecture

```
functions/src/
  index.ts              exports `api` (onRequest, region asia-south1):
                         wraps every request in a requestId + timing +
                         logging + response-header layer, then calls
                         handleRequest().
  http/
    types.ts             NormalizedRequest, ApiResult, RouteDefinition
    router.ts            normalizePath(), matchRoute(), dispatch()
    handleRequest.ts      dispatch() + catch-all -> generic 500
    envelope.ts           ApiResult -> the response JSON body
    logger.ts             structured request logging
  routes/
    me.ts                GET /me
  domain/
    users.ts             users/{userId} profile: schema + get-or-create
  auth/
    session.ts           verifyDescopeSession / authenticateRequest
    membership.ts         organization role authorization (unrelated to /me)
  firebaseAdmin.ts        centralized Admin SDK app + Firestore accessor
```

Route handlers work against `NormalizedRequest` / `ApiResult` — plain data,
not Express `Request`/`Response` — so `router.ts`, `envelope.ts`, and each
route handler can be unit tested by calling a function and inspecting a
return value. `index.ts` is the only place that touches Express: it adapts
the real `Request` into a `NormalizedRequest`, and writes an `ApiResult`
back onto the real `Response`.

**Path normalization:** Firebase Hosting's `/api/**` rewrite (production)
forwards the original path, e.g. `/api/me`. The Vite dev proxy (local
development) strips the `/api` prefix before forwarding to the Functions
emulator, so the function sees `/me`. `router.ts`'s `normalizePath()` strips
a leading `/api` if present, so routes are registered once (e.g. `/me`) and
match either way.

## Authentication pipeline

Every route handler that needs the caller's identity calls
`authenticateRequest` (see `functions/src/auth/session.ts` and
[authentication.md](./authentication.md)), which validates the
`Authorization: Bearer <sessionJwt>` header server-side and returns a
`VerifiedSession { userId, claims }`. The identity used by a handler is
**always** `session.userId` — never a `userId` from the request's query,
body, or a header like `X-User-Id`. `GET /me` explicitly ignores all three;
see its tests in `functions/src/routes/me.test.ts` and
`functions/src/routes/me.emulator.test.ts`.

## Response envelope

Every response body has exactly one of two shapes:

```jsonc
// success
{ "data": { /* ... */ } }

// error
{ "error": { "code": "not_found", "message": "...", "requestId": "..." } }
```

`requestId` is generated once per request (`crypto.randomUUID()`) and
appears both in the error body and in the `X-Request-Id` response header on
every response (success or error), so a client-reported problem can be
matched to server logs.

Every response also gets `Cache-Control: private, no-store` — this API has
no cacheable, non-personal responses yet. A 401 response additionally gets
`WWW-Authenticate: Bearer`. A 405 response gets `Allow: <methods>`.

## Error semantics

| Status | `error.code`          | Meaning |
| ------ | --------------------- | ------- |
| 401    | `unauthenticated`      | Missing, malformed, expired, or wrong-audience session token. |
| 404    | `not_found`            | No route registered for the path. |
| 405    | `method_not_allowed`   | The path exists, but not for this method (`Allow` header lists what does). |
| 500    | `internal`             | An unhandled exception in a route handler (e.g. a malformed stored Firestore document). The client never sees the underlying detail. |
| 503    | `unavailable`          | An infrastructure failure while validating the session (see below) — **not** the caller's fault. |

### Descope 401 vs 503

This is the one distinction the frontend must get right, per
[authentication.md](./authentication.md): a `401` means the session was
genuinely rejected (act like signed out for this request); a `503` means the
backend could not check the session at all right now (Descope's signing
keys were unreachable, a network failure, etc.) — **the frontend must not
sign the user out because of a 503.**

The Descope Node SDK's `validateSession` collapses every failure — a
rejected token and an infrastructure failure — into one generic `Error`.
`functions/src/auth/session.ts` classifies it by matching the stringified
inner error against known jose/Descope token-rejection error names
(`JWTExpired`, `JWSSignatureVerificationFailed`, `JWTClaimValidationFailed`,
"failed to fetch matching key", etc. — see the comment above
`TOKEN_REJECTION_PATTERNS`). Anything that doesn't match — a network/DNS
failure or bad response fetching Descope's signing keys — is treated as a
503. This is a heuristic on error message text, because that's the only
signal the SDK exposes; `functions/src/auth/session.test.ts` documents and
tests both directions.

## Firestore Admin SDK access

All Firestore access goes through `functions/src/firebaseAdmin.ts`'s
`getAdminFirestore()` — the one place the Admin app/client is created. It
refuses to hand out a Firestore client if it detects it's running inside the
Functions emulator without the Firestore emulator also running (see
"Local emulator setup" below), so a forgotten `--only functions` can't
silently write to production Firestore.

`users/{userId}` is intentionally minimal for now (see the root
`CLAUDE.md` / product docs): `{ id, createdAt }` only.
`functions/src/domain/users.ts`'s `getOrCreateUserProfile`:

- reads and creates the document inside one Firestore transaction, so
  concurrent first calls for the same `userId` are serialized by Firestore's
  optimistic-concurrency retries — exactly one creates the document, the
  rest just read it back (`functions/src/routes/me.emulator.test.ts` proves
  this with 10 concurrent calls);
- never overwrites an existing `createdAt`;
- validates a stored document with a Zod schema before trusting it (the
  Admin SDK bypasses Firestore rules, so this is the only validation a
  stored document gets); a malformed document raises a plain `Error`, which
  `handleRequest` turns into a generic 500 without leaking the detail.

## Local emulator setup

`functions/package.json`'s `serve` script starts **both** the Functions and
Firestore emulators (`firebase emulators:start --only functions,firestore`)
— Functions alone would leave `getAdminFirestore()` pointed at nothing safe
to write to.

The frontend dev server proxies `/api/*` to the Functions emulator (see
`vite.config.ts`'s `server.proxy`, built from `VITE_FIREBASE_PROJECT_ID` and
the fixed `asia-south1` region), stripping the `/api` prefix before
forwarding. Local development therefore needs `VITE_FIREBASE_PROJECT_ID` set
in `.env.local` in addition to the Descope variables described in
[authentication.md](./authentication.md).

Tests that need a live Firestore emulator (`functions/src/**/*.emulator.test.ts`)
are excluded from the default `npm run test:run` (see root `vite.config.ts`)
and run separately via `npm run test:functions-emulator`, which wraps them
in `firebase emulators:exec --only firestore` — mirroring `test:rules` for
`firestore.rules`.

## Production Hosting rewrite

`firebase.json`'s Hosting config rewrites `/api/**` to the `api` function in
`asia-south1`, listed **before** the SPA catch-all rewrite (rewrite order
matters — the first match wins). `functions/package.json`'s `build` script
also runs as a Firebase `predeploy` hook (`firebase.json`'s
`functions.predeploy`), so `firebase deploy` always compiles fresh
`functions/lib` output rather than whatever was last built locally.
