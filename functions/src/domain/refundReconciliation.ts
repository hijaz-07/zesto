import {Timestamp, type Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import type {RefundProviderGateway} from "../providers/refundGateway";
import {submitRefund, type SubmitRefundResult} from "./refundSubmission";
import {refundLocationFromPath, type RefundLocation} from "./refundTransitions";

/**
 * Refund recovery drivers. Both call `submitRefund` (the one submission driver) and
 * nothing else touches the provider.
 *
 * - `handleRefundCreated`: the Firestore trigger on a new refund document. It
 *   submits at once, so a cancellation's refund starts without waiting for a sweep.
 * - `reconcileDueRefunds`: the scheduled sweep. It is the SAFETY NET for everything
 *   the trigger cannot guarantee: a trigger that never fired, a worker that died
 *   holding a lease, a response that was lost, a `pending` refund whose webhook
 *   never came, a retry that is now due.
 *
 * The sweep is bounded and safe to run twice at once:
 * - one collection-group query over refunds that are `requested`/`pending` AND whose
 *   `nextAttemptAt` has passed, ordered by it, at most `limit` documents. It never
 *   scans tenant data, and a refund that needs a person (`attentionRequired`) or is
 *   terminal has no `nextAttemptAt` and is never returned;
 * - each document's path is validated (`refundLocationFromPath`: exactly
 *   `organizations/{o}/outlets/{ou}/menus/{m}/orders/{ord}/payments/{p}/refunds/{r}`
 *   with a refund ID that encodes its order) before anything is read, and
 *   `submitRefund` then validates the stored documents against that path, so a
 *   malformed record is skipped and logged, never acted on, and one tenant's record
 *   can only ever touch its own order and payment;
 * - leases make a second concurrent sweep skip what the first is working on;
 * - it never creates a refund and never chooses an amount: it only advances refunds
 *   a cancellation or a late capture already reserved;
 * - a wall-clock budget stops it before the function's timeout; the rest waits for
 *   the next run.
 */

export const DEFAULT_RECONCILE_LIMIT = 25;
export const DEFAULT_RECONCILE_BUDGET_MS = 4 * 60 * 1000;

/**
 * The creation trigger's body.
 *
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundProviderGateway} gateway The provider.
 * @param {string} path The created refund document's path.
 * @return {Promise<SubmitRefundResult | null>} The result, or null for a path that is not a refund's.
 */
export async function handleRefundCreated(
  db: Firestore,
  gateway: RefundProviderGateway,
  path: string,
): Promise<SubmitRefundResult | null> {
  const loc = refundLocationFromPath(path);
  if (loc === null) {
    logger.error("A refund trigger fired for an unexpected path.", {path});
    return null;
  }
  return submitRefund(db, gateway, loc);
}

export interface ReconcileOptions {
  now?: () => Timestamp;
  limit?: number;
  budgetMs?: number;
}

export interface ReconcileSummary {
  examined: number;
  stoppedForBudget: boolean;
  /** Counts by `SubmitRefundResult.kind`, plus the sweep's own `skipped_*` and `error`. */
  results: Record<string, number>;
}

/**
 * @param {Firestore} db Admin Firestore instance.
 * @param {RefundProviderGateway} gateway The provider.
 * @param {ReconcileOptions} [options] Clock, batch size and time budget.
 * @return {Promise<ReconcileSummary>} What the sweep did (never document contents).
 */
export async function reconcileDueRefunds(
  db: Firestore,
  gateway: RefundProviderGateway,
  options: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const clock = options.now ?? (() => Timestamp.now());
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_RECONCILE_LIMIT, 100));
  const budgetMs = options.budgetMs ?? DEFAULT_RECONCILE_BUDGET_MS;
  const startedAt = Date.now();

  const due = await db
    .collectionGroup("refunds")
    .where("status", "in", ["requested", "pending"])
    .where("nextAttemptAt", "<=", clock())
    .orderBy("nextAttemptAt", "asc")
    .limit(limit)
    .get();

  const summary: ReconcileSummary = {examined: 0, stoppedForBudget: false, results: {}};
  const count = (key: string): void => {
    summary.results[key] = (summary.results[key] ?? 0) + 1;
  };

  for (const doc of due.docs) {
    if (Date.now() - startedAt > budgetMs) {
      summary.stoppedForBudget = true;
      break;
    }
    summary.examined += 1;
    const loc: RefundLocation | null = refundLocationFromPath(doc.ref.path);
    if (loc === null) {
      count("skipped_malformed_path");
      logger.error("A refund at an unexpected path was skipped.", {path: doc.ref.path});
      continue;
    }
    if (doc.get("attentionRequired") === true) {
      count("skipped_attention_required");
      continue;
    }
    try {
      const result = await submitRefund(db, gateway, loc, {now: clock});
      count(result.kind);
    } catch (error) {
      // One refund's failure never stops the sweep; its lease expires and it is retried next run.
      count("error");
      logger.error("Reconciling a refund failed.", {
        refundId: loc.refundId, error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return summary;
}
