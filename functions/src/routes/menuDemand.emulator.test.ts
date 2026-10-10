// @vitest-environment node
import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import type {SessionValidator} from "../auth/session";
import {createMenuItem, createMenuItemBodySchema} from "../domain/menuItems";
import {createMenu, createMenuBodySchema} from "../domain/menus";
import {createOrganization} from "../domain/organizations";
import {createOutlet} from "../domain/outlets";
import {handleRequest} from "../http/handleRequest";
import type {NormalizedRequest} from "../http/types";
import {businessDateString} from "../time";
import {createMenuRoutes} from "./menus";

/**
 * `GET .../menus/{menuId}/demand` against a REAL Firestore emulator: the real
 * `paymentStatus == "paid"` query, real order-document parsing, the
 * owner/staff/non-member matrix against real membership documents, and tenant
 * isolation. Descope stays faked. Menus here stay drafts, so nothing leaks into
 * the Explore feed other suites read.
 *
 * Run via `npm run test:functions-emulator` (repo root).
 */

const PROJECT_ID = "demo-zesto-functions-test";

let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:functions-emulator`.");
  }
  const app = getApps().length > 0 ? getApps()[0] : initializeApp({projectId: PROJECT_ID});
  db = getFirestore(app);
});

beforeEach(() => {
  vi.stubEnv("DESCOPE_PROJECT_ID", "P-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function acceptingValidator(userId: string): SessionValidator {
  return {
    validateSession: vi.fn(async () => ({jwt: "irrelevant", token: {sub: userId, aud: ["P-test"]}})),
  };
}

interface Fixture {
  organizationId: string;
  ownerId: string;
  outletId: string;
  menuId: string;
  biriyaniId: string;
  mealsId: string;
}

async function setup(): Promise<Fixture> {
  const ownerId = `U-${randomUUID()}`;
  const suffix = randomUUID();
  const {organization} = await createOrganization(db, ownerId, {name: `Canteen ${suffix}`, slug: `canteen-${suffix}`});
  const outlet = await createOutlet(db, organization.id, ownerId, {name: `Outlet ${suffix}`, slug: `outlet-${suffix}`});
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  const menu = await createMenu(db, organization.id, outlet.id, ownerId, createMenuBodySchema.parse({
    menuDate: businessDateString(new Date(tomorrow)),
    title: `Menu ${suffix}`,
    orderingOpensAt: new Date(now).toISOString(),
    orderingClosesAt: new Date(now + 60 * 60 * 1000).toISOString(),
    pickupStartsAt: new Date(tomorrow).toISOString(),
    pickupEndsAt: new Date(tomorrow + 4 * 60 * 60 * 1000).toISOString(),
  }));
  const biriyani = await createMenuItem(db, organization.id, outlet.id, menu.id, ownerId,
    createMenuItemBodySchema.parse({name: "Chicken Biriyani", priceInPaise: 12000, displayOrder: 0}));
  const meals = await createMenuItem(db, organization.id, outlet.id, menu.id, ownerId,
    createMenuItemBodySchema.parse({name: "Veg Meals", priceInPaise: 8000, displayOrder: 1}));
  return {organizationId: organization.id, ownerId, outletId: outlet.id, menuId: menu.id, biriyaniId: biriyani.id, mealsId: meals.id};
}

async function seedOrder(
  f: Fixture,
  status: string,
  paymentStatus: "pending" | "paid",
  lines: Array<[string, string, number]>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const ref = db.collection("organizations").doc(f.organizationId)
    .collection("outlets").doc(f.outletId)
    .collection("menus").doc(f.menuId)
    .collection("orders").doc();
  const items = lines.map(([itemId, name, quantity]) => ({itemId, name, priceInPaise: 1000, quantity, lineTotalInPaise: 1000 * quantity}));
  const total = items.reduce((sum, line) => sum + line.lineTotalInPaise, 0);
  const now = Timestamp.now();
  await ref.set({
    id: ref.id, userId: `U-${randomUUID()}`, organizationId: f.organizationId, outletId: f.outletId, menuId: f.menuId,
    status, paymentStatus, currency: "INR", subtotalInPaise: total, totalInPaise: total, items,
    createdAt: now, updatedAt: now, ...extra,
  });
}

function request(path: string): NormalizedRequest {
  return {method: "GET", path, headers: {authorization: "Bearer token"}, query: {}, body: undefined};
}

async function callDemand(f: Fixture, userId: string, organizationId = f.organizationId) {
  const routes = createMenuRoutes({db, validator: acceptingValidator(userId)});
  return handleRequest(routes, request(`/organizations/${organizationId}/outlets/${f.outletId}/menus/${f.menuId}/demand`), () => {});
}

describe("GET .../menus/{menuId}/demand (emulator)", () => {
  it("counts only paid, not-cancelled orders, per item, with 0 for items nobody ordered", async () => {
    const f = await setup();
    await seedOrder(f, "confirmed", "paid", [[f.biriyaniId, "Chicken Biriyani", 3]]);
    await seedOrder(f, "ready", "paid", [[f.biriyaniId, "Chicken Biriyani", 2]]);
    await seedOrder(f, "pending_payment", "pending", [[f.mealsId, "Veg Meals", 9]]);
    await seedOrder(f, "cancelled", "paid", [[f.mealsId, "Veg Meals", 7]], {
      cancelledAt: Timestamp.now(), cancelledBy: f.ownerId, cancelledByRole: "organization",
      cancelledFromStatus: "confirmed", cancellationReason: "outlet_closed",
    });

    const result = await callDemand(f, f.ownerId);

    expect(result.status).toBe(200);
    if (result.kind !== "success") throw new Error("expected success");
    const demand = (result.data as {demand: Record<string, unknown>}).demand;
    expect(demand).toMatchObject({
      menuId: f.menuId,
      paidOrders: 2,
      totalPortions: 5,
      items: [
        {itemId: f.biriyaniId, name: "Chicken Biriyani", portions: 5},
        {itemId: f.mealsId, name: "Veg Meals", portions: 0},
      ],
    });
    expect(typeof demand.computedAt).toBe("string");
  });

  it("lets staff read it, but not a non-member or another organization's member", async () => {
    const f = await setup();
    const staffId = `U-${randomUUID()}`;
    await db.collection("organizations").doc(f.organizationId).collection("members").doc(staffId)
      .set({userId: staffId, organizationId: f.organizationId, role: "staff", status: "active", createdAt: new Date()});
    expect((await callDemand(f, staffId)).status).toBe(200);

    expect((await callDemand(f, `U-${randomUUID()}`)).status).toBe(403);

    const other = await setup();
    // A member of another organization naming this organization's menu under their own organization.
    expect((await callDemand(f, other.ownerId, other.organizationId)).status).toBe(404);
  });
});
