import fs from 'node:fs/promises';
import path from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import YAML from 'yaml';
import { createContext } from '../context.ts';
import { MATCHER_FIELDS } from '../schema/fields.ts';

const PLURAL_TO_FIELD: Record<string, { field: string; key: 'any' | 'all' }> = {
  subjects: { field: 'subject', key: 'any' },
  subject_all: { field: 'subject', key: 'all' },
  bodies: { field: 'body', key: 'any' },
  body_all: { field: 'body', key: 'all' },
};

const builder = (y: Argv) =>
  y.options({
    nested: { type: 'boolean', default: false, describe: 'Rewrite plural / _all matchers into nested {any, all} form' },
    'dry-run': { type: 'boolean', default: false },
  });

/**
 * Walk every YAML map in the rule file (defaults, archetypes.*, rules[]) and
 * fold plural/_all keys into the singular field's nested form. Mutates the
 * Document in-place to preserve comments and surrounding key order.
 *
 * `CANONICAL_FIELDS` is the set of MatcherValue-shaped fields (the ones
 * that can carry a `{any, all}` tree). Derived from the registry so new
 * matcher fields automatically participate.
 */
const CANONICAL_FIELDS: readonly string[] = MATCHER_FIELDS
  .filter((f) => f.shape === 'matcherValue')
  .map((f) => f.yaml);

function migrateMap(map: YAML.YAMLMap): boolean {
  let changed = false;

  // Collapse any pre-existing trivial nested forms ({any: [single]} → bare)
  // so re-running the codemod tidies up output even when no sugar exists.
  for (const fld of CANONICAL_FIELDS) {
    const node = map.get(fld, true);
    if (YAML.isMap(node)) {
      const collapsed = collapseTrivialNested(node);
      if (collapsed !== node) {
        map.set(fld, collapsed);
        changed = true;
      }
    }
  }

  for (const [pluralKey, target] of Object.entries(PLURAL_TO_FIELD)) {
    if (!map.has(pluralKey)) continue;
    const pluralNode = map.get(pluralKey, true);
    if (!YAML.isSeq(pluralNode)) continue;
    const pluralValues = pluralNode.items
      .map((it) => (YAML.isScalar(it) ? it.value : it))
      .filter((v): v is string => typeof v === 'string');
    if (pluralValues.length === 0) {
      map.delete(pluralKey);
      changed = true;
      continue;
    }

    const existing = map.get(target.field, true);
    let nested: YAML.YAMLMap;
    if (YAML.isMap(existing)) {
      nested = existing;
    } else {
      nested = new YAML.YAMLMap();
      const anySeq = new YAML.YAMLSeq();
      if (YAML.isScalar(existing) && typeof existing.value === 'string') {
        anySeq.add(existing.value);
      } else if (YAML.isSeq(existing)) {
        for (const it of existing.items) {
          if (YAML.isScalar(it) && typeof it.value === 'string') anySeq.add(it.value);
        }
      }
      if (anySeq.items.length > 0) nested.set('any', anySeq);
    }

    const bucketKey = target.key;
    const bucket = nested.get(bucketKey, true);
    let bucketSeq: YAML.YAMLSeq;
    if (YAML.isSeq(bucket)) {
      bucketSeq = bucket;
    } else {
      bucketSeq = new YAML.YAMLSeq();
      nested.set(bucketKey, bucketSeq);
    }
    for (const v of pluralValues) bucketSeq.add(v);

    const collapsed = collapseTrivialNested(nested);
    map.set(target.field, collapsed);
    map.delete(pluralKey);
    changed = true;
  }
  return changed;
}

/**
 * If a nested matcher has only `any` and that list has one item, collapse
 * to the bare string. If only `any` with multiple items, collapse to a
 * bare list. `all` stays nested (it's not equivalent to bare-list sugar).
 */
function collapseTrivialNested(nested: YAML.YAMLMap): YAML.YAMLMap | YAML.YAMLSeq | YAML.Scalar {
  const hasAll = nested.has('all');
  const anyNode = nested.get('any', true);
  if (!hasAll && YAML.isSeq(anyNode)) {
    if (anyNode.items.length === 1) {
      const only = anyNode.items[0];
      if (YAML.isScalar(only)) return only;
    }
    return anyNode;
  }
  return nested;
}

function visitRuleMaps(doc: YAML.Document): boolean {
  let changed = false;
  const root = doc.contents;
  if (!YAML.isMap(root)) return false;

  const defaults = root.get('defaults', true);
  if (YAML.isMap(defaults) && migrateMap(defaults)) changed = true;

  const archetypes = root.get('archetypes', true);
  if (YAML.isMap(archetypes)) {
    for (const item of archetypes.items) {
      if (YAML.isMap(item.value) && migrateMap(item.value)) changed = true;
    }
  }

  const rules = root.get('rules', true);
  if (YAML.isSeq(rules)) {
    for (const item of rules.items) {
      if (YAML.isMap(item) && migrateMap(item)) changed = true;
    }
  }
  return changed;
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
  const nested = argv.nested as boolean;
  const dryRun = argv['dry-run'] as boolean;

  if (!nested) {
    ctx.log.error('No migration selected. Pass --nested to fold plural / _all matchers.');
    process.exit(1);
  }

  let entries: string[];
  try {
    entries = await fs.readdir(ctx.paths.rules);
  } catch (err) {
    ctx.log.error(`Cannot read rules dir ${ctx.paths.rules}: ${(err as Error).message}`);
    process.exit(1);
  }

  const yamlFiles = entries
    .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('_'))
    .sort();

  let touched = 0;
  for (const name of yamlFiles) {
    const full = path.join(ctx.paths.rules, name);
    const raw = await fs.readFile(full, 'utf8');
    const doc = YAML.parseDocument(raw);
    if (!visitRuleMaps(doc)) continue;
    const out = doc.toString();
    if (dryRun) {
      ctx.log.info(`would rewrite ${name}`);
    } else {
      await fs.writeFile(full, out, 'utf8');
      ctx.log.info(`rewrote ${name}`);
    }
    touched++;
  }
  ctx.log.info(`${touched} file(s) ${dryRun ? 'would be ' : ''}rewritten`);
};

export const command: CommandModule = {
  command: 'migrate',
  describe: 'Rewrite YAML rule files into newer canonical forms',
  builder,
  handler,
};
