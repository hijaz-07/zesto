// @vitest-environment node
import {describe, expect, it} from "vitest";
import {BUSINESS_TIME_ZONE, businessDateString} from "./time";

describe("businessDateString", () => {
  it("uses Asia/Kolkata as the business time zone", () => {
    expect(BUSINESS_TIME_ZONE).toBe("Asia/Kolkata");
  });

  it("formats an instant well within the Kolkata day", () => {
    // 2026-09-27T04:00:00Z is 2026-09-27T09:30:00+05:30 in Kolkata.
    expect(businessDateString(new Date("2026-09-27T04:00:00Z")))
      .toBe("2026-09-27");
  });

  it("rolls over to the next Kolkata calendar day exactly at IST midnight", () => {
    // IST is UTC+5:30, so IST midnight (2026-09-28T00:00:00+05:30) is
    // 2026-09-27T18:30:00Z.
    expect(businessDateString(new Date("2026-09-27T18:29:59Z")))
      .toBe("2026-09-27");
    expect(businessDateString(new Date("2026-09-27T18:30:00Z")))
      .toBe("2026-09-28");
  });

  it("zero-pads single-digit months and days", () => {
    expect(businessDateString(new Date("2026-01-05T04:00:00Z")))
      .toBe("2026-01-05");
  });

  it("defaults to the current instant when none is given", () => {
    expect(businessDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
