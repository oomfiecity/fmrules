/**
 * Match orchestrator: load rules from the current repo, build their
 * SearchNode IRs, evaluate each against an email, return a structured
 * report. CLI consumers shape this for human or JSON output.
 */

import type { Context } from '../context.ts';
import { loadAndBuildRules } from '../compile/pipeline.ts';
import type { Email } from './email.ts';
import { evaluateWithTrace, type TraceEntry, type Tri } from './eval.ts';

export interface RuleEvaluation {
  name: string;
  file: string;
  result: Tri;
  reason?: string;
  trace?: TraceEntry[];
}

export interface MatchReport {
  totalRules: number;
  evaluatedRules: number;
  matched: RuleEvaluation[];
  undetermined: RuleEvaluation[];
  noMatch: RuleEvaluation[];
}

export interface MatchOptions {
  ruleFilter?: string;
  withTrace?: boolean;
}

export async function matchEmail(
  ctx: Context,
  email: Email,
  opts: MatchOptions = {},
): Promise<MatchReport> {
  const { rules } = await loadAndBuildRules(ctx);

  const evaluations: RuleEvaluation[] = [];
  let evaluated = 0;
  for (const rule of rules) {
    if (opts.ruleFilter && rule.name !== opts.ruleFilter) continue;
    if (!rule.search) continue;
    evaluated++;
    const { result, trace } = evaluateWithTrace(rule.search, email);
    const entry: RuleEvaluation = { name: rule.name, file: rule.meta.file, result };
    if (opts.withTrace) entry.trace = trace;
    if (result === 'unknown') {
      entry.reason = firstUnknownReason(trace) ?? 'contains opaque or unknown operator';
    }
    evaluations.push(entry);
  }

  const matched = evaluations.filter((e) => e.result === 'true');
  const undetermined = evaluations.filter((e) => e.result === 'unknown');
  const noMatch = evaluations.filter((e) => e.result === 'false');

  return {
    totalRules: rules.length,
    evaluatedRules: evaluated,
    matched,
    undetermined,
    noMatch,
  };
}

function firstUnknownReason(trace: TraceEntry[]): string | undefined {
  for (const e of trace) {
    if (e.outcome === 'unknown') return `${e.op}: ${e.reason}`;
  }
  return undefined;
}
