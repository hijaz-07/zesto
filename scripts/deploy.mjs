#!/usr/bin/env node
/**
 * The ONLY supported way to deploy Zesto. It always passes the Firebase project explicitly
 * (never the CLI's active project or the `default` alias), runs the environment check first,
 * builds the frontend for the right environment, and refuses to proceed on any doubt.
 *
 *   npm run deploy:staging    -- --only functions,hosting
 *   npm run deploy:production -- --only functions:api --confirm-production zesto-dev-2026
 *   npm run deploy:production -- --only hosting --confirm-production zesto-dev-2026 --dry-run
 *
 *   --only <list>               REQUIRED. What to deploy (firestore[:rules|:indexes], functions[:name], hosting, storage).
 *                               Follow docs/operations/deployment-runbook.md for the order.
 *   --confirm-production <id>   REQUIRED for production, and must equal the production project id.
 *   --dry-run                   Run the checks and print the exact command; change nothing, build nothing.
 *
 * Firebase's own `predeploy` hooks (firebase.json) call scripts/deploy-guard.mjs, which stops any
 * deploy that did not come from this script. See docs/operations/deployment-runbook.md.
 */
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  APPROVED_PROJECT_VARIABLE,
  DeployGuardError,
  PRODUCTION_CONFIRMATION_VARIABLE,
  PRODUCTION_PROJECT_ID,
  REPOSITORY_ROOT,
  deployTargetsIn,
  readFirebaserc,
  requireOnly,
  resolveDeployTarget,
} from './deploy-guard.mjs';

const ONLY_PATTERN = /^[A-Za-z0-9_:,-]+$/;

/**
 * @param {string[]} argv The arguments after the target.
 * @return {{only?: string, confirmProduction?: string, dryRun: boolean}} The parsed flags.
 * @throws {DeployGuardError} On an unknown or valueless flag.
 */
export function parseFlags(argv) {
  const flags = {dryRun: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--only' || arg === '--confirm-production') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new DeployGuardError(`${arg} needs a value.`);
      }
      flags[arg === '--only' ? 'only' : 'confirmProduction'] = value;
      i += 1;
    } else {
      throw new DeployGuardError(`Unknown option ${arg}. Supported: --only, --confirm-production, --dry-run.`);
    }
  }
  return flags;
}

/**
 * Builds the whole plan without running anything.
 *
 * @param {object} input
 * @param {string | undefined} input.target `staging` or `production`.
 * @param {string[]} input.flagArgs The remaining arguments.
 * @param {unknown} input.firebaserc The parsed `.firebaserc`.
 * @return {{target: string, projectId: string, only: string, dryRun: boolean, builds: boolean, env: Record<string, string>, deployArgs: string[], buildArgs: string[]}} The plan.
 * @throws {DeployGuardError} If the deploy must not proceed.
 */
export function buildPlan({target, flagArgs, firebaserc}) {
  const flags = parseFlags(flagArgs);
  const resolved = resolveDeployTarget({target, firebaserc, confirmProduction: flags.confirmProduction});
  const only = requireOnly(flags.only);
  if (!ONLY_PATTERN.test(only)) {
    throw new DeployGuardError('--only may contain only letters, digits, ":", "," "-" and "_".');
  }
  const targets = deployTargetsIn(only);
  const env = {[APPROVED_PROJECT_VARIABLE]: resolved.projectId};
  if (resolved.target === 'production') {
    env[PRODUCTION_CONFIRMATION_VARIABLE] = PRODUCTION_PROJECT_ID;
  }
  return {
    target: resolved.target,
    projectId: resolved.projectId,
    only,
    dryRun: flags.dryRun,
    // Only hosting serves the frontend bundle; functions have their own predeploy build.
    builds: targets.includes('hosting'),
    env,
    buildArgs: resolved.target === 'staging' ? ['run', 'build', '--', '--mode', 'staging'] : ['run', 'build'],
    // `--project` is explicit on purpose: nothing here depends on the CLI's active project.
    deployArgs: ['deploy', '--project', resolved.projectId, '--only', only, '--non-interactive'],
  };
}

/**
 * A staging bundle must never carry the production project's id: it would be talking to production.
 *
 * @param {string} distDirectory The built frontend.
 * @return {string[]} Files (relative) containing the production project id.
 */
export function filesMentioningProduction(distDirectory) {
  const hits = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.(js|html|css|json|map)$/.test(name) && readFileSync(path, 'utf8').includes(PRODUCTION_PROJECT_ID)) {
        hits.push(path.slice(distDirectory.length + 1));
      }
    }
  };
  if (existsSync(distDirectory)) {
    walk(distDirectory);
  }
  return hits;
}

/**
 * @param {string} value A program path.
 * @return {string} The value, double-quoted if it contains a space.
 */
function quoteIfNeeded(value) {
  return value.includes(' ') ? `"${value}"` : value;
}

/**
 * @param {string} command The program.
 * @param {string[]} args Its arguments (already validated; none comes from free text).
 * @param {Record<string, string>} extraEnv Extra environment variables.
 * @return {number} The exit status.
 */
function run(command, args, extraEnv = {}) {
  const options = {cwd: REPOSITORY_ROOT, stdio: 'inherit', env: {...process.env, ...extraEnv}};
  // `npm` and `firebase` are .cmd shims on Windows and need a shell; every argument here has been
  // validated against a fixed pattern, so joining them into one string is safe (and avoids Node's
  // deprecation of passing an argument array together with `shell: true`).
  const result = process.platform === 'win32' ?
    spawnSync([quoteIfNeeded(command), ...args].join(' '), {...options, shell: true}) :
    spawnSync(command, args, options);
  return result.status ?? 1;
}

/**
 * @param {string[]} argv The command-line arguments (`<target> [flags]`).
 * @return {number} The process exit code.
 */
export function main(argv) {
  let plan;
  try {
    plan = buildPlan({target: argv[0], flagArgs: argv.slice(1), firebaserc: readFirebaserc(REPOSITORY_ROOT)});
  } catch (error) {
    if (error instanceof DeployGuardError) {
      console.error(`deploy: ${error.message}`);
      return 1;
    }
    throw error;
  }

  console.log(`deploy: target ${plan.target.toUpperCase()} -> Firebase project ${plan.projectId}${plan.dryRun ? ' (dry run)' : ''}`);

  const checkArgs = ['scripts/check-environment.mjs', '--env', plan.target];
  if (run(process.execPath, checkArgs) !== 0) {
    console.error('deploy: the environment check failed. Nothing was built or deployed.');
    return 1;
  }

  const printable = `firebase ${plan.deployArgs.join(' ')}`;
  if (plan.dryRun) {
    if (plan.builds) {
      console.log(`deploy: would build the frontend: npm ${plan.buildArgs.join(' ')}`);
    }
    console.log(`deploy: would run: ${printable}`);
    console.log('deploy: dry run finished. Nothing was built or deployed.');
    return 0;
  }

  if (plan.builds) {
    if (run('npm', plan.buildArgs) !== 0) {
      console.error('deploy: the frontend build failed. Nothing was deployed.');
      return 1;
    }
    if (plan.target === 'staging') {
      const leaks = filesMentioningProduction(resolve(REPOSITORY_ROOT, 'dist'));
      if (leaks.length > 0) {
        console.error(`deploy: the staging bundle mentions the production project id (${leaks.slice(0, 3).join(', ')}). Nothing was deployed.`);
        return 1;
      }
    }
  }

  console.log(`deploy: running ${printable}`);
  return run('firebase', plan.deployArgs, plan.env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
