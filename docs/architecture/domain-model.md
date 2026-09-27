# Zesto Domain Model

This document describes the core concepts in Zesto in plain technical
language. It is documentation only — no Firestore collections, schemas,
or persistence are created by this document.

Zesto's core promise is **"Know the demand before you cook."** A menu
normally represents a *future* planned service (commonly "tomorrow's
menu"). Customers browse that future menu and place pre-orders, which
represent **demand** — a quantity a customer intends to collect, not a
reservation against limited stock. Organizations use the aggregate of
that demand to decide how much food to prepare. There is no default
concept of remaining stock, inventory depletion, or stock reservation
unless a future requirement explicitly introduces one.

## Entities

### User
A person who has authenticated with Zesto. A `User` may act as a
customer, as a member of one or more organizations, or both. Identity
comes from Descope; see `docs/architecture/authentication.md`.

### Organization
A business entity on the platform — a canteen, café, restaurant, or
college food outlet operator. An `Organization` owns one or more
`Outlet`s and is the billing/subscription unit.

The first implementation (`functions/src/domain/organizations.ts`,
[http-api.md](./http-api.md#organizations)) keeps this minimal: `id`
(Firestore auto-ID), `name`, `slug`, `createdAt`, `createdBy`. `slug` is
globally unique and **immutable for now** — reserved atomically via
`organizationSlugs/{slug}` in the same transaction that creates the
organization and its owner membership, so no organization or membership is
ever created without a reserved slug, or vice versa. `createdBy` records who
created the organization; it is not necessarily the current owner, since
ownership (an `OrganizationMember` with `role: 'owner'`) could in principle
be transferred later. No `status` field exists yet — every organization that
exists is implicitly active — and no billing/subscription/outlet fields
exist yet either; those are future requirements, not part of this feature.

### OrganizationMember
A `User` granted a role (e.g. owner, manager, staff) within an
`Organization`. Roles determine which organization capabilities
(publishing menus, editing items, viewing analytics, etc.) a member
may exercise.

### Outlet
A physical or logical point of service belonging to an `Organization`
— e.g. a specific canteen counter or café branch. Menus, orders, and
pickup happen in the context of an `Outlet`.

The first implementation (`functions/src/domain/outlets.ts`,
[http-api.md](./http-api.md#outlets)) keeps this minimal: `id` (Firestore
auto-ID), `organizationId`, `name`, `slug`, `description`, `status`
(`active`/`inactive`), `phone`, `address`, `location`, `createdAt`,
`updatedAt`, `createdBy`. `slug` is unique only within the parent
organization (reserved atomically via
`organizations/{organizationId}/outletSlugs/{slug}`, the same pattern an
organization's own slug uses) and **immutable for now**. Only an
organization's `owner`/`manager` may create or edit an outlet; any active
member (including `staff`) may view the list.

### OutletMember
A `User` granted a role scoped to a single `Outlet`, for staff who
work at one location rather than across the whole organization.

### Menu
A menu normally represents a **future** planned service for a
specific `menuDate` at an `Outlet` — commonly tomorrow's menu. A menu
has a 3-state lifecycle (draft → published → archived) and a
schedule: when ordering opens, when ordering closes, and the pickup
window. "Ordering open" vs. "ordering closed" is not a separate stored
state — it is computed from the current time against
`orderingOpensAt`/`orderingClosesAt`, never persisted. A menu owns a
list of `MenuItem`s.

The first implementation (`functions/src/domain/menus.ts`,
[http-api.md](./http-api.md#menus)) keeps this minimal: `id` (Firestore
auto-ID), `organizationId`, `outletId`, `menuDate` (a calendar date
string, `YYYY-MM-DD`, not a timestamp), `title`, `description`,
`status` (`draft`/`published`/`archived`, only `draft → published →
archived` allowed, each an explicit lifecycle action — never an
arbitrary `PATCH` of `status`), `orderingOpensAt`, `orderingClosesAt`,
`pickupStartsAt`, `pickupEndsAt`, `createdAt`, `updatedAt`, `createdBy`,
`publishedAt`. Zesto's business time zone is hardcoded to Asia/Kolkata
for v1 (`functions/src/time.ts`) — there is no per-outlet time zone
field yet. `MenuItem` is **not** part of this implementation; menu
items are a later step. There is no stock/inventory/remaining-quantity
concept anywhere in this model, matching Zesto's demand-driven design
(see "How these fit the demand-driven model" below) — quantity is
introduced later, at the `Order`/`OrderItem` level, as demand rather
than a reservation against this menu.

### MenuItem
A single dish offered on a `Menu` — name, description, price, image,
display order, and an enabled/disabled flag. Business rules must
protect historical orders when menu item data changes: changing a
menu item's price, for example, must never alter the price already
recorded on an existing `Order`.

### Order
A customer's pre-order against a specific `Menu`. An `Order` records
who placed it, which `Outlet`/`Menu` it belongs to, its current
status (e.g. placed, paid, ready, collected, cancelled), and the line
items that make it up. Order ownership and status are never trusted
from the frontend — they are validated server-side.

### OrderItem
A single line within an `Order`: a reference to the `MenuItem`
ordered, the **quantity representing demand** (not a stock
reservation), and the price captured at order time (so later menu
price edits do not retroactively change historical orders).

### Payment
The payment record associated with an `Order` — amount, method,
status, and any gateway reference. Payment status is authoritative
only when confirmed server-side, never from client state.

### Pickup
The collection event for an `Order` — when and how a customer
collected their food (by order ID or QR code), and who marked it
collected. Pickup completion is a privileged operation validated
server-side, not a frontend-only state change.

### Notification
A message sent to a `User` about their order or account — e.g. "menu
published," "order confirmed," "ready for pickup." Delivered via
push (Firebase Cloud Messaging) and/or in-app.

### DemandSnapshot
An aggregated view of demand for a `Menu` — total quantity requested
per `MenuItem`, generally as of ordering close. This is what
organizations use to plan preparation; it is a read model derived
from `Order`/`OrderItem` data, not a separate source of truth.

### AnalyticsSnapshot
A point-in-time aggregate used for organization-facing analytics
(e.g. demand trends over time, popular items, order volume). Derived
data, recomputed or cached — not hand-edited.

### Subscription
The billing/plan record for an `Organization` — which plan it is on,
its status, and any limits that plan implies. Distinct from a
customer's food order.

### AuditLog
An immutable record of privileged actions taken on the platform
(e.g. a menu published, a price changed, an order marked collected,
a member's role changed) — who did what, when, and to what entity.
Used for accountability and dispute resolution.

## How these fit the demand-driven model

```
Organization publishes a future Menu (with MenuItems)
        │
        ▼
Customers browse the Menu and place Orders (OrderItems = demand)
        │
        ▼
Ordering closes → DemandSnapshot reflects total demand per MenuItem
        │
        ▼
Organization prepares food based on demand, not pre-set stock
        │
        ▼
Customers collect via Pickup (order ID or QR)
        │
        ▼
AnalyticsSnapshot accumulates over time for planning future menus
```

Customers generate demand by ordering quantities of planned meals;
organizations consume that demand to decide preparation quantities.
There is intentionally no inventory/stock-decrement concept in this
model.
