// @vitest-environment node
import {describe, expect, it} from "vitest";
import {PENDING_POLL_INTERVAL_MS, refundLocationFromPath, safeFailureCode} from "./refundTransitions";

const PREFIX = "organizations/org1/outlets/out1/menus/menu1/orders/ord1/payments/ord1";

describe("refundLocationFromPath", () => {
  it("reads every coordinate from a well-formed refund path", () => {
    expect(refundLocationFromPath(`${PREFIX}/refunds/ord1-r1`)).toEqual({
      organizationId: "org1", outletId: "out1", menuId: "menu1", orderId: "ord1", paymentId: "ord1", refundId: "ord1-r1",
    });
  });

  it.each([
    ["too short", "organizations/org1/outlets/out1/menus/menu1/orders/ord1/payments/ord1"],
    ["too long", `${PREFIX}/refunds/ord1-r1/transitions/x`],
    ["wrong collection name", `${PREFIX}/refundz/ord1-r1`],
    ["not under organizations", "tenants/org1/outlets/out1/menus/menu1/orders/ord1/payments/ord1/refunds/ord1-r1"],
    ["a refund id that encodes a different order", `${PREFIX}/refunds/other-r1`],
    ["a refund id that is not order-r<seq>", `${PREFIX}/refunds/ord1`],
    ["a zero sequence", `${PREFIX}/refunds/ord1-r0`],
    ["an empty segment", "organizations//outlets/out1/menus/menu1/orders/ord1/payments/ord1/refunds/ord1-r1"],
    ["a dot segment", "organizations/./outlets/out1/menus/menu1/orders/ord1/payments/ord1/refunds/ord1-r1"],
  ])("rejects %s", (_name, path) => {
    expect(refundLocationFromPath(path)).toBeNull();
  });
});

describe("safeFailureCode", () => {
  it("keeps a provider code's safe characters and replaces everything else", () => {
    expect(safeFailureCode("BAD_REQUEST_ERROR")).toBe("BAD_REQUEST_ERROR");
    expect(safeFailureCode("a b/c\n<script>")).toBe("a_b_c__script_");
    expect(safeFailureCode("")).toBe("unknown");
  });

  it("is bounded to the schema's limit", () => {
    expect(safeFailureCode("x".repeat(500))).toHaveLength(100);
  });
});

describe("pending refund polling", () => {
  it("looks again after six hours: webhooks are the fast path, the sweep only a backup", () => {
    expect(PENDING_POLL_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });
});
