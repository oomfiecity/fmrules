#!/usr/bin/env bun
/**
 * Cut an oomfiecity/fmrules release.
 *
 * Usage:
 *   bun release <X.Y.Z>          # cut vX.Y.Z
 *   bun release --patch          # bump package.json patch, derive version
 *   bun release --minor          # bump package.json minor
 *   bun release --major          # bump package.json major
 *   bun release --dry-run <...>  # print the plan, touch nothing
 *   bun release --skip-verify <...>  # skip post-push watch (emergencies)
 *   bun release --help
 *
 * Encodes the manual release dance that shipped v1.0.0 → v1.1.0:
 *   preflight → stamp package.json → push main → tag → push tag →
 *   watch Release workflow → verify binaries + v<major> tag + smoke.
 *
 * Refuses to touch state on ANY preflight failure. Never runs
 * destructive git (force-push, reset, tag -d). Output is prefixed with
 * `[release]` so log-parsing consumers (including LLMs) can grep.
 */

const TAG = '[release]';
const REPO = 'oomfiecity/fmrules';
const PKG_URL = new URL('../package.json', import.meta.url);

// ──────────────────────────────────────────────────────────────────────
// Shell helpers

interface Ran {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function log(msg: string): void {
  console.log(`${TAG} ${msg}`);
}

function fail(msg: string, hint?: string): never {
  console.error(`${TAG} ERROR: ${msg}`);
  if (hint) console.error(`${TAG}        ${hint}`);
  process.exit(1);
}

/** Run a command via Bun.spawnSync. `dryRun` prints and returns ok. */
function run(cmd: string[], opts: { dryRun?: boolean; allowFail?: boolean } = {}): Ran {
  const shown = cmd.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' ');
  if (opts.dryRun) {
    log(`DRY: ${shown}`);
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  }
  const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const exitCode = proc.exitCode ?? 1;
  const ok = exitCode === 0;
  if (!ok && !opts.allowFail) {
    console.error(`${TAG} FAIL: ${shown}`);
    if (stdout.trim()) console.error(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
  }
  return { ok, stdout, stderr, exitCode };
}

/** Spawn with stdio inherited — for commands like `gh run watch` that
 *  emit a live spinner the operator wants to see. */
async function runInherit(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  return (await proc.exited) ?? 1;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ──────────────────────────────────────────────────────────────────────
// Arg parsing — yargs

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

interface Args {
  version?: string;
  bump?: 'patch' | 'minor' | 'major';
  dryRun: boolean;
  skipVerify: boolean;
}

const EPILOGUE = `The script refuses to run if the working tree is dirty, main is out of
sync with origin, local ci (typecheck + tests) fails, the requested
tag already exists, or the version arg is malformed. No destructive
git is ever invoked.`;

async function parseArgs(rawArgv: string[]): Promise<Args> {
  const parsed = await yargs(rawArgv)
    .scriptName('release')
    .usage('$0 <version> [flags]\n  $0 (--patch|--minor|--major) [flags]')
    .command(
      '$0 [version]',
      'Cut an oomfiecity/fmrules release.',
      (y) =>
        y
          .positional('version', {
            type: 'string',
            describe: 'Target version (X.Y.Z or vX.Y.Z). Mutually exclusive with --patch/--minor/--major.',
          })
          // Boolean flags are intentionally undefined-by-default so that
          // yargs `.conflicts()` only fires when the user explicitly
          // passes a flag. Treat absence as `false` downstream.
          .option('patch', { type: 'boolean', describe: 'Bump package.json patch and derive version' })
          .option('minor', { type: 'boolean', describe: 'Bump package.json minor and derive version' })
          .option('major', { type: 'boolean', describe: 'Bump package.json major and derive version' })
          .option('dry-run', { type: 'boolean', describe: 'Print the plan without touching state. Preflight still runs.' })
          .option('skip-verify', { type: 'boolean', describe: 'Push + tag, but skip the post-push CI watch + asset verify.' })
          .conflicts('patch', ['minor', 'major', 'version'])
          .conflicts('minor', ['major', 'version'])
          .conflicts('major', ['version'])
          .check((a) => {
            if (!a.version && !a.patch && !a.minor && !a.major) {
              throw new Error('one of <version> | --patch | --minor | --major is required');
            }
            return true;
          }),
    )
    .strict()
    .help()
    .alias('help', 'h')
    // Disable yargs's built-in --version so it doesn't shadow our `version`
    // positional. The script doesn't have a meaningful "release.ts version"
    // to report — it operates on the package.json version of the repo.
    .version(false)
    .epilogue(EPILOGUE)
    .parseAsync();
  const bump =
    parsed.patch ? 'patch' :
    parsed.minor ? 'minor' :
    parsed.major ? 'major' :
    undefined;
  return {
    version: parsed.version as string | undefined,
    bump,
    dryRun: parsed['dry-run'] === true,
    skipVerify: parsed['skip-verify'] === true,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Version utilities

interface Sem {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(s: string): Sem {
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) fail(`invalid version: "${s}"`, 'expected X.Y.Z or vX.Y.Z');
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function formatVersion(v: Sem): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

async function readPackageVersion(): Promise<string> {
  const pkg = (await Bun.file(PKG_URL).json()) as { version?: string };
  if (!pkg.version) fail('package.json has no version field');
  return pkg.version;
}

/** Replace the "version" field only; preserve the file's existing
 *  formatting (indentation, trailing newline, key order). */
async function writePackageVersion(version: string, dryRun: boolean): Promise<void> {
  const file = Bun.file(PKG_URL);
  const raw = await file.text();
  const next = raw.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (next === raw) return;
  if (dryRun) {
    log(`DRY: would write version=${version} to package.json`);
    return;
  }
  await Bun.write(PKG_URL, next);
}

// ──────────────────────────────────────────────────────────────────────
// Preflight

function preflightBranch(): void {
  const r = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) fail('could not resolve current branch');
  const branch = r.stdout.trim();
  if (branch !== 'main') fail(`not on main (on ${branch})`, 'checkout main first');
  log(`branch: ${branch} ✓`);
}

function preflightClean(): void {
  const r = run(['git', 'status', '--porcelain']);
  if (!r.ok) fail('could not read git status');
  if (r.stdout.trim()) {
    fail('working tree not clean', `commit or stash:\n${r.stdout.trimEnd()}`);
  }
  log('working tree: clean ✓');
}

function preflightFetch(): void {
  const f = run(['git', 'fetch', 'origin', 'main']);
  if (!f.ok) fail('git fetch failed');
  const local = run(['git', 'rev-parse', 'HEAD']).stdout.trim();
  const remote = run(['git', 'rev-parse', 'origin/main']).stdout.trim();
  if (!local || !remote) fail('could not resolve main / origin/main');
  if (local !== remote) {
    fail(
      `local main (${local.slice(0, 7)}) differs from origin/main (${remote.slice(0, 7)})`,
      'git pull --ff-only or push outstanding commits first',
    );
  }
  log(`main in sync with origin ✓ (${local.slice(0, 7)})`);
}

function preflightCi(dryRun: boolean): void {
  if (dryRun) {
    log('DRY: would run `bun run ci`');
    return;
  }
  log('running local CI (typecheck + tests)…');
  const r = run(['bun', 'run', 'ci']);
  if (!r.ok) fail('local CI failed — fix before releasing');
  log('local CI: green ✓');
}

function preflightTagAvailable(tag: string): void {
  const local = run(['git', 'rev-parse', '--verify', tag], { allowFail: true });
  if (local.ok) {
    fail(`tag ${tag} already exists locally`, `delete with: git tag -d ${tag} (manual, deliberate)`);
  }
  const remote = run(['git', 'ls-remote', '--tags', 'origin', tag]);
  if (!remote.ok) fail('git ls-remote failed');
  if (remote.stdout.includes(`refs/tags/${tag}`)) {
    fail(`tag ${tag} already exists on origin`, 'a release for this version was already cut');
  }
  log(`tag ${tag}: available ✓`);
}

// ──────────────────────────────────────────────────────────────────────
// Stamp + push

async function stamp(version: string, dryRun: boolean): Promise<void> {
  const current = await readPackageVersion();
  if (current === version) {
    log(`package.json already at ${version}; nothing to stamp`);
    return;
  }
  log(`stamping package.json: ${current} → ${version}`);
  await writePackageVersion(version, dryRun);
  const add = run(['git', 'add', 'package.json'], { dryRun });
  if (!add.ok) fail('git add package.json failed');
  const commit = run(['git', 'commit', '-m', `release: v${version}`], { dryRun });
  if (!commit.ok) fail('git commit failed');
}

function pushMain(dryRun: boolean): void {
  log('pushing main…');
  const r = run(['git', 'push', 'origin', 'main'], { dryRun });
  if (!r.ok) fail('git push main failed', 'check remote state; do not force-push unless intentional');
}

function tagAndPush(tag: string, dryRun: boolean): void {
  log(`tagging ${tag}…`);
  const t = run(['git', 'tag', '-a', tag, '-m', tag], { dryRun });
  if (!t.ok) fail(`git tag ${tag} failed`);
  log(`pushing ${tag}…`);
  const p = run(['git', 'push', 'origin', tag], { dryRun });
  if (!p.ok) fail(`git push ${tag} failed`);
}

// ──────────────────────────────────────────────────────────────────────
// Verify

async function waitForReleaseWorkflow(tag: string): Promise<void> {
  log(`waiting for Release workflow on ${tag}…`);
  const deadline = Date.now() + 10 * 60 * 1000;
  let runId: string | null = null;
  while (Date.now() < deadline && runId === null) {
    const r = run([
      'gh', 'run', 'list',
      '--repo', REPO,
      '--workflow', 'Release',
      '--branch', tag,
      '--limit', '1',
      '--json', 'databaseId',
    ]);
    if (r.ok && r.stdout.trim() && r.stdout.trim() !== '[]') {
      const runs = JSON.parse(r.stdout) as Array<{ databaseId: number }>;
      if (runs.length > 0) runId = String(runs[0]!.databaseId);
    }
    if (runId === null) await sleep(3000);
  }
  if (runId === null) fail(`Release workflow for ${tag} never appeared in 10 min`);
  log(`watching run ${runId}…`);
  const code = await runInherit(['gh', 'run', 'watch', runId, '--repo', REPO, '--exit-status']);
  if (code !== 0) fail(`Release workflow failed; see gh run view ${runId} --repo ${REPO}`);
  log('Release workflow: success ✓');
}

function verifyReleaseAssets(tag: string): void {
  const r = run(['gh', 'release', 'view', tag, '--repo', REPO, '--json', 'assets']);
  if (!r.ok) fail(`release ${tag} not visible via gh release view`);
  const parsed = JSON.parse(r.stdout) as { assets: Array<{ name: string }> };
  const names = new Set(parsed.assets.map((a) => a.name));
  const expected = [
    'fmrules-bun-linux-x64',
    'fmrules-bun-linux-arm64',
    'fmrules-bun-darwin-x64',
    'fmrules-bun-darwin-arm64',
    'SHA256SUMS.txt',
  ];
  const missing = expected.filter((n) => !names.has(n));
  if (missing.length > 0) {
    fail(`release ${tag} is missing assets: ${missing.join(', ')}`);
  }
  log(`release assets: ${expected.length}/${expected.length} present ✓`);
}

function verifyMajorTag(version: string): void {
  const { major } = parseVersion(version);
  const majorTag = `v${major}`;
  const r = run(['gh', 'api', `repos/${REPO}/git/refs/tags/${majorTag}`, '--jq', '.object.sha']);
  if (!r.ok) fail(`could not resolve floating tag ${majorTag}`);
  const majorSha = r.stdout.trim();
  const tagSha = run(['git', 'rev-parse', `v${version}^{commit}`]).stdout.trim();
  if (majorSha !== tagSha) {
    fail(
      `floating tag ${majorTag} (${majorSha.slice(0, 7)}) does not match v${version} (${tagSha.slice(0, 7)})`,
      'check .github/workflows/release.yml move-major-tag job',
    );
  }
  log(`floating tag ${majorTag} → ${majorSha.slice(0, 7)} ✓`);
}

async function verifySmokeAfter(): Promise<void> {
  log('waiting for Action smoke test (triggered by workflow_run)…');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const r = run([
      'gh', 'run', 'list',
      '--repo', REPO,
      '--workflow', 'Action smoke test',
      '--limit', '1',
      '--json', 'status,conclusion,event',
    ]);
    if (r.ok && r.stdout.trim() && r.stdout.trim() !== '[]') {
      const runs = JSON.parse(r.stdout) as Array<{ status: string; conclusion: string | null; event: string }>;
      const latest = runs[0]!;
      if (latest.event === 'workflow_run' && latest.status === 'completed') {
        if (latest.conclusion !== 'success') {
          fail(
            `latest Action smoke test: ${latest.conclusion}`,
            `gh run list --repo ${REPO} --workflow "Action smoke test"`,
          );
        }
        log('Action smoke test: success ✓');
        return;
      }
    }
    await sleep(5000);
  }
  log('Action smoke test: still pending after 5 min (not fatal; verify manually)');
}

// ──────────────────────────────────────────────────────────────────────
// Driver (top-level await; Bun supports ESM modules directly)

const args = await parseArgs(hideBin(Bun.argv));

// Resolve target version.
let version: string;
if (args.version) {
  version = formatVersion(parseVersion(args.version));
} else if (args.bump) {
  const cur = parseVersion(await readPackageVersion());
  const next: Sem = { ...cur };
  if (args.bump === 'patch') next.patch++;
  else if (args.bump === 'minor') {
    next.minor++;
    next.patch = 0;
  } else {
    next.major++;
    next.minor = 0;
    next.patch = 0;
  }
  version = formatVersion(next);
} else {
  // parseArgs's .check() rejects this, but TS doesn't know that.
  fail('no version specified');
}
const tag = `v${version}`;

log(`target: ${tag}${args.dryRun ? ' (DRY RUN)' : ''}`);

preflightBranch();
preflightClean();
preflightFetch();
preflightCi(args.dryRun);
preflightTagAvailable(tag);

await stamp(version, args.dryRun);
pushMain(args.dryRun);
tagAndPush(tag, args.dryRun);

if (args.dryRun) {
  log('DRY RUN complete — no state was modified on remote.');
  process.exit(0);
}

if (args.skipVerify) {
  log('--skip-verify set — release cut. CI may still be running.');
  log(`follow: gh run list --repo ${REPO} --limit 5`);
  process.exit(0);
}

await waitForReleaseWorkflow(tag);
verifyReleaseAssets(tag);
verifyMajorTag(version);
await verifySmokeAfter();

console.log();
log('─── release summary ───');
log(`tag:          ${tag}`);
log(`release:      https://github.com/${REPO}/releases/tag/${tag}`);
log(`major tag:    v${parseVersion(version).major} (advanced)`);
log('status:       ✓ shipped');
