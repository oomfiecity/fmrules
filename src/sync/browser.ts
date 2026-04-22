import type { Browser } from "playwright-core";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MAC_DEFAULTS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const LINUX_DEFAULTS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

function defaultCacheDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? homedir(), "ms-playwright");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright");
}

function chromiumExecInDir(dir: string): string | null {
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const macDirs = [`chrome-mac-${arch}`, "chrome-mac"];
    const appNames = [
      ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
      ["Chromium.app", "Contents", "MacOS", "Chromium"],
    ];
    for (const m of macDirs) {
      for (const parts of appNames) {
        const p = join(dir, m, ...parts);
        if (existsSync(p)) return p;
      }
    }
    return null;
  }
  if (process.platform === "win32") {
    const win = join(dir, "chrome-win", "chrome.exe");
    return existsSync(win) ? win : null;
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const linuxDirs = [`chrome-linux-${arch}`, "chrome-linux"];
  for (const l of linuxDirs) {
    const p = join(dir, l, "chrome");
    if (existsSync(p)) return p;
    const headless = join(dir, l, "headless_shell");
    if (existsSync(headless)) return headless;
  }
  return null;
}

function scanCache(cacheDir: string): string | null {
  if (!existsSync(cacheDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(cacheDir).filter((e) => e.startsWith("chromium-") || e.startsWith("chromium_headless_shell-"));
  } catch {
    return null;
  }
  entries.sort((a, b) => {
    const av = Number(a.split("-").pop()) || 0;
    const bv = Number(b.split("-").pop()) || 0;
    return bv - av;
  });
  for (const entry of entries) {
    const full = join(cacheDir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const exe = chromiumExecInDir(full);
    if (exe) return exe;
  }
  return null;
}

export function findChromium(override?: string): string | null {
  if (override) return existsSync(override) ? override : null;

  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envPath) {
    const cand = scanCache(envPath);
    if (cand) return cand;
  }

  const cached = scanCache(defaultCacheDir());
  if (cached) return cached;

  const defaults = process.platform === "darwin" ? MAC_DEFAULTS : LINUX_DEFAULTS;
  for (const p of defaults) if (existsSync(p)) return p;
  return null;
}

export async function installBrowsers(): Promise<void> {
  console.log("Installing Chromium via playwright-core registry...");
  type Executable = unknown;
  type RegistryModule = {
    registry: {
      resolveBrowsers: (names: string[], opts: { shell?: "no" | "only" }) => Executable[];
      install: (executables: Executable[], opts: { force?: boolean }) => Promise<void>;
    };
  };
  // @ts-expect-error — playwright-core/lib/server is an internal entry point without type declarations.
  const mod = (await import("playwright-core/lib/server")) as RegistryModule;
  if (!mod?.registry?.install || !mod?.registry?.resolveBrowsers) {
    throw new Error("playwright-core registry API unavailable. Try `bunx playwright install chromium` manually.");
  }
  const executables = mod.registry.resolveBrowsers(["chromium"], {});
  await mod.registry.install(executables, { force: false });
  console.log("Chromium installed.");
}

export async function ensureChromium(override?: string): Promise<string> {
  const found = findChromium(override);
  if (found) return found;
  console.log("No Chromium found — running one-time setup.");
  await installBrowsers();
  const after = findChromium(override);
  if (!after) {
    throw new Error("Chromium install completed but no executable could be located. Check PLAYWRIGHT_BROWSERS_PATH.");
  }
  return after;
}

export interface LaunchOptions {
  chromium?: string;
  headed?: boolean;
}

export async function launch(opts: LaunchOptions): Promise<Browser> {
  const exe = await ensureChromium(opts.chromium);
  const { chromium } = await import("playwright-core");
  return chromium.launch({ executablePath: exe, headless: !opts.headed });
}
