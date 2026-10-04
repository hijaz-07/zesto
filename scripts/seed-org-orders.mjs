#!/usr/bin/env node
/**
 * EMULATOR-ONLY seed for the organization order dashboard (`/org/orders`).
 *
 * It writes outlets, menus, orders and members straight into the Firestore
 * EMULATOR so the dashboard can be checked by hand: pagination (more than 50
 * orders), the outlet filter, confirmed / preparing / ready / pending_payment /
 * cancelled orders (so both fulfillment actions, "Start preparing" and "Mark
 * ready", have orders to act on), an inactive outlet with historical orders, and
 * a second, unrelated organization whose orders must never show up.
 *
 * SAFETY: this refuses to run unless FIRESTORE_EMULATOR_HOST is set to a
 * loopback address. With that variable set the Admin SDK talks only to the
 * emulator, so it cannot reach production — and it never loads credentials.
 * Everything it writes is clearly test data: "[SEED]" names, "seed-" slugs and
 * ids, "U-seed-" users.
 *
 * Usage (from the repo root; start the emulators first, see below):
 *
 *   # 1. Start the Functions + Firestore emulators (builds functions first):
 *   #      cd functions && npm run serve
 *   # 2. In another terminal, start the app (`npm run dev`), sign in, and create
 *   #    an organization through /org/onboarding (this is YOUR organization,
 *   #    with you as its owner).
 *   # 3. Seed it. The Firestore emulator listens on 127.0.0.1:8080:
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-org-orders.mjs --org-slug <your-org-slug>
 *
 *   # Check the dashboard as each kind of member (--as changes the status/role of
 *   # YOUR membership in that organization, e.g. to see what staff or a revoked
 *   # member gets; run again with --as owner to get your access back):
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-org-orders.mjs --org-slug <slug> --as staff
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-org-orders.mjs --org-slug <slug> --as revoked
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-org-orders.mjs --org-slug <slug> --as owner
 *
 *   # Remove everything this script created (the second organization, and the
 *   # seeded outlets/menus/orders/members in yours):
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-org-orders.mjs --org-slug <slug> --clean
 *
 * Options:
 *   --org-slug <slug>   The organization to seed (it must already exist).
 *   --user-id <id>      Whose membership --as changes. Defaults to the
 *                       organization's creator (you, if you onboarded it).
 *   --as <role>         owner | manager | staff (active) or invited | revoked
 *                       (keeps the current role). Needs no --clean/seed run.
 *   --clean             Delete what this script created, then exit.
 *   --project <id>      The emulator project id. Defaults to GCLOUD_PROJECT /
 *                       GOOGLE_CLOUD_PROJECT, then .firebaserc's default project
 *                       (the project `firebase emulators:start` runs under).
 *
 * Re-running is safe: every document has a fixed id, so a run overwrites the
 * previous seed instead of duplicating it.
 */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

// firebase-admin is installed in functions/, not at the repo root.
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const {initializeApp} = require('firebase-admin/app');
const {Timestamp, getFirestore} = require('firebase-admin/firestore');

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// -------------------------------------------------------------------------
// Emulator-only guard — runs before anything else touches Firestore.
// -------------------------------------------------------------------------
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulatorHost) {
  die(
    'Refusing to run: FIRESTORE_EMULATOR_HOST is not set.\n' +
    'This script seeds the Firestore EMULATOR only and never connects to production.\n' +
    'Start the emulators, then run, for example:\n' +
    '  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-org-orders.mjs --org-slug <slug>',
  );
}
const emulatorHostname = emulatorHost.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
if (!['127.0.0.1', 'localhost', '::1'].includes(emulatorHostname)) {
  die(
    `Refusing to run: FIRESTORE_EMULATOR_HOST is "${emulatorHost}", which is not a loopback address.\n` +
    'The seed only writes to an emulator on this machine (127.0.0.1, localhost or ::1).',
  );
}

// -------------------------------------------------------------------------
// Arguments
// -------------------------------------------------------------------------
const VALUE_FLAGS = new Set(['--org-slug', '--user-id', '--as', '--project']);
const BOOLEAN_FLAGS = new Set(['--clean']);
const AS_VALUES = ['owner', 'manager', 'staff', 'invited', 'revoked'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (BOOLEAN_FLAGS.has(flag)) {
      args[flag.slice(2)] = true;
    } else if (VALUE_FLAGS.has(flag)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        die(`${flag} needs a value.`);
      }
      args[flag.slice(2)] = value;
    } else {
      die(`Unknown argument "${flag}". See the usage at the top of scripts/seed-org-orders.mjs.`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args['org-slug']) {
  die('--org-slug <slug> is required: the organization (created through /org/onboarding) to seed.');
}
if (args.as !== undefined && !AS_VALUES.includes(args.as)) {
  die(`--as must be one of: ${AS_VALUES.join(', ')}.`);
}

function defaultProjectId() {
  const fromEnv = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (fromEnv) return fromEnv;
  try {
    const rc = JSON.parse(readFileSync(fileURLToPath(new URL('../.firebaserc', import.meta.url)), 'utf8'));
    return rc.projects?.default;
  } catch {
    return undefined;
  }
}

const projectId = args.project || defaultProjectId();
if (!projectId) {
  die('Could not work out the emulator project id. Pass --project <id> (the project the emulators run under).');
}

// No credential is passed: with FIRESTORE_EMULATOR_HOST set the SDK needs none.
initializeApp({projectId});
const db = getFirestore();

// -------------------------------------------------------------------------
// Fixed ids: re-running overwrites instead of duplicating, and --clean knows
// exactly what to remove. Menu ids are unique across organizations on purpose
// (the order list resolves menu names by menu id).
// -------------------------------------------------------------------------
const SEED_USERS = {
  manager: 'U-seed-manager',
  staff: 'U-seed-staff',
  invited: 'U-seed-invited',
  revoked: 'U-seed-revoked',
  otherOwner: 'U-seed-other-owner',
};
const CUSTOMERS = Array.from({length: 8}, (_unused, i) => `U-seed-customer-${i + 1}`);

const OTHER_ORG = {id: 'seed-other-org', slug: 'seed-other-org', name: '[SEED] Other Organization'};

const OUTLETS = [
  {id: 'seed-a-outlet-main', slug: 'seed-main-canteen', name: '[SEED] Main Canteen', status: 'active', menuId: 'seed-a-menu-main', orders: 75, offsetMinutes: 0},
  {id: 'seed-a-outlet-hostel', slug: 'seed-hostel-cafe', name: '[SEED] Hostel Café', status: 'active', menuId: 'seed-a-menu-hostel', orders: 30, offsetMinutes: 3},
  {id: 'seed-a-outlet-annex', slug: 'seed-old-annex', name: '[SEED] Old Annex', status: 'inactive', menuId: 'seed-a-menu-annex', orders: 12, offsetMinutes: 6},
];
const OTHER_OUTLET = {
  id: 'seed-b-outlet-canteen', slug: 'seed-other-canteen', name: '[SEED] Other Org Canteen', status: 'active',
  menuId: 'seed-b-menu-canteen', orders: 10, offsetMinutes: 1,
};

const DISHES = [
  ['Chicken Biriyani', 12000], ['Veg Meals', 6000], ['Fish Curry Meals', 9000], ['Masala Dosa', 5000],
  ['Egg Roast', 4000], ['Paneer Butter Masala', 11000], ['Parotta', 1500], ['Beef Fry', 10000],
  ['Ghee Rice', 7000], ['Tea', 1000], ['Filter Coffee', 1500], ['Gulab Jamun', 2500],
];
const OTHER_DISHES = [['OTHER-ORG Secret Special', 99900], ['OTHER-ORG Chef Platter', 88800]];

// A tiny deterministic generator, so every run seeds the same lines.
function lcg(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const now = Date.now();
const minutesAgo = (minutes) => Timestamp.fromMillis(now - minutes * 60_000);

// Of every 20 orders: 8 confirmed (ready to be started), 2 preparing, 2 ready,
// 5 awaiting payment, 2 cancelled unpaid, 1 cancelled after being paid. The
// preparing/ready ones carry the same audit fields the fulfillment transition
// writes (who and when), so the dashboard can be checked against realistic data.
function statusFor(index, createdAt) {
  const slot = index % 20;
  const later = (minutes) => Timestamp.fromMillis(createdAt.toMillis() + minutes * 60_000);
  if (slot < 8) return {status: 'confirmed', paymentStatus: 'paid'};
  if (slot < 10) {
    return {
      status: 'preparing', paymentStatus: 'paid',
      preparingStartedAt: later(5), preparingStartedBy: 'U-seed-staff',
      updatedAt: later(5),
    };
  }
  if (slot < 12) {
    return {
      status: 'ready', paymentStatus: 'paid',
      preparingStartedAt: later(5), preparingStartedBy: 'U-seed-staff',
      readyAt: later(15), readyBy: 'U-seed-staff',
      updatedAt: later(15),
    };
  }
  if (slot < 17) return {status: 'pending_payment', paymentStatus: 'pending'};
  if (slot < 19) return {status: 'cancelled', paymentStatus: 'pending'};
  return {status: 'cancelled', paymentStatus: 'paid'}; // paid, then cancelled
}

function buildOrder({organizationId, outlet, index, dishes, customerPool, createdAt, lineCount}) {
  const random = lcg(index * 7919 + outlet.id.length * 31);
  const lines = Array.from({length: lineCount ?? 1 + Math.floor(random() * 4)}, (_unused, lineIndex) => {
    const [name, priceInPaise] = dishes[(index + lineIndex * 3) % dishes.length];
    const quantity = 1 + Math.floor(random() * 3);
    return {
      itemId: `seed-item-${(index + lineIndex * 3) % dishes.length}`,
      name,
      priceInPaise,
      quantity,
      lineTotalInPaise: priceInPaise * quantity,
    };
  });
  const subtotalInPaise = lines.reduce((sum, line) => sum + line.lineTotalInPaise, 0);
  const id = `${outlet.id}-order-${String(index + 1).padStart(3, '0')}`;
  return {
    id,
    userId: customerPool[index % customerPool.length],
    organizationId,
    outletId: outlet.id,
    menuId: outlet.menuId,
    currency: 'INR',
    subtotalInPaise,
    totalInPaise: subtotalInPaise,
    items: lines,
    createdAt,
    updatedAt: createdAt,
    // Last, so a fulfilled order's own `updatedAt` replaces the default above.
    ...statusFor(index, createdAt),
  };
}

// -------------------------------------------------------------------------
// Writes
// -------------------------------------------------------------------------
async function writeAll(operations) {
  const BATCH_LIMIT = 400;
  for (let start = 0; start < operations.length; start += BATCH_LIMIT) {
    const batch = db.batch();
    for (const {ref, data} of operations.slice(start, start + BATCH_LIMIT)) {
      batch.set(ref, data);
    }
    await batch.commit();
  }
}

function outletOps(organizationId, createdBy, outlets) {
  const operations = [];
  const at = Timestamp.fromMillis(now - 30 * 24 * 60 * 60_000);
  for (const outlet of outlets) {
    const outletRef = db.collection('organizations').doc(organizationId).collection('outlets').doc(outlet.id);
    operations.push({
      ref: outletRef,
      data: {
        id: outlet.id, organizationId, name: outlet.name, slug: outlet.slug, status: outlet.status,
        createdAt: at, updatedAt: at, createdBy,
      },
    });
    operations.push({
      ref: db.collection('organizations').doc(organizationId).collection('outletSlugs').doc(outlet.slug),
      data: {organizationId, outletId: outlet.id, createdAt: at},
    });
    // Archived on purpose: an archived menu never shows up in the public Explore feed.
    operations.push({
      ref: outletRef.collection('menus').doc(outlet.menuId),
      data: {
        id: outlet.menuId, organizationId, outletId: outlet.id,
        menuDate: new Date(now).toISOString().slice(0, 10),
        title: `[SEED] ${outlet.name.replace('[SEED] ', '')} Menu`,
        status: 'archived',
        orderingOpensAt: Timestamp.fromMillis(now - 48 * 60 * 60_000),
        orderingClosesAt: Timestamp.fromMillis(now - 24 * 60 * 60_000),
        pickupStartsAt: Timestamp.fromMillis(now - 23 * 60 * 60_000),
        pickupEndsAt: Timestamp.fromMillis(now - 20 * 60 * 60_000),
        createdAt: at, updatedAt: at, createdBy, publishedAt: at,
      },
    });
  }
  return operations;
}

function memberOp(organizationId, userId, role, status) {
  return {
    ref: db.collection('organizations').doc(organizationId).collection('members').doc(userId),
    data: {userId, organizationId, role, status, createdAt: Timestamp.fromMillis(now - 30 * 24 * 60 * 60_000)},
  };
}

async function findOrganization(slug) {
  const reservation = await db.collection('organizationSlugs').doc(slug).get();
  const organizationId = reservation.exists ? reservation.data()?.organizationId : undefined;
  if (typeof organizationId !== 'string') return undefined;
  const snapshot = await db.collection('organizations').doc(organizationId).get();
  return snapshot.exists ? {id: organizationId, ...snapshot.data()} : undefined;
}

async function clean(organization) {
  const orgRef = db.collection('organizations').doc(organization.id);
  for (const outlet of OUTLETS) {
    await db.recursiveDelete(orgRef.collection('outlets').doc(outlet.id));
    await orgRef.collection('outletSlugs').doc(outlet.slug).delete();
  }
  for (const userId of [SEED_USERS.manager, SEED_USERS.staff, SEED_USERS.invited, SEED_USERS.revoked]) {
    await orgRef.collection('members').doc(userId).delete();
  }
  await db.recursiveDelete(db.collection('organizations').doc(OTHER_ORG.id));
  await db.collection('organizationSlugs').doc(OTHER_ORG.slug).delete();
}

async function seed(organization) {
  const organizationId = organization.id;
  const createdBy = organization.createdBy;
  const operations = [];

  // ---- Your organization: three outlets (one inactive), menus, orders, members.
  operations.push(...outletOps(organizationId, createdBy, OUTLETS));
  for (const outlet of OUTLETS) {
    for (let index = 0; index < outlet.orders; index++) {
      // Orders 20-23 of the main outlet share one exact createdAt (a tie), to exercise paging across ties.
      const tieIndex = outlet.id === OUTLETS[0].id && index >= 20 && index <= 23 ? 20 : index;
      const createdAt = minutesAgo(5 + tieIndex * 9 + outlet.offsetMinutes);
      // One main-outlet order has 13 lines: the list shows 10 and "+3 more".
      const lineCount = outlet.id === OUTLETS[0].id && index === 4 ? 13 : undefined;
      const order = buildOrder({organizationId, outlet, index, dishes: DISHES, customerPool: CUSTOMERS, createdAt, lineCount});
      operations.push({
        ref: db.collection('organizations').doc(organizationId).collection('outlets').doc(outlet.id)
          .collection('menus').doc(outlet.menuId).collection('orders').doc(order.id),
        data: order,
      });
    }
  }
  operations.push(memberOp(organizationId, SEED_USERS.manager, 'manager', 'active'));
  operations.push(memberOp(organizationId, SEED_USERS.staff, 'staff', 'active'));
  operations.push(memberOp(organizationId, SEED_USERS.invited, 'owner', 'invited'));
  operations.push(memberOp(organizationId, SEED_USERS.revoked, 'manager', 'revoked'));

  // ---- A second, unrelated organization. Its orders must never reach the dashboard above.
  const otherRef = db.collection('organizations').doc(OTHER_ORG.id);
  const at = Timestamp.fromMillis(now - 30 * 24 * 60 * 60_000);
  operations.push({
    ref: otherRef,
    data: {id: OTHER_ORG.id, name: OTHER_ORG.name, slug: OTHER_ORG.slug, createdAt: at, createdBy: SEED_USERS.otherOwner},
  });
  operations.push({
    ref: db.collection('organizationSlugs').doc(OTHER_ORG.slug),
    data: {organizationId: OTHER_ORG.id, createdAt: at},
  });
  operations.push(memberOp(OTHER_ORG.id, SEED_USERS.otherOwner, 'owner', 'active'));
  operations.push(...outletOps(OTHER_ORG.id, SEED_USERS.otherOwner, [OTHER_OUTLET]));
  for (let index = 0; index < OTHER_OUTLET.orders; index++) {
    const order = buildOrder({
      organizationId: OTHER_ORG.id, outlet: OTHER_OUTLET, index, dishes: OTHER_DISHES,
      customerPool: [`${SEED_USERS.otherOwner}-customer`], createdAt: minutesAgo(2 + index * 5),
    });
    operations.push({
      ref: otherRef.collection('outlets').doc(OTHER_OUTLET.id).collection('menus').doc(OTHER_OUTLET.menuId)
        .collection('orders').doc(order.id),
      data: order,
    });
  }

  await writeAll(operations);
}

async function setMembership(organization, userId, requested) {
  const memberRef = db.collection('organizations').doc(organization.id).collection('members').doc(userId);
  const current = await memberRef.get();
  const currentRole = current.exists ? current.data()?.role : undefined;
  const role = ['owner', 'manager', 'staff'].includes(requested) ? requested : currentRole ?? 'manager';
  const status = ['owner', 'manager', 'staff'].includes(requested) ? 'active' : requested;
  await memberRef.set({
    userId, organizationId: organization.id, role, status,
    createdAt: current.exists ? current.data().createdAt : Timestamp.fromMillis(now),
  });
  return {role, status};
}

// -------------------------------------------------------------------------
// Run
// -------------------------------------------------------------------------
console.log(`Firestore EMULATOR at ${emulatorHost}, project "${projectId}".`);

const organization = await findOrganization(args['org-slug']);
if (!organization) {
  die(
    `No organization with slug "${args['org-slug']}" exists in this emulator (project "${projectId}").\n` +
    'Create it first through /org/onboarding in the running app, and check --project matches the project\n' +
    'the Functions emulator runs under.',
  );
}

if (args.clean) {
  await clean(organization);
  console.log(`Removed the seeded outlets, menus, orders and members from "${organization.slug}", and the second organization.`);
  process.exit(0);
}

if (args.as) {
  const subject = args['user-id'] || organization.createdBy;
  const result = await setMembership(organization, subject, args.as);
  console.log(`Membership of ${subject} in "${organization.slug}" is now: role ${result.role}, status ${result.status}.`);
  process.exit(0);
}

await seed(organization);

const total = OUTLETS.reduce((sum, outlet) => sum + outlet.orders, 0);
console.log(`
Seeded "${organization.slug}" (${organization.id}):
  - ${OUTLETS.length} outlets: ${OUTLETS.map((o) => `${o.name} (${o.status}, ${o.orders} orders)`).join('; ')}
  - ${total} orders in total (confirmed, preparing, ready, pending_payment and cancelled; one with 13 item lines; four sharing one timestamp)
  - members: ${SEED_USERS.manager} (manager), ${SEED_USERS.staff} (staff), ${SEED_USERS.invited} (invited), ${SEED_USERS.revoked} (revoked)
Seeded "${OTHER_ORG.slug}": a second, unrelated organization with ${OTHER_OUTLET.orders} orders.
  Its dish names start with "OTHER-ORG": none of them may ever appear in /org/orders.

Open /org/orders in the app. Try Load more (more than 50 orders), the outlet filter (including
"[SEED] Old Annex (inactive)"), and Refresh. To view it as another kind of member, re-run with
--as staff | manager | invited | revoked (and --as owner to restore your access).
`);
