/**
 * 说话提醒（speak-guard）· 主入口
 *
 * 一件事：模型调完工具却不说话的时候，替主人提醒它一句。
 *
 * 落点选在 `agent/pre-step`。它每步 agent loop 之前触发一次，交给 App
 * 即将发往模型的完整消息数组；返回 `{ messages }` 即整体替换。于是：
 *
 *   - 判据是客观的：最后一条 assistant 消息带 toolCall 却没带 text；
 *   - 提醒只在这一次请求里生效，不写进会话历史，不会污染主人的对话记录；
 *   - 不需要 sessions.send，也不需要 start-turn 授权。
 *
 * 额度按「自最后一条真实用户消息以来」计数，换一个回合重新开始。
 */
import { defineApp } from "./sdk/app-contract/server-client.js";
import {
  DEFAULT_REMINDER_TEXT,
  decide,
  normalizeConfig,
  inspectPendingToolCall,
} from "./lib/guard-core.js";

export const name = "speak-guard";

const STATS_KEY = "stats.v1";
const RECENT_LIMIT = 80;

const emptyCounts = () => ({
  steps: 0,
  reminded: 0,
  skipped: 0,
  errors: 0,
});

export default defineApp(async (sdk) => {
  const log = (level, message) => {
    try {
      Promise.resolve(sdk.logger[level](`[speak-guard] ${message}`)).catch(() => {});
    } catch {
      /* logger 不可用时静默 */
    }
  };

  const shortRef = (p) => String(p ?? "").split(/[\\/]/).pop() || "?";

  log("info", "loading");

  // ── 配置 ──
  // 设置贡献在 apply 返回之后才注册；首次读取放在已装载后的回调里。
  let config = normalizeConfig({});
  let configRefresh = null;
  async function refreshConfig() {
    try {
      const all = await sdk.config.getAll();
      config = normalizeConfig(all && typeof all === "object" ? all : {});
    } catch (e) {
      log("warn", `config read failed, keeping current: ${e?.message || e}`);
    }
  }
  function refreshConfigSoon() {
    if (!configRefresh) {
      configRefresh = refreshConfig().finally(() => {
        configRefresh = null;
      });
    }
    return configRefresh;
  }

  // ── 会话级开关（键：sessionPath；"on" / "off" / null 跟随全局）──
  const overrides = new Map();

  // ── 统计 ──
  const stats = { counts: emptyCounts(), recent: [], lastError: null };

  async function loadStats() {
    try {
      const saved = await sdk.storage.global.get(STATS_KEY);
      if (saved && typeof saved === "object") {
        if (saved.counts && typeof saved.counts === "object") {
          stats.counts = { ...stats.counts, ...saved.counts };
        }
        if (Array.isArray(saved.recent)) stats.recent = saved.recent.slice(-RECENT_LIMIT);
      }
    } catch {
      /* 首次运行没有数据 */
    }
  }
  await loadStats();

  let saveTimer = null;
  function saveStatsSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      sdk.storage.global
        .set(STATS_KEY, { counts: stats.counts, recent: stats.recent.slice(-RECENT_LIMIT) })
        .catch((e) => log("warn", `stats save failed: ${e?.message || e}`));
    }, 2000);
    // 不拖住进程退出
    if (typeof saveTimer.unref === "function") saveTimer.unref();
  }

  function record(type, sessionPath, detail = null) {
    stats.recent.push({ at: Date.now(), type, sessionPath: sessionPath ?? null, detail });
    if (stats.recent.length > RECENT_LIMIT) {
      stats.recent.splice(0, stats.recent.length - RECENT_LIMIT);
    }
  }

  async function registerSafely(label, register) {
    try {
      return await register();
    } catch (e) {
      stats.lastError = `${label}: ${e?.message || e}`;
      log("warn", `${label} registration failed: ${e?.message || e}`);
      return null;
    }
  }

  /** 本会话当前是否生效。 */
  function isActive(sessionPath) {
    if (!config.enabled) return false;
    const override = sessionPath ? overrides.get(sessionPath) : undefined;
    return override !== "off";
  }

  // ── 1. 主链路：agent/pre-step ──
  await registerSafely("agent/pre-step hook", () =>
    sdk.hooks.onDecision("agent/pre-step", async (invocation) => {
      const sessionPath = invocation?.session?.sessionPath ?? null;
      const messages = invocation?.messages;

      try {
        await refreshConfigSoon();
        stats.counts.steps += 1;

        if (!isActive(sessionPath)) {
          stats.counts.skipped += 1;
          return undefined;
        }

        const result = decide(messages, config);

        if (result.action !== "remind") {
          if (result.reason !== "disabled") stats.counts.skipped += 1;
          return undefined;
        }

        stats.counts.reminded += 1;
        const toolNames = Array.isArray(result.inspection?.toolNames) ? result.inspection.toolNames : [];
        record("reminded", sessionPath, { tools: toolNames });
        saveStatsSoon();
        log("info", `remind ${shortRef(sessionPath)} tools=[${toolNames.join(",")}] 挂到最后一条 toolResult`);

        return { messages: result.messages };
      } catch (e) {
        stats.counts.errors += 1;
        stats.lastError = `pre-step: ${e?.message || e}`;
        log("warn", `pre-step failed: ${e?.message || e}`);
        return undefined; // 出错即放行，不干预模型请求
      }
    }),
  );

  // ── 2. /speak 命令：会话级查看与切换 ──
  function describeStatus(sessionPath) {
    const override = sessionPath ? overrides.get(sessionPath) : undefined;
    const effective = !config.enabled
      ? "全局已停用"
      : override === "off"
        ? "本会话已关闭"
        : override === "on"
          ? "本会话强制开启"
          : "生效中（跟随全局）";
    return [
      "【说话提醒】本会话状态",
      `- 生效：${effective}`,
      `- 触发条件：模型调用工具但这一轮没有输出正文`,
      `- 提醒位置：最后一条工具结果末尾`,
      `- 累计：检查 ${stats.counts.steps} 步，提醒 ${stats.counts.reminded} 次`,
    ].join("\n");
  }

  await registerSafely("speak command", () =>
    sdk.commands.register({
      name: "speak",
      description: "说话提醒：查看或切换当前会话的工具后提醒",
      usage: "/speak [on|off|reset|status]",
      handler: async (invocation) => {
        await refreshConfigSoon();
        const sub = String(invocation?.args ?? "").trim().toLowerCase();
        const sessionPath = invocation?.sessionPath ?? null;
        if (!sessionPath) {
          return "【说话提醒】此入口没有会话上下文（Bridge 会话），无法切换会话级状态；全局配置见「设置 → 说话提醒」。";
        }
        if (sub === "on") {
          overrides.set(sessionPath, "on");
          return "【说话提醒】已对本会话强制开启。";
        }
        if (sub === "off") {
          overrides.set(sessionPath, "off");
          return "【说话提醒】已对本会话关闭。";
        }
        if (sub === "reset") {
          overrides.delete(sessionPath);
          return "【说话提醒】会话级设置已恢复默认（跟随全局）。";
        }
        return describeStatus(sessionPath);
      },
    }),
  );

  // ── 3. 面板数据路由 ──
  await registerSafely("routes", () =>
    sdk.routes.register((app) => {
      app.get("/stats", async (c) => {
        await refreshConfigSoon();
        return c.json({
          ok: true,
          config: {
            enabled: config.enabled,
            reminderText: config.reminderText,
          },
          counts: { ...stats.counts },
          overrides: [...overrides.entries()].map(([sessionPath, mode]) => ({ sessionPath, mode })),
          recent: stats.recent.slice(-60).reverse(),
          lastError: stats.lastError,
        });
      });

      // 探针：给面板一个「这段消息数组会不会触发」的现场判断，只读不写
      app.post("/probe", async (c) => {
        let body = null;
        try {
          body = await c.req.json();
        } catch {
          body = null;
        }
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        return c.json({
          ok: true,
          inspection: inspectPendingToolCall(messages),
          config: { enabled: config.enabled },
        });
      });

      app.post("/reset-stats", async (c) => {
        stats.counts = emptyCounts();
        stats.recent = [];
        stats.lastError = null;
        try {
          await sdk.storage.global.set(STATS_KEY, { counts: stats.counts, recent: [] });
        } catch {
          /* 忽略 */
        }
        return c.json({ ok: true });
      });
    }),
  );

  // 启动自检：注册排干后读回清单，用于诊断钩子是否真的挂上
  setTimeout(() => {
    (async () => {
      try {
        const cmds = await sdk.commands.listOwn();
        log("info", `self-check commands: ${(cmds || []).map((x) => x.name).join(", ") || "(none)"}`);
      } catch (e) {
        log("warn", `self-check commands failed: ${e?.message || e}`);
      }
    })();
  }, 4000);

  log("info", "ready");
});

export { DEFAULT_REMINDER_TEXT };
