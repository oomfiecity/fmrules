import fs from 'node:fs/promises';
import path from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import { createContext } from '../context.ts';
import { matchEmail, type MatchReport, type RuleEvaluation } from '../match/index.ts';
import { detectFormat, getHeader, parseEmail, type Email } from '../match/email.ts';

const builder = (y: Argv) =>
  y
    .positional('path', {
      type: 'string',
      describe: 'Email file path (auto-detects .eml vs .json by extension/sniff)',
    })
    .options({
      stdin: { type: 'boolean', default: false, describe: 'Read email from stdin instead of a file' },
      json: { type: 'boolean', default: false, describe: 'Force JSON parsing' },
      eml: { type: 'boolean', default: false, describe: 'Force .eml parsing' },
      output: {
        choices: ['human', 'json'] as const,
        default: 'human' as const,
        describe: 'Output format',
      },
      trace: { type: 'boolean', default: false, describe: 'Include per-leaf evaluation trace' },
      rule: { type: 'string', describe: 'Restrict evaluation to a single rule by name' },
    });

const handler: CommandModule['handler'] = async (argv) => {
  const ctx = createContext({
    cwd: argv.cwd as string | undefined,
    rules: argv.rules as string,
    meta: argv.meta as string,
    verbose: argv.verbose as number,
    quiet: argv.quiet as boolean,
    color: argv.color as boolean,
  });

  const useStdin = argv.stdin as boolean;
  const inputPath = typeof argv.path === 'string' ? argv.path : undefined;
  if (!useStdin && !inputPath) {
    ctx.log.error('match requires an email path (or pass --stdin)');
    process.exit(2);
  }

  let content: string;
  try {
    content = useStdin ? await readStdin() : await fs.readFile(inputPath!, 'utf8');
  } catch (err) {
    ctx.log.error(`could not read email: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const forced = argv.json ? 'json' : argv.eml ? 'eml' : null;
  const format = forced ?? detectFormat(useStdin ? null : inputPath!, content);

  let email: Email;
  try {
    email = parseEmail(content, format);
  } catch (err) {
    ctx.log.error(`failed to parse email (${format}): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  let report: MatchReport;
  try {
    report = await matchEmail(ctx, email, {
      ruleFilter: argv.rule as string | undefined,
      withTrace: argv.trace as boolean,
    });
  } catch (err) {
    ctx.log.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  if (argv.output === 'json') {
    printJson(email, report, argv.trace as boolean);
  } else {
    printHuman(email, report, argv.trace as boolean);
  }

  process.exit(report.matched.length > 0 ? 0 : 1);
};

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function summarizeEmail(email: Email): { from: string | null; subject: string | null; listId: string | null } {
  return {
    from: getHeader(email, 'from') ?? null,
    subject: getHeader(email, 'subject') ?? null,
    listId: getHeader(email, 'list-id') ?? null,
  };
}

function printJson(email: Email, report: MatchReport, withTrace: boolean): void {
  const out = {
    email: summarizeEmail(email),
    totalRules: report.totalRules,
    evaluatedRules: report.evaluatedRules,
    matched: report.matched.map((e) => stripEmpty(e, withTrace)),
    undetermined: report.undetermined.map((e) => stripEmpty(e, withTrace)),
    noMatch: report.noMatch.length,
  };
  console.log(JSON.stringify(out, null, 2));
}

function stripEmpty(e: RuleEvaluation, withTrace: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { name: e.name, file: e.file, result: e.result };
  if (e.reason) out.reason = e.reason;
  if (withTrace && e.trace) out.trace = e.trace;
  return out;
}

function printHuman(email: Email, report: MatchReport, withTrace: boolean): void {
  const summary = summarizeEmail(email);
  console.log(`Email: from=${summary.from ?? '(none)'} subject=${summary.subject ?? '(none)'}`);
  console.log(
    `Evaluated ${report.evaluatedRules}/${report.totalRules} rules: ` +
      `${report.matched.length} matched, ${report.undetermined.length} undetermined, ${report.noMatch.length} no-match`,
  );
  if (report.matched.length > 0) {
    console.log('\nMatched:');
    for (const e of report.matched) {
      console.log(`  ${e.name}  (${e.file})`);
      if (withTrace && e.trace) {
        for (const t of e.trace) {
          console.log(`    ${pad(t.outcome)} ${t.op} — ${t.reason}`);
        }
      }
    }
  }
  if (report.undetermined.length > 0) {
    console.log('\nUndetermined:');
    for (const e of report.undetermined) {
      console.log(`  ${e.name}  (${e.file})  — ${e.reason ?? ''}`);
      if (withTrace && e.trace) {
        for (const t of e.trace) {
          console.log(`    ${pad(t.outcome)} ${t.op} — ${t.reason}`);
        }
      }
    }
  }
}

function pad(s: string): string {
  return (s + '       ').slice(0, 7);
}

export const command: CommandModule = {
  command: 'match [path]',
  describe: 'Report which rules in this repo would match an email',
  builder,
  handler,
};
