// @vitest-environment node
import {Timestamp} from "firebase-admin/firestore";
import {describe, expect, it} from "vitest";
import {inAppChannel, isAlreadyExists} from "./notificationChannels";
import {NOTIFICATION_EVENT_ERROR_MAX_LENGTH, buildNotificationEvent, type NotificationEvent} from "./notificationEvents";
import {
  MAX_NOTIFICATION_ATTEMPTS,
  NOTIFICATION_RECIPIENT_CAP,
  PermanentNotificationError,
  decideAttempt,
  describeNotificationError,
  dispositionForFailure,
  processNotificationEvent,
} from "./notificationProcessor";
import type {Order} from "./orders";

const AT = Timestamp.fromDate(new Date("2026-10-05T10:00:00Z"));

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  const order = {
    id: "order-1", userId: "U-customer", organizationId: "org-1", outletId: "outlet-1", menuId: "menu-1",
  } as Order;
  return {...buildNotificationEvent(order, "order_confirmed", AT), ...overrides};
}

describe("the documented limits", () => {
  it("allows 5 attempts and 200 recipients", () => {
    expect(MAX_NOTIFICATION_ATTEMPTS).toBe(5);
    expect(NOTIFICATION_RECIPIENT_CAP).toBe(200);
  });
});

describe("decideAttempt", () => {
  it("starts a pending event with attempts left", () => {
    expect(decideAttempt(event({attempts: 0}))).toBe("start");
    expect(decideAttempt(event({attempts: MAX_NOTIFICATION_ATTEMPTS - 1}))).toBe("start");
  });

  it("gives up on a pending event that has already used every attempt (e.g. earlier runs died)", () => {
    expect(decideAttempt(event({attempts: MAX_NOTIFICATION_ATTEMPTS}))).toBe("give_up");
    expect(decideAttempt(event({attempts: MAX_NOTIFICATION_ATTEMPTS + 3}))).toBe("give_up");
  });

  it("leaves a processed or failed event alone, however it is redelivered", () => {
    expect(decideAttempt(event({status: "processed"}))).toBe("skip_processed");
    expect(decideAttempt(event({status: "failed"}))).toBe("skip_failed");
    expect(decideAttempt(event({status: "failed", attempts: 0}))).toBe("skip_failed");
  });
});

describe("dispositionForFailure (retry classification)", () => {
  it("retries a transient error while attempts remain", () => {
    for (let attempts = 1; attempts < MAX_NOTIFICATION_ATTEMPTS; attempts++) {
      expect(dispositionForFailure(new Error("14 UNAVAILABLE"), attempts)).toBe("retry");
    }
  });

  it("stops on the fifth failed attempt — the cap — so there is no hot loop", () => {
    expect(dispositionForFailure(new Error("14 UNAVAILABLE"), MAX_NOTIFICATION_ATTEMPTS)).toBe("fail");
    expect(dispositionForFailure(new Error("14 UNAVAILABLE"), MAX_NOTIFICATION_ATTEMPTS + 1)).toBe("fail");
  });

  it("stops at once on a permanent error, whatever the attempt number", () => {
    expect(dispositionForFailure(new PermanentNotificationError("bad"), 1)).toBe("fail");
  });

  it("treats a non-Error throw as transient", () => {
    expect(dispositionForFailure("boom", 1)).toBe("retry");
  });
});

describe("describeNotificationError", () => {
  it("keeps the message only — never a stack", () => {
    const error = new Error("14 UNAVAILABLE: connection reset");

    expect(describeNotificationError(error)).toBe("14 UNAVAILABLE: connection reset");
    expect(describeNotificationError(error)).not.toContain("at ");
  });

  it("bounds the length and flattens whitespace", () => {
    const text = describeNotificationError(new Error(`line one\n\n   line two ${"x".repeat(1000)}`));

    expect(text.length).toBeLessThanOrEqual(NOTIFICATION_EVENT_ERROR_MAX_LENGTH);
    expect(text).toMatch(/^line one line two x+$/);
  });

  it("copes with a non-error and an empty message", () => {
    expect(describeNotificationError("plain string")).toBe("plain string");
    expect(describeNotificationError(new Error(""))).toBe("Unknown error");
  });
});

describe("isAlreadyExists", () => {
  it.each([[6], ["already-exists"]])("recognises the Firestore code %j", (code) => {
    expect(isAlreadyExists(Object.assign(new Error("exists"), {code}))).toBe(true);
  });

  it.each([[14], ["unavailable"], [undefined]])("does not mistake code %j for it", (code) => {
    expect(isAlreadyExists(Object.assign(new Error("other"), {code}))).toBe(false);
  });

  it("does not mistake a plain error or a string for it", () => {
    expect(isAlreadyExists(new Error("exists"))).toBe(false);
    expect(isAlreadyExists("already-exists")).toBe(false);
  });
});

describe("inAppChannel", () => {
  it("is the in_app channel", () => {
    expect(inAppChannel.name).toBe("in_app");
  });
});

describe("processNotificationEvent", () => {
  it("skips a malformed event id without touching Firestore", async () => {
    const untouched = new Proxy({}, {
      get(): never {
        throw new Error("Firestore should not have been touched.");
      },
    }) as never;

    for (const id of ["", "a/b", "..", "__x__"]) {
      expect(await processNotificationEvent(untouched, id)).toEqual({kind: "skipped", reason: "missing"});
    }
  });
});
