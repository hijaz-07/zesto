// @vitest-environment node
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";

/**
 * Guards `firestore.indexes.json`, the file `firebase deploy --only firestore:indexes`
 * ships. It must really parse, and the indexes the code's queries depend on must be in
 * the REAL `indexes` / `fieldOverrides` arrays — not in the commented-out example the
 * Firebase CLI template puts at the top of the file, where a refund index once sat
 * unnoticed. A missing composite fails only in production, at the first query that needs it.
 *
 * The Firebase CLI reads this file as JSON *with comments*, so the comments are removed
 * here the same way (string-aware), not by a bare `JSON.parse`.
 */

interface IndexField {
  fieldPath: string;
  order?: string;
  arrayConfig?: string;
}
interface CompositeIndex {
  collectionGroup: string;
  queryScope: string;
  fields: IndexField[];
}
interface FieldOverride {
  collectionGroup: string;
  fieldPath: string;
  indexes: {order?: string; arrayConfig?: string; queryScope: string}[];
}
interface IndexesFile {
  indexes: CompositeIndex[];
  fieldOverrides: FieldOverride[];
}

/**
 * @param {string} text JSON text that may contain `//` and block comments.
 * @return {string} The same text without them; string contents are left alone.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\"") {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const raw = readFileSync(resolve(__dirname, "../../firestore.indexes.json"), "utf8");
const file = JSON.parse(stripJsonComments(raw)) as IndexesFile;

const signature = (index: CompositeIndex): string =>
  `${index.collectionGroup}|${index.queryScope}|` +
  index.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`).join(",");

describe("firestore.indexes.json", () => {
  it("parses, with real indexes and fieldOverrides arrays", () => {
    expect(Array.isArray(file.indexes)).toBe(true);
    expect(Array.isArray(file.fieldOverrides)).toBe(true);
    expect(file.indexes.length).toBeGreaterThan(0);
  });

  it("has the refund reconciler's composite (status, nextAttemptAt) over the refunds collection group", () => {
    expect(file.indexes.map(signature)).toContain("refunds|COLLECTION_GROUP|status:ASCENDING,nextAttemptAt:ASCENDING");
  });

  it("keeps every composite index the application's queries rely on", () => {
    expect(file.indexes.map(signature).sort()).toEqual([
      "items|COLLECTION|displayOrder:ASCENDING,createdAt:ASCENDING",
      "items|COLLECTION|enabled:ASCENDING,displayOrder:ASCENDING,createdAt:ASCENDING",
      "members|COLLECTION_GROUP|userId:ASCENDING,status:ASCENDING,createdAt:ASCENDING",
      "menus|COLLECTION_GROUP|status:ASCENDING,menuDate:ASCENDING,createdAt:ASCENDING",
      "menus|COLLECTION|menuDate:ASCENDING,createdAt:ASCENDING",
      // `listUpcomingPublishedMenusForOutlet` filters one outlet's `menus` collection by status.
      "menus|COLLECTION|status:ASCENDING,menuDate:ASCENDING,createdAt:ASCENDING",
      "notifications|COLLECTION|scope:ASCENDING,createdAt:DESCENDING",
      "notifications|COLLECTION|scope:ASCENDING,readAt:ASCENDING,createdAt:DESCENDING",
      "orders|COLLECTION_GROUP|organizationId:ASCENDING,createdAt:DESCENDING",
      "orders|COLLECTION_GROUP|organizationId:ASCENDING,outletId:ASCENDING,createdAt:DESCENDING",
      "orders|COLLECTION_GROUP|organizationId:ASCENDING,status:ASCENDING,createdAt:DESCENDING",
      "orders|COLLECTION_GROUP|userId:ASCENDING,createdAt:DESCENDING",
      "refunds|COLLECTION_GROUP|status:ASCENDING,nextAttemptAt:ASCENDING",
    ]);
  });

  it("defines no composite index twice", () => {
    const signatures = file.indexes.map(signature);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("keeps the collection-group lookups the webhooks and order routes rely on (field overrides)", () => {
    const overrides = file.fieldOverrides.map((o) => ({
      key: `${o.collectionGroup}.${o.fieldPath}`,
      scopes: o.indexes.map((i) => i.queryScope).sort(),
    }));
    for (const key of [
      "orders.id",
      "payments.providerOrderId",
      "payments.providerPaymentId",
      // The payment reconciliation sweep (`reconcileDuePayments`): range + order on this one field.
      "payments.reconciliation.nextAttemptAt",
      "refunds.providerRefundId",
    ]) {
      expect(overrides.find((o) => o.key === key)?.scopes, key).toContain("COLLECTION_GROUP");
    }
    expect(overrides.find((o) => o.key === "outlets.id")?.scopes).toEqual(["COLLECTION", "COLLECTION_GROUP"]);
    expect(file.fieldOverrides).toHaveLength(6);
  });
});
