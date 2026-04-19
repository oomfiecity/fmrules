/**
 * Load meta/config.yaml and meta/modules/** into memory.
 *
 * - meta/config.yaml — folders list, file_order.
 * - meta/modules/*.ts — default-exported Module<unknown>.
 * - meta/modules/*.yaml — declarative field transform; compiled into a Module.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { Context } from '../context.ts';
import type { Module } from '../module.ts';
import { z } from 'zod';
import {
  ArchetypeSchema,
  ConfigSchema,
  DeclarativeModuleSchema,
  type ArchetypeYaml,
  type ConfigYaml,
  type DeclarativeModuleYaml,
} from '../schema/yaml.ts';
import { buildDeclarativeModule } from './declarative-module.ts';

export interface LoadedMeta {
  config: ConfigYaml;
  modules: Map<string, Module>;
  archetypes: Record<string, ArchetypeYaml>;
}

export async function loadMeta(ctx: Context): Promise<LoadedMeta> {
  const config = await loadConfig(ctx);
  const modules = await loadModules(ctx);
  const archetypes = await loadGlobalArchetypes(ctx);
  return { config, modules, archetypes };
}

const GlobalArchetypesSchema = z.object({
  archetypes: z.record(z.string(), ArchetypeSchema),
});

/**
 * Read + parse + schema-check a single optional YAML file. ENOENT →
 * `undefined` (caller supplies the default); parse or schema failure
 * throws with the path-qualified label so the user sees which file broke.
 */
async function loadOptionalYaml<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = YAML.parse(raw);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid ${label}:\n${result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}

async function loadGlobalArchetypes(ctx: Context): Promise<Record<string, ArchetypeYaml>> {
  const p = path.join(ctx.paths.meta, 'archetypes.yaml');
  const loaded = await loadOptionalYaml(p, GlobalArchetypesSchema, 'meta/archetypes.yaml');
  return loaded?.archetypes ?? {};
}

async function loadConfig(ctx: Context): Promise<ConfigYaml> {
  const p = path.join(ctx.paths.meta, 'config.yaml');
  return (await loadOptionalYaml(p, ConfigSchema, 'meta/config.yaml')) ?? {};
}

async function loadModules(ctx: Context): Promise<Map<string, Module>> {
  const dir = path.join(ctx.paths.meta, 'modules');
  const modules = new Map<string, Module>();
  // Directory-scoped rather than single-file: readdir + per-entry dispatch,
  // so `loadOptionalYaml` (single-file) doesn't fit. Per-entry schema errors
  // are thrown below with the offending filename.
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return modules;
    throw err;
  }
  for (const entry of entries.sort()) {
    const full = path.join(dir, entry);
    if (entry.endsWith('.ts') || entry.endsWith('.js')) {
      const mod = await importTsModule(full);
      if (modules.has(mod.name)) {
        throw new Error(`Duplicate module name "${mod.name}" (from ${entry})`);
      }
      modules.set(mod.name, mod);
      ctx.log.debug(`loaded module ${mod.name} (${entry})`);
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      const raw = await fs.readFile(full, 'utf8');
      const parsed = YAML.parse(raw);
      const result = DeclarativeModuleSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `Invalid declarative module ${entry}:\n${result.error.issues
            .map((i) => `  ${i.path.join('.')}: ${i.message}`)
            .join('\n')}`,
        );
      }
      const mod = buildDeclarativeModule(result.data as DeclarativeModuleYaml);
      if (modules.has(mod.name)) {
        throw new Error(`Duplicate module name "${mod.name}" (from ${entry})`);
      }
      modules.set(mod.name, mod);
      ctx.log.debug(`loaded declarative module ${mod.name} (${entry})`);
    }
  }
  return modules;
}

async function importTsModule(absolutePath: string): Promise<Module> {
  const imported = await import(absolutePath);
  const mod = imported.default ?? imported;
  if (!mod || typeof mod.apply !== 'function' || typeof mod.name !== 'string') {
    throw new Error(`Module file ${absolutePath} does not export a valid Module`);
  }
  return mod as Module;
}
