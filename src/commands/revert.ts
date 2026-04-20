import type { Argv, CommandModule } from 'yargs';
import { createContext } from '../context.ts';

/**
 * Revert a rule commit on a rules repo. Intended use: undoing an
 * `fmrules-agent`-authored commit whose rule change turned out wrong.
 *
 * Wraps `git revert` only — never rewrites history, never force-pushes.
 * Pushes to origin/main so the normal compile workflow picks up the
 * revert and regenerates mailrules.json / creates a release for the
 * revert commit.
 *
 * Output is prefixed `[revert]` so log-parsing consumers (LLMs, CI)
 * can grep.
 */

const LOG_PREFIX = '[revert]';

interface Ran {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runSync(cmd: string[], cwd?: string): Ran {
  const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', cwd });
  return {
    ok: (proc.exitCode ?? 1) === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? 1,
  };
}

const builder = (y: Argv) =>
  y
    .positional('sha', {
      type: 'string',
      describe: 'Commit SHA to revert (full or short). Omit with --last to revert the most recent agent commit.',
    })
    .options({
      last: {
        type: 'boolean',
        default: false,
        describe: 'Revert the most recent commit by the agent author (default filter: fmrules-agent).',
      },
      author: {
        type: 'string',
        default: 'fmrules-agent',
        describe: 'Author name to filter by when --last is used.',
      },
      reason: {
        type: 'string',
        describe: 'Optional reason trailer for the revert commit body.',
      },
      'dry-run': {
        type: 'boolean',
        default: false,
        describe: 'Print the intended revert without touching state.',
      },
    });

function log(msg: string): void {
  console.log(`${LOG_PREFIX} ${msg}`);
}

function fail(msg: string, hint?: string): never {
  console.error(`${LOG_PREFIX} ERROR: ${msg}`);
  if (hint) console.error(`${LOG_PREFIX}        ${hint}`);
  process.exit(1);
}

const handler: CommandModule['handler'] = async (argv) => {
  const ctx = createContext({
    cwd: argv.cwd as string | undefined,
    rules: argv.rules as string,
    meta: argv.meta as string,
    verbose: argv.verbose as number,
    quiet: argv.quiet as boolean,
    color: argv.color as boolean,
  });

  const sha = argv.sha as string | undefined;
  const last = argv.last as boolean;
  const authorFilter = argv.author as string;
  const reason = argv.reason as string | undefined;
  const dryRun = argv['dry-run'] as boolean;

  if (!sha && !last) {
    fail('provide <sha> or --last', 'e.g. `fmrules revert --last` or `fmrules revert abc1234`');
  }
  if (sha && last) fail('give either <sha> or --last, not both');

  const repoCwd = ctx.paths.cwd;

  // Preflight: on main, tree clean, in sync with origin.
  const branch = runSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], repoCwd);
  if (!branch.ok) fail('could not resolve current branch — is this a git repo?');
  if (branch.stdout.trim() !== 'main') {
    fail(`not on main (on ${branch.stdout.trim()})`, 'checkout main first');
  }
  log('branch: main ✓');

  const status = runSync(['git', 'status', '--porcelain'], repoCwd);
  if (!status.ok) fail('git status failed');
  if (status.stdout.trim()) {
    fail('working tree not clean', `commit or stash first:\n${status.stdout.trimEnd()}`);
  }
  log('working tree: clean ✓');

  const fetch = runSync(['git', 'fetch', 'origin', 'main'], repoCwd);
  if (!fetch.ok) fail('git fetch failed');
  const localSha = runSync(['git', 'rev-parse', 'HEAD'], repoCwd).stdout.trim();
  const remoteSha = runSync(['git', 'rev-parse', 'origin/main'], repoCwd).stdout.trim();
  if (localSha !== remoteSha) {
    fail(
      `local main (${localSha.slice(0, 7)}) differs from origin/main (${remoteSha.slice(0, 7)})`,
      'git pull --ff-only or push outstanding commits first',
    );
  }
  log(`main in sync with origin ✓ (${localSha.slice(0, 7)})`);

  // Resolve target SHA.
  let targetSha: string;
  if (last) {
    const r = runSync(
      ['git', 'log', `--author=${authorFilter}`, '--format=%H', '--max-count=1'],
      repoCwd,
    );
    if (!r.ok || !r.stdout.trim()) {
      fail(
        `no commit found with author matching "${authorFilter}"`,
        `try: git log --author="${authorFilter}" --oneline`,
      );
    }
    targetSha = r.stdout.trim();
    log(`resolved --last → ${targetSha.slice(0, 7)} (author: ${authorFilter})`);
  } else {
    const r = runSync(['git', 'rev-parse', '--verify', sha!], repoCwd);
    if (!r.ok) fail(`commit not found: ${sha}`);
    targetSha = r.stdout.trim();
    // Must be on main's ancestry.
    const anc = runSync(['git', 'merge-base', '--is-ancestor', targetSha, 'main'], repoCwd);
    if (!anc.ok) fail(`commit ${targetSha.slice(0, 7)} is not on main`, 'only main-branch commits are revertable here');
    log(`resolved ${sha} → ${targetSha.slice(0, 7)}`);
  }

  // Safety: refuse to revert compile bot-commits.
  const authorR = runSync(['git', 'log', '-1', '--format=%an <%ae>', targetSha], repoCwd);
  if (!authorR.ok) fail('could not read commit author');
  const author = authorR.stdout.trim();
  if (author.includes('github-actions[bot]')) {
    fail(
      `refusing to revert github-actions[bot] commit ${targetSha.slice(0, 7)}`,
      'those are auto-regenerated compile outputs; revert the rule commit that preceded it instead',
    );
  }
  log(`original author: ${author}`);

  // Read original subject + date for the amended message.
  const subject = runSync(['git', 'log', '-1', '--format=%s', targetSha], repoCwd).stdout.trim();
  const date = runSync(['git', 'log', '-1', '--format=%aI', targetSha], repoCwd).stdout.trim();

  const message = [
    `revert: ${subject}`,
    '',
    `Reverts ${targetSha.slice(0, 7)}.`,
    `Original author: ${author}`,
    `Original date:   ${date}`,
    ...(reason ? ['', `Reason: ${reason}`] : []),
  ].join('\n');

  if (dryRun) {
    log('DRY RUN — no state modified');
    console.log();
    console.log(`${LOG_PREFIX} would run: git revert --no-edit ${targetSha.slice(0, 7)}`);
    console.log(`${LOG_PREFIX} would amend message to:`);
    console.log();
    for (const line of message.split('\n')) console.log(`    ${line}`);
    console.log();
    console.log(`${LOG_PREFIX} would push: git push origin main`);
    return;
  }

  // Do the revert.
  log(`reverting ${targetSha.slice(0, 7)}…`);
  const revert = runSync(['git', 'revert', '--no-edit', targetSha], repoCwd);
  if (!revert.ok) {
    const err = revert.stderr.trim() || revert.stdout.trim();
    fail(
      `git revert failed: ${err}`,
      'resolve conflicts manually with `git revert --continue` after editing, or `git revert --abort`',
    );
  }

  // Amend the revert commit message to our structured form.
  const amend = runSync(['git', 'commit', '--amend', '-m', message], repoCwd);
  if (!amend.ok) fail('git commit --amend failed');

  log('pushing…');
  const push = runSync(['git', 'push', 'origin', 'main'], repoCwd);
  if (!push.ok) {
    fail(
      'git push failed',
      'the revert commit is local; fix the push issue (typically auth or rebased remote) and retry `git push origin main`',
    );
  }

  const newSha = runSync(['git', 'rev-parse', 'HEAD'], repoCwd).stdout.trim();
  console.log();
  log('─── revert summary ───');
  log(`reverted:     ${targetSha.slice(0, 7)} "${subject}"`);
  log(`revert sha:   ${newSha.slice(0, 7)}`);
  log('status:       ✓ pushed');
  log('the compile workflow will regenerate mailrules.json and publish a release on the revert.');
};

export const command: CommandModule = {
  command: 'revert [sha]',
  describe: 'Revert a rule commit (for fmrules-agent mistakes) and push to origin',
  builder,
  handler,
};
