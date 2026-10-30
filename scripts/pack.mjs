#!/usr/bin/env node
// 把当前提交打成一个可安装的 App zip，并生成市场条目 entry.json。
//
// 用法：node scripts/pack.mjs
// 产物：dist/app-<id>-<version>.zip、dist/app-<id>-<version>.entry.json
//
// 只依赖 git 与 node 内置模块。zip 用 `git archive` 生成：它只打包已跟踪文件，
// 并按 .gitattributes 的 export-ignore 排除仓库元数据，因此打包结果与提交一致、可复现。
// entry.json 里的 archive.url 用 {{BASE_URL}} 占位，由市场索引构建方替换。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const outDir = path.join(root, "dist");
fs.mkdirSync(outDir, { recursive: true });

const zipName = `app-${manifest.id}-${manifest.version}.zip`;
const zipPath = path.join(outDir, zipName);

execFileSync("git", ["archive", `--output=${zipPath}`, "--format=zip", "HEAD"], { cwd: root });

const bytes = fs.readFileSync(zipPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");

function readIcon() {
  const iconPath = path.join(root, manifest.icon);
  const ext = path.extname(iconPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".svg" ? "image/svg+xml" : null;
  if (!mime) return undefined;
  return `data:${mime};base64,${fs.readFileSync(iconPath).toString("base64")}`;
}

function resolvePublisher() {
  if (process.env.MARKET_PUBLISHER) return process.env.MARKET_PUBLISHER;
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const m = remote.match(/github\.com[:/]([^/]+)\//);
    if (m) return m[1];
  } catch {
    // 没有 remote 时退回仓库名推断，交给发布流程覆盖
  }
  return "unknown";
}

const entry = {
  kind: "app",
  id: manifest.id,
  name: manifest.name,
  publisher: resolvePublisher(),
  description: manifest.description,
  version: manifest.version,
  permissions: (manifest.capabilities || []).map((capability) => ({ capability })),
  compatibility: { minAppVersion: manifest.minAppVersion },
  archive: {
    url: `{{BASE_URL}}/${zipName}`,
    sha256,
    size: bytes.length,
    format: "zip",
  },
};

const icon = readIcon();
if (icon) entry.icon = icon;

const entryName = `app-${manifest.id}-${manifest.version}.entry.json`;
fs.writeFileSync(path.join(outDir, entryName), `${JSON.stringify(entry, null, 2)}\n`, "utf8");

console.log(`zip     ${zipName}`);
console.log(`size    ${bytes.length} bytes`);
console.log(`sha256  ${sha256}`);
console.log(`entry   ${entryName}`);
