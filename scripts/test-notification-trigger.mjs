#!/usr/bin/env node
/**
 * Runs the notification TRIGGER integration test (functions/src/**\/*.trigger.test.ts): events are
 * written to a Firestore emulator and processed by the REAL, compiled `onNotificationEventCreated`
 * running in the Functions emulator (document create -> Eventarc emulator -> function ->
 * processor -> inbox). Nothing calls the processor directly.
 *
 * Isolation (all local, nothing real is touched):
 * - The Functions emulator loads the real compiled `functions/lib/index.js` from a THROWAWAY copy
 *   of the Functions source (functions/.trigger-test/app, deleted afterwards). It carries no real
 *   value: `.env.demo-zesto-trigger` holds placeholders and a BLANK `RAZORPAY_KEY_ID`, and
 *   `.secret.local` holds dummy secrets (so the emulator does not look them up in Google Secret
 *   Manager). The `onRefundCreated` trigger also fires here whenever a test creates a refund; with no
 *   key id the Razorpay gateway reports "credentials missing" before it builds a request, so it
 *   defers and cannot reach Razorpay.
 * - A guard (`--require`d into every Node process the emulators start) refuses any network connection
 *   that is not to loopback and records each attempt. The run FAILS if it blocked anything other
 *   than the CLI tooling's own telemetry/npm lookups.
 * - Project id `demo-zesto-trigger` (a demo project: the emulators never contact Google), and
 *   ports away from the defaults, so a `firebase emulators:start` already running on the usual
 *   ports (8080, 5001, ...) is left alone.
 *
 * Build functions first (`npm --prefix functions run build`): this script builds it itself.
 */
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = resolve(root, 'functions/.trigger-test');
const appDir = resolve(tempRoot, 'app');
const PROJECT_ID = 'demo-zesto-trigger';
const isWindows = process.platform === 'win32';
const guardFile = resolve(tempRoot, 'network-guard.cjs');
const blockedLog = resolve(tempRoot, 'blocked-network.log');
// Traffic from the CLI tools wrapped around the test (Firebase CLI usage telemetry, npx/npm lookups):
// blocked like everything else, and not a failure. Anything else blocked fails the run.
const TOOLING_HOSTS = ['www.google-analytics.com:443', 'registry.npmjs.org:443'];

// Loaded into every Node process the emulators start: refuses any non-loopback connection and records it.
const GUARD_SOURCE = String.raw`
const net = require('node:net');
const fs = require('node:fs');
const original = net.Socket.prototype.connect;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;
net.Socket.prototype.connect = function (...args) {
  const [options] = net._normalizeArgs(args);
  if (!options.path) {
    const host = String(options.host || 'localhost');
    if (!LOOPBACK.test(host)) {
      try { fs.appendFileSync(${JSON.stringify(blockedLog)}, host + ':' + options.port + '\n'); } catch {}
      throw new Error('network-guard: blocked connection to ' + host);
    }
  }
  return original.apply(this, args);
};
`;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', shell: isWindows, env});
  return result.status ?? 1;
}

function toForwardSlashes(path) {
  return path.split(sep).join('/');
}

function cleanup() {
  rmSync(tempRoot, {recursive: true, force: true});
}

cleanup();
let status = 1;
try {
  if (run('npm', ['--prefix', 'functions', 'run', 'build']) !== 0) {
    throw new Error('functions build failed');
  }

  mkdirSync(appDir, {recursive: true});
  cpSync(resolve(root, 'functions/package.json'), resolve(appDir, 'package.json'));
  cpSync(resolve(root, 'functions/lib'), resolve(appDir, 'lib'), {recursive: true});
  // Placeholders only. RAZORPAY_KEY_ID is blank, so the refund gateway reports "credentials missing"
  // before it builds any request; the secrets are non-empty dummies, which stops the emulator looking
  // them up in Google Secret Manager.
  writeFileSync(
    resolve(appDir, `.env.${PROJECT_ID}`),
    'DESCOPE_PROJECT_ID=placeholder-descope-project\nRAZORPAY_KEY_ID=\n',
  );
  writeFileSync(
    resolve(appDir, '.secret.local'),
    'RAZORPAY_KEY_SECRET=dummy-not-a-secret\nRAZORPAY_WEBHOOK_SECRET=dummy-not-a-secret\nPICKUP_CREDENTIAL_SECRET=dummy-not-a-secret\n',
  );
  writeFileSync(guardFile, GUARD_SOURCE);
  writeFileSync(resolve(tempRoot, 'firebase.json'), JSON.stringify({
    functions: {source: 'app'},
    firestore: {},
    emulators: {
      hub: {port: 4410},
      logging: {port: 4510},
      functions: {port: 5011},
      firestore: {port: 8093, websocketPort: 9193},
      eventarc: {port: 9399},
      ui: {enabled: false},
    },
  }, null, 2));

  status = run('npx', [
    'firebase', 'emulators:exec',
    '--config', 'functions/.trigger-test/firebase.json',
    '--project', PROJECT_ID,
    '--only', 'functions,firestore',
    '"npx vitest run --config functions/vitest.trigger.config.mts"',
  ], {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${toForwardSlashes(guardFile)}`.trim(),
  });
  const attempts = existsSync(blockedLog) ? readFileSync(blockedLog, 'utf8').split('\n').filter(Boolean) : [];
  const counts = new Map();
  for (const attempt of attempts) {
    counts.set(attempt, (counts.get(attempt) ?? 0) + 1);
  }
  const unexpected = [...counts.keys()].filter((host) => !TOOLING_HOSTS.includes(host));
  console.log(`\nNETWORK GUARD: ${attempts.length} blocked non-loopback connection attempt(s).`);
  for (const [host, count] of counts) {
    console.log(`  ${host} x${count}${TOOLING_HOSTS.includes(host) ? ' (CLI tooling: telemetry / npm lookup)' : '  <-- UNEXPECTED'}`);
  }
  if (unexpected.length > 0) {
    console.error('NETWORK GUARD: the Functions code or a test tried to reach something outside this machine.');
    status = 1;
  }
} finally {
  cleanup();
}
process.exit(status);
