/**
 * Load + parse + zod-validate rules/*.yaml.
 * Surfaces parse errors with file path + line if available.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { Context } from '../context.ts';
import { RuleFileSchema, type RuleFileYaml } from '../schema/yaml.ts';

export interface LoadedFile {
  path: string;
  /** Filename relative to the rules dir (used for display + sort order lookup). */
  name: string;
  content: RuleFileYaml;
}

async function listYamlFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(`Rules directory does not exist: ${dir}`);
    }
    throw err;
  }
  return entries
    .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('_'))
    .sort();
}

export async function loadRuleFiles(ctx: Context): Promise<LoadedFile[]> {
  const files = await listYamlFiles(ctx.paths.rules);
  const loaded: LoadedFile[] = [];
  for (const name of files) {
    const full = path.join(ctx.paths.rules, name);
    const raw = await fs.readFile(full, 'utf8');
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = RuleFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid schema in ${name}:\n${result.error.issues
          .map((i) => `  ${i.path.join('.')}: ${i.message}`)
          .join('\n')}`,
      );
    }
    loaded.push({ path: full, name, content: result.data });
    ctx.log.debug(`loaded ${name} (${result.data.rules.length} rules)`);
  }
  return loaded;
}
