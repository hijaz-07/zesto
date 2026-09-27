// @vitest-environment node
import {describe, expect, it} from "vitest";
import {dispatch, matchRoute, normalizePath} from "./router";
import type {ApiResult, RouteDefinition} from "./types";

const okResult: ApiResult = {kind: "success", status: 200, data: {ok: true}};

const routes: RouteDefinition[] = [
  {method: "GET", path: "/me", handler: async () => okResult},
  {method: "POST", path: "/orders", handler: async () => okResult},
  {method: "GET", path: "/orders", handler: async () => okResult},
];

describe("normalizePath", () => {
  it("strips a leading /api segment", () => {
    expect(normalizePath("/api/me")).toBe("/me");
    expect(normalizePath("/api/orders")).toBe("/orders");
  });

  it("maps /api itself to /", () => {
    expect(normalizePath("/api")).toBe("/");
  });

  it("leaves a path with no /api prefix unchanged", () => {
    expect(normalizePath("/me")).toBe("/me");
    expect(normalizePath("/")).toBe("/");
  });

  it("does not strip /api from the middle of a path", () => {
    expect(normalizePath("/v1/api/me")).toBe("/v1/api/me");
  });
});

describe("matchRoute", () => {
  it("finds a route matching both path and method", () => {
    const match = matchRoute(routes, "GET", "/me");

    expect(match).toEqual({kind: "found", route: routes[0]});
  });

  it("matches methods case-insensitively", () => {
    const match = matchRoute(routes, "get", "/me");

    expect(match.kind).toBe("found");
  });

  it("reports not_found for an unregistered path", () => {
    expect(matchRoute(routes, "GET", "/unknown")).toEqual({kind: "not_found"});
  });

  it("reports method_not_allowed, distinct from not_found, for a known " +
    "path called with the wrong method", () => {
    const match = matchRoute(routes, "POST", "/me");

    expect(match).toEqual({
      kind: "method_not_allowed",
      allowedMethods: ["GET"],
    });
  });

  it("lists every allowed method for a multi-method path", () => {
    const match = matchRoute(routes, "PUT", "/orders");

    expect(match.kind).toBe("method_not_allowed");
    if (match.kind === "method_not_allowed") {
      expect(new Set(match.allowedMethods)).toEqual(new Set(["GET", "POST"]));
    }
  });
});

describe("dispatch", () => {
  it("invokes the matching route's handler", async () => {
    const result = await dispatch(routes, {
      method: "GET",
      path: "/me",
      headers: {},
      query: {},
      body: undefined,
    });

    expect(result).toBe(okResult);
  });

  it("returns a 404 error result for an unknown path", async () => {
    const result = await dispatch(routes, {
      method: "GET",
      path: "/unknown",
      headers: {},
      query: {},
      body: undefined,
    });

    expect(result).toEqual({
      kind: "error",
      status: 404,
      code: "not_found",
      message: expect.any(String),
    });
  });

  it("returns a 405 error result with an Allow header for a known path " +
    "called with the wrong method", async () => {
    const result = await dispatch(routes, {
      method: "POST",
      path: "/me",
      headers: {},
      query: {},
      body: undefined,
    });

    expect(result).toEqual({
      kind: "error",
      status: 405,
      code: "method_not_allowed",
      message: expect.any(String),
      headers: {"Allow": "GET"},
    });
  });
});
