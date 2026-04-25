#!/usr/bin/env bun
import { resolve, dirname } from "node:path";
import { readFileSync, mkdirSync } from "node:fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = await yargs(hideBin(Bun.argv))
  .scriptName("build")
  .usage("$0 [target] [outfile]")
  .command(
    "$0 [target] [outfile]",
    "Compile dist/fmrules (or a cross-target binary) via Bun.build",
    (y) =>
      y
        .positional("target", {
          type: "string",
          default: "",
          describe: "Bun cross-compile target (e.g. bun-linux-x64); omit for the host target",
        })
        .positional("outfile", {
          type: "string",
          default: "dist/fmrules",
          describe: "Output binary path",
        }),
  )
  .strict()
  .help()
  .alias("help", "h")
  .parseAsync();

const target = argv.target as string;
const outfile = argv.outfile as string;
mkdirSync(dirname(resolve(outfile)), { recursive: true });

// Stamp the package.json `version` into the bundle so `fmrules --version`
// returns a literal — independent of yargs's filesystem-based pkgUp lookup,
// which is fragile inside a Bun-compiled VFS.
const fmrulesPkgPath = Bun.fileURLToPath(new URL("../package.json", import.meta.url));
const fmrulesPkg = JSON.parse(readFileSync(fmrulesPkgPath, "utf8")) as { version: string };

const playwrightPkgPath = Bun.fileURLToPath(new URL(import.meta.resolve("playwright-core/package.json")));
const playwrightPkgJson = JSON.parse(readFileSync(playwrightPkgPath, "utf8"));
const playwrightPkgDir = dirname(playwrightPkgPath);

/**
 * playwright-core has `require("../../package.json")` / `require.resolve(...)` calls
 * in runtime code that Bun doesn't statically resolve, so they fail from inside the
 * compiled VFS. Rewrite them to literal values at load time.
 */
const patchPlaywrightPlugin: import("bun").BunPlugin = {
  name: "patch-playwright-package-json-lookups",
  setup(build) {
    build.onLoad({ filter: /playwright-core.*\.js$/ }, async (args) => {
      let contents = await Bun.file(args.path).text();
      if (!/package\.json/.test(contents)) return;
      if (process.env.BUILD_DEBUG) console.error("[patch]", args.path);
      const pkgLiteral = JSON.stringify(playwrightPkgJson);
      const dirLiteral = JSON.stringify(playwrightPkgDir);

      contents = contents.replace(
        /require\.resolve\(\s*["'](?:\.\.\/)+package\.json["']\s*\)/g,
        JSON.stringify(playwrightPkgPath),
      );
      contents = contents.replace(
        /require\(\s*["'](?:\.\.\/)+package\.json["']\s*\)/g,
        `(${pkgLiteral})`,
      );
      void dirLiteral;

      return { contents, loader: "js" };
    });
  },
};

const buildArgs: Parameters<typeof Bun.build>[0] = {
  entrypoints: ["./src/cli.ts"],
  target: "bun",
  minify: true,
  sourcemap: "linked",
  external: ["electron", "chromium-bidi"],
  plugins: [patchPlaywrightPlugin],
  define: {
    __FMRULES_VERSION__: JSON.stringify(fmrulesPkg.version),
  },
};

if (process.env.BUILD_DEBUG) {
  const inspect = await Bun.build({ ...buildArgs, minify: false, outdir: "/tmp/fmrules-debug" });
  if (!inspect.success) {
    for (const msg of inspect.logs) console.error(msg);
    process.exit(1);
  }
}

const result = await Bun.build({
  ...buildArgs,
  compile: target ? { target: target as any, outfile } : { outfile },
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}
console.log(`Built ${outfile}`);
