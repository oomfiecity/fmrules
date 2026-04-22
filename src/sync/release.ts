import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface LatestRules {
  name: string;
  mimeType: string;
  buffer: Buffer;
  count: number;
}

function countRules(buffer: Buffer): number {
  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
  } catch {
    // non-JSON asset; leave count at 0
  }
  return 0;
}

export async function downloadLatestRules(repo: string, fileName = "mailrules.json"): Promise<LatestRules> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN env var is required to fetch release assets.");
  }

  const apiBase = `https://api.github.com/repos/${repo}`;
  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "fmrules",
  };

  const releaseRes = await fetch(`${apiBase}/releases/latest`, { headers: baseHeaders });
  if (!releaseRes.ok) {
    throw new Error(`GitHub API error fetching latest release: ${releaseRes.status} ${releaseRes.statusText}`);
  }
  const release = (await releaseRes.json()) as { assets: Array<{ id: number; name: string; content_type?: string }> };

  const asset = release.assets.find((a) => a.name === fileName) ?? release.assets[0];
  if (!asset) throw new Error(`No assets found in latest release of ${repo}.`);

  const assetRes = await fetch(`${apiBase}/releases/assets/${asset.id}`, {
    headers: { ...baseHeaders, Accept: "application/octet-stream" },
  });
  if (!assetRes.ok) {
    throw new Error(`Download failed: ${assetRes.status} ${assetRes.statusText}`);
  }

  const arrayBuffer = await assetRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return {
    name: asset.name,
    mimeType: asset.content_type || "application/octet-stream",
    buffer,
    count: countRules(buffer),
  };
}

export async function loadLocalRules(filePath: string): Promise<LatestRules> {
  const buffer = await readFile(filePath);
  return {
    name: basename(filePath),
    mimeType: "application/json",
    buffer,
    count: countRules(buffer),
  };
}
