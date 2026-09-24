# Zesto Engineering Rules

## Product

Zesto is a multi-tenant SaaS platform for canteens, cafés,
restaurants, college food outlets, and similar businesses.

Core promise:

> Zesto — Know the demand before you cook.

Zesto collects customer demand for future planned meals.

The organization normally publishes the next day's menu after
the current day's operational cycle.

Customers can pre-order planned meals before the ordering deadline.

The core quantity is DEMAND, not inventory.

Customers normally may order any quantity permitted by the
business rules.

Do NOT implement stock decrement or inventory reservation unless
a future requirement explicitly introduces it.

## Organization capabilities

Organizations can:

- create menus
- edit menus
- publish menus
- edit menu dates
- edit ordering times
- edit pickup times
- add menu items
- edit menu items
- delete menu items
- enable menu items
- disable menu items
- control overall menu availability
- monitor orders
- view demand
- view analytics

## Customer capabilities

Customers can:

- create an account
- discover affiliated food outlets
- browse future menus
- select quantities
- place pre-orders
- pay
- cancel eligible orders
- receive notifications
- view order history
- collect using order ID or QR

## Technology

Use:

- TypeScript
- React
- Vite
- Ionic React
- Tailwind CSS 4
- React Router with Ionic-compatible routing
- Firebase
- Firebase Authentication
- Firestore
- Firebase Storage
- Firebase Cloud Functions
- Firebase Cloud Messaging
- OTPLESS
- Capacitor 8
- Git
- GitHub
- GitHub Actions
- Zod
- React Hook Form
- Vitest
- React Testing Library
- Firebase Emulator Suite

## Important architecture rules

Never trust the frontend for security.

Never expose secrets in frontend code.

Never use client-side data as the authoritative source for:

- prices
- payment status
- order ownership
- authorization
- pickup completion
- critical business rules

Privileged operations must eventually be validated server-side.

Do not add major dependencies without a clear reason.

Do not rewrite unrelated code.

Do not use `any` just to silence TypeScript.

Do not weaken TypeScript settings.

Do not claim tests passed unless they were actually run.

Do not claim a build succeeded unless it actually succeeded.

## Demand-driven ordering

Zesto is NOT primarily an inventory-reservation system.

Customers normally order quantities representing demand.

Example:

Customer A → Chicken Biriyani × 3
Customer B → Chicken Biriyani × 2
Customer C → Chicken Biriyani × 10

Zesto records demand of 15 portions.

Do not implement stock decrement by default.

There is no default concept of:

- remaining stock
- stock reservation
- inventory depletion

unless a later business requirement explicitly introduces one.

## Menu lifecycle

A menu normally represents a future menu, commonly tomorrow's menu.

Example:

September 24:
organization publishes September 25 menu.

September 24–25:
customers pre-order.

September 25:
ordering closes.

Organization sees final demand.

Food is prepared.

Customers collect orders.

The next menu cycle begins.

## Menu editing

Organizations can edit menu-level information such as:

- menu date
- title
- description
- publish time
- ordering-open time
- ordering deadline
- pickup start
- pickup end
- menu state

Organizations can edit menu items:

- name
- description
- price
- image/icon
- display order
- enabled state

Organizations can also add and delete items.

Business rules must protect historical orders when menu data changes.

For example, changing a menu item's price must not change the price
already recorded on existing orders.

## Prototype reference

A previous KMCTCEM Café prototype may exist in:

reference/kmctcem-prototype/

It is reference material only.

Use it to understand:

- interaction patterns
- customer ordering behavior
- menu management
- order presentation
- responsive behavior
- organization/admin workflows
- loading states
- error states

Do NOT copy:

- the old multi-page architecture
- old Firebase configuration
- old authentication
- old Firestore schema
- old CSS architecture
- old Firebase CDN imports
- old callable function names as architectural requirements

Rebuild useful behavior using Zesto's new architecture.

## AI development workflow

Before modifying code:

1. Inspect the existing relevant code.
2. Explain the intended change.
3. Make the smallest coherent change.
4. Do not modify unrelated files.
5. Run appropriate validation.
6. Report exactly what changed.
7. Report actual test/build results.
8. Mention unresolved issues honestly.