/**
 * 说话提醒 · 面板脚本
 *
 * 只做展示与自测，不改真实会话。数据全部来自本 App 自己的后端路由。
 */
import { hana } from "./sdk.js";

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function showError(message) {
  const el = $("err");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

async function readJson(path, init) {
  const res = await hana.api.fetch(path, init);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error || body?.code || "";
    } catch {
      /* 非 JSON 响应 */
    }
    throw new Error(`HTTP ${res.status}${detail ? ` · ${detail}` : ""}`);
  }
  return res.json();
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "—";
  }
}

const TAG_LABEL = {
  reminded: "已提醒",
};

function renderRecent(recent) {
  const list = $("recent");
  const empty = $("recent-empty");
  if (!list) return;
  list.textContent = "";

  if (!Array.isArray(recent) || recent.length === 0) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  for (const item of recent.slice(0, 30)) {
    const li = document.createElement("li");

    const tag = document.createElement("span");
    tag.className = "sg-tag";
    tag.dataset.t = item.type || "";
    tag.textContent = TAG_LABEL[item.type] || item.type || "—";
    li.appendChild(tag);

    const time = document.createElement("span");
    time.className = "sg-time";
    time.textContent = fmtTime(item.at);
    li.appendChild(time);

    const detail = document.createElement("span");
    detail.className = "sg-detail";
    const tools = Array.isArray(item.detail?.tools) ? item.detail.tools.join("、") : "";
    detail.textContent = item.type === "reminded" ? (tools || "工具") : "";
    li.appendChild(detail);

    list.appendChild(li);
  }
}

async function refresh() {
  showError("");
  try {
    const data = await readJson("/stats");
    const c = data.config || {};
    const n = data.counts || {};

    setText("m-steps", n.steps ?? 0);
    setText("m-reminded", n.reminded ?? 0);
    setText("m-skipped", n.skipped ?? 0);
    setText("m-errors", n.errors ?? 0);

    const state = $("state");
    if (state) {
      const on = c.enabled !== false;
      state.dataset.on = on ? "1" : "0";
      state.textContent = on ? "运行中" : "已停用";
    }

    renderRecent(data.recent);

    if (data.lastError) showError(`最近错误：${data.lastError}`);
  } catch (e) {
    showError(`读取数据失败：${e?.message || e}`);
  }
}

function renderVerdict(hit, inspection) {
  const el = $("verdict");
  if (!el) return;
  el.hidden = false;
  el.dataset.hit = hit ? "1" : "0";
  const tools = Array.isArray(inspection?.toolNames) && inspection.toolNames.length
    ? inspection.toolNames.join("、")
    : "无";
  el.textContent = hit
    ? `判据命中 → 会注入提醒\n原因：${inspection?.reason}\n识别到的工具：${tools}`
    : `判据未命中 → 不干预\n原因：${inspection?.reason}`;
}

async function probe(kind) {
  showError("");
  // 构造两段对照消息：一段调了工具没说话，一段说过了
  const messages = kind === "hit"
    ? [
        { role: "user", content: [{ type: "text", text: "（自测）帮我看看这个目录" }] },
        { role: "assistant", content: [{ type: "thinking", text: "先列目录" }, { type: "toolCall", name: "ls", id: "c1" }] },
      ]
    : [
        { role: "user", content: [{ type: "text", text: "（自测）帮我看看这个目录" }] },
        { role: "assistant", content: [{ type: "text", text: "我先列一下目录看看结构。" }, { type: "toolCall", name: "ls", id: "c1" }] },
      ];

  try {
    const res = await readJson("/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    renderVerdict(res?.inspection?.pending === true, res?.inspection);
  } catch (e) {
    showError(`自测失败：${e?.message || e}`);
  }
}

async function resetStats() {
  showError("");
  try {
    await readJson("/reset-stats", { method: "POST" });
    await refresh();
  } catch (e) {
    showError(`清零失败：${e?.message || e}`);
  }
}

function wire() {
  const bind = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener("click", fn);
  };
  bind("btn-probe-hit", () => probe("hit"));
  bind("btn-probe-miss", () => probe("miss"));
  bind("btn-refresh", () => refresh());
  bind("btn-reset", () => resetStats());
}

async function main() {
  try {
    await hana.ready();
  } catch (e) {
    showError(`SDK 未就绪：${e?.message || e}`);
    return;
  }
  wire();
  await refresh();
}

main();
