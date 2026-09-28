// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {
  computeOrderingState,
  toCustomerMenuResponse,
  toExploreOutletsEntryResponse,
  toPublicOutletSummary,
  type ExploreOutletsEntry,
  type PublicMenuSummary,
} from "./explore";
import type {MenuItem} from "./menuItems";
import type {Menu} from "./menus";
import type {Outlet} from "./outlets";

const ORG_ID = "org-1";
const OUTLET_ID = "outlet-1";
const MENU_ID = "menu-1";

function ts(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

const baseOutlet: Outlet = {
  id: OUTLET_ID,
  organizationId: ORG_ID,
  name: "Main Canteen",
  slug: "main-canteen",
  status: "active",
  createdAt: ts("2026-09-01T00:00:00Z"),
  updatedAt: ts("2026-09-01T00:00:00Z"),
  createdBy: "U-owner",
};

const baseMenu: Menu = {
  id: MENU_ID,
  organizationId: ORG_ID,
  outletId: OUTLET_ID,
  menuDate: "2026-09-29",
  title: "Tuesday Special Menu",
  status: "published",
  orderingOpensAt: ts("2026-09-28T04:00:00Z"),
  orderingClosesAt: ts("2026-09-28T10:00:00Z"),
  pickupStartsAt: ts("2026-09-29T06:00:00Z"),
  pickupEndsAt: ts("2026-09-29T10:00:00Z"),
  createdAt: ts("2026-09-27T00:00:00Z"),
  updatedAt: ts("2026-09-27T00:00:00Z"),
  createdBy: "U-owner",
  publishedAt: ts("2026-09-27T01:00:00Z"),
};

const baseItem: MenuItem = {
  id: "item-1",
  menuId: MENU_ID,
  name: "Chicken Biriyani",
  priceInPaise: 12000,
  enabled: true,
  displayOrder: 1,
  createdAt: ts("2026-09-27T00:00:00Z"),
  updatedAt: ts("2026-09-27T00:00:00Z"),
  createdBy: "U-owner",
};

describe("computeOrderingState", () => {
  const schedule = {
    orderingOpensAt: ts("2026-09-28T04:00:00Z"),
    orderingClosesAt: ts("2026-09-28T10:00:00Z"),
  };

  it("is not_open strictly before orderingOpensAt", () => {
    expect(computeOrderingState(schedule, new Date("2026-09-28T03:59:59.999Z"))).toBe("not_open");
  });

  it("is open exactly at orderingOpensAt (inclusive opening boundary)", () => {
    expect(computeOrderingState(schedule, new Date("2026-09-28T04:00:00.000Z"))).toBe("open");
  });

  it("is open in the middle of the window", () => {
    expect(computeOrderingState(schedule, new Date("2026-09-28T07:00:00Z"))).toBe("open");
  });

  it("is closed exactly at orderingClosesAt (inclusive closing boundary)", () => {
    expect(computeOrderingState(schedule, new Date("2026-09-28T10:00:00.000Z"))).toBe("closed");
  });

  it("is closed strictly after orderingClosesAt", () => {
    expect(computeOrderingState(schedule, new Date("2026-09-28T10:00:00.001Z"))).toBe("closed");
  });
});

describe("toPublicOutletSummary", () => {
  it("includes only id/name/description/address(city,state)", () => {
    const outlet: Outlet = {
      ...baseOutlet,
      description: "Main campus food outlet",
      phone: "0499xxxxxxx",
      address: {
        line1: "Main Campus",
        line2: "Block B",
        city: "Kasaragod",
        state: "Kerala",
        postalCode: "671xxx",
      },
      location: {latitude: 12.5, longitude: 74.9},
    };

    const result = toPublicOutletSummary(outlet);

    expect(result).toEqual({
      id: OUTLET_ID,
      name: "Main Canteen",
      description: "Main campus food outlet",
      address: {city: "Kasaragod", state: "Kerala"},
    });
    expect(result).not.toHaveProperty("organizationId");
    expect(result).not.toHaveProperty("slug");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("phone");
    expect(result).not.toHaveProperty("location");
    expect(result).not.toHaveProperty("createdBy");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("omits description and address entirely when absent, rather than emitting undefined/null", () => {
    const result = toPublicOutletSummary(baseOutlet);

    expect(result).toEqual({id: OUTLET_ID, name: "Main Canteen"});
    expect(Object.keys(result)).not.toContain("description");
    expect(Object.keys(result)).not.toContain("address");
  });

  it("omits address when the stored address has neither city nor state", () => {
    const outlet: Outlet = {...baseOutlet, address: {line1: "Main Campus"}};

    const result = toPublicOutletSummary(outlet);

    expect(Object.keys(result)).not.toContain("address");
  });
});

describe("toCustomerMenuResponse", () => {
  it("includes only the customer-safe menu fields, plus derived orderingState and mapped items", () => {
    const now = new Date("2026-09-28T07:00:00Z");

    const result = toCustomerMenuResponse(baseMenu, [baseItem], now);

    expect(result).toEqual({
      id: MENU_ID,
      menuDate: "2026-09-29",
      title: "Tuesday Special Menu",
      orderingOpensAt: "2026-09-28T04:00:00.000Z",
      orderingClosesAt: "2026-09-28T10:00:00.000Z",
      pickupStartsAt: "2026-09-29T06:00:00.000Z",
      pickupEndsAt: "2026-09-29T10:00:00.000Z",
      orderingState: "open",
      items: [
        {
          id: "item-1",
          name: "Chicken Biriyani",
          priceInPaise: 12000,
          displayOrder: 1,
        },
      ],
    });
    expect(result).not.toHaveProperty("organizationId");
    expect(result).not.toHaveProperty("outletId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("createdBy");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
    expect(result).not.toHaveProperty("publishedAt");
    expect(result.items[0]).not.toHaveProperty("menuId");
    expect(result.items[0]).not.toHaveProperty("enabled");
    expect(result.items[0]).not.toHaveProperty("createdBy");
    expect(result.items[0]).not.toHaveProperty("createdAt");
    expect(result.items[0]).not.toHaveProperty("updatedAt");
  });

  it("keeps priceInPaise as an integer, never floating-point rupees", () => {
    const result = toCustomerMenuResponse(baseMenu, [{...baseItem, priceInPaise: 9950}]);

    expect(result.items[0].priceInPaise).toBe(9950);
    expect(Number.isInteger(result.items[0].priceInPaise)).toBe(true);
  });

  it("includes description when present and omits it when absent, for both menu and item", () => {
    const withDescription = toCustomerMenuResponse(
      {...baseMenu, description: "Freshly prepared lunch menu."},
      [{...baseItem, description: "Aromatic chicken biriyani"}],
    );
    expect(withDescription.description).toBe("Freshly prepared lunch menu.");
    expect(withDescription.items[0].description).toBe("Aromatic chicken biriyani");

    const withoutDescription = toCustomerMenuResponse(baseMenu, [baseItem]);
    expect(Object.keys(withoutDescription)).not.toContain("description");
    expect(Object.keys(withoutDescription.items[0])).not.toContain("description");
  });

  it("produces an empty items array for a menu with no enabled items", () => {
    const result = toCustomerMenuResponse(baseMenu, []);

    expect(result.items).toEqual([]);
  });
});

describe("toExploreOutletsEntryResponse", () => {
  it("flattens the outlet's fields to the top level, alongside a nested nextMenu", () => {
    const nextMenu: PublicMenuSummary = {
      id: MENU_ID,
      menuDate: "2026-09-29",
      title: "Tuesday Special Menu",
      orderingOpensAt: "2026-09-28T04:00:00.000Z",
      orderingClosesAt: "2026-09-28T10:00:00.000Z",
      pickupStartsAt: "2026-09-29T06:00:00.000Z",
      pickupEndsAt: "2026-09-29T10:00:00.000Z",
      orderingState: "not_open",
    };
    const entry: ExploreOutletsEntry = {outlet: toPublicOutletSummary(baseOutlet), nextMenu};

    const result = toExploreOutletsEntryResponse(entry);

    expect(result).toEqual({id: OUTLET_ID, name: "Main Canteen", nextMenu});
  });
});
