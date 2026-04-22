#!/usr/bin/env bun
import { resolve, dirname } from "node:path";
import { readFileSync, mkdirSync } from "node:fs";

const target = Bun.argv[2] ?? "";
const outfile = Bun.argv[3] ?? "dist/fmrules";
mkdirSync(dirname(resolve(outfile)), { recursive: true });

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
