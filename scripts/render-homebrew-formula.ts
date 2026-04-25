#!/usr/bin/env bun
/**
 * Render oomfiecity/homebrew-tap/Formula/fmrules.rb from the SHA256SUMS
 * file produced by the release workflow.
 *
 * Invoked from .github/workflows/release.yml's bump-homebrew job:
 *   bun run scripts/render-homebrew-formula.ts <SHA256SUMS path> <vX.Y.Z>
 *     > tap/Formula/fmrules.rb
 *
 * Output is stable: same SHAs + same version → byte-identical formula.
 * The release workflow short-circuits the push when `git diff --quiet`
 * reports no change, so a re-run on the same release is idempotent.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'node:fs';

interface Args {
  sumsFile: string;
  version: string;
}

const argv = await yargs(hideBin(Bun.argv))
  .scriptName('render-homebrew-formula')
  .usage('$0 <sumsFile> <version>')
  .command(
    '$0 <sumsFile> <version>',
    'Render Formula/fmrules.rb to stdout',
    (y) =>
      y
        .positional('sumsFile', {
          type: 'string',
          demandOption: true,
          describe: 'Path to the combined SHA256SUMS.txt produced by the release workflow',
        })
        .positional('version', {
          type: 'string',
          demandOption: true,
          describe: 'Release tag (vX.Y.Z) or bare X.Y.Z',
        }),
  )
  .strict()
  .help()
  .alias('help', 'h')
  .version(false)
  .parseAsync();

const args: Args = {
  sumsFile: argv.sumsFile as string,
  version: argv.version as string,
};

// ──────────────────────────────────────────────────────────────────────

function bareVersion(v: string): string {
  return v.startsWith('v') ? v.slice(1) : v;
}

function parseSums(text: string): Map<string, string> {
  // shasum -a 256 output: "<sha>  <filename>"
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!m) throw new Error(`unparseable line in SHA256SUMS: ${line!}`);
    out.set(m[2]!.trim(), m[1]!);
  }
  return out;
}

function pick(sums: Map<string, string>, name: string): string {
  const v = sums.get(name);
  if (!v) {
    throw new Error(
      `missing SHA256 for ${name}; SHA256SUMS contains: ${[...sums.keys()].join(', ')}`,
    );
  }
  return v;
}

const tagVersion = bareVersion(args.version);
const tag = `v${tagVersion}`;
const sumsText = readFileSync(args.sumsFile, 'utf8');
const sums = parseSums(sumsText);

const darwinArm = pick(sums, 'fmrules-bun-darwin-arm64');
const darwinX64 = pick(sums, 'fmrules-bun-darwin-x64');
const linuxArm = pick(sums, 'fmrules-bun-linux-arm64');
const linuxX64 = pick(sums, 'fmrules-bun-linux-x64');

const baseUrl = `https://github.com/oomfiecity/fmrules/releases/download/${tag}`;

const formula = `class Fmrules < Formula
  desc "Declarative YAML authoring for Fastmail Email Rules"
  homepage "https://github.com/oomfiecity/fmrules"
  version "${tagVersion}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${baseUrl}/fmrules-bun-darwin-arm64"
      sha256 "${darwinArm}"
    else
      url "${baseUrl}/fmrules-bun-darwin-x64"
      sha256 "${darwinX64}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${baseUrl}/fmrules-bun-linux-arm64"
      sha256 "${linuxArm}"
    else
      url "${baseUrl}/fmrules-bun-linux-x64"
      sha256 "${linuxX64}"
    end
  end

  def install
    bin.install Dir["*"].first => "fmrules"
  end

  test do
    system "#{bin}/fmrules", "--help"
  end
end
`;

process.stdout.write(formula);
