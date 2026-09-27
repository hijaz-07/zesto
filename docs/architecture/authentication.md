# Authentication and data access

Descope is Zesto's **sole identity and session provider**. Firebase is
used for data and backend services only (Firestore, Cloud Functions,
Storage, Hosting, Emulator Suite). Firebase Authentication is not used,
and there is no Firebase custom-token bridge.

This document covers the authentication boundary itself. For the HTTP API
that sits behind it (routing, response envelope, `/me`), see
[http-api.md](./http-api.md).

## Client (web / Capacitor)

- `src/features/auth/AuthProvider.tsx` wraps Descope's `AuthProvider`
  (`@descope/react-sdk`) and exposes Zesto's stable `useAuth()` contract:
  `user`, `status` (`initializing` | `signedIn` | `signedOut`),
  `isAuthenticated`, `signOut`.
- The Descope SDK restores, refreshes, persists, and clears session
  tokens itself. App code never reads or stores tokens.
- `/login` (`src/pages/LoginPage.tsx`) embeds the Descope flow
  `sign-up-or-in` (SMS OTP → verify → new-user details). The flow's
  screens are owned by the Descope console, not the app.
- `RequireAuth` is **UX only**. It keeps signed-out users out of
  authenticated shells; it protects no data.
- The Descope Project ID comes from `VITE_DESCOPE_PROJECT_ID` (public
  identifier). No Descope secret ever goes into a `VITE_*` variable.

## Backend (Cloud Functions)

- `functions/src/auth/descopeClient.ts` — the Descope Node SDK client,
  configured from the `DESCOPE_PROJECT_ID` Functions param.
- `functions/src/auth/session.ts` — the authentication boundary.
  `verifyDescopeSession` / `authenticateRequest` validate the session JWT
  server-side (signature against Descope's published keys, expiry,
  issuer, **audience**) and return the caller's Descope user ID. Any
  failure becomes `HttpsError("unauthenticated")`.
- **Audience:** every validation passes
  `validateSession(token, { audience: DESCOPE_PROJECT_ID })`, and the
  boundary re-checks `aud` itself afterward. The expected audience comes
  only from backend configuration. Nothing in a request (header, body,
  query, or client code) can supply or influence it. Descope's default
  session `aud` is the Project ID. If a Descope JWT template ever
  customizes `aud`, the backend's expected audience must be updated with
  it, or every session will be rejected.
- `functions/src/auth/membership.ts` — tenant authorization.
  `requireOrganizationRole` requires an **active** membership at
  `organizations/{organizationId}/members/{userId}` with an allowed role.

Every protected operation must:

1. authenticate the caller with `verifyDescopeSession`,
2. take the caller's identity **only** from the verified session, never
   from request data,
3. authorize tenant access with `requireOrganizationRole` where the
   operation is organization-scoped, and
4. only then read or write Firestore with the Admin SDK.

**401 vs 503:** `verifyDescopeSession` / `authenticateRequest` throw
`HttpsError("unauthenticated", ...)` (→ 401) when the token itself is
rejected — missing, malformed, expired, wrong signature, or wrong audience —
and `HttpsError("unavailable", ...)` (→ 503) when the session could not be
validated at all because of an infrastructure failure (e.g. Descope's
signing keys could not be fetched). These must not be confused: a 401 means
"this session is invalid," a 503 means "we couldn't check." In particular,
**the frontend must never sign the user out in response to a 503** — only
to a 401. See [http-api.md](./http-api.md#descope-401-vs-503) for how the
distinction is actually detected (the SDK gives us only an error message to
go on) and `functions/src/auth/session.test.ts` for both directions.

**Revocation caveat:** validation is offline (signature, expiry, audience)
and doesn't ask Descope whether a session was revoked. Signing out clears
the client's tokens, but a session JWT copied before sign-out stays valid
until it expires (the session token observed locally had a 10-minute
lifetime, set in the Descope project's session settings). Operations that need immediate revocation will need an
online check in addition to this boundary.

**Transport:** the client sends `Authorization: Bearer <session JWT>` to
HTTPS (`onRequest`) functions. `onCall` callables are not used for
Descope-authenticated operations: the callable protocol treats the
Authorization header as a Firebase Auth ID token and rejects anything
else before the handler runs.

## Firestore access model

Firestore Security Rules can only see Firebase Authentication identities
(`request.auth`). With Descope as the identity provider, `request.auth`
is `null` for every legitimate Zesto client. A non-null `request.auth`
could only come from a Firebase Auth sign-in outside Zesto, so it must
never be treated as a Zesto user.

Therefore:

- `firestore.rules` grants **no** client access based on `request.auth`.
  `users`, `organizations`, and `organizations/*/members` are
  client-deny, and everything else is deny-by-default.
- All protected reads and writes go through Cloud Functions (steps 1–4
  above). The Admin SDK bypasses the rules, so schema validation and
  immutability checks the rules used to perform (e.g. user profile
  fields, immutable `id` / `createdAt`) must be enforced in the function
  code, for example with Zod.
- Direct client reads may be re-opened later only for data that needs
  **no identity** (for example, published menus), justified per
  collection. They must not rely on `request.auth`.

## Organization membership

- Path: `organizations/{organizationId}/members/{userId}`, where
  `userId` is the Descope user ID.
- Roles `owner` / `manager` / `staff` are tenant-scoped fields on the
  membership document. There are no global custom claims (neither
  Firebase nor Descope roles are used for tenant authorization).
- Membership is written only by trusted backend code. Clients cannot
  read or write it directly.

## Configuration

| Where | Variable | Notes |
| --- | --- | --- |
| Web (`.env.local`) | `VITE_DESCOPE_PROJECT_ID` | Public. `.env.local` is gitignored. |
| Functions (`functions/.env.local`) | `DESCOPE_PROJECT_ID` | Public, read via `defineString`. Also the expected session audience. |
| Functions (Secret Manager) | future management key | Must use `defineSecret()`. Never `VITE_*`. |

## Local development setup

Both sides must point at the **same** development Descope project.

1. Frontend: add to your existing `.env.local` (repo root, gitignored):

   ```
   VITE_DESCOPE_PROJECT_ID=<real development Descope Project ID>
   ```

2. Backend: create `functions/.env.local` (gitignored, loaded by the
   Functions emulator):

   ```
   DESCOPE_PROJECT_ID=<same real development Descope Project ID>
   ```

Rules:

- Never commit either file. Only the `.local` variants are gitignored.
  `.env`, `functions/.env`, and `functions/.env.<project>` are **not**,
  so don't put real values there.
- Never put `DESCOPE_PROJECT_ID`, or any backend Descope setting or
  secret, in a `VITE_*` variable. Vite embeds every `VITE_*` value in
  the public frontend bundle.
- If the two values differ, users can sign in on the frontend, but every
  backend call fails the audience check and returns `unauthenticated`.
- The frontend fails fast with a clear error if `VITE_DESCOPE_PROJECT_ID`
  is missing. The backend throws `DESCOPE_PROJECT_ID is not configured.`
  (a server error, not a 401) if its value is missing.
