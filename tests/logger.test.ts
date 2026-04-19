import { describe, expect, spyOn, test } from 'bun:test';
import { createLogger } from '../src/logger.ts';

describe('logger stream routing', () => {
  test('info → stdout; warn / error / debug / trace → stderr', () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const log = createLogger({ verbose: 2, color: false });
      log.info('i');
      log.warn('w');
      log.error('e');
      log.debug('d');
      log.trace('t');
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledTimes(4);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test('fmrules compile --dry-run routes its info line to stdout', async () => {
    const proc = Bun.spawn(
      ['bun', 'run', 'src/cli.ts', 'compile', '--cwd', 'tests/fixtures/basic', '--dry-run'],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } },
    );
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(stdout).toContain('Dry run:');
    expect(stderr).not.toContain('Dry run:');
  });
});
