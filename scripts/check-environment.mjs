#!/usr/bin/env node
/**
 * READ-ONLY environment safety check. Before building or deploying, it states WHICH Zesto
 * environment the local configuration files describe and refuses combinations that would let one
 * environment reach another's data or money. It changes nothing, contacts nothing, and prints only
 * variable NAMES, payment-mode words and shortened public identifiers — never a secret or a full value.
 *
 *   node scripts/check-environment.mjs --env production
 *   node scripts/check-environment.mjs --env staging
 *
 * Files it reads (all gitignored; see docs/operations/environments.md):
 *   frontend  .env.production.local  (production; falls back to the legacy .env.local)
 *             .env.staging.local     (staging)
 *   backend   functions/.env.<firebase project id>   (the Firebase CLI loads it for that project only)
 *
 * It fails (exit 1) when:
 *   - the frontend names a different Firebase project than the environment's;
 *   - the frontend and backend name different Descope projects (the backend would reject every session);
 *   - staging shares a Firebase project or Descope project with production;
 *   - staging uses anything but a Razorpay TEST key, or production uses a LIVE key without --allow-live
 *     (Live Mode is a deliberate, separate step);
 *   - a Razorpay key id is not a recognisable `rzp_test_` / `rzp_live_` id;
 *   - a secret-looking variable sits in a file that is not a secret store.
 * and reports (without failing) what is not set up yet. A staging environment that does not exist yet
 * is reported as "not configured", never guessed at.
 */
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const PRODUCTION_PROJECT_ID = 'zesto-dev-2026';

/** Variables that are public identifiers by design (safe to show shortened). */
const PUBLIC_VARIABLES = new Set([
  'VITE_FIREBASE_PROJECT_ID', 'VITE_DESCOPE_PROJECT_ID', 'DESCOPE_PROJECT_ID', 'RAZORPAY_KEY_ID',
]);
const SECRET_NAME = /(SECRET|PRIVATE_KEY|PASSWORD|TOKEN|MANAGEMENT_KEY|SERVICE_ACCOUNT)/i;

/**
 * @param {string} text The text of a dotenv file.
 * @return {Record<string, string>} Its variables (comments and blank lines ignored; surrounding quotes removed).
 */
export function parseDotenv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) {
      continue;
    }
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/**
 * @param {string | undefined} keyId A Razorpay key id.
 * @return {'test' | 'live' | 'unknown' | 'missing'} The mode its public prefix names.
 */
export function razorpayMode(keyId) {
  if (!keyId) {
    return 'missing';
  }
  if (/^rzp_test_[A-Za-z0-9]+$/.test(keyId)) {
    return 'test';
  }
  return /^rzp_live_[A-Za-z0-9]+$/.test(keyId) ? 'live' : 'unknown';
}

/**
 * @param {string | undefined} value A public identifier.
 * @return {string} A shortened form safe to print (`abcd…wxyz`), or `(not set)`.
 */
export function shorten(value) {
  if (!value) {
    return '(not set)';
  }
  return value.length <= 10 ? `${value.slice(0, 3)}…` : `${value.slice(0, 5)}…${value.slice(-3)}`;
}

/**
 * The pure decision. `files` holds the parsed variables of each file (or `null` when absent).
 *
 * @param {object} input
 * @param {'production' | 'staging'} input.env The environment being checked.
 * @param {string | null} input.stagingProjectId The staging Firebase project id, once one exists (from .firebaserc).
 * @param {Record<string, string> | null} input.frontend The environment's frontend variables.
 * @param {Record<string, string> | null} input.backend The environment's backend variables.
 * @param {Record<string, string> | null} input.otherFrontend The OTHER environment's frontend variables, if readable.
 * @param {Record<string, string> | null} input.otherBackend The OTHER environment's backend variables, if readable.
 * @param {Record<string, string> | null} [input.legacyFrontend] The shared `.env.local`, which Vite loads in EVERY mode.
 * @param {boolean} [input.allowLive] Whether Live Mode is explicitly permitted.
 * @return {{errors: string[], notes: string[], summary: Record<string, string>}} What was found.
 */
export function checkEnvironment(input) {
  const {env, frontend, backend, otherFrontend, otherBackend, legacyFrontend = null, allowLive = false} = input;
  const errors = [];
  const notes = [];
  const expectedProject = env === 'production' ? PRODUCTION_PROJECT_ID : input.stagingProjectId;

  if (expectedProject === null || expectedProject === undefined) {
    notes.push(`No ${env} Firebase project is configured (.firebaserc has no "${env}" alias). Nothing to check.`);
    return {errors, notes, summary: {environment: env, firebaseProject: '(not configured)'}};
  }
  if (env === 'staging' && expectedProject === PRODUCTION_PROJECT_ID) {
    errors.push('The staging alias points at the PRODUCTION Firebase project. Staging must be its own project.');
  }

  if (frontend === null) {
    notes.push(`Frontend env file for ${env} not found.`);
  } else if (frontend.VITE_FIREBASE_PROJECT_ID !== expectedProject) {
    errors.push(
      `Frontend VITE_FIREBASE_PROJECT_ID is ${shorten(frontend.VITE_FIREBASE_PROJECT_ID)} but ${env} is ${expectedProject}.`,
    );
  }
  if (backend === null) {
    notes.push(`Backend env file functions/.env.${expectedProject} not found.`);
  }

  const frontDescope = frontend?.VITE_DESCOPE_PROJECT_ID;
  const backDescope = backend?.DESCOPE_PROJECT_ID;
  if (frontDescope && backDescope && frontDescope !== backDescope) {
    errors.push('Frontend VITE_DESCOPE_PROJECT_ID and backend DESCOPE_PROJECT_ID differ: the backend would reject every session.');
  }
  if (frontend !== null && !frontDescope) {
    errors.push('Frontend VITE_DESCOPE_PROJECT_ID is not set.');
  }
  if (backend !== null && !backDescope) {
    errors.push('Backend DESCOPE_PROJECT_ID is not set.');
  }

  const mode = razorpayMode(backend?.RAZORPAY_KEY_ID);
  if (backend !== null) {
    if (mode === 'missing') {
      errors.push('Backend RAZORPAY_KEY_ID is not set.');
    } else if (mode === 'unknown') {
      errors.push('Backend RAZORPAY_KEY_ID is not a recognisable rzp_test_ / rzp_live_ key id.');
    } else if (mode === 'live' && (env === 'staging' || !allowLive)) {
      errors.push(env === 'staging' ?
        'Staging must use a Razorpay TEST key; a LIVE key id is configured.' :
        'Production is configured with a Razorpay LIVE key id. Live Mode is a deliberate step: pass --allow-live only then.');
    }
  }

  // The other environment must share nothing mutable with this one.
  if (env === 'staging') {
    if (frontDescope && (otherFrontend?.VITE_DESCOPE_PROJECT_ID === frontDescope || otherBackend?.DESCOPE_PROJECT_ID === frontDescope)) {
      errors.push('Staging uses the same Descope project as production: users and sessions would be shared.');
    }
    if (backend?.RAZORPAY_KEY_ID && otherBackend?.RAZORPAY_KEY_ID === backend.RAZORPAY_KEY_ID) {
      errors.push('Staging uses the same Razorpay key id as production.');
    }
    if (frontend?.VITE_FIREBASE_PROJECT_ID === PRODUCTION_PROJECT_ID) {
      errors.push('The staging frontend points at the production Firebase project.');
    }
    // `vite build --mode staging` still loads `.env.local` (every mode does) and only OVERRIDES it with
    // `.env.staging.local`. A variable staging forgot to define would silently take the legacy
    // (production) value.
    if (frontend !== null && legacyFrontend !== null) {
      for (const name of Object.keys(legacyFrontend)) {
        if (name.startsWith('VITE_') && !(name in frontend)) {
          errors.push(`.env.staging.local does not define ${name}, so a staging build would inherit it from .env.local (the production file).`);
        }
      }
    }
  }

  for (const [label, vars] of [['frontend', frontend], ['backend', backend]]) {
    for (const name of Object.keys(vars ?? {})) {
      if (SECRET_NAME.test(name) && !PUBLIC_VARIABLES.has(name)) {
        errors.push(`${label} env file defines ${name}: secrets belong in Secret Manager / functions/.secret.local, not here.`);
      }
      if (label === 'frontend' && !name.startsWith('VITE_')) {
        notes.push(`frontend env file defines ${name}, which is not exposed to the browser (no VITE_ prefix).`);
      }
    }
  }

  return {
    errors,
    notes,
    summary: {
      environment: env,
      firebaseProject: expectedProject,
      frontendFirebaseProject: frontend ? shorten(frontend.VITE_FIREBASE_PROJECT_ID) : '(no file)',
      descopeProject: shorten(frontDescope ?? backDescope),
      razorpayMode: backend === null ? '(no file)' : mode,
      razorpayKeyId: shorten(backend?.RAZORPAY_KEY_ID),
    },
  };
}

/**
 * @param {string} path A file path.
 * @return {Record<string, string> | null} Its parsed variables, or null if it does not exist.
 */
function readEnvFile(path) {
  return existsSync(path) ? parseDotenv(readFileSync(path, 'utf8')) : null;
}

/**
 * @param {string} root The repository root.
 * @return {string | null} The staging Firebase project id from `.firebaserc`, if an alias exists.
 */
function stagingProjectIdFrom(root) {
  const path = resolve(root, '.firebaserc');
  if (!existsSync(path)) {
    return null;
  }
  const projects = JSON.parse(readFileSync(path, 'utf8')).projects ?? {};
  return typeof projects.staging === 'string' ? projects.staging : null;
}

/**
 * Runs the check against the files on disk and prints the result.
 *
 * @param {string[]} argv The command-line arguments.
 * @return {number} The process exit code.
 */
export function main(argv) {
  const envIndex = argv.indexOf('--env');
  const env = envIndex >= 0 ? argv[envIndex + 1] : undefined;
  if (env !== 'production' && env !== 'staging') {
    console.error('Usage: node scripts/check-environment.mjs --env <production|staging> [--allow-live]');
    return 2;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const stagingProjectId = stagingProjectIdFrom(root);
  const frontendFile = (name) => {
    const specific = readEnvFile(resolve(root, `.env.${name}.local`));
    // Production historically builds from `.env.local`.
    return specific ?? (name === 'production' ? readEnvFile(resolve(root, '.env.local')) : null);
  };
  const backendFile = (projectId) => (projectId ? readEnvFile(resolve(root, `functions/.env.${projectId}`)) : null);

  const result = checkEnvironment({
    env,
    stagingProjectId,
    frontend: frontendFile(env),
    backend: backendFile(env === 'production' ? PRODUCTION_PROJECT_ID : stagingProjectId),
    otherFrontend: frontendFile(env === 'production' ? 'staging' : 'production'),
    otherBackend: backendFile(env === 'production' ? stagingProjectId : PRODUCTION_PROJECT_ID),
    legacyFrontend: readEnvFile(resolve(root, '.env.local')),
    allowLive: argv.includes('--allow-live'),
  });

  console.log(`Zesto environment check — TARGET: ${env.toUpperCase()}`);
  for (const [key, value] of Object.entries(result.summary)) {
    console.log(`  ${key.padEnd(24)} ${value}`);
  }
  for (const note of result.notes) {
    console.log(`  note: ${note}`);
  }
  for (const error of result.errors) {
    console.error(`  ERROR: ${error}`);
  }
  console.log(result.errors.length === 0 ? '  OK — no unsafe combination found.' : `  FAILED — ${result.errors.length} problem(s). Do not build or deploy.`);
  return result.errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
