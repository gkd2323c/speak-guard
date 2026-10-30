// 说话提醒 · UI 渲染检查（可选工具，需要 Electron 运行时）
//
// 用法：<electron-binary> test/ui.render.check.mjs
//
// 作用：用 Electron 加载真实的 ui/panel.html，验证面板骨架能渲染、数据能
// 填进页面、无资源加载失败、无脚本级错误。
//
// 两个环境约束：
//   1. 本机 Electron 存在一个已定位的兼容问题——命令行中 URL 值之后若还有
//      参数，进程会在启动早期静默崩溃。本脚本不向 Electron 传任何命令行
//      参数（URL 在脚本内部构造），不受该问题影响。
//   2. 面板要调本 App 的后端路由。这里没有宿主，于是把 ./sdk.js 的请求
//      重定向到一个本地桩模块，返回构造数据，用来验证「拿到数据后能不能
//      正确渲染」。真实握手与真实数据流仍须在宿主里验。
import { app, BrowserWindow } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** 桩模块源码：导出与真实 sdk.js 同名的 hana。 */
const STUB_SOURCE = `
const STATS = {
  ok: true,
  config: { enabled: true, maxPerTurn: 2, reminderText: "(stub)" },
  counts: { steps: 42, reminded: 7, skipped: 33, budgetExhausted: 2, errors: 0 },
  overrides: [],
  recent: [
    { at: Date.now() - 60000, type: "reminded", sessionPath: "s.jsonl", detail: { tools: ["read", "grep"], used: 1, max: 2 } },
    { at: Date.now() - 120000, type: "budget-exhausted", sessionPath: "s.jsonl", detail: { used: 2, max: 2 } },
  ],
  lastError: null,
};
const PROBE_HIT = {
  ok: true,
  inspection: { pending: true, toolNames: ["ls"], reason: "tool-call-without-text" },
  config: { enabled: true, maxPerTurn: 2 },
};
const reply = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });

export const hana = {
  ready: () => Promise.resolve(),
  api: {
    url: (p) => "/api/apps/speak-guard/routes/" + String(p || "").replace(/^\\//, ""),
    fetch: (p) => {
      const key = String(p || "");
      if (key.endsWith("/stats")) return reply(STATS);
      if (key.endsWith("/probe")) return reply(PROBE_HIT);
      if (key.endsWith("/reset-stats")) return reply({ ok: true });
      return reply({ ok: false, error: "unknown route " + key });
    },
  },
  theme: { getSnapshot: () => null, subscribe: () => () => {} },
  envelope: { getSnapshot: () => null, subscribe: () => () => {} },
  ui: { resize: () => Promise.resolve() },
};
`;

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);

    // 把 sdk.js 换成桩
    if (rel === "/assets/sdk.js") {
      res.writeHead(200, { "content-type": MIME[".js"] });
      res.end(STUB_SOURCE);
      return;
    }

    if (rel === "/") rel = "/panel.html";
    const filePath = path.normalize(path.join(UI_DIR, rel));
    if (!filePath.startsWith(path.normalize(UI_DIR))) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/panel.html`;

app.whenReady().then(async () => {
  const guard = setTimeout(() => {
    console.log("RESULT_JSON " + JSON.stringify({ ok: false, error: "verifier timeout", errors: [] }));
    app.exit(3);
  }, 20000);

  const errors = [];
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  win.webContents.on("console-message", (event, level, message) => {
    if (level >= 2) errors.push(`console[${level}]: ${String(message).slice(0, 300)}`);
  });
  win.webContents.on("did-fail-load", (event, code, desc) => {
    errors.push(`did-fail-load: ${code} ${desc}`);
  });
  win.webContents.on("render-process-gone", (event, details) => {
    errors.push(`render-process-gone: ${details?.reason} ${details?.exitCode}`);
  });

  try {
    await win.loadURL(pageUrl);
    await new Promise((r) => setTimeout(r, 2000));

    const probe = await win.webContents.executeJavaScript(`(() => {
      const text = document.body.innerText || "";
      const g = (id) => (document.getElementById(id) || {}).textContent;
      return {
        text,
        steps: g("m-steps"),
        reminded: g("m-reminded"),
        state: g("state"),
        recentCount: document.querySelectorAll("#recent li").length,
        errHidden: (document.getElementById("err") || {}).hidden,
        errText: (document.getElementById("err") || {}).textContent,
      };
    })()`);

    const text = String(probe.text || "");
    const checks = {
      hasTitle: text.includes("说话提醒"),
      hasSection: text.includes("判据自测"),
      metricsFilled: probe.steps === "42" && probe.reminded === "7",
      stateShown: probe.state === "运行中",
      recentRendered: probe.recentCount === 2,
      noError: probe.errHidden === true || !probe.errText,
    };
    const ok = Object.values(checks).every(Boolean);

    console.log("RESULT_JSON " + JSON.stringify({
      ok,
      checks,
      textSample: text.replace(/\s+/g, " ").slice(0, 240),
      errors,
    }));
  } catch (e) {
    console.log("RESULT_JSON " + JSON.stringify({ ok: false, error: String(e && e.message), errors }));
  }
  clearTimeout(guard);
  try {
    server.close();
  } catch {}
  app.exit(0);
});
