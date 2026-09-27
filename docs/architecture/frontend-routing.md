# Frontend routing and the organization gate

This document covers how `src/app/routes.tsx` decides which shell to render,
and in particular how the organization area (`/org/*`) resolves onboarding
vs. the existing organization dashboard. For the backend endpoints involved,
see [http-api.md](./http-api.md#organizations); for the entities, see
[domain-model.md](./domain-model.md).

## Top-level shells

`src/app/routes.tsx` maps each top-level path to a shell:

- `/` and `/login` — `PublicLayout`, no auth required.
- `/app/*` — `RequireAuth` + `CustomerAppLayout` (bottom tab navigation).
- `/org/*` — `RequireAuth` + `OrganizationGate`.

`RequireAuth` is a UX-only gate driven by the Descope session (see
[authentication.md](./authentication.md)); it says nothing about
organization membership.

## The organization gate

`src/layouts/OrganizationGate.tsx` is what actually decides what `/org/*`
renders. Unlike `RequireAuth`, its decision is **data-driven**, not just a
static route match: it loads the caller's organizations
(`GET /organizations`, via `src/features/organization/useOrganizations.ts`)
and branches on the result:

| State | `/org/onboarding` | any other `/org/*` path |
| --- | --- | --- |
| loading | `LoadingState` | `LoadingState` |
| fetch failed | `ErrorState` + retry | `ErrorState` + retry |
| zero active organizations | `OrganizationOnboardingPage` | redirect to `/org/onboarding` |
| one or more active organizations | redirect to `/org/dashboard` | `OrganizationAppLayout` (unchanged) |

`OrganizationAppLayout` and its child pages (`dashboard`, `menus`, `orders`,
`analytics`, `settings`) are unmodified by this gate — they are simply
mounted or not, based on the table above.

After `POST /organizations` succeeds, the client uses the organization and
membership objects the response already contains to update
`useOrganizations`'s local state directly, then navigates to
`/org/dashboard`. `GET /organizations` is deliberately not re-fetched at
that point.

## Routes stay paramless for now

The organization routes are currently `/org/onboarding`, `/org/dashboard`,
`/org/menus`, `/org/orders`, `/org/analytics`, `/org/settings` — with no
`:organizationId` segment. This is intentional, not an oversight: today a
user can only ever end up as a member of the one organization they created
(there is no invitation flow yet), so there is nothing to switch between.

**Organization switching and a global "current organization" are
intentionally deferred.** No context or store holds a "current organization"
anywhere in the frontend. If a future requirement introduces multiple
organizations per user with UI that needs to distinguish between them, the
expected shape of that change is:

1. add `:organizationId` to the routes under `OrganizationAppLayout`;
2. read it via `useParams()` where a page needs to know which organization
   it's scoped to (the URL is the natural source for this — no new state
   management primitive is needed for that alone);
3. any actual authorization for organization-scoped data still happens
   server-side (`requireOrganizationRole`, per
   [authentication.md](./authentication.md)) — the frontend route param is
   only ever a display/routing concern, never an authorization source.

## Slug immutability

The slug entered during onboarding is sent once, at organization creation,
and is immutable thereafter — there is no slug-edit UI, matching the
backend, which has no slug-edit endpoint (see
[http-api.md](./http-api.md#post-organizations)). The frontend only
*suggests* a slug from the organization name (`src/utils/slug.ts`); the
backend remains the sole authority on whether a given slug is valid or
already taken.
