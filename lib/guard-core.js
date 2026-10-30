/**
 * speak-guard 核心判据（零依赖纯函数）
 *
 * 要回答的问题只有一个：这一轮里，模型上一次调工具之后，有没有对主人说过话？
 *
 * 判据落在消息数组上，不落在事件流上。`agent/pre-step` 每步都交给 App
 * 即将发往模型的完整消息数组，于是「模型最近一次发言」与「模型最近一次
 * 调工具」在同一份数组里的相对位置，直接就是答案。
 *
 * 三个概念：
 *   - assistant 消息的 content 是块数组，块类型有 thinking / text / toolCall；
 *   - 「说过话」= 该条 assistant 消息里存在非空 text 块（thinking 不算，主人看不见）；
 *   - 「悬空的工具调用」= 最后一条 assistant 消息带 toolCall，却没有非空 text。
 */

/** 一条消息的文本内容（仅 text 块，thinking 不计）。 */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

/** 该消息是否含工具调用块。 */
export function toolCallsOf(content) {
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "toolCall" || block.type === "tool_call" || block.type === "toolUse") calls.push(block);
  }
  return calls;
}

/** 归一化一条消息的 role / content，兼容宿主两种落盘形状。 */
export function normalizeMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw.message && typeof raw.message === "object" ? raw.message : raw;
  const role = typeof msg.role === "string" ? msg.role : null;
  if (!role) return null;
  return { role, content: msg.content };
}

/**
 * 找出「悬空的工具调用」：最后一条 assistant 消息调了工具，但没说话。
 *
 * 只看最后一条 assistant 消息就够——前面的轮次早已被后来的发言覆盖。
 * 中途出现 user / toolResult 不影响判断，因为它们都发生在该 assistant
 * 消息之后、模型下一步之前。
 *
 * @returns {{pending: boolean, toolNames: string[], reason: string}}
 */
export function inspectPendingToolCall(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = normalizeMessage(list[i]);
    if (!m || m.role !== "assistant") continue;

    const calls = toolCallsOf(m.content);
    if (calls.length === 0) {
      return { pending: false, toolNames: [], reason: "last-assistant-has-no-tool-call" };
    }
    const text = textOf(m.content).trim();
    if (text) {
      return { pending: false, toolNames: [], reason: "last-assistant-spoke" };
    }
    const names = calls
      .map((c) => (typeof c.name === "string" ? c.name : typeof c.toolName === "string" ? c.toolName : ""))
      .filter(Boolean);
    return { pending: true, toolNames: names, reason: "tool-call-without-text" };
  }
  return { pending: false, toolNames: [], reason: "no-assistant-message" };
}


/** 把模板里的占位符换掉。 */
export function renderReminder(template, vars = {}) {
  let out = String(template ?? "");
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(String(value ?? ""));
  }
  return out;
}


/**
 * 把提醒挂到「最后那条 toolResult」里。
 *
 * 为什么不新增一条消息：
 *
 * 提醒的语义是「你刚才那一下没说话」，它天然属于那个时刻。挂在哪条
 * 工具结果后面，模型读到的就是「刚跑完这个工具——哦，我还没说话」。
 *
 * 如果新增一条 system 消息，宿主会把它抽出来拼进 systemPrompt
 * （bundle/index.js 两条分支均如此），于是它跑到请求最前面，时间点
 * 被抹掉，读起来就变成「你一向如此」——模型会误以为自己一直没说话。
 *
 * 用 user 角色新增也不行：那是借用户的嘴说话。
 *
 * 所以位置就是语义：贴着 toolResult 才是「刚才」，跑到 systemPrompt
 * 就是「一直」。改写已有消息既保住位置，又不改变数组结构。
 *
 * @returns {{ messages: unknown[], appended: boolean }}
 */
export function appendReminderToLastToolResult(messages, text) {
  const list = Array.isArray(messages) ? messages.slice() : [];

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const raw = list[i];
    if (!raw || typeof raw !== "object") continue;

    // 兼容两种形状：直接的消息对象，或宿主包装的 { type, message }
    const isWrapped = raw.message && typeof raw.message === "object";
    const msg = isWrapped ? raw.message : raw;
    const role = typeof msg.role === "string" ? msg.role : null;
    if (role !== "toolResult" && role !== "tool") continue;

    const blocks = Array.isArray(msg.content) ? msg.content.slice() : [];
    blocks.push({ type: "text", text: `\n\n${text}` });

    const nextMsg = { ...msg, content: blocks };
    list[i] = isWrapped ? { ...raw, message: nextMsg } : nextMsg;
    return { messages: list, appended: true };
  }

  // 找不到工具结果（例如模型没调工具就结束了）→ 不动数组
  return { messages: list, appended: false };
}

/**
 * 一次完整的裁决：给定消息数组与配置，返回要不要提醒、以及改好的数组。
 *
 * 没有次数上限：需求就是「每次工具调用后没说话就提醒」，上限会直接削掉
 * 这件事本身。提醒对用户不可见，不存在「刷用户的屏」这回事。
 */
export function decide(messages, config = {}) {
  const {
    enabled = true,
    reminderText = "",
  } = config;

  if (!enabled) return { action: "skip", reason: "disabled" };

  const inspection = inspectPendingToolCall(messages);
  if (!inspection.pending) {
    return { action: "skip", reason: inspection.reason, inspection };
  }

  const text = renderReminder(reminderText, {
    tools: inspection.toolNames.length ? inspection.toolNames.join("、") : "工具",
  });

  const patched = appendReminderToLastToolResult(messages, text);
  if (!patched.appended) {
    return { action: "skip", reason: "no-tool-result-to-attach", inspection };
  }

  return {
    action: "remind",
    reason: "tool-call-without-text",
    inspection,
    messages: patched.messages,
  };
}

/** 配置归一化：宿主存的是松散 JSON，缺项走默认。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: src.enabled !== false,
    reminderText: typeof src.reminderText === "string" && src.reminderText.trim()
      ? src.reminderText
      : DEFAULT_REMINDER_TEXT,
  };
}

/**
 * 默认提醒文案。
 *
 * 用 XML 标签包裹，而不是用自然语言解释「这是系统提醒」：标签本身就在
 * 声明来源，模型见过无数次这类标签，不必再读一句话才知道该不该当指令。
 * 标签名不叫 hana_*，免得和宿主自己的上下文块撞车。
 */
export const DEFAULT_REMINDER_TEXT = [
  "<system-reminder source=\"speak-guard\">",
  "你刚调用过 {tools}，但这一轮还没有对用户说过话。用户此刻只看到一个转圈，不知道你在做什么。",
  "在继续调用工具之前，先用一两句话说明：刚才做了什么、接下来要做什么。",
  "</system-reminder>",
].join("\n");
