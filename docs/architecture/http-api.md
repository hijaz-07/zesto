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
    organizations.ts     POST /organizations, GET /organizations
    outlets.ts           POST/GET /organizations/{organizationId}/outlets,
                         PATCH .../outlets/{outletId}
  domain/
    users.ts             users/{userId} profile: schema + get-or-create
    organizations.ts     organizations/*, organizationSlugs/*, and the
                         owner-membership write side of organizations/*/members
    outlets.ts           organizations/*/outlets/*, organizations/*/outletSlugs/*
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

**Path parameters:** a route's `path` may contain `:name` segments (e.g.
`/organizations/:organizationId/outlets`), each matching exactly one
non-empty path segment. `matchRoute()` captures them into
`RouteContext.params`, which a handler reads (e.g.
`ctx.params?.organizationId`) instead of parsing `request.path` itself. A
route with no `:name` segments (e.g. `/me`) behaves exactly as before —
`params` is just `{}`.

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
| 400    | `invalid_argument`    | The request body failed validation (e.g. `POST /organizations` with a bad `name`/`slug`). |
| 401    | `unauthenticated`      | Missing, malformed, expired, or wrong-audience session token. |
| 403    | `permission_denied`    | The caller is authenticated but is not an active organization member with an allowed role (e.g. `staff` calling `POST .../outlets`). |
| 404    | `not_found`            | No route registered for the path, or (e.g. `PATCH .../outlets/{outletId}`) the specific resource doesn't exist. |
| 405    | `method_not_allowed`   | The path exists, but not for this method (`Allow` header lists what does). |
| 409    | `already_exists`       | `POST /organizations` or `POST .../outlets` with a `slug` that is already taken. |
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

## Organizations

`POST /organizations` and `GET /organizations` (`functions/src/routes/organizations.ts`
+ `functions/src/domain/organizations.ts`) are the first organization/tenant
endpoints. See [domain-model.md](./domain-model.md#organization) for the
entity and `functions/src/auth/membership.ts` for the tenant-role
authorization future organization-scoped endpoints will build on.

### `POST /organizations`

Request body (validated with Zod; any other field, e.g. `ownerId`, `userId`,
`createdBy`, `role`, `status`, `id`, is ignored — never treated as authority):

```jsonc
{ "name": "Test Canteen", "slug": "test-canteen" }
```

- `name`: trimmed, 1-100 characters.
- `slug`: 3-50 characters, matching `^[a-z0-9]+(-[a-z0-9]+)*$` — lowercase
  letters, digits, and single hyphens only. The backend validates this
  strictly and never lowercases or otherwise slugifies the input itself.
  **The slug is immutable for this first implementation** — there is no
  slug-edit endpoint. A future slug-change feature will need its own atomic
  reservation migration (release the old `organizationSlugs/{oldSlug}` doc
  and create the new one in the same transaction that updates the
  organization), not an in-place field edit.

The authenticated caller (from the verified Descope session — never the
request body) always becomes the organization's `createdBy` and its sole
`owner`/`active` member. Success: `201` with

```jsonc
{
  "data": {
    "organization": { "id": "...", "name": "...", "slug": "...", "createdAt": "...", "createdBy": "..." },
    "membership": { "userId": "...", "organizationId": "...", "role": "owner", "status": "active", "createdAt": "..." }
  }
}
```

Errors: `400 invalid_argument` (bad `name`/`slug`), `401 unauthenticated`,
`409 already_exists` (slug already taken), `503 unavailable`.

The organization document, the `organizationSlugs/{slug}` uniqueness
reservation, and the owner membership are created in **one Firestore
transaction** (`createOrganization`): it pre-allocates the organization's
auto-ID, reads the slug reservation, and aborts with `already-exists` before
writing anything if the slug is taken — so a slug conflict never leaves a
partial organization behind.

### `GET /organizations`

Returns the organizations where the caller has an **active** membership —
never `invited`/`revoked` memberships, and never an organization the caller
has no membership in. `200` with

```jsonc
{ "data": { "organizations": [ { "id": "...", "name": "...", "slug": "...", "createdAt": "...", "createdBy": "...", "role": "owner" } ] } }
```

ordered by the caller's membership `createdAt` ascending; `[]` if the caller
belongs to no organization. Implemented as a **collection-group query** over
every `organizations/*/members` subcollection
(`.where('userId','==',uid).where('status','==','active').orderBy('createdAt','asc')`),
then a single batched `db.getAll(...)` of the matched organizations —
`members` stays the one source of truth for tenant access, rather than a
denormalized list that could drift. Requires the composite index in
`firestore.indexes.json` (`members`, `COLLECTION_GROUP`, `userId` +
`status` + `createdAt`). If an active membership ever points at a missing or
malformed organization document, the request fails with a generic `500`
(logged with its `requestId`, detail never returned to the client) rather
than silently omitting it.

## Outlets

`POST`, `GET`, and `PATCH` on `/organizations/{organizationId}/outlets[/{outletId}]`
(`functions/src/routes/outlets.ts` + `functions/src/domain/outlets.ts`) are
the first outlet endpoints. See
[domain-model.md](./domain-model.md#outlet) for the entity.

Every outlet endpoint first authenticates the caller (`401`/`503` exactly as
above), then authorizes them via `requireOrganizationRole` against
`organizations/{organizationId}/members/{userId}` (`functions/src/auth/membership.ts`)
**before** looking at the request body — an unauthorized caller never learns
whether their body would otherwise have been valid. `organizationId` (and
`outletId`, for `PATCH`) come from the route's path parameters
(`RouteContext.params`), never the request body.

| Role | View (`GET`) | Create/Edit (`POST`/`PATCH`) |
| --- | --- | --- |
| `owner` | ✓ | ✓ |
| `manager` | ✓ | ✓ |
| `staff` | ✓ | ✗ (`403 permission_denied`) |
| non-member | ✗ (`403 permission_denied`) | ✗ (`403 permission_denied`) |

### `POST /organizations/{organizationId}/outlets`

Request body (validated with Zod; `status`, `id`, `organizationId`,
`createdBy`, `createdAt`, `updatedAt` are never accepted — an unrecognized
field is ignored, not treated as authority):

```jsonc
{
  "name": "Main Canteen",
  "slug": "main-canteen",
  "description": "Main campus food outlet",
  "phone": "0499xxxxxxx",
  "address": { "line1": "Main Campus", "city": "Kasaragod", "state": "Kerala", "postalCode": "671xxx" },
  "location": { "latitude": 12.5, "longitude": 74.9 }
}
```

- `name`: trimmed, 1-100 characters.
- `slug`: 3-50 characters, matching `^[a-z0-9]+(-[a-z0-9]+)*$`, unique only
  **within this organization** — not globally unique like an organization's
  own slug. **Immutable for this first implementation**, same reasoning as
  an organization's slug (see [Organizations](#organizations) above).
- `description` (≤500 chars), `phone` (≤30 chars), `address`, `location`
  (latitude ∈ [-90, 90], longitude ∈ [-180, 180]) are all optional.

A new outlet always starts `status: "active"`; `createdBy` always comes from
the verified Descope session. Success: `201` with

```jsonc
{ "data": { "outlet": { "id": "...", "organizationId": "...", "name": "...", "slug": "...", "status": "active", "createdAt": "...", "updatedAt": "...", "createdBy": "..." } } }
```

Errors: `400 invalid_argument`, `401 unauthenticated`, `403 permission_denied`
(not an active `owner`/`manager` member), `409 already_exists` (slug already
taken in this organization), `503 unavailable`.

Like `createOrganization`, `createOutlet` creates the outlet document and its
`organizations/{organizationId}/outletSlugs/{slug}` uniqueness reservation in
**one Firestore transaction**, so a slug conflict never leaves a partial
outlet behind, and the same slug is always free to reuse in a *different*
organization.

### `GET /organizations/{organizationId}/outlets`

Returns **every** outlet in the organization — active and inactive alike;
this is an organization-management view, so inactive outlets are never
hidden. Any active member (`owner`, `manager`, or `staff`) may call this.
`200` with

```jsonc
{ "data": { "outlets": [ { "id": "...", "organizationId": "...", "name": "...", "slug": "...", "status": "active", "createdAt": "...", "updatedAt": "...", "createdBy": "..." } ] } }
```

ordered by `createdAt` ascending (a single-field index, automatic — no
`firestore.indexes.json` entry needed, unlike `GET /organizations`'s
collection-group query); `[]` if the organization has no outlets.

### `PATCH /organizations/{organizationId}/outlets/{outletId}`

Only an active `owner`/`manager` member may call this. Editable fields:
`name`, `description`, `phone`, `address`, `location`, `status` (`"active"`
or `"inactive"`) — every field is optional, but the body must contain at
least one. `slug`, `id`, `organizationId`, `createdBy`, and `createdAt` can
never be changed through this endpoint (present-but-ignored, same as the
create-time authority fields above). `updatedAt` is set to the current time
on every successful update. Success: `200` with the updated outlet, in the
same shape as `POST`'s response.

Errors: `400 invalid_argument` (bad body, including an empty one), `401
unauthenticated`, `403 permission_denied`, `404 not_found` (no such outlet in
this organization — including an outlet ID that belongs to a *different*
organization: this never leaks whether that ID exists elsewhere), `503
unavailable`.

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
