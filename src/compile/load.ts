/**
 * Phase 1 — walk the filesystem, read files, parse YAML.
 *
 * Enforces the cross-cutting SPEC(10).md §11.1 rules:
 *   - UTF-8 encoding only.
 *   - YAML 1.2 core schema (no 1.1 yes/no coercion).
 *   - Anchors / aliases forbidden.
 *   - Forward-slash paths only (backslashes rejected at manifest load).
 *
 * Walks rules/ and snippets/ recursively. Per §4:
 *   - Only .yml files processed.
 *   - .yaml files warned about (probably a typo).
 *   - Symlinks skipped with a warning.
 *   - Hidden files silently ignored.
 *   - Paths case-sensitive (enforced in manifest.ts / resolve.ts).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { ErrorCollector } from './errors.ts';

/**
 * Walk a parsed YAML document and detect anchors/aliases — forbidden per
 * §11.1. Returns a list of anchor names (empty if none).
 */
function collectAnchors(doc: YAML.Document.Parsed): string[] {
  const names: string[] = [];
  YAML.visit(doc, {
    Alias(_key, node) {
      if (node.source) names.push(node.source);
    },
    Node(_key, node) {
      const anchor = (node as { anchor?: string }).anchor;
      if (anchor) names.push(anchor);
    },
  });
  return names;
}

export interface RawFile {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to project root, forward-slash. */
  relPath: string;
  /** Parsed YAML value (any shape). `null` if parse errored. */
  value: unknown;
  /** Line-position resolver; returns undefined if unmapped. */
  lineFor?: (offset: number) => number | undefined;
}

export interface WalkResult {
  rules: RawFile[];
  snippets: RawFile[];
  /** All rule-file relPaths that exist on disk under rules/, for manifest cross-check. */
  ruleRelPaths: Set<string>;
}

/**
 * Recursively walk a directory. Returns `.yml` file absolute paths.
 * Emits warnings for `.yaml` files and symlinks. Skips hidden files.
 * Non-existent directories return [].
 */
async function walkYmlFiles(
  root: string,
  relRoot: string,
  errors: ErrorCollector,
): Promise<{ abs: string; rel: string }[]> {
  let dirents: Array<import('node:fs').Dirent>;
  try {
    dirents = await fs.readdir(root, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: { abs: string; rel: string }[] = [];
  for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.name.startsWith('.')) continue;
    const abs = path.join(root, d.name);
    const rel = relRoot === '' ? d.name : `${relRoot}/${d.name}`;

    if (d.isSymbolicLink()) {
      errors.warn({
        file: rel,
        tag: '12.8',
        message: `Symbolic link skipped (symlinks are not followed). Copy the file in directly if you want it included.`,
      });
      continue;
    }

    if (d.isDirectory()) {
      out.push(...(await walkYmlFiles(abs, rel, errors)));
      continue;
    }
    if (!d.isFile()) continue;

    if (d.name.endsWith('.yaml')) {
      errors.warn({
        file: rel,
        tag: '12.8',
        message: `.yaml extension ignored; fmrules only processes .yml files. Rename to .yml if this was a typo.`,
      });
      continue;
    }
    if (!d.name.endsWith('.yml')) continue;
    out.push({ abs, rel });
  }
  return out;
}

async function readAndParseYaml(
  entry: { abs: string; rel: string },
  errors: ErrorCollector,
): Promise<RawFile | null> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(entry.abs);
  } catch (err) {
    errors.error({
      file: entry.rel,
      tag: '12.7',
      message: `Could not read file: ${(err as Error).message}`,
    });
    return null;
  }

  // UTF-8 validity: decode strictly; if it round-trips we accept.
  const text = buf.toString('utf8');
  const reencoded = Buffer.from(text, 'utf8');
  if (!buf.equals(reencoded)) {
    errors.error({
      file: entry.rel,
      tag: '12.7',
      message: 'File is not valid UTF-8.',
    });
    return null;
  }

  const lineCounter = new YAML.LineCounter();
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(text, {
      version: '1.2',
      schema: 'core',
      lineCounter,
      prettyErrors: true,
      strict: true,
    });
  } catch (err) {
    errors.error({
      file: entry.rel,
      tag: entry.rel.startsWith('rules/') ? '12.2' : '12.3',
      message: `YAML parse failed: ${(err as Error).message}`,
    });
    return null;
  }

  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      const line = e.linePos?.[0]?.line;
      errors.error({
        file: entry.rel,
        line,
        tag: entry.rel.startsWith('rules/') ? '12.2' : '12.3',
        message: `YAML parse error: ${e.message}`,
      });
    }
    return null;
  }

  // §11.1: anchors and aliases forbidden.
  const anchors = collectAnchors(doc);
  if (anchors.length > 0) {
    errors.error({
      file: entry.rel,
      tag: '12.7',
      message: `YAML anchors/aliases are forbidden (found: ${Array.from(new Set(anchors)).join(', ')}). Use snippets + extends instead.`,
    });
    return null;
  }

  const value = doc.toJS();
  return {
    absPath: entry.abs,
    relPath: entry.rel,
    value,
    lineFor: (offset) => lineCounter.linePos(offset).line,
  };
}

export async function loadProjectFiles(
  cwd: string,
  errors: ErrorCollector,
): Promise<WalkResult> {
  const rulesRoot = path.join(cwd, 'rules');
  const snippetsRoot = path.join(cwd, 'snippets');

  const ruleEntries = await walkYmlFiles(rulesRoot, 'rules', errors);
  const snippetEntries = await walkYmlFiles(snippetsRoot, 'snippets', errors);

  const rules: RawFile[] = [];
  for (const e of ruleEntries) {
    const loaded = await readAndParseYaml(e, errors);
    if (loaded) rules.push(loaded);
  }
  const snippets: RawFile[] = [];
  for (const e of snippetEntries) {
    const loaded = await readAndParseYaml(e, errors);
    if (loaded) snippets.push(loaded);
  }

  const ruleRelPaths = new Set(ruleEntries.map((e) => e.rel));
  return { rules, snippets, ruleRelPaths };
}

/** Read + parse manifest.yml. Returns raw YAML value or null (errors pushed). */
export async function loadManifestFile(
  cwd: string,
  errors: ErrorCollector,
): Promise<RawFile | null> {
  const abs = path.join(cwd, 'manifest.yml');
  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      errors.error({
        file: 'manifest.yml',
        tag: '12.1',
        message: 'manifest.yml is missing. Every project needs a manifest at the root.',
      });
    } else {
      errors.error({
        file: 'manifest.yml',
        tag: '12.1',
        message: `Could not read manifest.yml: ${(err as Error).message}`,
      });
    }
    return null;
  }
  const text = buf.toString('utf8');
  const reencoded = Buffer.from(text, 'utf8');
  if (!buf.equals(reencoded)) {
    errors.error({ file: 'manifest.yml', tag: '12.7', message: 'manifest.yml is not valid UTF-8.' });
    return null;
  }

  const lineCounter = new YAML.LineCounter();
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(text, {
      version: '1.2',
      schema: 'core',
      lineCounter,
      prettyErrors: true,
      strict: true,
    });
  } catch (err) {
    errors.error({ file: 'manifest.yml', tag: '12.1', message: `YAML parse failed: ${(err as Error).message}` });
    return null;
  }
  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      errors.error({
        file: 'manifest.yml',
        line: e.linePos?.[0]?.line,
        tag: '12.1',
        message: `YAML parse error: ${e.message}`,
      });
    }
    return null;
  }
  if (collectAnchors(doc).length > 0) {
    errors.error({
      file: 'manifest.yml',
      tag: '12.7',
      message: 'YAML anchors/aliases are forbidden in manifest.yml.',
    });
    return null;
  }
  return {
    absPath: abs,
    relPath: 'manifest.yml',
    value: doc.toJS(),
    lineFor: (offset) => lineCounter.linePos(offset).line,
  };
}
