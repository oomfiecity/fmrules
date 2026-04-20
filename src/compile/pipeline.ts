/**
 * Compile pipeline. Each stage is an independent module; this file
 * threads a PartialRule[] through them in order.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Context } from '../context.ts';
import type { EmittedRule, PartialRule } from '../types.ts';
import { loadRuleFiles, type LoadedFile } from './load.ts';
import { loadMeta, type LoadedMeta } from './meta.ts';
import { normalizeRule } from './normalize.ts';
import { applyModules } from './apply-modules.ts';
import { buildSearch } from './build-search.ts';
import { render } from './render.ts';
import { validateRule } from './validate.ts';
import { assignSortOrder } from './sort.ts';
import { readLockfileOptional, reconcileLockfile, writeLockfile, type LockfileMap } from './lockfile.ts';
import { toEmitted } from './emit.ts';
import { ruleFingerprint } from '../util/fingerprint.ts';

export interface PipelineOptions {
  out?: string;
  dryRun?: boolean;
  useLockfile?: boolean;
  pretty?: boolean;
  checkOnly?: boolean;
  strict?: boolean;
}

/**
 * Load + normalize + apply modules + buildSearch. Stops short of
 * render/validate/sort/emit so callers (`fmrules match`) that only need
 * the SearchNode IR don't pay for serialization. Returns an empty
 * `rules` array when no rule files are present — callers decide how to
 * report that.
 */
export async function loadAndBuildRules(
  ctx: Context,
): Promise<{ rules: PartialRule[]; meta: LoadedMeta; files: LoadedFile[] }> {
  const files = await loadRuleFiles(ctx);
  const meta = await loadMeta(ctx);

  let rules: PartialRule[] = [];
  for (const file of files) {
    for (let i = 0; i < file.content.rules.length; i++) {
      const rule = file.content.rules[i]!;
      rules.push(
        normalizeRule({
          rule,
          defaults: file.content.defaults,
          archetypes: file.content.archetypes,
          globalArchetypes: meta.archetypes,
          meta: { file: file.name, fileIndex: i, fanoutIndex: 0 },
        }),
      );
    }
  }

  rules = await applyModules(rules, meta, ctx);
  for (const rule of rules) {
    rule.search = buildSearch(rule);
  }
  return { rules, meta, files };
}

export async function runPipeline(ctx: Context, opts: PipelineOptions): Promise<void> {
  const { rules, meta, files } = await loadAndBuildRules(ctx);

  if (files.length === 0) {
    ctx.log.warn('No rule files found.');
    return;
  }

  const renderedByRule = new Map<PartialRule, string>();
  for (const rule of rules) {
    const rendered = render(rule.search!);
    renderedByRule.set(rule, rendered);
    validateRule(
      rule,
      meta,
      {
        strict: opts.strict ?? false,
        log: ctx.log,
      },
      rendered,
    );
  }

  assignSortOrder(rules, files, meta.config);

  if (opts.checkOnly) {
    ctx.log.info(`Checked ${rules.length} rules across ${files.length} files.`);
    return;
  }

  const nowIso = new Date().toISOString();
  const lockfile = opts.useLockfile ? await readLockfileOptional(ctx) : {};
  const emitted: EmittedRule[] = rules.map((r) => {
    const searchStr = renderedByRule.get(r)!;
    const combinator = deriveCombinator(r);
    return toEmitted(r, searchStr, combinator, nowIso);
  });

  const reconciled = opts.useLockfile
    ? reconcileLockfile(emitted, lockfile, nowIso)
    : { rules: emitted, lockfile: {} };

  if (opts.dryRun) {
    const diff = summarizeDiff(reconciled.rules, lockfile);
    ctx.log.info(
      `Dry run: ${reconciled.rules.length} rules would be emitted — ` +
        `${diff.unchanged} unchanged, ${diff.changed} changed, ${diff.added} new, ${diff.removed} removed.`,
    );
    return;
  }

  const outPath = path.resolve(ctx.paths.cwd, opts.out ?? 'mailrules.json');
  const json = opts.pretty
    ? JSON.stringify(reconciled.rules, null, 2) + '\n'
    : JSON.stringify(reconciled.rules);
  await fs.writeFile(outPath, json, 'utf8');
  ctx.log.info(`Wrote ${reconciled.rules.length} rules to ${path.relative(ctx.paths.cwd, outPath)}`);

  if (opts.useLockfile) {
    await writeLockfile(ctx, reconciled.lockfile);
  }
}

function summarizeDiff(
  rules: EmittedRule[],
  prevLockfile: LockfileMap,
): { unchanged: number; changed: number; added: number; removed: number } {
  const prevByFp = new Set(Object.keys(prevLockfile));
  const prevByName = new Set(Object.values(prevLockfile).map((e) => e.name));
  let unchanged = 0;
  let changed = 0;
  let added = 0;
  for (const r of rules) {
    const fp = ruleFingerprint(r);
    if (prevByFp.has(fp)) unchanged++;
    else if (prevByName.has(r.name)) changed++;
    else added++;
  }
  const outputNames = new Set(rules.map((r) => r.name));
  const removed = Object.values(prevLockfile).filter((e) => !outputNames.has(e.name)).length;
  return { unchanged, changed, added, removed };
}

function deriveCombinator(rule: PartialRule): 'all' | 'any' {
  if (rule.combinator) return rule.combinator;
  // A top-level OR in the search tree implies combinator=any.
  return rule.search?.kind === 'or' ? 'any' : 'all';
}

export type { LoadedFile, LoadedMeta };
