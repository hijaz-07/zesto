#!/usr/bin/env node
/**
 * REAL Razorpay TEST MODE validation of the payment-reconciliation lookup path (checkpoint 4.7).
 * It never touches Firebase, Firestore, Zesto orders or customers: it creates ONE disposable
 * Razorpay order (Rs 1, receipt `zesto-lookup-validation-<time>`) and exercises the compiled
 * `razorpayPayments` gateway and the pure matching rules against Razorpay's real API.
 *
 *   npm --prefix functions run build
 *   node scripts/validate-razorpay-lookup.mjs --env-file functions/.env.<project> [--secret-file functions/.secret.local]
 *
 * Safety:
 *   - refuses any key id that is not `rzp_test_...` (a Live key never gets this far);
 *   - the key id is read from the env file and the secret from the secret file; neither is printed;
 *   - it creates an ORDER only. It does not create a payment, so no `payment.*` webhook can fire
 *     (Razorpay Test Mode accounts deliver webhooks for every payment in the account, which for the
 *     shared Test account would reach the production endpoint). Capturing a real Test payment
 *     therefore waits for a staging Razorpay key pair and webhook (docs/operations/environments.md);
 *   - the order is not captured and expires by itself; nothing needs cleaning up.
 *
 * What it proves against the real provider: the endpoint and response shape the gateway parses,
 * the `no payments` evaluation, the typed failure for an unknown order and for rejected credentials,
 * and that a malformed id is refused locally before any request.
 */
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDotenv, razorpayMode, shorten} from './check-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/**
 * @param {string[]} argv Arguments.
 * @param {string} name Flag name.
 * @return {string | undefined} The flag's value.
 */
function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * @param {string} path A file path (relative to the repository).
 * @return {Record<string, string>} Its variables.
 */
function readVariables(path) {
  const full = resolve(root, path);
  if (!existsSync(full)) {
    throw new Error(`File not found: ${path}`);
  }
  return parseDotenv(readFileSync(full, 'utf8'));
}

const results = [];
/**
 * @param {string} name What was checked.
 * @param {boolean} ok Whether it held.
 * @param {string} detail A short, secret-free note.
 */
function record(name, ok, detail) {
  results.push({name, ok, detail});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * @param {string[]} argv Arguments.
 * @return {Promise<number>} The exit code.
 */
async function main(argv) {
  const envFile = flag(argv, '--env-file');
  if (!envFile) {
    console.error('Usage: node scripts/validate-razorpay-lookup.mjs --env-file functions/.env.<project> [--secret-file functions/.secret.local]');
    return 2;
  }
  const keyId = readVariables(envFile).RAZORPAY_KEY_ID;
  const keySecret = readVariables(flag(argv, '--secret-file') ?? 'functions/.secret.local').RAZORPAY_KEY_SECRET;
  if (razorpayMode(keyId) !== 'test') {
    console.error(`Refusing to run: the key id is not a Razorpay TEST key (mode: ${razorpayMode(keyId)}).`);
    return 2;
  }
  if (!keySecret) {
    console.error('Refusing to run: RAZORPAY_KEY_SECRET is not set in the secret file.');
    return 2;
  }
  console.log(`Razorpay mode: test (key ${shorten(keyId)}). Secret not printed.`);

  const {createRazorpayPaymentLookupGateway} = require(resolve(root, 'functions/lib/providers/razorpayPayments.js'));
  const {evaluateOrderPayments} = require(resolve(root, 'functions/lib/domain/paymentReconciliation.js'));
  const {isRefundProviderError} = require(resolve(root, 'functions/lib/providers/refundGateway.js'));

  const gateway = createRazorpayPaymentLookupGateway({getCredentials: () => ({keyId, keySecret})});

  // 1. One disposable Test Mode order (an order only: no payment, so no payment webhook).
  const amountInPaise = 100;
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
    },
    body: JSON.stringify({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `zesto-lookup-validation-${Date.now()}`,
      notes: {purpose: 'Zesto checkpoint 4.7 reconciliation lookup validation (disposable, Test Mode)'},
    }),
  });
  const created = await response.json();
  record('disposable Test Mode order created', response.status === 200 && /^order_[A-Za-z0-9]+$/.test(created.id ?? ''),
    `HTTP ${response.status}, id ${created.id ?? '(none)'}, status ${created.status ?? '(none)'}`);
  if (!created.id) {
    return 1;
  }

  // 2. Provider payment lookup through the real gateway: an order nobody paid lists no payments.
  const listed = await gateway.listOrderPayments(created.id);
  record('real GET /orders/{id}/payments parsed by the gateway', Array.isArray(listed) && listed.length === 0,
    `${listed.length} payment(s) listed`);

  // 3. The matching rules on that real answer: nothing captured is never "paid".
  const verdict = evaluateOrderPayments({providerOrderId: created.id, amountInPaise, currency: 'INR'}, listed);
  record('an unpaid real order evaluates as open/no_payments, never captured',
    verdict.evaluation.kind === 'open' && verdict.evaluation.state === 'no_payments', `evaluation ${verdict.evaluation.kind}`);

  // 4. Typed failure for an order the provider does not know (no payment can be inferred from it).
  try {
    await gateway.listOrderPayments('order_ZestoDoesNotExist0000');
    record('unknown provider order is a typed failure', false, 'the lookup unexpectedly succeeded');
  } catch (error) {
    record('unknown provider order is a typed failure', isRefundProviderError(error),
      isRefundProviderError(error) ? `category ${error.category}, code ${error.code}` : `untyped ${error?.name}`);
  }

  // 5. Rejected credentials are classified as a configuration problem, not as "not paid".
  const wrongCredentials = createRazorpayPaymentLookupGateway({
    getCredentials: () => ({keyId: 'rzp_test_ZestoInvalidKey00', keySecret: 'not-a-real-secret'}),
  });
  try {
    await wrongCredentials.listOrderPayments(created.id);
    record('rejected credentials are a configuration failure', false, 'the lookup unexpectedly succeeded');
  } catch (error) {
    record('rejected credentials are a configuration failure', isRefundProviderError(error) && error.category === 'AUTH_CONFIGURATION',
      isRefundProviderError(error) ? `category ${error.category}, code ${error.code}` : `untyped ${error?.name}`);
  }

  // 6. A malformed id never leaves the process.
  try {
    await gateway.listOrderPayments('order_x/../../refunds');
    record('a malformed provider id is refused before any request', false, 'it was accepted');
  } catch (error) {
    record('a malformed provider id is refused before any request', isRefundProviderError(error), error?.code ?? error?.name);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `\nAll ${results.length} real-provider checks passed.` : `\n${failed} of ${results.length} checks FAILED.`);
  return failed === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
  console.error(`Validation aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
