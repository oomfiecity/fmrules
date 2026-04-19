import pc from 'picocolors';

export interface Logger {
  error: (msg: string) => void;
  warn: (msg: string) => void;
  info: (msg: string) => void;
  debug: (msg: string) => void;
  trace: (msg: string) => void;
}

export interface LoggerOptions {
  /** 0 = info, 1 = debug, 2 = trace. */
  verbose?: number;
  quiet?: boolean;
  color?: boolean;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const verbose = opts.verbose ?? 0;
  const quiet = opts.quiet ?? false;
  const color = opts.color ?? !process.env.NO_COLOR;

  const paint = (fn: (s: string) => string) => (color ? fn : (s: string) => s);
  const red = paint(pc.red);
  const yellow = paint(pc.yellow);
  const cyan = paint(pc.cyan);
  const gray = paint(pc.gray);

  return {
    error: (msg) => console.error(red('error: ') + msg),
    warn: (msg) => {
      if (!quiet) console.error(yellow('warn: ') + msg);
    },
    info: (msg) => {
      if (!quiet) console.error(cyan('info: ') + msg);
    },
    debug: (msg) => {
      if (verbose >= 1) console.error(gray('debug: ') + msg);
    },
    trace: (msg) => {
      if (verbose >= 2) console.error(gray('trace: ') + msg);
    },
  };
}
