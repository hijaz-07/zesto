// @vitest-environment node
import {describe, expect, it} from "vitest";
import {toResponseBody} from "./envelope";
import type {ApiResult} from "./types";

describe("toResponseBody", () => {
  it("wraps success data as {data: ...}", () => {
    const result: ApiResult = {kind: "success", status: 200, data: {id: "u1"}};

    expect(toResponseBody(result, "req-1")).toEqual({data: {id: "u1"}});
  });

  it("wraps an error as {error: {code, message, requestId}}", () => {
    const result: ApiResult = {
      kind: "error",
      status: 404,
      code: "not_found",
      message: "The requested resource was not found.",
    };

    expect(toResponseBody(result, "req-2")).toEqual({
      error: {
        code: "not_found",
        message: "The requested resource was not found.",
        requestId: "req-2",
      },
    });
  });

  it("uses the requestId passed in, not anything on the result", () => {
    const result: ApiResult = {
      kind: "error",
      status: 500,
      code: "internal",
      message: "An unexpected error occurred.",
    };

    const first = toResponseBody(result, "req-a");
    const second = toResponseBody(result, "req-b");

    expect(first).toMatchObject({error: {requestId: "req-a"}});
    expect(second).toMatchObject({error: {requestId: "req-b"}});
  });
});
