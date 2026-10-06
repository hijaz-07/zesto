#!/usr/bin/env node
/**
 * ONE-SHOT sweep: hand the refund notification events that were created while nothing consumed
 * them (`notificationEvents`, type refund_requested|refund_completed|refund_failed, status
 * pending) to the notification processor. See functions/src/domain/notificationBackfill.ts for
 * why it is needed (the Firestore trigger fires only on document creation) and its guarantees:
 * recognised refund events only, bounded, document-ID order, idempotent, never touches an event
 * already processed or failed.
 *
 * It is NOT scheduled and NOT run by anything. It reads functions/lib, so build first:
 *
 *   cd functions && npm run build
 *
 * DRY RUN is the default: it lists what it would process and writes nothing.
 *
 * Against the EMULATOR (FIRESTORE_EMULATOR_HOST set; credentials are never loaded):
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-refund-notifications.mjs --project demo-zesto
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-refund-notifications.mjs --project demo-zesto --execute
 *
 * Against a REAL project (only ever with explicit approval, after the Functions with the 7.6
 * notification policy are deployed — otherwise the processor would have no policy for them).
 * Uses Application Default Credentials; both flags are required to write:
 *
 *   node scripts/backfill-refund-notifications.mjs --project zesto-dev-2026                    # dry run: read-only
 *   node scripts/backfill-refund-notifications.mjs --project zesto-dev-2026 --execute --i-understand-this-writes-to-production
 *
 * Options:
 *   --project <id>     Required. The Firebase project id.
 *   --execute          Process the events (default: dry run).
 *   --limit <n>        Events per page, 1..500 (default 100).
 *   --max-pages <n>    Pages per run, default 20 (so a run is always bounded).
 *
 * The two protected production orders are always excluded and never processed.
 */
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';

const PROTECTED_ORDER_IDS = ['OpSIkzpFFP7kcGrNE75F', 'e60n23hMaxQo9FLYhCmt'];
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/;

function parseArgs(argv) {
  const args = {execute: false, ack: false, limit: 100, maxPages: 20, project: undefined};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') args.execute = true;
    else if (arg === '--i-understand-this-writes-to-production') args.ack = true;
    else if (arg === '--project') args.project = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--max-pages') args.maxPages = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.project) fail('--project <id> is required.');
if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500) fail('--limit must be 1..500.');
if (!Number.isInteger(args.maxPages) || args.maxPages < 1) fail('--max-pages must be a positive integer.');

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const isEmulator = emulatorHost !== undefined && emulatorHost !== '';
if (isEmulator && !LOOPBACK.test(emulatorHost)) fail('FIRESTORE_EMULATOR_HOST must be a loopback address.');
if (!isEmulator && args.execute && !args.ack) {
  fail('Refusing to write to a real project without --i-understand-this-writes-to-production.');
}

const here = dirname(fileURLToPath(import.meta.url));
const functionsRequire = createRequire(resolve(here, '../functions/package.json'));
const {initializeApp} = functionsRequire('firebase-admin/app');
const {getFirestore} = functionsRequire('firebase-admin/firestore');
const {backfillRefundNotifications} = await import(
  pathToFileURL(resolve(here, '../functions/lib/domain/notificationBackfill.js')).href
);

initializeApp({projectId: args.project});
const db = getFirestore();

console.log(
  `${args.execute ? 'EXECUTE' : 'DRY RUN'} against ${isEmulator ? `emulator ${emulatorHost}` : `REAL project ${args.project}`}`,
);

const totals = {scanned: 0, processed: 0, excluded: 0, failed: 0, notProcessed: 0};
let after;
for (let page = 1; page <= args.maxPages; page++) {
  const result = await backfillRefundNotifications(db, {
    limit: args.limit,
    dryRun: !args.execute,
    excludeOrderIds: PROTECTED_ORDER_IDS,
    ...(after !== undefined ? {after} : {}),
  });
  for (const key of Object.keys(totals)) totals[key] += result[key];
  console.log(`page ${page}:`, {...result, eventIds: `${result.eventIds.length} ids`});
  if (!args.execute && result.eventIds.length > 0) console.log('  would process:', result.eventIds.join(', '));
  if (result.nextCursor === null) {
    after = undefined;
    break;
  }
  after = result.nextCursor;
}
console.log('totals:', totals);
if (after !== undefined) console.log(`Stopped at --max-pages; continue by raising it (next cursor: ${after}).`);
