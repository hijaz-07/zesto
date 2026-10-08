#!/usr/bin/env node
/**
 * DEPLOYMENT GUARD. Two jobs, both pure decisions plus a thin CLI:
 *
 *  1. `resolveDeployTarget` — which Firebase project an `npm run deploy:<env>` may touch. The
 *     project id is NEVER read from the Firebase CLI's "active project" or from the `default`
 *     alias (the active project is stored per machine in ~/.config/configstore and can silently be
 *     production). Production is a constant; staging comes from the `staging` alias in
 *     `.firebaserc` and is refused if it is missing or equals production.
 *
 *  2. `--predeploy` — run by the Firebase CLI itself (firebase.json `predeploy` of firestore,
 *     functions, hosting and storage) BEFORE anything is uploaded. It lets the deploy continue
 *     only when `scripts/deploy.mjs` approved this exact project, so a bare `firebase deploy`,
 *     `firebase deploy --project production`, or `npm --prefix functions run deploy` is stopped
 *     before it changes anything.
 *
 * This is an accident guard, not an access control: someone who exports the variables below by hand
 * can still deploy. IAM on the Firebase project is the real control.
 */
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PRODUCTION_PROJECT_ID} from './check-environment.mjs';

export {PRODUCTION_PROJECT_ID};

/** Set by `deploy.mjs` to the one project it approved. */
export const APPROVED_PROJECT_VARIABLE = 'ZESTO_DEPLOY_APPROVED_PROJECT';
/** Set by `deploy.mjs`, for a production deploy only, to the production project id. */
export const PRODUCTION_CONFIRMATION_VARIABLE = 'ZESTO_DEPLOY_CONFIRMED_PRODUCTION';

export class DeployGuardError extends Error {
  /** @param {string} message Why the deploy is refused. */
  constructor(message) {
    super(message);
    this.name = 'DeployGuardError';
  }
}

/**
 * @param {unknown} firebaserc The parsed `.firebaserc` (or null when absent).
 * @return {string | null} The staging project id, if the `staging` alias exists.
 */
export function stagingProjectFrom(firebaserc) {
  const projects = firebaserc && typeof firebaserc === 'object' ? firebaserc.projects : undefined;
  const staging = projects && typeof projects === 'object' ? projects.staging : undefined;
  return typeof staging === 'string' && staging.length > 0 ? staging : null;
}

/**
 * Decides which Firebase project a deploy may use.
 *
 * @param {object} input
 * @param {string} input.target `staging` or `production`.
 * @param {unknown} input.firebaserc The parsed `.firebaserc`.
 * @param {string | undefined} input.confirmProduction The value of `--confirm-production`.
 * @return {{target: 'staging' | 'production', projectId: string}} The approved target.
 * @throws {DeployGuardError} If the deploy must not proceed.
 */
export function resolveDeployTarget({target, firebaserc, confirmProduction}) {
  if (target !== 'staging' && target !== 'production') {
    throw new DeployGuardError('Unknown target. Use `npm run deploy:staging` or `npm run deploy:production`.');
  }
  if (target === 'staging') {
    if (confirmProduction !== undefined) {
      throw new DeployGuardError('`--confirm-production` is for production only. A staging deploy never takes it.');
    }
    const projectId = stagingProjectFrom(firebaserc);
    if (projectId === null) {
      throw new DeployGuardError(
        'No staging Firebase project is configured: .firebaserc has no "staging" alias. ' +
        'Staging has not been created yet; see docs/operations/environments.md section 4. ' +
        'Nothing was deployed.',
      );
    }
    if (projectId === PRODUCTION_PROJECT_ID) {
      throw new DeployGuardError(
        `The "staging" alias in .firebaserc points at the PRODUCTION project (${PRODUCTION_PROJECT_ID}). ` +
        'Staging must be its own project. Nothing was deployed.',
      );
    }
    return {target, projectId};
  }
  if (confirmProduction !== PRODUCTION_PROJECT_ID) {
    throw new DeployGuardError(
      `A production deploy needs the production project id typed out: \`--confirm-production ${PRODUCTION_PROJECT_ID}\`. ` +
      'Nothing was deployed.',
    );
  }
  return {target, projectId: PRODUCTION_PROJECT_ID};
}

/**
 * The Firebase CLI deploy targets in `--only`, as the CLI names them.
 *
 * @param {string} only The `--only` value (comma separated, e.g. `functions:api,hosting`).
 * @return {string[]} The distinct top-level targets (`functions`, `hosting`, `firestore`, ...).
 */
export function deployTargetsIn(only) {
  return [...new Set(only.split(',').map((part) => part.trim().split(':')[0]).filter(Boolean))];
}

/**
 * Refuses a deploy that does not name what it deploys. The runbook's order matters (indexes READY
 * before functions, functions before hosting), so "deploy everything at once" is not a supported path.
 *
 * @param {string | undefined} only The `--only` value.
 * @return {string} The validated value.
 * @throws {DeployGuardError} If it is missing or names no known target.
 */
export function requireOnly(only) {
  const known = new Set(['firestore', 'functions', 'hosting', 'storage']);
  if (only === undefined || only.trim() === '') {
    throw new DeployGuardError(
      'Name what to deploy with `--only` (e.g. `--only firestore:indexes`). ' +
      'Deploying everything at once is not supported: follow the order in docs/operations/deployment-runbook.md.',
    );
  }
  const targets = deployTargetsIn(only);
  const unknown = targets.filter((t) => !known.has(t));
  if (targets.length === 0 || unknown.length > 0) {
    throw new DeployGuardError(`Unsupported --only target(s): ${unknown.join(', ') || only}. Use firestore, functions, hosting or storage.`);
  }
  return only.trim();
}

/**
 * The decision the Firebase CLI's predeploy hook asks for.
 *
 * @param {Record<string, string | undefined>} env The hook's environment (the CLI sets GCLOUD_PROJECT).
 * @return {{projectId: string}} The project the deploy is approved for.
 * @throws {DeployGuardError} If the deploy was not started by `scripts/deploy.mjs` for this very project.
 */
export function assertPredeployAllowed(env) {
  const projectId = env.GCLOUD_PROJECT;
  const approved = env[APPROVED_PROJECT_VARIABLE];
  if (!projectId) {
    throw new DeployGuardError('The Firebase CLI did not say which project it is deploying to. Deploy refused.');
  }
  if (approved === undefined || approved === '') {
    throw new DeployGuardError(
      `Direct \`firebase deploy\` is blocked in this repository (it was about to deploy to "${projectId}"). ` +
      'Use `npm run deploy:staging -- --only ...` or `npm run deploy:production -- --only ... --confirm-production <project>`.',
    );
  }
  if (approved !== projectId) {
    throw new DeployGuardError(
      `This deploy was approved for "${approved}" but the Firebase CLI is deploying to "${projectId}". Deploy refused.`,
    );
  }
  if (projectId === PRODUCTION_PROJECT_ID && env[PRODUCTION_CONFIRMATION_VARIABLE] !== PRODUCTION_PROJECT_ID) {
    throw new DeployGuardError('Deploying to production needs the explicit production confirmation. Deploy refused.');
  }
  if (projectId !== PRODUCTION_PROJECT_ID && env[PRODUCTION_CONFIRMATION_VARIABLE] !== undefined) {
    throw new DeployGuardError('A production confirmation was supplied for a non-production project. Deploy refused.');
  }
  return {projectId};
}

/**
 * @param {string} root The repository root.
 * @return {unknown} The parsed `.firebaserc`, or null.
 */
export function readFirebaserc(root) {
  const path = resolve(root, '.firebaserc');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * @param {string[]} argv The command-line arguments.
 * @param {Record<string, string | undefined>} env The environment.
 * @return {number} The process exit code.
 */
export function main(argv, env) {
  if (!argv.includes('--predeploy')) {
    console.error('Usage: node scripts/deploy-guard.mjs --predeploy  (run by the Firebase CLI, not by hand)');
    return 2;
  }
  try {
    const {projectId} = assertPredeployAllowed(env);
    console.log(`deploy-guard: approved for project ${projectId}.`);
    return 0;
  } catch (error) {
    if (error instanceof DeployGuardError) {
      console.error(`deploy-guard: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), process.env));
}

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
