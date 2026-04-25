/**
 * 5-phase compile driver (SPEC(10).md §11.2).
 *
 * Phases: Load → Validate → Resolve → Expand → Emit. The driver does not
 * halt on the first error — each phase runs to completion and accumulated
 * errors are surfaced at the end. `check` uses this with `write=false`;
 * `compile` adds the emit write.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Context } from '../context.ts';
import type {
  Condition,
  EmittedRule,
  Manifest,
  Project,
  Rule,
  RuleFile,
  SnippetFile,
} from '../types.ts';
import { ErrorCollector, formatError } from './errors.ts';
import { loadManifestFile, loadProjectFiles } from './load.ts';
import { buildManifest } from './manifest.ts';
import { buildRuleFile, buildSnippetFile, checkGlobalNameUniqueness } from './validate.ts';
import { resolveRuleConditions } from './resolve.ts';
import { checkCollisions } from './collisions.ts';
import { expandRule, type ExpandedRule } from './expand.ts';
import { emitRule } from './emit.ts';
import {
  readLockfileOptional,
  reconcileLockfile,
  writeLockfile,
  type LockfileMap,
} from './lockfile.ts';
import { ruleFingerprint } from '../util/fingerprint.ts';

export interface PipelineOptions {
  /** Skip emit, only validate. */
  checkOnly?: boolean;
  /** Output path for mailrules.json, relative to cwd. */
  out?: string;
  /** When false, skip lockfile read/write (timestamps = now). */
  useLockfile?: boolean;
  /** When true, don't write anything to disk — print add/change/remove summary. */
  dryRun?: boolean;
}

export interface PipelineResult {
  errors: readonly ReturnType<ErrorCollector['getErrors']>[number][];
  warnings: readonly ReturnType<ErrorCollector['getWarnings']>[number][];
  emittedCount: number;
  files: readonly RuleFile[];
  orphanedSnippets: string[];
}

function warnOrphanedSnippets(
  snippets: Map<string, SnippetFile>,
  referencedSnippetPaths: Set<string>,
  errors: ErrorCollector,
): string[] {
  const orphaned: string[] = [];
  for (const path of snippets.keys()) {
    if (!referencedSnippetPaths.has(path)) {
      orphaned.push(path);
      errors.warn({
        file: path,
        tag: '12.8',
        message: `Snippet is not referenced by any rule's \`extends:\` (including disabled rules). It may be dead code.`,
      });
    }
  }
  return orphaned;
}

function collectExtendsPaths(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.kind === 'extends' && Array.isArray(n.paths)) {
    for (const p of n.paths as string[]) out.add(p);
  }
  if (Array.isArray(n.children)) {
    for (const c of n.children) collectExtendsPaths(c, out);
  }
  if (n.child) collectExtendsPaths(n.child, out);
}

/**
 * One entry point, two modes.
 *   checkOnly: phases 1-4 only (no emit).
 *   otherwise: full pipeline + emit.
 */
export async function runPipeline(
  ctx: Context,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const errors = new ErrorCollector();
  const cwd = ctx.cwd;

  // ── Phase 1: Load ─────────────────────────────────────────────────────
  const manifestRaw = await loadManifestFile(cwd, errors);
  const { rules: ruleRaws, snippets: snippetRaws, ruleRelPaths } = await loadProjectFiles(cwd, errors);

  // ── Phase 2: Validate (per-file) ──────────────────────────────────────
  const ruleFiles: RuleFile[] = [];
  for (const r of ruleRaws) {
    const rf = buildRuleFile(r, errors);
    if (rf) ruleFiles.push(rf);
  }
  const snippetMap = new Map<string, SnippetFile>();
  for (const s of snippetRaws) {
    const sf = buildSnippetFile(s, errors);
    if (sf) snippetMap.set(sf.path, sf);
  }
  checkGlobalNameUniqueness(ruleFiles, errors);

  let manifest: Manifest | null = null;
  if (manifestRaw) {
    manifest = await buildManifest(manifestRaw, cwd, ruleRelPaths, errors);
  }

  const project: Project = {
    manifest: manifest ?? { order: [] },
    ruleFiles,
    snippets: snippetMap,
  };

  // Orphaned-snippet warning — look across ALL rules (enabled and disabled).
  const referencedSnippets = new Set<string>();
  for (const f of ruleFiles) {
    for (const rule of f.rules) {
      if (rule.when.kind !== 'always') {
        collectExtendsPaths(rule.when, referencedSnippets);
      }
    }
  }
  const orphaned = warnOrphanedSnippets(snippetMap, referencedSnippets, errors);

  // Which rules actually compile forward? Only enabled rules from files
  // listed in manifest.order — in the order they appear.
  const manifestFileSet = new Set(project.manifest.order);
  const filesInOrder = project.manifest.order
    .map((p) => ruleFiles.find((f) => f.path === p))
    .filter((f): f is RuleFile => !!f);

  // ── Phase 3: Resolve (enabled rules only) ────────────────────────────
  interface ResolvedRule {
    rule: Rule;
    condition: Condition | null;
  }
  const resolved: ResolvedRule[] = [];
  for (const f of filesInOrder) {
    for (const rule of f.rules) {
      if (!rule.enabled) continue;
      const cond = await resolveRuleConditions(rule, project, cwd, errors);
      resolved.push({ rule, condition: cond });
    }
  }
  // Collision check after flattening (§8.9/§9.2).
  for (const r of resolved) {
    if (r.condition) checkCollisions(r.rule, r.condition, errors);
  }

  // ── Phase 4: Expand + leaf cap ────────────────────────────────────────
  const expanded: ExpandedRule[] = [];
  for (const r of resolved) {
    expanded.push(...expandRule(r.rule, r.condition, errors));
  }

  // ── Phase 5: Emit ─────────────────────────────────────────────────────
  // We always compute the emission — it's cheap and gives `check` a useful
  // total count. But we only write to disk when there are zero errors and
  // this is not checkOnly / dryRun.
  const nowIso = new Date().toISOString();
  const emitted: EmittedRule[] = expanded.map((r) => emitRule(r, nowIso));

  let finalEmitted = emitted;
  let lockfileOut: LockfileMap = {};
  const useLockfile = opts.useLockfile ?? true;
  if (useLockfile && !opts.checkOnly) {
    const prev = await readLockfileOptional(cwd);
    const reconciled = reconcileLockfile(emitted, prev, nowIso);
    finalEmitted = reconciled.rules;
    lockfileOut = reconciled.lockfile;
  }

  // Ignored-but-informative: files listed in manifest that happen to be
  // absent (also surfaced as an error in phase 1). Suppress to avoid dup.
  void manifestFileSet;

  if (errors.hasErrors()) {
    // Skip writing; just return the error list.
    return {
      errors: errors.getErrors(),
      warnings: errors.getWarnings(),
      emittedCount: finalEmitted.length,
      files: ruleFiles,
      orphanedSnippets: orphaned,
    };
  }

  if (opts.checkOnly) {
    return {
      errors: errors.getErrors(),
      warnings: errors.getWarnings(),
      emittedCount: finalEmitted.length,
      files: ruleFiles,
      orphanedSnippets: orphaned,
    };
  }

  if (opts.dryRun) {
    const prev = useLockfile ? await readLockfileOptional(cwd) : {};
    printDiffSummary(ctx, finalEmitted, prev);
    return {
      errors: errors.getErrors(),
      warnings: errors.getWarnings(),
      emittedCount: finalEmitted.length,
      files: ruleFiles,
      orphanedSnippets: orphaned,
    };
  }

  const outRel = opts.out ?? 'mailrules.json';
  const outAbs = path.resolve(cwd, outRel);
  await fs.writeFile(outAbs, JSON.stringify(finalEmitted, null, 2) + '\n', 'utf8');
  if (useLockfile) {
    await writeLockfile(cwd, lockfileOut);
  }

  return {
    errors: errors.getErrors(),
    warnings: errors.getWarnings(),
    emittedCount: finalEmitted.length,
    files: ruleFiles,
    orphanedSnippets: orphaned,
  };
}

function printDiffSummary(ctx: Context, rules: EmittedRule[], prev: LockfileMap): void {
  const prevByFp = new Set(Object.keys(prev));
  const prevByName = new Set(Object.values(prev).map((e) => e.name));
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
  const removed = Object.values(prev).filter((e) => !outputNames.has(e.name)).length;
  ctx.log.info(
    `Dry run: ${rules.length} rules would be emitted — ${unchanged} unchanged, ${changed} changed, ${added} new, ${removed} removed.`,
  );
}

export function printErrors(ctx: Context, result: PipelineResult): void {
  for (const w of result.warnings) {
    ctx.log.warn(formatError(w));
  }
  for (const e of result.errors) {
    ctx.log.error(formatError(e));
  }
}
