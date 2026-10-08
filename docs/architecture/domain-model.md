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

An **active** outlet is also readable by anonymous customers, in reduced
form, through the public `GET /explore/outlets[/{outletId}]` endpoints (see
[http-api.md](./http-api.md#explore-public-customer-discovery)) — `id`,
`name`, `description`, and only the `city`/`state` of `address`; never
`slug`, `phone`, `location`, or any audit field. There is no customer ↔
organization affiliation yet, and no GPS/location-based discovery.

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
list of `MenuItem`s. **A menu can be published only when it contains at
least one enabled menu item** — checked against the real, persisted
`MenuItem` documents at publish time (see [http-api.md](./http-api.md#menu-lifecycle)),
never trusted from client-supplied state.

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
field yet. See "MenuItem" below for how items attach to a menu. There is
no stock/inventory/remaining-quantity concept anywhere in this model,
matching Zesto's demand-driven design
(see "How these fit the demand-driven model" below) — quantity is
introduced later, at the `Order`/`OrderItem` level, as demand rather
than a reservation against this menu.

A **published** menu whose service date hasn't passed is also readable by
anonymous customers, in reduced form, through the public
`GET /explore/outlets/{outletId}[/menus/{menuId}]` endpoints (see
[http-api.md](./http-api.md#explore-public-customer-discovery)); a
`draft`/`archived` menu is never exposed there. The default customer
discovery feed additionally excludes a published menu whose ordering has
already closed, but a known direct link to it still resolves read-only.

### MenuItem
A single dish offered on a `Menu` — name, description, price, image,
display order, and an enabled/disabled flag. Business rules must
protect historical orders when menu item data changes: changing a
menu item's price, for example, must never alter the price already
recorded on an existing `Order`.

The first implementation (`functions/src/domain/menuItems.ts`,
[http-api.md](./http-api.md#menu-items)) keeps this minimal: `id`
(Firestore auto-ID), `menuId`, `name`, `description`, `priceInPaise`,
`enabled`, `displayOrder`, `createdAt`, `updatedAt`, `createdBy`. Unlike
`Menu` (which duplicates its own `organizationId`/`outletId`), an item does
**not** duplicate `organizationId`/`outletId`/`menuId`'s ancestors onto the
document — every request already re-resolves and re-validates the full
organization → outlet → menu chain before an item is ever touched, so
those fields would be redundant path metadata rather than load-bearing
data. `priceInPaise` is always a non-negative integer number of paise,
never a floating-point rupee amount (see root `CLAUDE.md`) — there is no
secondary rupee-price field. `name` is not required to be unique within a
menu (variants like "Chicken Biriyani" vs "Chicken Biriyani + Egg" are
expected). `enabled` defaults `true` and is independent of any inventory
concept (Zesto has none) — it is how an organization temporarily makes a
published menu's item unavailable without destroying it. No image field
exists yet (a later, separate capability).

Whether an item can be created, edited, enabled/disabled, or reordered
depends on its parent menu's lifecycle state and ordering window: always
allowed on a `draft` menu; allowed on a `published` menu only until
`orderingClosesAt`; never allowed on an `archived` menu. Hard deletion is
stricter still — allowed **only** while the parent menu is `draft`,
regardless of the ordering window; once a menu is published, an item can
only be disabled (`enabled: false`), never deleted, so historical menu/
order data is never destroyed. Reads are never gated by any of this.
Only an organization's `owner`/`manager` may create, edit, or delete an
item; any active member (including `staff`) may view it.

Only an **enabled** item on a customer-visible published menu is ever
returned by the public `GET /explore/outlets/{outletId}/menus/{menuId}`
endpoint (see [http-api.md](./http-api.md#explore-public-customer-discovery))
— a disabled item is omitted completely, not returned with
`enabled: false`, and `priceInPaise` stays an integer there too.

### Order
A customer's pre-order against a specific `Menu`. An `Order` records
who placed it, which `Outlet`/`Menu` it belongs to, its current
status, and the line items that make it up. Order ownership and status
are never trusted from the frontend — they are validated server-side.

Status today is `pending_payment` → `confirmed` (set only by a verified
payment) → `preparing` → `ready` (set by an active organization member
through the explicit fulfillment actions) → `picked_up` (set only by
redeeming the customer's pickup credential, see Pickup below) →
`completed` (set by a member once the order has been handed over), or
`cancelled`. `completed` and `cancelled` are terminal. Cancellation (by the
customer or by an owner/manager), the refund it reserves for a paid order, the
order's `refundStatus`/`refundedInPaise` mirror of the payment's refund
figures, and a payment captured after the cancellation are in
[http-api.md](./http-api.md#order-cancellation). How a refund is then
submitted to the provider, settled by webhook, recovered after a lost response and
reconciled is in [http-api.md](./http-api.md#refund-orchestration); a refund has
its own lifecycle (`requested` → `pending` → `processed`, or `failed`), independent
of the order's. The
fulfillment transitions, and who may make them, are in
[http-api.md](./http-api.md#organization-order-fulfillment); pickup is in
[http-api.md](./http-api.md#organization-order-pickup).

### OrderItem
A single line within an `Order`: a reference to the `MenuItem`
ordered, the **quantity representing demand** (not a stock
reservation), and the price captured at order time (so later menu
price edits do not retroactively change historical orders).

### Payment
The payment record associated with an `Order` — amount, method,
status, and any gateway reference. Payment status is authoritative
only when confirmed server-side, never from client state.

A payment reaches `succeeded` by exactly three server-side paths — Checkout
verification, the Razorpay webhook, and **payment reconciliation** (a
scheduled, read-only lookup of what the provider holds for the payment's own
provider order, for a capture Zesto never heard about) — all through the one
`markPaymentSucceeded` transition. Reconciliation state lives in an internal
`reconciliation` map on the payment (never in an API response) and an audit
subcollection `reconciliationAudit`; see
`docs/operations/payment-reconciliation.md`.

### Pickup
The collection event for an `Order` — when a customer collected their
food, and which organization member handed it over. It is not a separate
document: it is the `ready` → `picked_up` transition of the `Order`, with
`pickedUpAt`/`pickedUpBy` recorded on it. It is a privileged operation
validated server-side, never a frontend-only state change, and it is the
only transition that needs a credential.

The **pickup credential** is what the customer shows: a QR payload
(`ZP1.<orderId>.<proof>`, 128-bit proof) and a short backup code
(`K7QX-4M2P`, 40 bits). Both are HMAC-SHA256 values derived on demand from
the order's ID under a server-only secret (`PICKUP_CREDENTIAL_SECRET`) —
they are **never stored** (not in Firestore, not in logs, not in a URL, not
in browser storage) and carry no customer or payment data. Possession of
the credential proves nothing by itself: the server also requires an
authenticated, active member of the order's own organization, a `ready` and
paid order, and decides all of it inside one transaction. Once the order is
`picked_up` the same credential changes nothing, which is the replay
protection. See [http-api.md](./http-api.md#organization-order-pickup).

### Notification
A message sent to a `User` about their order or account — e.g. "order
confirmed," "ready for pickup," or, for an organization's members, "new order."
Stored in the recipient's own in-app inbox
(`users/{userId}/notifications/{eventId}.{audience}`), in either a `customer` or
an `org:{organizationId}` scope. Always created by the backend from a
`NotificationEvent`, never by a client. Delivery channels (`in_app` today;
browser push, email and mobile push later) are pluggable behind one interface.

### NotificationEvent
The outbox record for one fact. Order facts are keyed by the order (`{orderId}_{type}`): the forward lifecycle (`order_confirmed` … `order_completed`) and the cancellation (`order_cancelled_by_customer`, `order_cancelled_by_outlet`, `order_cancelled_by_system`). Refund lifecycle facts (`refund_requested`, `refund_completed`, `refund_failed`) are keyed by the refund (`{refundId}_{type}`) — see [http-api.md](./http-api.md#refund-orchestration). All are consumed by the same processor; `refund_requested` is consumed without producing any visible notification, because the cancellation notification already says a refund was started.

The outbox record of one order lifecycle transition
(`notificationEvents/{orderId}_{eventType}`: `order_confirmed`, `order_preparing`,
`order_ready`, `order_picked_up`, `order_completed`). Written in the same
transaction as the transition, carrying only the order's coordinates and its
customer; the order stays the source of truth. A Firestore trigger turns it into
`Notification`s. An event can exist without producing a visible notification
(`order_completed`). See [http-api.md](./http-api.md#notifications).

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
