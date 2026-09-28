// @vitest-environment node
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {
  CustomerMenuDetail,
  ExploreOutletsEntry,
} from "../domain/explore";
import * as exploreDomain from "../domain/explore";
import type {Outlet} from "../domain/outlets";
import type {NormalizedRequest, RouteDefinition} from "../http/types";
import {createExploreRoutes} from "./explore";

vi.mock("../domain/explore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../domain/explore")>();
  return {
    ...actual,
    listExploreOutlets: vi.fn(),
    resolveActivePublicOutlet: vi.fn(),
    listUpcomingPublishedMenusForOutlet: vi.fn(),
    getCustomerMenuDetail: vi.fn(),
  };
});

const FAKE_DB = {} as Firestore;

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    method: "GET",
    path: "/explore/outlets",
    headers: {},
    query: {},
    body: undefined,
    ...overrides,
  };
}

function findRoute(method: string, path: string): RouteDefinition {
  const routes = createExploreRoutes({db: FAKE_DB});
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`${method} ${path} not registered`);
  return route;
}

const NOW = Timestamp.now();

const activeOutlet: Outlet = {
  id: "outlet-1",
  organizationId: "org-1",
  name: "Main Canteen",
  slug: "main-canteen",
  status: "active",
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: "U-owner",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createExploreRoutes", () => {
  it("registers exactly the 3 public GET explore routes", () => {
    const routes = createExploreRoutes({db: FAKE_DB});

    expect(routes.map((r) => ({method: r.method, path: r.path}))).toEqual([
      {method: "GET", path: "/explore/outlets"},
      {method: "GET", path: "/explore/outlets/:outletId"},
      {method: "GET", path: "/explore/outlets/:outletId/menus/:menuId"},
    ]);
  });
});

describe("GET /explore/outlets", () => {
  it("succeeds with no Authorization header at all", async () => {
    vi.mocked(exploreDomain.listExploreOutlets).mockResolvedValue([]);
    const route = findRoute("GET", "/explore/outlets");

    const result = await route.handler({request: request({headers: {}})});

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("succeeds identically when a valid Authorization header is present (ignored, not required)", async () => {
    vi.mocked(exploreDomain.listExploreOutlets).mockResolvedValue([]);
    const route = findRoute("GET", "/explore/outlets");

    const result = await route.handler({
      request: request({headers: {authorization: "Bearer some-valid-looking-token"}}),
    });

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("flattens each entry's outlet fields to the top level, alongside a nested nextMenu", async () => {
    const entry: ExploreOutletsEntry = {
      outlet: {id: "outlet-1", name: "Main Canteen"},
      nextMenu: {
        id: "menu-1",
        menuDate: "2026-09-29",
        title: "Tuesday Special",
        orderingOpensAt: "2026-09-28T04:00:00.000Z",
        orderingClosesAt: "2026-09-28T10:00:00.000Z",
        pickupStartsAt: "2026-09-29T06:00:00.000Z",
        pickupEndsAt: "2026-09-29T10:00:00.000Z",
        orderingState: "not_open",
      },
    };
    vi.mocked(exploreDomain.listExploreOutlets).mockResolvedValue([entry]);
    const route = findRoute("GET", "/explore/outlets");

    const result = await route.handler({request: request()});

    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("expected success");
    expect(result.data).toEqual({
      outlets: [{id: "outlet-1", name: "Main Canteen", nextMenu: entry.nextMenu}],
    });
  });

  it("returns an empty list, not an error, when nothing qualifies", async () => {
    vi.mocked(exploreDomain.listExploreOutlets).mockResolvedValue([]);
    const route = findRoute("GET", "/explore/outlets");

    const result = await route.handler({request: request()});

    expect(result).toMatchObject({kind: "success", status: 200, data: {outlets: []}});
  });
});

describe("GET /explore/outlets/:outletId", () => {
  it("succeeds with no Authorization header", async () => {
    vi.mocked(exploreDomain.resolveActivePublicOutlet).mockResolvedValue(activeOutlet);
    vi.mocked(exploreDomain.listUpcomingPublishedMenusForOutlet).mockResolvedValue([]);
    const route = findRoute("GET", "/explore/outlets/:outletId");

    const result = await route.handler({
      request: request({path: "/explore/outlets/outlet-1", headers: {}}),
      params: {outletId: "outlet-1"},
    });

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("returns 404 not_found for a nonexistent/inactive outlet, without leaking which", async () => {
    vi.mocked(exploreDomain.resolveActivePublicOutlet).mockRejectedValue(
      new HttpsError("not-found", "Outlet not found."),
    );
    const route = findRoute("GET", "/explore/outlets/:outletId");

    const result = await route.handler({
      request: request({path: "/explore/outlets/no-such-outlet"}),
      params: {outletId: "no-such-outlet"},
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("returns the outlet and its menus, with no items field anywhere", async () => {
    vi.mocked(exploreDomain.resolveActivePublicOutlet).mockResolvedValue(activeOutlet);
    vi.mocked(exploreDomain.listUpcomingPublishedMenusForOutlet).mockResolvedValue([
      {
        id: "menu-1",
        menuDate: "2026-09-29",
        title: "Tuesday Special",
        orderingOpensAt: "2026-09-28T04:00:00.000Z",
        orderingClosesAt: "2026-09-28T10:00:00.000Z",
        pickupStartsAt: "2026-09-29T06:00:00.000Z",
        pickupEndsAt: "2026-09-29T10:00:00.000Z",
        orderingState: "not_open",
      },
    ]);
    const route = findRoute("GET", "/explore/outlets/:outletId");

    const result = await route.handler({
      request: request({path: "/explore/outlets/outlet-1"}),
      params: {outletId: "outlet-1"},
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("expected success");
    const data = result.data as {outlet: {id: string}; menus: Array<Record<string, unknown>>};
    expect(data.outlet).toEqual({id: "outlet-1", name: "Main Canteen"});
    expect(data.menus).toHaveLength(1);
    expect(data.menus[0]).not.toHaveProperty("items");
  });

  it("rethrows a non-404 domain error for the caller's generic 500 handling", async () => {
    vi.mocked(exploreDomain.resolveActivePublicOutlet).mockRejectedValue(new Error("boom"));
    const route = findRoute("GET", "/explore/outlets/:outletId");

    await expect(route.handler({
      request: request({path: "/explore/outlets/outlet-1"}),
      params: {outletId: "outlet-1"},
    })).rejects.toThrow("boom");
  });
});

describe("GET /explore/outlets/:outletId/menus/:menuId", () => {
  const detail: CustomerMenuDetail = {
    menu: {
      id: "menu-1",
      organizationId: "org-1",
      outletId: "outlet-1",
      menuDate: "2026-09-29",
      title: "Tuesday Special",
      status: "published",
      orderingOpensAt: Timestamp.fromDate(new Date("2026-09-28T04:00:00Z")),
      orderingClosesAt: Timestamp.fromDate(new Date("2026-09-28T10:00:00Z")),
      pickupStartsAt: Timestamp.fromDate(new Date("2026-09-29T06:00:00Z")),
      pickupEndsAt: Timestamp.fromDate(new Date("2026-09-29T10:00:00Z")),
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "U-owner",
    },
    items: [
      {
        id: "item-1",
        menuId: "menu-1",
        name: "Chicken Biriyani",
        priceInPaise: 12000,
        enabled: true,
        displayOrder: 1,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: "U-owner",
      },
    ],
  };

  it("succeeds with no Authorization header", async () => {
    vi.mocked(exploreDomain.resolveActivePublicOutlet).mockResolvedValue(activeOutlet);
    vi.mocked(exploreDomain.getCustomerMenuDetail).mockResolvedValue(detail);
    const route = findRoute("GET", "/explore/outlets/:outletId/menus/:menuId");

    const result = await route.handler({
      request: request({path: "/explore/outlets/outlet-1/menus/menu-1", headers: {}}),
      params: {outletId: "outlet-1", menuId: "menu-1"},
    });

    expect(result).toMatchObject({kind: "success", status: 200});
  });

  it("returns 404 for a nonexistent/inactive outlet before even resolving the menu", async () => {
    vi.mocked(exploreDomain.resolveActivePublicOutlet).mockRejectedValue(
      new HttpsError("not-found", "Outlet not found."),
    );
    const route = findRoute("GET", "/explore/outlets/:outletId/menus/:menuId");

    const result = await route.handler({
      request: request({path: "/explore/outlets/no-such-outlet/menus/menu-1"}),
      params: {outletId: "no-such-outlet", menuId: "menu-1"},
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
    expect(exploreDomain.getCustomerMenuDetail).not.toHaveBeenCalled();
  });

  it("returns 404 for a draft/archived/nonexistent menu, or one under a different outlet", async () => {
    vi.mocked(exploreDomain.resolveActivePublicOutlet).mockResolvedValue(activeOutlet);
    vi.mocked(exploreDomain.getCustomerMenuDetail).mockRejectedValue(
      new HttpsError("not-found", "Menu not found."),
    );
    const route = findRoute("GET", "/explore/outlets/:outletId/menus/:menuId");

    const result = await route.handler({
      request: request({path: "/explore/outlets/outlet-1/menus/no-such-menu"}),
      params: {outletId: "outlet-1", menuId: "no-such-menu"},
    });

    expect(result).toMatchObject({kind: "error", status: 404, code: "not_found"});
  });

  it("returns the outlet and menu, with the item's enabled field never present", async () => {
    vi.mocked(exploreDomain.resolveActivePublicOutlet).mockResolvedValue(activeOutlet);
    vi.mocked(exploreDomain.getCustomerMenuDetail).mockResolvedValue(detail);
    const route = findRoute("GET", "/explore/outlets/:outletId/menus/:menuId");

    const result = await route.handler({
      request: request({path: "/explore/outlets/outlet-1/menus/menu-1"}),
      params: {outletId: "outlet-1", menuId: "menu-1"},
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("expected success");
    const data = result.data as {outlet: {id: string}; menu: {items: Array<Record<string, unknown>>}};
    expect(data.outlet).toEqual({id: "outlet-1", name: "Main Canteen"});
    expect(data.menu.items).toHaveLength(1);
    expect(data.menu.items[0]).not.toHaveProperty("enabled");
    expect(data.menu.items[0]).not.toHaveProperty("menuId");
  });
});
