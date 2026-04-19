/**
 * Run the module chain for every rule.
 *
 * Each rule's `moduleChain` (resolved during normalization) names the
 * modules to apply in order. We feed the rule (as a single-element array)
 * through each module sequentially, letting modules fan out as needed.
 *
 * Fan-out children inherit the parent's sortOrder base but get fanoutIndex
 * + 1, +2, ... to keep them adjacent in the final ordering.
 */

import type { Context } from '../context.ts';
import type { Module, ModuleContext } from '../module.ts';
import type { PartialRule } from '../types.ts';
import type { LoadedMeta } from './meta.ts';

export async function applyModules(
  rules: PartialRule[],
  meta: LoadedMeta,
  ctx: Context,
): Promise<PartialRule[]> {
  const modCtx: ModuleContext = {
    paths: ctx.paths,
    log: {
      warn: (m) => ctx.log.warn(m),
      info: (m) => ctx.log.info(m),
    },
  };

  const out: PartialRule[] = [];
  for (const rule of rules) {
    const chain = rule.moduleChain ?? [];
    let current: PartialRule[] = [rule];
    for (const ref of chain) {
      const mod = meta.modules.get(ref.name);
      if (!mod) {
        throw new Error(
          `Rule "${rule.name}" (${rule.meta.file}): unknown module "${ref.name}"`,
        );
      }
      const args = validateArgs(mod, ref.args, rule.name);
      current = await Promise.resolve(mod.apply(current, args, modCtx));
      current = stampFanoutIndices(current, rule);
    }
    out.push(...current);
  }
  return out;
}

function validateArgs(mod: Module, args: unknown, ruleName: string): unknown {
  if (!mod.schema) return args;
  const parsed = mod.schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(
      `Module "${mod.name}" args invalid on rule "${ruleName}":\n${parsed.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return parsed.data;
}

/**
 * After each module pass, re-assign fanoutIndex so siblings produced
 * from the same parent stay adjacent under a consistent base.
 */
function stampFanoutIndices(rules: PartialRule[], parent: PartialRule): PartialRule[] {
  if (rules.length === 1) return rules;
  return rules.map((r, i) => ({
    ...r,
    meta: {
      ...r.meta,
      file: parent.meta.file,
      fileIndex: parent.meta.fileIndex,
      fanoutIndex: i,
    },
  }));
}
