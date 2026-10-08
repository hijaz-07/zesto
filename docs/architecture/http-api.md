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
    menus.ts             POST/GET .../outlets/{outletId}/menus,
                         GET/PATCH .../menus/{menuId},
                         POST .../menus/{menuId}/publish|archive
    menuItems.ts         POST/GET .../menus/{menuId}/items,
                         GET/PATCH/DELETE .../items/{itemId}
    explore.ts           GET /explore/outlets[/{outletId}[/menus/{menuId}]]
                         — public, unauthenticated customer discovery
  domain/
    users.ts             users/{userId} profile: schema + get-or-create
    organizations.ts     organizations/*, organizationSlugs/*, and the
                         owner-membership write side of organizations/*/members
    outlets.ts           organizations/*/outlets/*, organizations/*/outletSlugs/*
    menus.ts             organizations/*/outlets/*/menus/*
    menuItems.ts         organizations/*/outlets/*/menus/*/items/*
    explore.ts           customer-safe read views of outlets/menus/menu
                         items for the public /explore routes
  auth/
    session.ts           verifyDescopeSession / authenticateRequest
    membership.ts         organization role authorization (unrelated to /me)
  firebaseAdmin.ts        centralized Admin SDK app + Firestore accessor
  time.ts                 businessDateString(): Zesto's Asia/Kolkata
                         "business calendar date" for the given instant
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
| 409    | `conflict`             | The resource is not in a state the request can act on, or changed underneath it: a fulfillment action (`.../orders/{orderId}/start-preparing`, `.../mark-ready`, `.../complete`), a cancellation (`POST /orders/{orderId}/cancel`, `.../orders/{orderId}/cancel`) of an order that is past cancelling, a refund retry (`.../orders/{orderId}/retry-refund`) with no failed refund to retry, or a pickup (`POST .../pickups`) on an order that is not in the state it needs (stale screen, a racing colleague, an unpaid or cancelled order, an order already picked up), a pickup at the wrong outlet, and `GET /orders/{orderId}/pickup-credential` for an order that cannot be collected right now. A client should re-read the resource, not retry the same request. Only the organization order routes and the pickup credential route use it so far; elsewhere a wrong lifecycle state is still `400` (`failed-precondition`). |
| 429    | `rate_limited`         | The verified caller sent too many requests to one of the highest-risk routes (order and payment preparation, cancellation, refund retry, pickup redemption, notification reads, organization creation) within the window. `Retry-After` gives the seconds to wait; the handler did not run, so nothing changed. A best-effort, per-user, per-instance limit — see [Rate limiting](#rate-limiting). Never returned to an unauthenticated caller. |
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

## Rate limiting

`functions/src/http/rateLimit.ts` wraps a short list of routes (`RATE_LIMIT_POLICIES`:
`POST /orders`, `.../payment`, `.../payment/verify`, `POST /orders/{id}/cancel`,
`GET .../pickup-credential`, `POST /organizations`, the organization `cancel`,
`retry-refund` and `pickups` routes, and the notification list / unread-count reads) so
each request is counted against its **verified** caller before the handler runs. The
caller is verified once in the wrapper only to choose a bucket (`{method} {route
pattern}:{userId}`); a request that does not verify is passed on untouched and the
handler answers it (401/503) exactly as before. Over the limit: `429 rate_limited` with
`Retry-After`, and the handler never runs.

Design choices, deliberately conservative:

- **Keyed by user, never by IP.** A campus Wi-Fi puts hundreds of legitimate students
  behind one address, and an unverified token claim would let anyone spend another
  user's budget.
- **Best effort, per instance.** Counters live in each function instance's memory (bounded
  to 10,000 buckets), so one user's effective ceiling is the limit times the number of warm
  instances (at most `maxInstances`, 10) and resets when an instance restarts. The limits
  are well above real use (e.g. 20 order creations per minute, 120 pickup redemptions per
  minute), so this stops runaway clients and single abusive accounts — chiefly protecting
  the shared Razorpay API budget — without ever turning a real customer away. A hard global
  limit needs shared state or an edge control and is a documented future step
  (`docs/operations/production-readiness-audit.md`).
- The webhook route is not limited: it is authenticated by Razorpay's signature, rejects
  before touching Firestore, and must never drop a genuine delivery.

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

## Menus

`POST`, `GET`, `PATCH` on `/organizations/{organizationId}/outlets/{outletId}/menus[/{menuId}]`,
plus the explicit lifecycle actions `POST .../menus/{menuId}/publish` and
`POST .../menus/{menuId}/archive` (`functions/src/routes/menus.ts` +
`functions/src/domain/menus.ts`) are the first menu endpoints. See
[domain-model.md](./domain-model.md#menu) for the entity. A menu belongs to
exactly one outlet; ownership always comes through the outlet, and
`organizationId`/`outletId` (and `menuId`, for the single-menu/lifecycle
endpoints) come from the route's path parameters, never the request body.

Every menu endpoint first authenticates the caller (`401`/`503` exactly as
above), then authorizes them via `requireOrganizationRole` against
`organizations/{organizationId}/members/{userId}` — identical to Outlet's
authorization; there is no separate outlet-level or menu-level role — and
then confirms the route's `:outletId` exists and belongs to `organizationId`
(`404` otherwise, via `getOutlet`, `functions/src/domain/outlets.ts`) before
looking at the request body.

| Role | View (`GET`) | Create/Edit/Publish (`POST`/`PATCH`) | Archive |
| --- | --- | --- | --- |
| `owner` | ✓ | ✓ | ✓ |
| `manager` | ✓ | ✓ | ✓ |
| `staff` | ✓ | ✗ (`403 permission_denied`) | ✗ (`403 permission_denied`) |
| non-member | ✗ (`403 permission_denied`) | ✗ (`403 permission_denied`) | ✗ (`403 permission_denied`) |

### Time model

Zesto's business time zone is hardcoded to **Asia/Kolkata** for v1 (no
per-outlet time zone field — see `functions/src/time.ts`). `menuDate` is
persisted as a calendar date string (`YYYY-MM-DD`); `orderingOpensAt`,
`orderingClosesAt`, `pickupStartsAt`, `pickupEndsAt`, and `publishedAt` are
Firestore Timestamps. The request body accepts the same representation the
response always emits: ISO 8601 date-time strings (`z.iso.datetime({offset:
true})`, accepting either a literal `Z` or a numeric `+HH:MM`/`-HH:MM`
offset), which the backend transforms straight into a Firestore `Timestamp`.
`menuDate` uses Zod's `z.iso.date()`, which already rejects a non-existent
calendar date (e.g. `2026-02-30`) — no separate calendar validation exists.

A menu's schedule must satisfy, always (checked by
`functions/src/domain/menus.ts`'s `findScheduleViolation`, both at create
time and against the merged result of any edit):

1. `orderingOpensAt` < `orderingClosesAt`
2. `pickupStartsAt` < `pickupEndsAt`
3. `orderingClosesAt` <= `pickupStartsAt`
4. `pickupStartsAt`'s Asia/Kolkata calendar date is not before `menuDate`
   (interpreted literally as "not before" — a pickup date several days after
   `menuDate` is technically permitted; same-day equality is the normal,
   expected case but is not separately enforced).

Separately, `menuDate` itself cannot be before today in Asia/Kolkata (today
is not "in the past" — a same-day menu is technically allowed, even though
the normal workflow publishes for the next service day). This check only
runs at creation, and on an edit only when `menuDate` is part of that
specific request — it is never re-applied at publish time, so a valid draft
is never blocked from being published purely because a day boundary passed.

### Menu lifecycle

```
draft ──publish──> published ──archive──> archived
```

Only `draft -> published` and `published -> archived` are allowed; every
other transition (`draft -> archived`, `archived -> published`,
`archived -> draft`, `published -> draft`) is rejected. Status can **never**
be changed through the generic `PATCH` endpoint — only through the explicit
`publish`/`archive` actions below, both of which run inside one Firestore
transaction (read the current status, verify the transition, write), so a
lifecycle change can never partially succeed, and two concurrent lifecycle
mutations on the same menu can never both win.

**A menu can be published only when it contains at least one enabled menu
item.** This is checked by reading the menu's real `items` subcollection
(`functions/src/domain/menuItems.ts`'s `hasEnabledMenuItem`) inside the same
Firestore transaction as the status transition itself — never trusted from
the request body or from frontend state — so a concurrent change to the
menu's items while a publish is in flight cannot result in an
effectively-empty menu being published. See
[Menu items](#menu-items) below and
[domain-model.md](./domain-model.md#menu) for the entity-level statement of
this rule. This is a publish-**time** gate, not an ongoing invariant: an
already-published menu's last enabled item can still be disabled afterward
(see [Menu-lifecycle and ordering-window gate](#menu-lifecycle-and-ordering-window-gate)
above) — a client must not assume every currently-published menu still has
an enabled item.

### Outlet dependency

| Endpoint | Outlet must be active? |
| --- | --- |
| `POST` (create) | Yes — `400 invalid_argument` if inactive |
| `GET` (list/one) | No — menus on an inactive outlet remain readable |
| `PATCH` (update) | Yes — `400 invalid_argument` if inactive |
| `POST .../publish` | Yes — `400 invalid_argument` if inactive |
| `POST .../archive` | No — archiving an already-published menu is a cleanup/historical action, allowed even after the outlet is deactivated |

A nonexistent outlet, or one belonging to a different organization, is
`404 not_found` — the same "it simply doesn't exist at this path" behavior
Outlet's own `PATCH` already relies on (see [Outlets](#outlets) above).

### `POST /organizations/{organizationId}/outlets/{outletId}/menus`

Request body (validated with Zod; `status`, `id`, `organizationId`,
`outletId`, `createdBy`, `createdAt`, `updatedAt`, `publishedAt` are never
accepted — an unrecognized field is ignored, not treated as authority):

```jsonc
{
  "menuDate": "2026-09-29",
  "title": "Tuesday Special Menu",
  "description": "Freshly prepared lunch menu.",
  "orderingOpensAt": "2026-09-28T04:00:00Z",
  "orderingClosesAt": "2026-09-28T10:00:00Z",
  "pickupStartsAt": "2026-09-29T06:00:00Z",
  "pickupEndsAt": "2026-09-29T10:00:00Z"
}
```

- `title`: trimmed, 1-100 characters. `description` (≤500 chars): optional.
- See [Time model](#time-model) above for `menuDate` and the 4 schedule
  fields' validation.

A new menu always starts `status: "draft"`; `createdBy` always comes from
the verified Descope session. Unlike Outlet, this write is **not** wrapped
in a Firestore transaction — there is no uniqueness constraint on
`menuDate` (multiple menus may share one), so a plain document create is
sufficient. Success: `201` with

```jsonc
{
  "data": {
    "menu": {
      "id": "...", "organizationId": "...", "outletId": "...",
      "menuDate": "2026-09-29", "title": "Tuesday Special Menu",
      "description": "Freshly prepared lunch menu.", "status": "draft",
      "orderingOpensAt": "...", "orderingClosesAt": "...",
      "pickupStartsAt": "...", "pickupEndsAt": "...",
      "createdAt": "...", "updatedAt": "...", "createdBy": "..."
    }
  }
}
```

Errors: `400 invalid_argument` (bad body, including any schedule-rule
violation above, or an inactive outlet), `401 unauthenticated`,
`403 permission_denied`, `404 not_found` (no such outlet), `503 unavailable`.

### `GET /organizations/{organizationId}/outlets/{outletId}/menus`

Returns **every** menu in the outlet, every lifecycle state alike; this is
an organization-management view, so archived menus are never hidden. Any
active member (`owner`, `manager`, or `staff`) may call this, and the outlet
may be inactive. `200` with

```jsonc
{ "data": { "menus": [ { "id": "...", "status": "draft", "...": "..." } ] } }
```

ordered by `menuDate` ascending, then `createdAt` ascending as a
deterministic tie-breaker (multiple menus can share a `menuDate`) — this
2-field ordering requires the composite index declared in
`firestore.indexes.json` (`menus`, `COLLECTION` scope, `menuDate` +
`createdAt`, both ascending); `[]` if the outlet has no menus.

### `GET /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}`

Returns a single menu. Any active member may call this, and the outlet may
be inactive. `200` with the same shape as a single entry of the list above.

Errors: `401 unauthenticated`, `403 permission_denied`, `404 not_found` (no
such menu in this outlet — including a menu ID that belongs to a different
outlet or organization: this never leaks whether that ID exists elsewhere).

### `PATCH /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}`

Only an active `owner`/`manager` member may call this, and only for an
active outlet. Editable fields: `menuDate`, `title`, `description`,
`orderingOpensAt`, `orderingClosesAt`, `pickupStartsAt`, `pickupEndsAt` —
every field is optional, but the body must contain at least one. `status`,
`id`, `organizationId`, `outletId`, `createdBy`, `createdAt`, and
`publishedAt` can never be changed through this endpoint (present-but-
ignored). `updatedAt` is set to the current time on every successful update.

Two additional rules, checked against the **merged** result (existing
document + this patch) inside one Firestore transaction, so a lone edit to
one schedule field can't silently invalidate an untouched one:

- An **archived** menu rejects every edit outright.
- Once **ordering has closed** (`now >= orderingClosesAt`), any edit that
  touches `menuDate`/`orderingOpensAt`/`orderingClosesAt`/`pickupStartsAt`/
  `pickupEndsAt` is rejected — `title`/`description` remain editable
  regardless, since they don't affect an already-finalized demand workflow.

Success: `200` with the updated menu, in the same shape as `POST`'s
response.

Errors: `400 invalid_argument` (bad body, including an empty one, a
schedule-rule violation on the merged result, an archived menu, an
ordering-window-locked schedule edit, or an inactive outlet),
`401 unauthenticated`, `403 permission_denied`, `404 not_found`,
`503 unavailable`.

### `POST /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/publish`

No request body. Only an active `owner`/`manager` member may call this, and
only for an active outlet. Requires the menu is currently `"draft"`;
re-validates the stored schedule's business rules as a defense-in-depth
step; and requires the menu currently has at least one enabled item (see
[Menu lifecycle](#menu-lifecycle) above) — read directly from Firestore
inside the same transaction, never trusted from the request body. Only then
does it set `status: "published"`, generate `publishedAt`, and bump
`updatedAt` — all in one Firestore transaction. Success: `200` with the
published menu.

Errors: `400 invalid_argument` (not currently a draft, an inactive outlet,
or no enabled item), `401 unauthenticated`, `403 permission_denied`, `404 not_found`,
`503 unavailable`.

### `POST /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/archive`

No request body. Only an active `owner`/`manager` member may call this.
Requires the menu is currently `"published"`; sets `status: "archived"` and
bumps `updatedAt`, in one Firestore transaction. Unlike every other mutating
menu endpoint, **does not** require the outlet to be active (see
[Outlet dependency](#outlet-dependency) above). Success: `200` with the
archived menu.

Errors: `400 invalid_argument` (not currently published), `401
unauthenticated`, `403 permission_denied`, `404 not_found`, `503 unavailable`.

## Menu items

`POST`, `GET`, `PATCH`, `DELETE` on
`/organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items[/{itemId}]`
(`functions/src/routes/menuItems.ts` + `functions/src/domain/menuItems.ts`)
are the first menu item endpoints. See
[domain-model.md](./domain-model.md#menuitem) for the entity. An item
belongs to exactly one menu; ownership always comes through the menu (and,
transitively, the outlet), and `organizationId`/`outletId`/`menuId` (and
`itemId`, for the single-item endpoints) come from the route's path
parameters, never the request body. Unlike `Menu` (which duplicates its
`organizationId`/`outletId` onto its own document), an item's document does
**not** duplicate `organizationId`/`outletId`/`menuId` — every request
already re-resolves and re-validates the full ancestor chain before an item
is ever touched, so those fields would be redundant path metadata.

Every item endpoint first authenticates the caller (`401`/`503` exactly as
above), then authorizes them via `requireOrganizationRole` — identical to
Outlet's/Menu's authorization; there is no separate outlet-level,
menu-level, or item-level role — then confirms the route's `:outletId`
exists and belongs to `organizationId` (`404` otherwise, via `getOutlet`),
then confirms the route's `:menuId` exists and belongs to that outlet (`404`
otherwise, via `getMenu`), before looking at the request body.

| Role | View (`GET`) | Create/Edit (`POST`/`PATCH`) | Delete |
| --- | --- | --- | --- |
| `owner` | ✓ | ✓ | ✓ |
| `manager` | ✓ | ✓ | ✓ |
| `staff` | ✓ | ✗ (`403 permission_denied`) | ✗ (`403 permission_denied`) |
| non-member | ✗ (`403 permission_denied`) | ✗ (`403 permission_denied`) | ✗ (`403 permission_denied`) |

### Price model

`priceInPaise` is always a non-negative integer number of paise — money is
never a floating-point rupee amount (see root `CLAUDE.md`). `₹120.00` is
`12000`; `₹99.50` is `9950`. The request body must send an actual JSON
number (`z.number().int().min(0)`, exactly like `outlets.ts`'s `location`
fields) — a numeric string, a decimal, or a negative value is rejected.
There is no secondary rupee-price field, and the API always returns
`priceInPaise` as an integer. Changing an item's price never alters the
price already recorded on an existing order — Orders will snapshot their
own `unitPriceInPaiseAtOrder` at order time (not part of this
implementation; see [domain-model.md](./domain-model.md#menuitem)).

### Menu-lifecycle and ordering-window gate

Whether an item mutation is allowed right now depends on the **parent
menu's** current state — checked by `routes/menuItems.ts`'s `requireMenu`
(a non-transactional read, mirroring `requireOutlet`'s shape and accepting
the same narrow TOCTOU race) calling two pure, independently-tested
functions in `domain/menuItems.ts`:

- `findItemMutationViolation` — governs `POST`/`PATCH` (create, edit,
  enable/disable, reorder): a **draft** menu always allows item mutations,
  regardless of its `orderingClosesAt` (a draft's ordering window has no
  meaning until it is published); a **published** menu allows them only
  until `orderingClosesAt`; an **archived** menu never allows them.
- `findItemDeletionViolation` — stricter, governs `DELETE` only: allowed
  **only** while the menu is currently `draft`, regardless of the ordering
  window. A published or archived menu's item can only be disabled
  (`PATCH {"enabled": false}`), never hard-deleted — this is how
  historical menu/order data survives a menu going live.

Reads (`GET`) are **never** gated by menu state or the ordering window —
historical menu/item data must always remain readable, and the outlet may
be inactive.

| Endpoint | Outlet must be active? | Menu gate |
| --- | --- | --- |
| `POST` (create) | Yes — `400 invalid_argument` if inactive | `findItemMutationViolation` |
| `GET` (list/one) | No | None — always readable |
| `PATCH` (update) | Yes | `findItemMutationViolation` |
| `DELETE` | Yes | `findItemDeletionViolation` (stricter: draft only) |

A nonexistent outlet or menu, or one belonging to a different
organization/outlet, is `404 not_found` — the same secure-not-found
behavior Menu's own endpoints already rely on.

### `POST /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items`

Request body (validated with Zod; `id`, `menuId`, `enabled`, `createdBy`,
`createdAt`, `updatedAt` are never accepted — an unrecognized field is
ignored, not treated as authority):

```jsonc
{
  "name": "Chicken Biriyani",
  "description": "Aromatic chicken biriyani",
  "priceInPaise": 12000,
  "displayOrder": 1
}
```

- `name`: trimmed, 1-100 characters. Not required to be unique within a
  menu — variants (e.g. "Chicken Biriyani" vs "Chicken Biriyani + Egg") are
  expected. `description` (≤500 chars): optional.
- `priceInPaise`, `displayOrder`: non-negative integers (see
  [Price model](#price-model) above).

A new item always starts `enabled: true`; `createdBy` always comes from the
verified Descope session. Like `createMenu`, this write is **not** wrapped
in a Firestore transaction — there is no uniqueness constraint to protect.
Success: `201` with

```jsonc
{
  "data": {
    "item": {
      "id": "...", "menuId": "...", "name": "Chicken Biriyani",
      "description": "Aromatic chicken biriyani", "priceInPaise": 12000,
      "enabled": true, "displayOrder": 1,
      "createdAt": "...", "updatedAt": "...", "createdBy": "..."
    }
  }
}
```

Errors: `400 invalid_argument` (bad body, an inactive outlet, or the menu
gate above), `401 unauthenticated`, `403 permission_denied`,
`404 not_found` (no such outlet or menu), `503 unavailable`.

### `GET /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items`

Returns **every** item on the menu — enabled and disabled alike; this is an
organization-management view, so disabled items are never hidden. Any
active member (`owner`, `manager`, or `staff`) may call this, the outlet may
be inactive, and the menu may be in any lifecycle state. `200` with

```jsonc
{ "data": { "items": [ { "id": "...", "enabled": true, "...": "..." } ] } }
```

ordered by `displayOrder` ascending, then `createdAt` ascending as a
deterministic tie-breaker (multiple items can share a `displayOrder`) —
this 2-field ordering requires the composite index declared in
`firestore.indexes.json` (`items`, `COLLECTION` scope, `displayOrder` +
`createdAt`, both ascending); `[]` if the menu has no items.

### `GET /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items/{itemId}`

Returns a single item. Any active member may call this, the outlet may be
inactive, and the menu may be in any lifecycle state. `200` with the same
shape as a single entry of the list above.

Errors: `401 unauthenticated`, `403 permission_denied`, `404 not_found` (no
such item in this menu — including an item ID that belongs to a different
menu, outlet, or organization: this never leaks whether that ID exists
elsewhere).

### `PATCH /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items/{itemId}`

Only an active `owner`/`manager` member may call this, only for an active
outlet, and only while the menu gate above allows it. Editable fields:
`name`, `description`, `priceInPaise`, `enabled`, `displayOrder` — every
field is optional, but the body must contain at least one. `id`, `menuId`,
`createdBy`, and `createdAt` can never be changed through this endpoint
(present-but-ignored). `updatedAt` is set to the current time on every
successful update. Success: `200` with the updated item, in the same shape
as `POST`'s response.

Errors: `400 invalid_argument` (bad body, including an empty one, an
inactive outlet, or the menu gate above), `401 unauthenticated`,
`403 permission_denied`, `404 not_found`, `503 unavailable`.

### `DELETE /organizations/{organizationId}/outlets/{outletId}/menus/{menuId}/items/{itemId}`

Only an active `owner`/`manager` member may call this, only for an active
outlet, and only while the parent menu is currently `draft` (the stricter
`findItemDeletionViolation` gate — see above). Permanently removes the
Firestore document; a published or archived menu's item is never silently
disabled as a fallback — the caller must `PATCH {"enabled": false}`
explicitly instead. Success: `200` with an empty `data` object.

Errors: `400 invalid_argument` (the outlet is inactive, or the menu is not
currently draft), `401 unauthenticated`, `403 permission_denied`,
`404 not_found`, `503 unavailable`.

Zesto is demand-driven, not inventory-driven: there is no stock/inventory/
remaining-quantity concept anywhere in the menu or menu item model (see
[domain-model.md](./domain-model.md#menu)). Historical order pricing (an
`Order`'s immutable `unitPriceInPaiseAtOrder` snapshot) is a future Orders
concern, not part of this implementation.

## Customer order history

### `GET /orders`

The signed-in customer's own orders, newest first, one page at a time
(`functions/src/routes/orders.ts` + `functions/src/domain/orderHistory.ts`).
Authenticated (any signed-in Descope user; no organization membership is
involved or special-cased — an organization's owner/staff see only the orders
they themselves placed as a customer).

**Ownership.** The caller is the verified session's user and nothing else:
`userId` is not a request input, so a `userId` query parameter is ignored. The
query is `collectionGroup("orders").where("userId", "==", <session user>)`, so
another customer's order can never be in the result set to begin with.

**Query parameters** (both optional; anything else is ignored):

- `limit` — a positive integer page-size hint. Defaults to `20`; the server
  clamps it to a hard maximum of `50`, so asking for more just returns `50`.
  Not a positive integer (e.g. `0`, `-1`, `abc`, `1.5`, repeated) → `400`.
- `cursor` — the `nextCursor` of the previous page. An opaque value; one this
  endpoint did not issue → `400`.

**Ordering and paging.** `createdAt` descending, then document path descending
as a tie-break, so orders sharing a timestamp are never skipped or repeated
between pages. The cursor encodes the last returned order's `createdAt` and
path. It carries no authority: it is only a boundary inside a query already
filtered to the caller's own `userId`, so a forged or borrowed cursor can only
move where in the caller's own history a page starts.

Response (`200`): `{ "orders": [...], "nextCursor": string | null }`.
`nextCursor` is `null` on the last page; a customer with no orders gets
`{ "orders": [], "nextCursor": null }`. Each order is a customer-safe summary:

```json
{
  "id": "…", "outletId": "…", "menuId": "…",
  "outlet": { "name": "Main Canteen" },
  "menu": { "title": "Tuesday Menu", "menuDate": "2026-09-29" },
  "status": "pending_payment | confirmed | preparing | ready | picked_up | completed | cancelled",
  "paymentStatus": "pending | paid",
  "currency": "INR",
  "subtotalInPaise": 30000, "totalInPaise": 30000,
  "itemCount": 3,
  "items": [{ "name": "Chicken Biriyani", "quantity": 2 }],
  "moreItemLines": 0,
  "createdAt": "…", "updatedAt": "…"
}
```

- `itemCount` is the total portions across every line; `items` lists at most
  the first 3 lines (names and quantities from the order's own snapshots,
  never the live menu) and `moreItemLines` counts the rest. Prices per line,
  and the full order, are read with `GET /orders/{orderId}`.
- `outlet`/`menu` are display-only names read from the live documents (one
  read per distinct outlet/menu on the page). They are omitted, not an error,
  if that document no longer exists, and an inactive outlet or archived menu
  still resolves — history must not vanish when an outlet or menu is retired.
- Never present: `userId`, `organizationId`, payment or provider data, or any
  other backend metadata.

Errors: `400 invalid_argument` (bad `limit`/`cursor`), `401 unauthenticated`,
`503 unavailable`.

**Index.** `firestore.indexes.json` gained a composite index: `orders`,
`COLLECTION_GROUP` scope, `userId` ascending + `createdAt` descending. The
document-path tie-break is implicit in that index, in the same direction as
its last field.

## Organization orders

### `GET /organizations/{organizationId}/orders`

The organization-side counterpart of customer order history: the orders placed
with an organization's outlets, newest first, one page at a time
(`functions/src/routes/organizationOrders.ts` +
`functions/src/domain/organizationOrders.ts`). It is tenant-scoped like the
outlet/menu routes, not identity-scoped like `GET /orders`. This route only
reads; an order is moved along by the fulfillment actions
[below](#organization-order-fulfillment) and handed over by
[pickup](#organization-order-pickup). Cancellation is its own money-handling
action with its own role set (owners and managers only), described under
[Order cancellation](#order-cancellation); it is not one of them.

**Authorization.** In this order, each step stopping the request if it fails:

1. `authenticateRequest` — a missing/invalid Descope session is `401`.
2. `requireOrganizationRole` with `VIEW_ROLES` (`owner`, `manager`, `staff` —
   the same set that may read outlets and menus; there is no per-outlet
   permission, and no new role model): an **active** membership at
   `organizations/{organizationId}/members/{session user}`. A non-member
   (including a customer who has only ever placed orders), an `invited` or
   `revoked` member, a nonexistent organization, and an unknown role/status are
   all the same `403` — a nonexistent organization is not distinguishable from
   a forbidden one.
3. Only then is the query string validated.

`organizationId` in the path is a claim about *which membership to look up*,
never authority by itself: the member document read is keyed by the **verified**
session user. The scope used for the query is the organization of that verified
membership. An `organizationId`/`userId` in the query string is ignored.

**Query parameters** (all optional; anything else is ignored):

- `outletId` — narrows the list to one outlet. A requested filter only: the
  outlet is read under *this* organization's path, so another organization's
  outlet is simply "not found" (`404`, identical to a nonexistent one — nothing
  about it leaks). A deactivated outlet is accepted: its history stays
  readable. A malformed or blank value is `400`, never "no filter".
- `limit` — as for customer history: default `20`, hard maximum `50`, a
  non-positive-integer is `400`.
- `cursor` — the `nextCursor` of the previous page. One this endpoint did not
  issue, **or one that points outside the current organization (or, with an
  `outletId` filter, outside that outlet), is `400`** — it is never quietly
  accepted and never widens the query.

**Query.** `collectionGroup("orders").where("organizationId", "==", <verified
organization>)`, plus `.where("outletId", "==", <verified outlet>)` when
filtering, ordered `createdAt` descending then document path descending (so
orders sharing a timestamp are never skipped or repeated between pages), fetched
as `limit + 1` to learn whether another page exists. Before anything is
returned, every document's path and `organizationId` (and `outletId`, when
filtering) are checked against the verified scope once more, and a mismatch
fails the request rather than returning the order.

Response (`200`): `{ "orders": [...], "nextCursor": string | null }`; an
organization with no orders gets `{ "orders": [], "nextCursor": null }`. Every
status is listed (`pending_payment`, `confirmed`, `preparing`, `ready`,
`picked_up`, `completed`, `cancelled`) — there is no status filter yet. Orders from inactive outlets are
listed like any other. Each row:

```json
{
  "id": "…", "outletId": "…", "menuId": "…",
  "outlet": { "name": "Main Canteen" },
  "menu": { "title": "Tuesday Menu", "menuDate": "2026-09-29" },
  "status": "pending_payment | confirmed | preparing | ready | picked_up | completed | cancelled",
  "paymentStatus": "pending | paid",
  "currency": "INR",
  "subtotalInPaise": 30000, "totalInPaise": 30000,
  "itemCount": 3,
  "items": [{ "name": "Chicken Biriyani", "quantity": 2 }],
  "moreItemLines": 0,
  "createdAt": "…", "updatedAt": "…",
  "cancellation": { "cancelledBy": "customer | organization", "cancelledAt": "…" },
  "refund": { "state": "in_progress | partially_refunded | refunded | attention_required", "refundedInPaise": 0 }
}
```

- `items` lists at most the first **10** lines (name and quantity, from the
  order's own snapshots — never the live menu, so a later rename or reprice
  changes nothing) and `moreItemLines` counts the rest; `itemCount` is the
  total portions across every line. No per-line prices.
- `cancellation` and `refund` are **optional**, additive, read-only blocks (the
  dashboard's cancellation/refund UX reads them). `cancellation` is present only
  on a `cancelled` order whose cancellation was recorded, and says who it came
  from (a role, never an identity) and when — not the reason, the actor, or the
  status it was cancelled from. `refund` is the order document's own refund
  mirror (no extra read): the payment-level state and the amount already
  refunded; it is absent when the order has had no refund activity.
  `attention_required` means a refund failed or stalled and needs an owner or
  manager. No refund, payment or provider identifier, amount in flight or audit
  field is ever sent. The fulfillment, pickup and `.../cancel` routes answer
  with the same row, blocks included.
- `outlet`/`menu` are display-only names, omitted (not an error) if that
  document no longer exists.
- Never present: `userId` or any customer identity (name, phone, email),
  `organizationId`, payment or provider data, or any other backend metadata.

Errors: `400 invalid_argument` (bad `limit`/`outletId`/`cursor`), `401
unauthenticated`, `403 permission_denied`, `404 not_found` (unknown or foreign
outlet), `503 unavailable`.

**Indexes.** `firestore.indexes.json` gained two composite indexes, both
`orders`, `COLLECTION_GROUP` scope (the document-path tie-break is implicit, in
the same direction as the last field): `organizationId` ascending + `createdAt`
descending (all outlets), and `organizationId` ascending + `outletId` ascending +
`createdAt` descending (one outlet). The Firestore emulator does not enforce
composite indexes, so these can only be confirmed against real Firestore once
deployed.

## Organization order fulfillment

Three explicit, body-less actions move a **paid** order through the kitchen and
out the door (`functions/src/routes/organizationOrders.ts` +
`functions/src/domain/orderFulfillment.ts`):

```
POST /organizations/{organizationId}/orders/{orderId}/start-preparing
POST /organizations/{organizationId}/orders/{orderId}/mark-ready
POST /organizations/{organizationId}/orders/{orderId}/complete
```

```
confirmed --start-preparing--> preparing --mark-ready--> ready
                                                           |  (pickup, below — needs a credential)
                                                           v
                                          completed <--complete-- picked_up
```

That is the whole state machine. `completed` and `cancelled` are terminal;
there is no way back (`ready` -> `preparing`, `picked_up` -> `ready` and the
like are refused). Cancelling is its own operation, [below](#order-cancellation).
Like a menu's `publish`/`archive`, these are explicit operations and not a
generic "set status": the target is fixed by the URL, nothing in the request
body or query is read (a `status`, `userId`, `organizationId`, `outletId` there
is ignored). `ready` -> `picked_up` is deliberately **not** one of them: it
needs a credential, so it is [`POST .../pickups`](#organization-order-pickup),
and no URL that merely names an order ID can mark that order picked up. All
three routes call the single `transitionOrderStatus`, so the rules live in
exactly one place. `complete` needs no credential — it only closes out an order
that was already handed over — and `ready` -> `completed` is refused: an order
cannot be completed without having been picked up.

**Authorization.** In this order, each step stopping the request if it fails:

1. `authenticateRequest` — a missing/invalid Descope session is `401`.
2. `requireOrganizationRole` with `ORDER_FULFILLMENT_ROLES` (`owner`, `manager`,
   `staff`): an **active** membership of the verified session user in the
   path's organization. Non-members (including the customer who placed the
   order), `invited` and `revoked` members, and an unknown role are all the same
   `403`. Operating the counter is not configuring the organization, so staff
   may do this although they may not edit menus. There is no separate
   fulfillment role and no per-outlet permission.
3. Only then is the order looked up — **inside the caller's organization**.

The membership is read just before the transaction, as on every other route; a
revocation that lands in that window is not seen by the request already in
flight, and takes effect for the next one.

**The transition** runs in one Firestore transaction: read the order, check it
belongs to the caller's organization (`404` otherwise — another organization's
order is indistinguishable from a missing one), decide from what was actually
read, and write the status, the audit fields and `updatedAt` together. Nothing
about the order's current state comes from the request.

| The order is…                                  | `start-preparing`            | `mark-ready`                 | `complete`                   |
| ---------------------------------------------- | ---------------------------- | ---------------------------- | ---------------------------- |
| `confirmed`, paid                              | → `preparing`, `200`         | `409`                        | `409` (not picked up yet)    |
| `preparing`, paid                              | `200`, nothing changed       | → `ready`, `200`             | `409` (not picked up yet)    |
| `ready`                                        | `409`                        | `200`, nothing changed       | `409` (not picked up yet)    |
| `picked_up`, paid                              | `409`                        | `409`                        | → `completed`, `200`         |
| `completed`                                    | `409`                        | `409`                        | `200`, nothing changed       |
| `pending_payment`                              | `409` (not paid yet)         | `409` (not paid yet)         | `409` (not paid yet)         |
| `cancelled`                                    | `409`                        | `409`                        | `409`                        |
| right status but `paymentStatus` ≠ `paid`      | `409`                        | `409`                        | `409`                        |

Eligibility is the order's own `status` and `paymentStatus == "paid"`. That is
sufficient because the only code that writes either is `markPaymentSucceeded`,
which sets both atomically with the payment's `succeeded` status, and clients
cannot write orders at all; fulfillment never reads the payment document or
calls Razorpay. A paid-but-not-`paid` order can't occur and is refused rather
than fulfilled.

**Repeating an action is safe.** An action whose result already holds
(`preparing` -> `start-preparing`, `ready` -> `mark-ready`, `completed` ->
`complete`) is a `200` that writes nothing: the first person stays on record
(the audit fields are never overwritten) and `updatedAt` does not move. A
request for a state the order has already moved past (`start-preparing` on a
`ready` order) is a `409`, never an overwrite. (Pickup is different on purpose:
see below.)

**Concurrency.** Two people pressing the same button at once produce exactly one
write: the second transaction re-runs against the committed state and sees the
repeat. A `mark-ready` racing a `start-preparing` on a `confirmed` order is
either applied after it or refused with `409` — never half-applied, and an order
is never `ready` without having been `preparing`. A transaction that still
cannot commit after Firestore's own retries is reported as `409 conflict`, not
`500`.

**Audit.** The transition that enters `preparing` writes `preparingStartedAt` +
`preparingStartedBy`, the one that enters `ready` writes `readyAt` + `readyBy`,
and the one that enters `completed` writes `completedAt` + `completedBy` (the
member's Descope user ID). Each pair is written once and kept;
they are internal and appear in no API response. The request log line also
carries the caller's `userId` and `{from, to, outcome}`. This is deliberately
not a general event history, which is a later feature.

Response (`200`): `{ "order": { … } }` — the order's row in exactly the shape
the list above returns (no customer identity, no actor, no audit fields), so a
client can swap it in. Errors: `401 unauthenticated`, `403 permission_denied`,
`400 invalid_argument` (malformed `orderId`), `404 not_found` (no such order in
this organization), `409 conflict` (see the table above), `503 unavailable`.

An order from a since-deactivated outlet can still be fulfilled — its customers
have already paid. No Firestore index is added: the order is resolved with the
existing `orders.id` collection-group lookup.

## Order cancellation

Two explicit routes cancel an order — the customer's own, and the organization's
(`functions/src/routes/orders.ts`, `functions/src/routes/organizationOrders.ts`):

```
POST /orders/{orderId}/cancel                                  body {reason?}
POST /organizations/{organizationId}/orders/{orderId}/cancel   body {reason}
```

Both call the single `cancelOrder` (`functions/src/domain/orderCancellation.ts`),
which wraps the pure policy `decideCancellation` (`domain/cancellation.ts`) in one
Firestore transaction. Nothing in the request chooses the order's status, the
deadline, the actor, the organization, or an amount: only the order ID (path) and
a `reason` are read; any other body field is ignored.

**Who and when.**

| Order is…         | Customer (own order)                            | Owner / manager | Staff |
| ----------------- | ----------------------------------------------- | --------------- | ----- |
| `pending_payment` | yes, any time                                   | yes             | `403` |
| `confirmed`       | yes, strictly before the menu's `orderingClosesAt` | yes             | `403` |
| `preparing`/`ready` | `409`                                         | yes             | `403` |
| `picked_up`/`completed` | `409`                                     | `409`           | `403` |
| `cancelled`       | `200`, nothing changed (once authorized)        | `200`, nothing changed | `403` |

The deadline is read from the order's **own menu** inside the transaction; the
instant itself is closed. A missing or unreadable menu fails closed (`409`) for
a customer. An organization is not bound by the deadline.

**Authorization comes first.** Authentication, then (organization route) an
active `owner`/`manager` membership of the path's organization (`403` otherwise,
staff included — cancelling a paid order starts a refund, which is money), then
inside the transaction the order must be the caller's: another customer's order,
another organization's order and a missing order are the same `404`. Only after
that is the reason checked (`400`; a customer's is optional, an organization's is
required and from its own set), and only after that is an already-`cancelled`
order answered with an idempotent `200` — so a repeat is never an authorization
bypass. The first cancellation's audit fields (who, when, from which status,
why) stay; a repeat never overwrites them.

**Money.** A paid order (`confirmed`/`preparing`/`ready`, payment `succeeded`) gets
exactly one refund of the **entire remaining refundable amount**
(`captured - refunded - pending`), computed server-side from the payment read in
the same transaction. The refund (`requested`, `submitAttempts: 0`; it is submitted
to the provider afterwards by the [refund orchestration](#refund-orchestration) —
the cancellation transaction itself never calls Razorpay), the payment's refund
aggregates and `refundSeq`, the order's cancellation and its refund mirror all
commit as one write set. An unpaid (`pending_payment`) cancellation creates no
refund. If the payment cannot be refunded safely — missing, still pending,
failed, in another currency, with no provider payment ID, or with inconsistent
amounts — the cancellation is **refused** (`409`), never completed on a guess.
A payment whose money is already fully refunded or reserved still cancels the
order, with no second refund. The refund ID is `{orderId}-r{seq}` and is also the
provider idempotency key.

**Order refund mirror.** `refundStatus` and `refundedInPaise` on the order are a
denormalized read copy of the payment's `refundState` and
`refundedAmountInPaise`. They are only ever written in the same transaction that
changes the payment's refund figures, from the figures that transaction just
computed; the payment stays authoritative and an order without them (any order
written before refunds) is valid. They are not part of any API response.

**Late capture.** If a payment succeeds after its order was cancelled (paid in
one tab, cancelled in another; a webhook after the cancellation),
`markPaymentSucceeded` records the capture (`status`, `capturedAmountInPaise`)
and reserves a `late_capture_after_cancel` refund of the whole amount in the same
transaction. The final state is: order `status: cancelled` (never reopened or
confirmed, no `order_confirmed` event, its cancellation audit fields untouched)
and `paymentStatus: paid` (the money was captured); payment `succeeded` with
`capturedAmountInPaise`; one refund, `requested`, reason
`late_capture_after_cancel`. A repeated capture finds the payment `succeeded` and
does nothing, so there is never a second refund, and a late `payment.failed`
never moves a succeeded payment back. Every new success also writes
`capturedAmountInPaise`.

**Concurrency.** Cancelling, capturing a payment and moving an order through
fulfillment all read and write the same order (and payment) documents in
transactions, so they serialize: two cancellations produce one write and one
refund; a cancellation racing a capture ends cancelled, captured and refunded
exactly once, in full, whichever commits first; a cancellation racing
`start-preparing` is either a refunded cancellation or a `409`, never both.

**Response.** `200`, for the cancellation and for a safe repeat alike, with the
same three blocks on both routes:

```json
{"data": {
  "order": { "…": "the customer's order shape on /orders/…/cancel; the organization list row on the organization route" },
  "cancellation": {"state": "cancelled", "canCancel": false},
  "refund": {"status": "requested", "amountInPaise": 25000, "currency": "INR",
             "initiatedAt": "2026-09-24T10:00:00.000Z", "completedAt": "…only once processed"}
}}
```

`refund` is the order's latest refund and is **absent** when no money was captured
(an unpaid cancellation). `status` is the refund's local status
(`requested`/`pending`/`processed`/`failed`); `completedAt` appears only when it is
`processed`. Nothing else is exposed: no provider refund or payment ID, webhook
data, audit field (who cancelled, why), idempotency key, or secret. There is no
separate refund endpoint. A refused state is `409 conflict`. Errors: `401`, `403`, `400 invalid_argument`, `404 not_found`,
`409 conflict`, `503`. No Firestore index is added.

### Retrying a failed refund

```
POST /organizations/{organizationId}/orders/{orderId}/retry-refund     (no body)
```

An owner or manager of the order's organization starts a **new** refund attempt for a
cancelled order whose latest refund `failed` (the provider definitively refused it, so
the customer's money has not come back). Staff are refused (`403`). It is
`functions/src/domain/orderRefundRetry.ts` (who may ask, which order) over
`createRefundRetry` (what it does — see [Refund orchestration](#refund-orchestration)); there
is no second implementation.

- **Nothing is read from the request.** There is no body, amount or refund ID: the
  amount is always the whole remaining refundable amount of the payment, decided in the
  transaction, so the accounting can never exceed what was captured.
- **Scope.** The order is resolved by ID and must belong to the caller's organization;
  another organization's (or an unknown) order is a plain `404`. It must be `cancelled`.
- **A new document, never a reopened one.** The failed attempt stays `failed`; the retry is
  `{orderId}-r{seq+1}` (source `retry`, initiated by the caller, role `organization`) with its
  own provider idempotency key, and the existing `onRefundCreated` trigger submits it. A
  refund made outside Zesto (`external`) is never retried.
- **Idempotent.** A repeat — or the loser of two racing requests — finds the new refund as
  the latest one, which is not `failed`, and gets `409 conflict`; exactly one refund is created.
  `409` also answers an order with no refund, a refund that has not failed, nothing left to refund,
  or a payment that cannot be refunded safely.

**Response.** `200` with the order's organization list row (now showing the refund as
`in_progress`) and the new refund in the same safe shape a cancellation returns:

```json
{"data": {
  "order": { "…": "the organization list row" },
  "refund": {"status": "requested", "amountInPaise": 25000, "currency": "INR", "initiatedAt": "…"}
}}
```

No provider refund or payment ID, idempotency key, failure code or actor is exposed.
Errors: `401`, `403`, `404 not_found`, `409 conflict`, `503`. No Firestore index is added.

**Reading the state back: `GET /orders/{orderId}` (customer).** The customer's order read carries the same two blocks beside `order`, so a screen can show whether Cancel is on offer and where a refund stands without a second endpoint:

```json
{"data": {
  "order": { "…": "the customer's order shape" },
  "cancellation": {"state": "cancellable | not_cancellable | cancelled", "canCancel": true},
  "refund": {"status": "requested | pending | processed | failed", "amountInPaise": 25000, "currency": "INR",
             "initiatedAt": "…", "completedAt": "…only once processed"}
}}
```

`cancellation` is always present. `canCancel` is the SAME policy as the cancel route (`decideCancellation` for the customer: `pending_payment`, or `confirmed` strictly before the menu's `orderingClosesAt`; a missing menu or payment fails closed), read in one read-only transaction. It is a **hint, never the authority**: `POST /orders/{orderId}/cancel` decides again and may still answer `409`. `refund` is the order's latest refund (the same safe summary as above) and is absent when the order has none; a payment captured after cancellation (late capture) therefore reads as `status: cancelled`, `paymentStatus: paid` and a refund. An unreadable refund document is left out rather than failing the read. Nothing about the provider, payment, audit or idempotency is exposed. The order history list (`GET /orders`) does not carry these blocks.


## Organization order pickup

Handing a `ready` order to the customer who comes to collect it
(`functions/src/routes/organizationOrders.ts` +
`functions/src/domain/orderPickup.ts` +
`functions/src/domain/pickupCredential.ts`):

```
GET  /orders/{orderId}/pickup-credential           (the customer: shows it)
POST /organizations/{organizationId}/pickups       (staff: redeem it)
```

```
ready --pickup(credential)--> picked_up --complete--> completed
```

### The credential

What the customer shows is a **pickup credential**, in two forms of the same
proof:

| Form | Looks like | Strength | Used for |
| ---- | ---------- | -------- | -------- |
| QR payload | `ZP1.<orderId>.<proof>` | 128 bits | scanning; names its own order |
| Backup code | `K7QX-4M2P` | 40 bits (8 Crockford-base32 characters) | reading out and typing; does not name its order |

Both are HMAC-SHA256 of the order's ID under a server-only secret
(`PICKUP_CREDENTIAL_SECRET`, Cloud Secret Manager in production, `functions/.secret.local`
locally; at least 32 characters; never the same value as a Razorpay secret),
with different domain-separation strings so that learning one reveals nothing of
the other. It is **derived on demand and never stored** — not in Firestore, not
in a log line, not in a URL, not in any API response other than the one below,
and the frontend must keep it in memory only (never `localStorage`,
`sessionStorage`, IndexedDB or a query string). It carries no customer, payment or
provider data and is not a reversible encoding of the order ID (which is not
secret: it is in URLs and the staff table). A typed code is forgiving the way a
person needs it to be — case-insensitive, spaces and hyphens ignored, `O`/`I`/`L`
read as `0`/`1`/`1` — a QR payload is exact. Rotating the secret invalidates every
outstanding credential at once; the `ZP1` prefix versions the format.

There is no expiry: a credential is valid exactly while its order is `ready` and
paid, and the first successful pickup kills it (the order is then `picked_up`, and
the same credential changes nothing). A screenshot of a QR is therefore a bearer
credential until the order is collected — which is why staff see what was ordered
and the first successful use wins.

### `GET /orders/{orderId}/pickup-credential`

The **customer's** QR payload and backup code for their own ready order.

**Authorization is the order's customer, and nothing else.** `authenticateRequest`
gives the verified session user; the order is read from Firestore and its stored
`userId` compared with that user (`getOwnedOrder`). Knowing an order ID is not
enough: an unrelated customer gets `404`, indistinguishable from an order that
does not exist — and so does the organization's own owner, manager or staff, who
are shown the credential by the customer and never need to fetch it. The secret
is read only after ownership and state have passed.

Response (`200`): exactly `{ "pickup": { "qrPayload": "ZP1.…", "code": "K7QX-4M2P" } }`
— no customer identity, Descope ID, payment-provider data, audit field, or secret.
Only available while the order is `ready` and paid; otherwise `409 conflict` ("This
order isn't ready for pickup."). The same value on every fetch (a reloaded screen
shows the same QR); nothing is written. Errors: `400` (malformed `orderId`), `401`,
`404`, `409 conflict`, `503`. Like every response here it is `Cache-Control: private,
no-store`. It is deliberately not part of `GET /orders/{orderId}`, the history, or
any payment response.

### `POST /organizations/{organizationId}/pickups`

Body: `{ "credential": "<QR payload or typed code>", "outletId"?: "<outlet ID>" }`.
Any active `owner`/`manager`/`staff` member may call it (`ORDER_PICKUP_ROLES`; no
new role, no per-outlet permission). Only `credential` and `outletId` are read: a
`status`, `userId`, `organizationId`, `orderId` or `paymentStatus` in the body or
query is ignored.

It is a `POST .../pickups` and not a route under an order's ID because a typed
code does not carry an order ID — and because that keeps every `.../orders/{orderId}/…`
URL credential-free: **no URL that merely names an order can mark it picked up.**

**Authorization and checks**, each stopping the request if it fails:

1. `authenticateRequest` — `401`.
2. `requireOrganizationRole` with `ORDER_PICKUP_ROLES` — an **active** membership of
   the verified session user in the path's organization; non-members (including the
   customer who placed the order), `invited`, `revoked` and unknown-role members are
   all `403`.
3. The body is validated (`400`) — after authorization, so a non-member never learns
   whether theirs was well formed.
4. The credential's **format** is checked (`400`): a QR payload, or an 8-character
   code. The message never echoes the input.
5. Then, **inside one Firestore transaction**:
   1. the order exists and belongs to the caller's organization;
   2. the credential is genuine for it (constant-time comparison);
      — 1 and 2 are the **same `404`** ("No order awaiting pickup matches this
      code."), as are an unknown order and a typed code that matches nothing, so a
      caller learns nothing about orders they cannot open, and never that an order
      "exists but belongs to someone else";
   3. if `outletId` was sent, the order is that outlet's (`409`, "This order is for a
      different outlet.") — only reachable with a genuine credential. `outletId` can
      only *narrow*: membership is organization-wide, and the order's organization is
      checked regardless;
   4. the order is `ready` and `paymentStatus == "paid"` (`409`, with a message saying
      which of: not ready yet, not paid, cancelled, already picked up, already picked
      up and completed).
   Then `status`, `pickedUpAt` + `pickedUpBy` (the verified member) and `updatedAt`
   are written together.

**Verification and transition are one request.** There is no separate "verify"
call that returns a token for a later "commit" — nothing can happen between a check
and the write it justifies, and nothing can be replayed from a stale verification.

**A typed code.** It does not name its order, so before the transaction the
organization's own `ready` and `picked_up` orders (at most 500) are searched for the
one whose derived code matches. That search is only a *locator*, outside the
transaction on purpose (so one counter's lookup does not lock every awaiting order
against the others), and its answer is not trusted: the transaction re-reads that
single order and re-derives and compares the credential exactly as for a QR. A code
that matches none, or more than one, order (not realistic at 40 bits, but never
guessed about) is the same `404`; more than 500 candidates is refused rather than
searched partially. `picked_up` is included so that a repeat attempt is told
"already picked up"; once an order is `completed`, its code is simply no match.

**A second claim is a `409`, never a `200`.** Unlike the fulfillment actions, there
is no "already done, so succeed quietly": a second person presenting a credential for
an order that has already left is exactly the case staff must be told about, and a
success would read as "hand it over". Of two counters presenting the same credential
at once, exactly one write happens and the other is refused ("already been picked
up", or "just changed by someone else" if the transaction could not retry past the
contention). A client that loses its connection after sending cannot tell whether the
pickup was recorded; re-presenting the credential then gives a definitive answer.

Response (`200`): `{ "order": { … } }` — the order's row in the shape the list above
returns (no customer identity, no actor, no audit field, **no credential**). Errors:
`400 invalid_argument`, `401 unauthenticated`, `403 permission_denied`, `404
not_found`, `409 conflict`, `503 unavailable`. The request log carries the caller's
`userId` and only `{from, to, outcome, via: "qr" | "code"}` — never the credential.

**Audit.** The transition writes `pickedUpAt` + `pickedUpBy`, once, in the same
transaction; they are never overwritten and appear in no response. Completing the
order afterwards (`.../orders/{orderId}/complete`, above) writes `completedAt` +
`completedBy`.

**Indexes.** The typed-code search needs a third composite index on `orders`,
`COLLECTION_GROUP` scope: `organizationId` ascending + `status` ascending +
`createdAt` descending. It must be deployed (and READY) before the API that uses it;
the Firestore emulator does not enforce composite indexes, so it can only be confirmed
against real Firestore once deployed. The QR path needs no index (it resolves the order
with the existing `orders.id` lookup).

## Notifications

An in-app inbox, filled by the backend from order events — never by a client.
Nothing here creates a notification, and no request names a recipient: every
route reads and writes only the verified session's OWN inbox (`users/{userId}/notifications`,
the path carries the user), in one of two scopes:

- `/notifications...` — the caller's **customer** notifications (identity-scoped, like `/orders`).
- `/organizations/{organizationId}/notifications...` — the caller's notifications **for that
  organization**. Requires an active `owner`/`manager`/`staff` membership, checked on every
  request, so a revoked member is refused at once. The scope is the verified membership's
  organization, not the path as received.

### How a notification comes to exist

```
order transition (payment confirmed / preparing / ready / picked up / completed)
   │  same Firestore transaction as the status change
   ▼
notificationEvents/{orderId}_{eventType}        (the outbox: pending → processed | failed)
   │  Firestore onDocumentCreated trigger (onNotificationEventCreated, asia-south1, retry: true)
   ▼
policy → recipients → channels (in_app) → users/{userId}/notifications/{eventId}.{audience}
```

- The event is written by `markPaymentSucceeded`, `transitionOrderStatus` and `redeemPickup`,
  inside the transaction that commits the new status — so an event exists iff the transition
  committed. A repeated, refused or rolled-back transition writes none. Webhook replays and
  repeated Checkout verifications return before the write, so they record none either.
- Processing runs after the commit, in the trigger, and **can never fail or undo a transition**.
- Guarantee: **at-least-once processing with deterministic visible notification creation**
  (not exactly-once). IDs are deterministic and notifications are written with `create`
  semantics, so reprocessing neither duplicates a notification nor resets `readAt`.
- Retry: each run first counts an attempt. A transient failure records a bounded `lastError`
  and rethrows so the trigger retries with backoff; the 5th failed attempt, or a permanent
  failure (malformed event, an order that does not match, more than 200 active members), marks
  the event `failed`, logs an error, and returns — no hot loop. A `failed` event stays for a
  human; reprocessing it by hand is safe.
- Who is told what (`domain/notificationPolicy.ts`): the customer gets "Order confirmed",
  "Being prepared", "Ready for pickup" and "Picked up". `order_completed` is recorded but shows
  no notification. The organization's active owners, managers and staff get one `new_order`
  notification on `order_confirmed`, and nothing else. Copy names the outlet; it carries no
  order number, contact detail, payment data or credential.

### Cancellation and refund notifications

A cancellation and a refund are separate lifecycle facts with separate events, written in the
transaction that commits each (never collapsed into one):

```
cancelOrder  ──► order_cancelled_by_customer | order_cancelled_by_outlet   (`{orderId}_{type}`, always)
             └─► refund_requested                                          (`{refundId}_{type}`, only if money was captured)
refund settles ─► refund_completed | refund_failed                         (in the refund transition's transaction)
```

An unpaid cancellation therefore has the cancellation event only. `order_cancelled_by_system` is
supported by the policy but has no producer (no automatic cancellation exists yet). The cancellation
event carries `refundInitiated` (whether that transaction reserved a refund) so the copy can say so.

| Event | Customer | Organization |
| --- | --- | --- |
| `order_cancelled_by_customer` | — (they did it) | owners, managers, staff: "Order cancelled" |
| `order_cancelled_by_outlet` | "Order cancelled" (+ "A refund has been initiated." if one was started) | — |
| `order_cancelled_by_system` | "Order cancelled" (+ the refund sentence) | — |
| `refund_requested` | — consumed, no inbox document | — |
| `refund_completed` | "Refund processed … may take a few business days" | — |
| `refund_failed` | "Refund issue … contact support with your order ID" | owners and managers only: "Refund failed" |

Cancellation and refund events are not steps of the forward order progression and are never ranked
against it; the processor checks each against its own subject (the order is `cancelled` by that kind
of actor; the refund is the order's own, owned by that customer, and in the state the event reports).
A refund notification's ID is an opaque hash of its event ID, so the internal refund ID never reaches
a client. No copy carries an amount, a provider ID or error, or an internal identifier.

**Backlog sweep.** Refund events written by Checkpoint 7.5 before the processor consumed them stay
`pending` (the trigger fires only on creation). `domain/notificationBackfill.ts`
(`scripts/backfill-refund-notifications.mjs`) hands exactly those — refund event types, `status ==
pending`, document-ID order, bounded per page — to the same processor. It is idempotent, dry-run by
default, excludes the two protected production orders, and is not scheduled.

### Routes

| Route | |
| --- | --- |
| `GET …/notifications?limit=&cursor=&unread=true` | A page, newest first: `{notifications, nextCursor}`. Default 20, hard maximum 50. `unread=true` lists only unread ones. |
| `GET …/notifications/unread-count` | `{unreadCount}`, counted no further than 100. |
| `POST …/notifications/{notificationId}/read` | `{notification}`. Idempotent: an already-read notification is a `200` that keeps its original `readAt`. |
| `POST …/notifications/read-all` | `{updated, hasMore}`. Bounded batches (400 per transaction, 5 per call). |

A notification is `{id, type, title, body, orderId, createdAt, readAt}` (`readAt` is `null` while
unread). `orderId` is what a client builds its deep link from; nothing else internal is returned.

Errors: `401` unauthenticated; `400` for a malformed organization/notification ID, query value or
cursor; `403` for a caller who is not an active member of the organization (checked before the query
string is read); `404` for a notification that is not in the caller's own inbox in this scope — someone
else's, another scope's, and a missing one are indistinguishable.

The list needs two composite indexes on `notifications` (see `firestore.indexes.json`): `scope` ASC,
`createdAt` DESC, and `scope` ASC, `readAt` ASC, `createdAt` DESC. The emulator does not enforce them,
so they can only be confirmed against real Firestore once deployed.

## Explore (public customer discovery)

`GET /explore/outlets`, `GET /explore/outlets/{outletId}`, and
`GET /explore/outlets/{outletId}/menus/{menuId}` (`functions/src/routes/explore.ts`
+ `functions/src/domain/explore.ts`) are Zesto's first **customer-facing**
endpoints — everything above this section is organization-management only.
This is Step 9A of the roadmap: public read APIs only. There is no customer
React UI, cart, order, payment, GPS/location, or customer↔organization
affiliation yet, and this v1 uses **"Explore Outlets"**, deliberately not
"Nearby" — no geolocation feature exists yet, and `Outlet.location`
(latitude/longitude) is never returned by these endpoints.

### Public access model

These are the only three routes in this codebase that never call
`authenticateRequest`. They work identically:

- with no `Authorization` header at all,
- with a valid Descope session (the session is simply never inspected), and
- for a caller with no organization membership whatsoever.

Every other route (`/me`, `/organizations`, and all outlet/menu/menu-item
management routes) is untouched and remains fully authenticated exactly as
documented above. No new HTTP function and no router/auth-architecture
change was needed: this codebase's router has never enforced authentication
globally — every route file decides for itself whether to call
`authenticateRequest` (see [Authentication pipeline](#authentication-pipeline)
above) — so `routes/explore.ts` simply never does. Only `GET` is registered
for these three paths; any other method gets the router's normal `405
method_not_allowed`.

### Customer-visible filtering rules

- **Outlet:** visible only when `status === "active"`. Never exposed:
  `organizationId`, `slug`, `status`, `phone`, `location`, `createdBy`,
  `createdAt`, `updatedAt`. The address is reduced to `{ city?, state? }`
  only — `line1`, `line2`, and `postalCode` are never returned.
- **Menu:** visible only when `status === "published"` — a `draft` or
  `archived` menu is treated exactly like a nonexistent one. Never exposed:
  `organizationId`, `outletId`, `status`, `createdBy`, `createdAt`,
  `updatedAt`, `publishedAt`.
- **Menu item:** visible only when `enabled === true`; a disabled item is
  omitted completely (never returned with `enabled: false`). Ordered by
  `displayOrder` ascending, then `createdAt` ascending, matching the
  management endpoint's convention. Never exposed: `menuId`, `enabled`,
  `createdBy`, `createdAt`, `updatedAt`.
- **Price:** `priceInPaise` is always a non-negative integer, exactly as in
  the management API — never floating-point rupees (see root `CLAUDE.md`).

For the **default Explore feed** (`GET /explore/outlets`) and the **outlet
explore page** (`GET /explore/outlets/{outletId}`), a published menu must
additionally satisfy:

- `menuDate` is not before today in Zesto's business time zone
  (`functions/src/time.ts`'s `businessDateString`, Asia/Kolkata), and
- ordering has **not already closed** (`now < orderingClosesAt`).

Ordering has **not yet opened** is fine — a published menu is visible before
its ordering window opens and while it's open, just not once it's closed.
The **menu detail endpoint** (`GET .../menus/{menuId}`) is deliberately
looser: a known, direct link to an already-closed published menu still
resolves, read-only — only `draft`/`archived`/nonexistent menus 404 there.

`orderingState` (`"not_open" | "open" | "closed"`) is included on every
menu representation these endpoints return. It is derived on every request
from `orderingOpensAt`/`orderingClosesAt` versus the current instant — never
persisted in Firestore. Boundary semantics match the existing convention in
`domain/menuItems.ts`'s `findItemMutationViolation`: `"closed"` is inclusive
of the exact `orderingClosesAt` instant.

### `GET /explore/outlets`

The default customer discovery feed: one entry per active outlet that has
at least one upcoming, customer-visible published menu, paired with the
earliest such menu. `200` with

```jsonc
{
  "data": {
    "outlets": [
      {
        "id": "...", "name": "Main Canteen", "description": "...",
        "address": { "city": "Kasaragod", "state": "Kerala" },
        "nextMenu": {
          "id": "...", "menuDate": "2026-09-29", "title": "Tuesday Special Menu",
          "orderingOpensAt": "...", "orderingClosesAt": "...",
          "pickupStartsAt": "...", "pickupEndsAt": "...",
          "orderingState": "not_open"
        }
      }
    ]
  }
}
```

ordered by `nextMenu.menuDate` ascending, then that menu's `createdAt`
ascending, then (only to break an otherwise-exact tie) the outlet's `name`
then `id` ascending; `[]` if nothing qualifies.

### `GET /explore/outlets/{outletId}`

One active outlet and its upcoming customer-visible menus (no items). `404
not_found` if the outlet doesn't exist or isn't active — the same
secure-not-found behavior used throughout this codebase, so an anonymous
caller can never distinguish "doesn't exist" from "isn't visible to you."
`200` with

```jsonc
{
  "data": {
    "outlet": { "id": "...", "name": "...", "description": "...", "address": {"city": "...", "state": "..."} },
    "menus": [
      {
        "id": "...", "menuDate": "...", "title": "...", "description": "...",
        "orderingOpensAt": "...", "orderingClosesAt": "...",
        "pickupStartsAt": "...", "pickupEndsAt": "...", "orderingState": "..."
      }
    ]
  }
}
```

ordered by `menuDate` then `createdAt` ascending; `[]` if none qualify.

### `GET /explore/outlets/{outletId}/menus/{menuId}`

One customer-safe published menu and its enabled items. `404 not_found` if
the outlet doesn't exist/isn't active, the menu doesn't exist under that
outlet, or the menu isn't `published` (draft/archived/wrong-outlet/wrong-
organization are all indistinguishable 404s — never leaking which). `200`
with

```jsonc
{
  "data": {
    "outlet": { "id": "...", "name": "...", "description": "...", "address": {"city": "...", "state": "..."} },
    "menu": {
      "id": "...", "menuDate": "...", "title": "...", "description": "...",
      "orderingOpensAt": "...", "orderingClosesAt": "...",
      "pickupStartsAt": "...", "pickupEndsAt": "...", "orderingState": "...",
      "items": [
        { "id": "...", "name": "Chicken Biriyani", "description": "...", "priceInPaise": 12000, "displayOrder": 1 }
      ]
    }
  }
}
```

### Discovery query design

There is no global public-discovery collection: the existing hierarchy
(`organizations/{organizationId}/outlets/{outletId}/menus/{menuId}`) is
queried directly. `listExploreOutlets` (`domain/explore.ts`) runs one bounded
**collection-group** query over every outlet's `menus` subcollection —
`status == "published"`, `menuDate >= today`, ordered by `menuDate` then
`createdAt`, `limit(200)` — then resolves the candidate menus' parent
outlets with a single batched `db.getAll(...)` (the same "collection-group
query, then `getAll` the resolved parents" shape as
`domain/organizations.ts`'s `listOrganizationsForUser`). Inactive outlets,
already-closed menus, and duplicate outlets are then filtered/deduplicated
in memory, and the result is capped at 50 outlets. `GET
/explore/outlets/{outletId}` reuses the same composite index for a
single-outlet query (a `COLLECTION_GROUP`-scoped composite index also
serves an equivalent single-collection query on that collection ID).

Resolving `{outletId}` alone (the route carries no `organizationId`) uses a
collection-group query on `outlets` filtered by the outlet's own `id` field
(a field override enables this in `firestore.indexes.json`). Outlet IDs are
Firestore auto-IDs — effectively globally unique — so this should return at
most one match; if it were ever ambiguous, the lookup fails closed as
"not found" rather than guessing.

**Known v1 scalability limitation:** the 200-menu candidate scan and the
50-outlet result cap mean the default feed has no pagination. If more than
200 published, not-yet-closed future menus exist platform-wide before 50
distinct qualifying outlets are found (ordered by `menuDate` then
`createdAt`), an outlet whose only qualifying menu sorts after that cutoff
will not appear in the feed. This is acceptable for a v1 read path at
Zesto's current expected scale; a future iteration would need real
pagination (or a denormalized discovery collection) rather than a larger
hardcoded limit.

### New indexes for this step

`firestore.indexes.json` gained:

- A composite index: `menus`, `COLLECTION_GROUP` scope, `status` + `menuDate`
  + `createdAt` (all ascending) — powers both `/explore` menu queries above.
- A composite index: `items`, `COLLECTION` scope, `enabled` + `displayOrder`
  + `createdAt` (all ascending) — powers the menu-detail endpoint's
  enabled-items-only query (`hasEnabledMenuItem`'s existing bare
  `enabled == true` check needs no index, since it has no `orderBy`; this
  query does).
- A field override enabling collection-group indexing on `outlets.id`
  (ascending) — powers `{outletId}` resolution above.

No Firestore rules changed: these endpoints read exclusively through the
Admin SDK, which bypasses `firestore.rules` entirely, exactly like every
other route in this codebase (see `firestore.rules`'s own header comment).

## Refund orchestration

Internal, with one exception — the owner/manager retry of a failed refund ([Retrying a failed refund](#retrying-a-failed-refund)); there is no refund-status endpoint (cancellation responses and the order reads carry the safe refund summary). A refund is created `requested` by a cancellation or a late capture (see [Order cancellation](#order-cancellation)); `functions/src/domain/refundSubmission.ts`'s `submitRefund` is the ONE driver that moves it on with the provider, whoever calls it: the `onRefundCreated` Firestore trigger, the scheduled `reconcileRefunds` sweep, or a later route.

**Shape (a provider call is never inside a Firestore transaction).**

1. *Claim* (transaction): the refund must be live (`requested`/`pending`), not `attentionRequired`, due, and not leased. It takes a lease (`submitLeaseExpiresAt`, 2 minutes), counts the attempt (`submitAttempts`, `lastSubmitAt`) and sets `nextAttemptAt` to the lease's end, so a worker that dies leaves the refund findable. A second worker finds the lease and is turned away. An expired lease says nothing about the provider: the refund stays `requested`.
2. *Provider call* (no transaction): a first submission creates the refund with the deterministic idempotency key (`{orderId}-r{seq}`), receipt and notes carrying Zesto's IDs, speed `normal`. Any later attempt LOOKS UP FIRST (`listPaymentRefunds` + the 7.4 matcher: provider refund ID, then Zesto's refund ID in receipt/notes; never the amount alone) and only sends a create — with the same key — if the provider holds none of Zesto's. A `pending` refund is fetched by its provider ID instead.
3. *Result* (a separate transaction, `refundTransitions.ts`'s `applyRefundEvidence`): the refund, the payment's refund aggregates and the order's mirror move together, and one record is written under `refunds/{id}/transitions/{from}_to_{to}` (from, to, source `submit`/`lookup`/`webhook`/`reconciliation`/`adoption`, actor, time, webhook event key, provider status, failure code — IDs and codes only, never a provider payload). Valid moves: `requested → pending|processed|failed`, `pending → processed|failed`. Evidence for a state already held is a no-op, an older event after a terminal state is a stale no-op, and evidence that CONTRADICTS a terminal state is refused and recorded as an anomaly. Money: `pending` keeps the reservation, `processed` moves it from `refundPendingInPaise` to `refundedAmountInPaise`, `failed` releases it; `refunded + pending ≤ captured` always.

**Provider outcomes.**

| Outcome | Result |
|---|---|
| refund returned (`pending`/`processed`/`failed`) | applied as above |
| definitive rejection (`DEFINITIVE_FAILURE`) | `requested → failed`, reservation released, the provider's code kept as `failureCode` |
| `invalid_input` / `idempotency_key_conflict` | Zesto's own request was wrong: `attentionRequired`, **not** `failed` |
| timeout, dropped connection, unreadable answer, duplicate receipt, 5xx on the create (`AMBIGUOUS`) | stays `requested`; lease released; next attempt after 1m, 2m, 4m… (cap 1h), and it LOOKS UP first |
| 429 / other retryable | same backoff; never `failed` |
| missing or rejected credentials (`AUTH_CONFIGURATION`) | stays `requested`; retried every 15 minutes; never flagged or failed |
| a failed lookup | stays recoverable; no create is sent |
| lookup finds two refunds carrying Zesto's ID, or a same-amount refund with no Zesto identifier | `attentionRequired`; nothing adopted, nothing sent |

After 8 inconclusive attempts automatic work stops (`attentionRequired`, `nextAttemptAt` removed) — the refund is still not `failed`. A `failed` refund also sets `attentionRequired` (the customer's money has not come back); the payment's `refundState` and the order's `refundStatus` then read `attention_required` until a person clears it (clearing is a later checkpoint; creating a retry clears the flag when no other live refund is flagged).

**Reconciliation** (`reconcileRefunds`, every 15 minutes, `maxInstances: 1`; code only — enabling it needs the Cloud Scheduler API on the project and a deploy, which this checkpoint does not do). One bounded collection-group query: `status in (requested, pending)` and `nextAttemptAt <= now`, oldest first, at most 25. A new refund carries `nextAttemptAt = createdAt + 5 min` as a safety net for a lost trigger; a `pending` refund is rechecked every 6 hours as a backup to its webhook; a terminal or `attentionRequired` refund has no `nextAttemptAt` and is never selected. Each document's path is validated against `organizations/{o}/outlets/{ou}/menus/{m}/orders/{ord}/payments/{p}/refunds/{r}` (the refund ID must encode its order) and then its stored documents against that path; a malformed one is skipped and logged. It never creates a refund or chooses an amount. Two sweeps at once are safe (leases). A wall-clock budget (4 minutes) ends a run early.

**Refund events (the producer boundary for notifications).** Refund lifecycle facts are written to the SAME `notificationEvents` outbox the order lifecycle uses (same conventions: backend-only, deterministic ID, one buffered `set` inside the transition's own transaction, `status: pending`), keyed by the refund: `notificationEvents/{refundId}_{type}`.

| Type | Written when |
|---|---|
| `refund_requested` | a refund is created: a cancellation of a paid order, a payment captured after cancellation, or a retry of a failed refund |
| `refund_completed` | the refund reaches `processed` (by the submit driver, a lookup, a webhook or the reconciler) |
| `refund_failed` | the refund reaches `failed` (definitive rejection, or the provider reports it failed) |

Each carries `refundId`, `orderId`, `paymentId`, `organizationId`, `outletId`, `menuId`, `customerUserId`, `occurredAt` (the transition's own timestamp, equal to the refund's `createdAt`/`processedAt`/`failedAt`), `providerPaymentId`, `amountInPaise`, and `providerRefundId` once the provider has given one. Nothing about the customer beyond their user ID, no idempotency key, reason, failure message or audit data. A move to `pending`, a no-op repeat, a stale or contradictory event, an anomaly, an inconclusive attempt and an adopted external refund (provenance uncertain, flagged for a person) write no event. A transition and its event commit together or not at all, and because a refund reaches each state once, a duplicate webhook, a retry or a re-run transaction can never produce a second logical event. Consumers read these events, never the `transitions`/`anomalies` audit records. The notification processor consumes them (checkpoint 7.6): `notificationPolicy.ts` decides who is told what, and `refund_requested` is processed without any inbox document — see [Cancellation and refund notifications](#cancellation-and-refund-notifications).

**External / manual refunds.** A signed refund event (or a lookup) for a Zesto payment with no local refund document, and no Zesto identifier, is ADOPTED: a refund with reason `external`, source `reconciliation`, `attentionRequired: true`, its money booked like a refund of that status. It never cancels the order. If booking it would break `refunded + pending ≤ captured`, or the payment is not safely refundable, nothing is adopted: the payment is flagged and an `anomalies` record is written under it.

**Retry.** `refundRetry.ts`'s `createRefundRetry` (the one implementation; the owner/manager route [below](#retrying-a-failed-refund) is a thin wrapper around it) creates the next refund (`{orderId}-r{seq+1}`, source `retry`) only when the LATEST refund is `failed` and not external, for the whole remaining refundable amount, in one transaction; the failed attempt is never reopened.

**Required before this runs in production (not done in 7.5):** deploy the functions `onRefundCreated` and `reconcileRefunds` (the latter needs Cloud Scheduler), deploy the new Firestore indexes (`refunds`: `status`+`nextAttemptAt` composite; collection-group overrides on `refunds.providerRefundId` and `payments.providerPaymentId`), and add the three refund events to the Razorpay webhook subscription.

## Razorpay webhook

`POST /api/webhooks/razorpay` receives Razorpay's asynchronous payment
notifications and reconciles them with Zesto's own payment records. It is the
provider-driven counterpart of the customer's `POST /orders/{orderId}/payment/verify`:
Checkout verification gives the customer immediate confirmation, the webhook
makes sure a payment is still reconciled when the browser never gets to call
verify (closed tab, lost network). Both end in the **same** trusted domain
transitions (`markPaymentSucceeded` / `markPaymentFailed`), so the webhook can
never do anything the verified-Checkout path could not.

It lives on the existing `api` Cloud Function and router — there is no second
function — and is public at `https://zesto-dev-2026.web.app/api/webhooks/razorpay`
(HTTPS only, through the Hosting rewrite).

### Authentication: the signature, not a session

This is the only route that does **not** require a Descope session: Razorpay has
no Zesto user. It is authenticated by Razorpay's own signature instead, and it
ignores any `Authorization` header it is sent.

- Header: `X-Razorpay-Signature`.
- Algorithm (per Razorpay's webhook validation guidance): the hex HMAC-SHA256 of
  the **raw request body**, keyed with the **webhook secret**
  (`providers/razorpay.ts`'s `verifyWebhookSignature`), compared in constant time.
- This is a *different* operation from Checkout verification
  (`verifyCheckoutSignature`: HMAC over `orderId|paymentId`, keyed with the **API
  key secret**). Different input, different secret; neither can stand in for the
  other, and they are tested separately.

### Raw body handling

Razorpay signs the exact bytes it sends, so the HMAC must be computed over those
bytes — never over `JSON.stringify(JSON.parse(body))`, whose whitespace, key
order, escaping, and number formatting can differ.

The Firebase Functions runtime (both the deployed Functions Framework and the
local emulator) captures the original body through body-parser's `verify` hook
before parsing and exposes it as `request.rawBody` (a `Buffer`). The `api`
function copies it onto the normalized request (`http/request.ts` →
`NormalizedRequest.rawBody`) next to the parsed `body`; nothing re-parses or
re-serializes it. The webhook route HMACs that `Buffer` directly (bytes, not a
decoded string, so even non-UTF-8 input is verified exactly), and JSON is parsed
**only after** the signature verifies. The regression tests prove this over a real
HTTP socket with a body whose re-serialization differs byte-for-byte from what
was signed (`http/request.test.ts`).

### Webhook secret

`RAZORPAY_WEBHOOK_SECRET` is a **separate** secret from `RAZORPAY_KEY_SECRET`. It is
the signing secret chosen when the webhook is added in the Razorpay Dashboard
(Accounts & Settings → Webhooks).

| Where | Storage |
|---|---|
| Production | Firebase Secret Manager (`firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET`), bound to the `api` function's `secrets` array |
| Local emulator | one more line in `functions/.secret.local` |

It is never in source control, the frontend, Firestore, an API response, or a log
line. A missing secret is a server misconfiguration and surfaces as the generic
`500` — never as "invalid signature".

### Supported events

Subscribe to **only**:

- `payment.captured`
- `payment.failed`
- `refund.created`, `refund.processed` and `refund.failed` (from checkpoint 7.5; see
  [Refund webhooks](#refund-webhooks). Adding them to the Razorpay Dashboard subscription
  is a deployment step, not something the code does.)

Not `order.paid`: subscribing to both `payment.captured` and `order.paid` would
deliver two success events for one payment. Any other (valid, signed) event type
is acknowledged with `200` and never mutates anything. Events are handled by the
payment entity's own status in the payload, never by assumed delivery order.

### Pipeline

1. **Signature** over the raw bytes. Invalid → `401`; nothing is recorded.
2. **Parse** (zod): only `payment.id`, `payment.order_id`, `payment.amount`,
   `payment.currency`, and `payment.status` are read. Card, customer, bank, UPI,
   fee, and notes data in the payload are never read, stored, or logged.
3. **Deduplicate**: claim the event (below).
4. **Resolve** the Zesto payment by Razorpay's order ID (below) and **validate**
   it: provider, `providerOrderId`, currency, amount, and that the event's own
   payment status matches its type.
5. **Transition** through the existing trusted functions.
6. **Record** the event as processed — only now, after the transition.

### Deduplication

Razorpay retries deliveries, so processing is at-least-once and every effect is
idempotent.

- **Key**: Razorpay's documented per-event header `x-razorpay-event-id` →
  `razorpayWebhookEvents/evt_<id>`. If absent (or not a safe identifier), fall
  back to the SHA-256 fingerprint of the raw body → `body_<fingerprint>`. The
  fallback is deterministic for retries of the same payload, at the cost that two
  distinct events with byte-identical bodies would collapse into one (not expected:
  payloads carry `created_at` and distinct entities).
- The key is derived **after** the signature check and is never used to
  authenticate. Because the header is not covered by the HMAC, the body
  fingerprint is stored beside it: re-using a known event ID with a *different*
  body is `409 event_id_conflict`, never mistaken for a duplicate.
- **Claim** (one Firestore transaction): create the record as `processing` with a
  60-second lease. A second delivery while the lease is live gets a retryable
  `409 event_in_progress` (so a crash of the first can never lose the event); a
  `processed` record is a safe duplicate (`200`); an *expired* lease is re-claimed.
- The record becomes `processed` only after the payment transition completed. If
  processing throws, the claim is released and the delivery fails with `500` so
  Razorpay redelivers; the transition is idempotent, so redelivery is safe.
- Malformed or unsupported events are not recorded at all.

Event record (`razorpayWebhookEvents/{eventKey}`, a root collection — a webhook has
no authenticated customer): `id`, `eventType`, `keySource`, `bodyFingerprint`,
`status`, `attempts`, `receivedAt`, `claimedAt`, `leaseExpiresAt`, `processedAt`,
`outcome`, and Razorpay's own `providerOrderId` / `providerPaymentId`. Backend-only
(`allow read, write: if false`).

### Resolving the Zesto payment

A collection-group query on `payments.providerOrderId == payment.order_id`
(`firestore.indexes.json` field override; the ID is Razorpay's, set by
`ensureProviderOrder` before the customer could ever pay). Exactly one match is
required; the stored payment/order — never the webhook — decides the owner, the
amount, and the currency. No match → the event is not about Zesto: acknowledged,
nothing created.

### State behaviour

| Event | Payment now | Result |
|---|---|---|
| `payment.captured` | `pending` / `failed` | `markPaymentSucceeded`: payment `succeeded` + `providerPaymentId`, order `confirmed`/`paid`, atomically |
| `payment.captured` | `pending` / `failed`, order `cancelled` | **late capture**: payment `succeeded` + captured amount, the order stays `cancelled` (never reopened or confirmed), and the whole amount is reserved for a `requested` refund (`late_capture_after_cancel`), atomically — see [Order cancellation](#order-cancellation) |
| `payment.captured` | `succeeded` | idempotent no-op (e.g. browser verification got there first); a *different* Razorpay payment ID is reported, never overwritten |
| `payment.failed` | `pending` | `markPaymentFailed`: payment `failed` + `providerPaymentId`; the **order stays `pending_payment`** and payable |
| `payment.failed` | `failed` | idempotent no-op |
| `payment.failed` | `succeeded` | ignored — a late failure never moves a success backward |

A webhook can never change an order's total, items, customer, menu, or outlet, and
never confirms a payment whose amount, currency, or provider order ID differs.

### Responses

| Status | Meaning |
|---|---|
| `200` `{"data":{"received":true,"outcome":"…"}}` | processed, safe duplicate, or a valid event Zesto intentionally ignores (unknown type, not a Zesto payment, or a reported inconsistency such as an amount mismatch that no retry can fix) |
| `400` | signed but malformed payload, or no body |
| `401` | missing/invalid signature |
| `409` | the event is being processed right now (retryable), or its ID was re-used with a different body |
| `500` | transient/unexpected failure (e.g. Firestore): Razorpay retries; reconciliation is idempotent |

Inconsistencies (`rejected_*`, `success_conflicting_payment_id`, `event_id_conflict`)
are acknowledged (retrying cannot change them) but logged at error severity for
follow-up.

### Logging

The normal `api request` line (with `requestId`, route, status, duration) gains a
`context` of curated safe fields: `eventType`, `eventKey`, `outcome`,
`providerOrderId`, `providerPaymentId`. The webhook secret, API key secret,
`Authorization` header, signature, and webhook body are never logged.

### Refund webhooks

`refund.created`, `refund.processed` and `refund.failed` ride this same route, signature check and event-claim machinery; nothing about the steps above changes (HMAC over the raw bytes, claim/lease, body-fingerprint conflict). Any other event type, including `refund.speed_changed`, is acknowledged and ignored. Only the refund entity's `id`, `payment_id`, `amount`, `currency`, `status`, `receipt` and Zesto's two notes (`zestoRefundId`, `zestoOrderId`) are read; every other field is dropped by the schema.

The local refund is found by the provider refund ID first (a collection-group lookup on `refunds.providerRefundId`; two matches are `rejected_ambiguous_refund`), else — for a webhook that beats the create response — by Zesto's refund ID in the receipt/notes under the payment the event names. The refund, payment and order then move in one transaction (see [Refund orchestration](#refund-orchestration)). Outcomes: `refund_pending`, `refund_processed`, `refund_failed`, `refund_noop_already_in_state`, `refund_noop_stale_event`, `refund_adopted_external`, `refund_external_already_known`, `ignored_unrecognized_refund`, `ignored_refund_status_mismatch`, and the anomalies (logged at error severity) `rejected_refund_payment_mismatch`, `rejected_refund_amount_mismatch`, `rejected_refund_currency_mismatch`, `rejected_refund_id_mismatch`, `rejected_refund_contradicts_terminal_state`, `rejected_ambiguous_refund`, `rejected_ambiguous_payment`, `rejected_external_refund_not_applicable`. All are acknowledged with `200`.

A refund event whose `payment_id`, amount or currency differs from the stored refund, or whose status contradicts a terminal refund (`processed` after `failed`, `failed` after `processed`), is never applied: the refund and its payment are flagged `attentionRequired` and an `anomalies` record is written. A stale event (an older `pending` after a terminal state) is a no-op.

### Razorpay Dashboard configuration (Test Mode)

After this is deployed: Accounts & Settings → Webhooks → add

- URL: `https://zesto-dev-2026.web.app/api/webhooks/razorpay`
- Secret: a **new** value, entered directly into Secret Manager (never pasted into chat or source), different from the API key secret
- Active events: **`payment.captured`**, **`payment.failed`**, and (from checkpoint 7.5) **`refund.created`**, **`refund.processed`** and **`refund.failed`** — see [Refund webhooks](#refund-webhooks) and [Refund orchestration](#refund-orchestration)

Create `RAZORPAY_WEBHOOK_SECRET` in Secret Manager **before** deploying the `api`
function: the function now declares the secret binding, so a deploy without it
fails. Also deploy the new Firestore index (`firebase deploy --only firestore:indexes`)
before the first event arrives.

### Local testing

Add `RAZORPAY_WEBHOOK_SECRET=<any local value>` to `functions/.secret.local`, start
the emulators, and POST a body you signed yourself — the signature must be computed
over the exact string you send:

```
sig=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST http://127.0.0.1:5001/zesto-dev-2026/asia-south1/api/webhooks/razorpay \
  -H "Content-Type: application/json" -H "X-Razorpay-Signature: $sig" \
  -H "x-razorpay-event-id: evt_local_1" --data-binary "$BODY"
```

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

To check `/org/orders` by hand, `scripts/seed-org-orders.mjs` seeds an
organization you created through `/org/onboarding` with outlets (one inactive),
more than 50 orders in every status, and a second, unrelated organization. It is
**emulator-only**: it refuses to run unless `FIRESTORE_EMULATOR_HOST` is set to a
loopback address. Usage and options are in the header of the script, e.g.
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-org-orders.mjs --org-slug <slug>`
(`--as staff|manager|invited|revoked|owner` changes your own membership to try
each kind of member; `--clean` removes what it created).

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
