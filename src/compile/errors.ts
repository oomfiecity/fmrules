/**
 * Error collector threaded through the 5-phase pipeline. The driver does
 * not halt on the first error — each phase runs to completion (skipping
 * items whose predecessors failed), and every error gets surfaced at the
 * end. See SPEC(10).md §11.2 and §12.
 */

export interface CompileError {
  /** Source file path(s), relative to cwd. Multiple files for cross-file errors. */
  file: string | string[];
  /** 1-based line number when the parser made it available; omitted otherwise. */
  line?: number;
  /** §12 bullet tag for grouping + fixture assertions, e.g. "12.2" or "12.4". */
  tag: string;
  message: string;
}

export class ErrorCollector {
  private readonly items: CompileError[] = [];
  private readonly warnings: CompileError[] = [];

  error(err: CompileError): void {
    this.items.push(err);
  }

  warn(warning: CompileError): void {
    this.warnings.push(warning);
  }

  hasErrors(): boolean {
    return this.items.length > 0;
  }

  getErrors(): readonly CompileError[] {
    return this.items;
  }

  getWarnings(): readonly CompileError[] {
    return this.warnings;
  }

  count(): number {
    return this.items.length;
  }
}

export function formatError(e: CompileError): string {
  const files = Array.isArray(e.file) ? e.file.join(', ') : e.file;
  const loc = e.line !== undefined ? `${files}:${e.line}` : files;
  return `[${e.tag}] ${loc}: ${e.message}`;
}
