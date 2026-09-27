// @vitest-environment node
import {describe, expect, it, vi} from "vitest";
import {handleRequest} from "./handleRequest";
import type {NormalizedRequest, RouteDefinition} from "./types";

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {method: "GET", path: "/boom", headers: {}, query: {}, body: undefined, ...overrides};
}

describe("handleRequest", () => {
  it("returns a generic 500 when a handler throws, without leaking the error", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        path: "/boom",
        handler: async () => {
          throw new Error("Malformed user document at users/U-1 — sensitive detail.");
        },
      },
    ];
    const onUnhandledError = vi.fn();

    const result = await handleRequest(routes, request(), onUnhandledError);

    expect(result).toEqual({
      kind: "error",
      status: 500,
      code: "internal",
      message: "An unexpected error occurred.",
    });
    expect(onUnhandledError).toHaveBeenCalledTimes(1);
    expect(onUnhandledError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("passes through a route's own ApiResult unchanged", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        path: "/boom",
        handler: async () => ({kind: "success", status: 200, data: {ok: true}}),
      },
    ];

    const result = await handleRequest(routes, request(), vi.fn());

    expect(result).toEqual({kind: "success", status: 200, data: {ok: true}});
  });

  it("returns 404 for an unknown route without calling onUnhandledError", async () => {
    const onUnhandledError = vi.fn();

    const result = await handleRequest([], request({path: "/unknown"}), onUnhandledError);

    expect(result).toMatchObject({status: 404, code: "not_found"});
    expect(onUnhandledError).not.toHaveBeenCalled();
  });
});
