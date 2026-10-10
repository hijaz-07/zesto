// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPROVED_PROJECT_VARIABLE,
  DeployGuardError,
  PRODUCTION_CONFIRMATION_VARIABLE,
  PRODUCTION_PROJECT_ID,
  assertPredeployAllowed,
  deployTargetsIn,
  main as guardMain,
  requireOnly,
  resolveDeployTarget,
  stagingProjectFrom,
} from './deploy-guard.mjs';
import { buildPlan, filesMentioningProduction, parseFlags } from './deploy.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STAGING_RC = { projects: { default: PRODUCTION_PROJECT_ID, production: PRODUCTION_PROJECT_ID, staging: 'zesto-staging-x' } };
const NO_STAGING_RC = { projects: { default: PRODUCTION_PROJECT_ID, production: PRODUCTION_PROJECT_ID } };

describe('resolveDeployTarget', () => {
  it('refuses staging while no staging alias exists, and says so', () => {
    expect(() => resolveDeployTarget({ target: 'staging', firebaserc: NO_STAGING_RC })).toThrow(/No staging Firebase project is configured/);
    expect(() => resolveDeployTarget({ target: 'staging', firebaserc: null })).toThrow(DeployGuardError);
  });

  it('refuses a staging alias that points at production', () => {
    const rc = { projects: { staging: PRODUCTION_PROJECT_ID } };
    expect(() => resolveDeployTarget({ target: 'staging', firebaserc: rc })).toThrow(/points at the PRODUCTION project/);
  });

  it('uses the staging alias for staging, never the default alias', () => {
    expect(resolveDeployTarget({ target: 'staging', firebaserc: STAGING_RC })).toEqual({ target: 'staging', projectId: 'zesto-staging-x' });
  });

  it('never lets a staging deploy carry the production confirmation', () => {
    expect(() => resolveDeployTarget({ target: 'staging', firebaserc: STAGING_RC, confirmProduction: PRODUCTION_PROJECT_ID }))
      .toThrow(/production only/);
  });

  it('requires the production project id to be typed out for production', () => {
    expect(() => resolveDeployTarget({ target: 'production', firebaserc: STAGING_RC })).toThrow(/--confirm-production/);
    expect(() => resolveDeployTarget({ target: 'production', firebaserc: STAGING_RC, confirmProduction: 'yes' })).toThrow(/--confirm-production/);
    expect(() => resolveDeployTarget({ target: 'production', firebaserc: STAGING_RC, confirmProduction: 'zesto-staging-x' })).toThrow(DeployGuardError);
    expect(resolveDeployTarget({ target: 'production', firebaserc: STAGING_RC, confirmProduction: PRODUCTION_PROJECT_ID }))
      .toEqual({ target: 'production', projectId: PRODUCTION_PROJECT_ID });
  });

  it('refuses any other target name', () => {
    expect(() => resolveDeployTarget({ target: 'prod', firebaserc: STAGING_RC })).toThrow(/Unknown target/);
    expect(() => resolveDeployTarget({ target: undefined, firebaserc: STAGING_RC })).toThrow(/Unknown target/);
  });
});

describe('stagingProjectFrom / requireOnly / deployTargetsIn', () => {
  it('reads only a non-empty string alias', () => {
    expect(stagingProjectFrom(STAGING_RC)).toBe('zesto-staging-x');
    expect(stagingProjectFrom({ projects: { staging: '' } })).toBeNull();
    expect(stagingProjectFrom({ projects: { staging: 5 } })).toBeNull();
    expect(stagingProjectFrom(null)).toBeNull();
  });

  it('refuses a deploy that does not say what it deploys', () => {
    expect(() => requireOnly(undefined)).toThrow(/--only/);
    expect(() => requireOnly('  ')).toThrow(/--only/);
    expect(() => requireOnly('database')).toThrow(/Unsupported/);
    expect(requireOnly('functions:api, hosting')).toBe('functions:api, hosting');
  });

  it('names the top-level targets', () => {
    expect(deployTargetsIn('functions:api,functions:reconcilePayments,hosting')).toEqual(['functions', 'hosting']);
  });
});

describe('assertPredeployAllowed (what the Firebase CLI hook enforces)', () => {
  it('blocks a deploy nobody approved: bare `firebase deploy` to production', () => {
    expect(() => assertPredeployAllowed({ GCLOUD_PROJECT: PRODUCTION_PROJECT_ID })).toThrow(/Direct `firebase deploy` is blocked/);
  });

  it('blocks when the CLI does not say which project it is deploying to', () => {
    expect(() => assertPredeployAllowed({ [APPROVED_PROJECT_VARIABLE]: 'zesto-staging-x' })).toThrow(/did not say/);
  });

  it('blocks a deploy approved for staging that the CLI aims at production', () => {
    expect(() => assertPredeployAllowed({
      GCLOUD_PROJECT: PRODUCTION_PROJECT_ID, [APPROVED_PROJECT_VARIABLE]: 'zesto-staging-x',
    })).toThrow(/approved for "zesto-staging-x"/);
  });

  it('blocks production without the explicit production confirmation, even if approved', () => {
    expect(() => assertPredeployAllowed({
      GCLOUD_PROJECT: PRODUCTION_PROJECT_ID, [APPROVED_PROJECT_VARIABLE]: PRODUCTION_PROJECT_ID,
    })).toThrow(/explicit production confirmation/);
  });

  it('blocks a staging project that arrives with a production confirmation', () => {
    expect(() => assertPredeployAllowed({
      GCLOUD_PROJECT: 'zesto-staging-x', [APPROVED_PROJECT_VARIABLE]: 'zesto-staging-x',
      [PRODUCTION_CONFIRMATION_VARIABLE]: PRODUCTION_PROJECT_ID,
    })).toThrow(/non-production project/);
  });

  it('allows exactly what the wrapper approved', () => {
    expect(assertPredeployAllowed({ GCLOUD_PROJECT: 'zesto-staging-x', [APPROVED_PROJECT_VARIABLE]: 'zesto-staging-x' }))
      .toEqual({ projectId: 'zesto-staging-x' });
    expect(assertPredeployAllowed({
      GCLOUD_PROJECT: PRODUCTION_PROJECT_ID, [APPROVED_PROJECT_VARIABLE]: PRODUCTION_PROJECT_ID,
      [PRODUCTION_CONFIRMATION_VARIABLE]: PRODUCTION_PROJECT_ID,
    })).toEqual({ projectId: PRODUCTION_PROJECT_ID });
  });

  it('exits 1 for a blocked hook and 0 for an approved one; refuses to run without --predeploy', () => {
    const quiet = (fn) => {
      const log = console.log; const error = console.error;
      console.log = () => {}; console.error = () => {};
      try { return fn(); } finally { console.log = log; console.error = error; }
    };
    expect(quiet(() => guardMain(['--predeploy'], { GCLOUD_PROJECT: PRODUCTION_PROJECT_ID }))).toBe(1);
    expect(quiet(() => guardMain(['--predeploy'], { GCLOUD_PROJECT: 'zesto-staging-x', [APPROVED_PROJECT_VARIABLE]: 'zesto-staging-x' }))).toBe(0);
    expect(quiet(() => guardMain([], {}))).toBe(2);
  });
});

describe('buildPlan', () => {
  const plan = (target, flagArgs, firebaserc = STAGING_RC) => buildPlan({ target, flagArgs, firebaserc });

  it('passes the project explicitly, never relying on aliases or the active project', () => {
    const staging = plan('staging', ['--only', 'functions,hosting']);
    expect(staging.deployArgs).toEqual(['deploy', '--project', 'zesto-staging-x', '--only', 'functions,hosting', '--non-interactive']);
    expect(staging.env).toEqual({ [APPROVED_PROJECT_VARIABLE]: 'zesto-staging-x' });
    expect(staging.buildArgs).toEqual(['run', 'build', '--', '--mode', 'staging']);

    const production = plan('production', ['--only', 'functions:api', '--confirm-production', PRODUCTION_PROJECT_ID]);
    expect(production.deployArgs).toEqual(['deploy', '--project', PRODUCTION_PROJECT_ID, '--only', 'functions:api', '--non-interactive']);
    expect(production.env).toEqual({
      [APPROVED_PROJECT_VARIABLE]: PRODUCTION_PROJECT_ID, [PRODUCTION_CONFIRMATION_VARIABLE]: PRODUCTION_PROJECT_ID,
    });
    expect(production.builds).toBe(false);
  });

  it('builds the frontend only when hosting is deployed', () => {
    expect(plan('staging', ['--only', 'hosting']).builds).toBe(true);
    expect(plan('staging', ['--only', 'firestore:rules']).builds).toBe(false);
  });

  it('can never aim a staging plan at production, whatever the flags', () => {
    expect(() => plan('staging', ['--only', 'hosting'], { projects: { staging: PRODUCTION_PROJECT_ID } })).toThrow(DeployGuardError);
    expect(() => plan('staging', ['--only', 'hosting'], NO_STAGING_RC)).toThrow(/No staging/);
    expect(() => plan('staging', ['--only', 'hosting', '--confirm-production', PRODUCTION_PROJECT_ID])).toThrow(DeployGuardError);
  });

  it('refuses production without its confirmation, and refuses an unscoped deploy', () => {
    expect(() => plan('production', ['--only', 'hosting'])).toThrow(/--confirm-production/);
    expect(() => plan('production', ['--confirm-production', PRODUCTION_PROJECT_ID])).toThrow(/--only/);
  });

  it('passes --force only for functions-only deploys', () => {
    expect(plan('staging', ['--only', 'functions:onRefundCreated', '--force']).deployArgs).toEqual([
      'deploy', '--project', 'zesto-staging-x', '--only', 'functions:onRefundCreated', '--non-interactive', '--force',
    ]);
    expect(plan('staging', ['--only', 'functions:api']).deployArgs).not.toContain('--force');
    expect(() => plan('staging', ['--only', 'firestore:indexes', '--force'])).toThrow(/--force/);
    expect(() => plan('staging', ['--only', 'functions,hosting', '--force'])).toThrow(/--force/);
  });

  it('rejects shell metacharacters and unknown flags', () => {
    expect(() => plan('staging', ['--only', 'hosting;rm -rf /'])).toThrow(DeployGuardError);
    expect(() => plan('staging', ['--only', 'hosting&&calc'])).toThrow(DeployGuardError);
    expect(() => plan('staging', ['--only', 'hosting', '--project', PRODUCTION_PROJECT_ID])).toThrow(/Unknown option/);
    expect(() => parseFlags(['--only'])).toThrow(/needs a value/);
    expect(() => parseFlags(['--only', '--dry-run'])).toThrow(/needs a value/);
  });
});

describe('filesMentioningProduction', () => {
  let directory;
  afterEach(() => directory && rmSync(directory, { recursive: true, force: true }));

  it('finds a built file that names the production project, and passes a clean bundle', () => {
    directory = mkdtempSync(join(tmpdir(), 'zesto-dist-'));
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'index.html'), '<html></html>');
    writeFileSync(join(directory, 'assets', 'app.js'), 'const p="zesto-staging-x";');
    expect(filesMentioningProduction(directory)).toEqual([]);
    writeFileSync(join(directory, 'assets', 'leak.js'), `const p="${PRODUCTION_PROJECT_ID}";`);
    expect(filesMentioningProduction(directory)).toEqual([join('assets', 'leak.js')]);
  });

  it('treats a missing dist folder as nothing to scan', () => {
    expect(filesMentioningProduction(join(tmpdir(), 'zesto-no-such-dist'))).toEqual([]);
  });
});

describe('repository configuration', () => {
  const firebaseJson = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'));
  const firebaserc = JSON.parse(readFileSync(join(ROOT, '.firebaserc'), 'utf8'));
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const functionsPackage = JSON.parse(readFileSync(join(ROOT, 'functions', 'package.json'), 'utf8'));
  const GUARD = 'node scripts/deploy-guard.mjs --predeploy';

  it('puts the guard FIRST in the predeploy of every target that can be deployed', () => {
    for (const target of ['firestore', 'functions', 'hosting', 'storage']) {
      const hooks = [].concat(firebaseJson[target].predeploy ?? []);
      expect(hooks[0], `${target} predeploy`).toBe(GUARD);
    }
  });

  it('keeps the production alias, and any staging alias is a different project', () => {
    expect(firebaserc.projects.production).toBe(PRODUCTION_PROJECT_ID);
    if (firebaserc.projects.staging !== undefined) {
      expect(firebaserc.projects.staging).not.toBe(PRODUCTION_PROJECT_ID);
    }
  });

  it('documents deployment through the guarded scripts only', () => {
    expect(packageJson.scripts['deploy:staging']).toBe('node scripts/deploy.mjs staging');
    expect(packageJson.scripts['deploy:production']).toBe('node scripts/deploy.mjs production');
    expect(JSON.stringify(functionsPackage.scripts)).not.toMatch(/firebase deploy/);
    expect(JSON.stringify(packageJson.scripts)).not.toMatch(/firebase deploy/);
  });
});

describe('the real commands (subprocesses; nothing is deployed, built or sent anywhere)', () => {
  const node = (script, args, env = {}) => spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, GCLOUD_PROJECT: '', [APPROVED_PROJECT_VARIABLE]: '', ...env },
  });

  it('the Firebase predeploy hook exits non-zero for a bare deploy', () => {
    const result = node('scripts/deploy-guard.mjs', ['--predeploy'], { GCLOUD_PROJECT: PRODUCTION_PROJECT_ID });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Direct `firebase deploy` is blocked/);
  });

  it('deploy:production without the confirmation exits non-zero before anything else', () => {
    const result = node('scripts/deploy.mjs', ['production', '--only', 'hosting', '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--confirm-production/);
  });

  it('deploy:staging exits non-zero while no staging project is configured (or is production)', () => {
    const rc = JSON.parse(readFileSync(join(ROOT, '.firebaserc'), 'utf8'));
    if (rc.projects.staging === undefined) {
      const result = node('scripts/deploy.mjs', ['staging', '--only', 'hosting', '--dry-run']);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/No staging Firebase project is configured/);
    }
  });

  it('a fully specified production dry run prints the explicit command and does not run it', () => {
    const result = node('scripts/deploy.mjs', ['production', '--only', 'functions:api', '--confirm-production', PRODUCTION_PROJECT_ID, '--dry-run']);
    if (result.status === 0) {
      expect(result.stdout).toContain(`would run: firebase deploy --project ${PRODUCTION_PROJECT_ID} --only functions:api --non-interactive`);
      expect(result.stdout).toContain('Nothing was built or deployed');
    } else {
      // Only the local environment check (gitignored config files) may stop it, never the guard.
      expect(result.stderr + result.stdout).toMatch(/environment check failed|ERROR/);
    }
  });
});
