/**
 * speak-guard 判据回归测试（零依赖，直接 node 跑）
 *
 * 守四件事：
 *   1. 判据必须把「调了工具但没说话」和「调了工具也说过话」分开；
 *   2. 提醒必须挂进已有的 toolResult，不新增消息——位置就是语义；
 *   3. 没有次数上限：每次没说话都要提醒，不能中途静默放行；
 *   4. 默认文案必须是 XML 包裹的。
 */
import assert from "node:assert/strict";
import {
  decide,
  inspectPendingToolCall,
  appendReminderToLastToolResult,
  normalizeConfig,
  textOf,
  DEFAULT_REMINDER_TEXT,
} from "../lib/guard-core.js";

let pass = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  FAIL ${name}`);
    console.log(`       ${e?.message || e}`);
  }
}

const asst = (blocks) => ({ role: "assistant", content: blocks });
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const toolResult = (name) => ({ role: "toolResult", toolName: name, content: [{ type: "text", text: "ok" }] });
const think = (t) => ({ type: "thinking", text: t });
const say = (t) => ({ type: "text", text: t });
const call = (name) => ({ type: "toolCall", name, id: `c_${name}` });

console.log("\n[textOf]");

test("只取 text 块，thinking 不算说话", () => {
  assert.equal(textOf([think("我在想"), say("好")]), "好");
});

test("thinking-only 的文本是空", () => {
  assert.equal(textOf([think("想了很久")]), "");
});

test("空白文本不算说话", () => {
  assert.equal(textOf([say("   \n  ")]).trim(), "");
});

console.log("\n[inspectPendingToolCall]");

test("只有工具调用没有正文 → pending", () => {
  const r = inspectPendingToolCall([user("做点事"), asst([think("嗯"), call("read")])]);
  assert.equal(r.pending, true);
  assert.deepEqual(r.toolNames, ["read"]);
});

test("工具调用带正文 → 不算 pending", () => {
  const r = inspectPendingToolCall([user("做点事"), asst([say("我先看看文件"), call("read")])]);
  assert.equal(r.pending, false);
});

test("最后一条 assistant 没有工具调用 → 不算 pending", () => {
  const r = inspectPendingToolCall([user("问个事"), asst([say("答案是这样")])]);
  assert.equal(r.pending, false);
});

test("中间的旧工具调用不影响判断（只看最后一条 assistant）", () => {
  const r = inspectPendingToolCall([
    user("做点事"),
    asst([call("grep")]),
    toolResult("grep"),
    asst([say("找到了，接下来写文件"), call("write")]),
  ]);
  assert.equal(r.pending, false);
});

test("多次连续工具调用且从未说话 → pending，且能报出工具名", () => {
  const r = inspectPendingToolCall([
    user("做点事"),
    asst([call("ls")]),
    toolResult("ls"),
    asst([call("read")]),
    toolResult("read"),
    asst([call("grep")]),
  ]);
  assert.equal(r.pending, true);
  assert.deepEqual(r.toolNames, ["grep"]);
});

test("空数组 → 不 pending", () => {
  assert.equal(inspectPendingToolCall([]).pending, false);
});

test("宿主落盘的 {message:{role,content}} 包装形状也能认", () => {
  const r = inspectPendingToolCall([
    { type: "message", message: { role: "assistant", content: [call("read")] } },
  ]);
  assert.equal(r.pending, true);
});

console.log("\n[挂进 toolResult，而不是新增消息]");

test("提醒追加到最后那条 toolResult 的 content 里", () => {
  const msgs = [user("做点事"), asst([call("read")]), toolResult("read")];
  const r = appendReminderToLastToolResult(msgs, "提醒内容");
  assert.equal(r.appended, true);
  assert.equal(r.messages.length, msgs.length, "数组长度不能变——不新增消息");
  const last = r.messages[r.messages.length - 1];
  assert.equal(last.role, "toolResult");
  assert.equal(last.content.length, 2, "原 content 块 + 提醒块");
  assert.ok(textOf(last.content).includes("提醒内容"));
});

test("不新增任何 user / system 消息", () => {
  const msgs = [user("做点事"), asst([call("read")]), toolResult("read")];
  const r = appendReminderToLastToolResult(msgs, "提醒");
  const roles = r.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "toolResult"], "角色序列必须原样不变");
});

test("原数组不被改动", () => {
  const msgs = [user("做点事"), asst([call("read")]), toolResult("read")];
  const before = JSON.stringify(msgs);
  appendReminderToLastToolResult(msgs, "提醒");
  assert.equal(JSON.stringify(msgs), before, "必须返回新数组，不能就地改");
});

test("兼容宿主包装形状 {type, message}", () => {
  const msgs = [
    { type: "message", message: user("做点事") },
    { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] } },
  ];
  const r = appendReminderToLastToolResult(msgs, "提醒");
  assert.equal(r.appended, true);
  assert.equal(r.messages[1].message.content.length, 2, "包装形状里也要挂上");
  assert.equal(r.messages[1].type, "message", "外层字段不能丢");
});

test("没有 toolResult 时不动数组", () => {
  const msgs = [user("问个事"), asst([say("直接回答")])];
  const r = appendReminderToLastToolResult(msgs, "提醒");
  assert.equal(r.appended, false);
  assert.equal(r.messages.length, msgs.length);
});

test("提醒里不夹带任何不可见标记字符", () => {
  const msgs = [user("做点事"), asst([call("read")]), toolResult("read")];
  const r = appendReminderToLastToolResult(msgs, "提醒内容");
  const text = textOf(r.messages[r.messages.length - 1].content);
  assert.ok(!text.includes("\u2063"), "标记已无用途，不该再占用字符");
});

console.log("\n[默认文案契约]");

test("默认文案用 XML 标签包裹", () => {
  assert.ok(DEFAULT_REMINDER_TEXT.includes("<system-reminder"), "缺开标签");
  assert.ok(DEFAULT_REMINDER_TEXT.includes("</system-reminder>"), "缺闭标签");
});

test("默认文案不再用自然语言解释「这是系统提醒」", () => {
  assert.ok(
    !DEFAULT_REMINDER_TEXT.includes("这是系统提醒"),
    "标签已声明来源，再解释一遍是多余且可疑的",
  );
});

test("默认文案保留 {tools} 占位符", () => {
  assert.ok(DEFAULT_REMINDER_TEXT.includes("{tools}"));
});

test("默认文案不含已删除的 {n} / {max} 占位符", () => {
  assert.ok(!DEFAULT_REMINDER_TEXT.includes("{n}"), "次数上限已移除");
  assert.ok(!DEFAULT_REMINDER_TEXT.includes("{max}"), "次数上限已移除");
});

console.log("\n[decide]");

test("命中时返回改好的数组，长度不变", () => {
  const msgs = [user("做点事"), asst([call("read")]), toolResult("read")];
  const r = decide(msgs, { enabled: true, reminderText: DEFAULT_REMINDER_TEXT });
  assert.equal(r.action, "remind");
  assert.equal(r.messages.length, msgs.length, "不新增消息");
  assert.ok(textOf(r.messages[r.messages.length - 1].content).includes("system-reminder"));
});

test("提醒文案里的 {tools} 被替换成真实工具名", () => {
  const msgs = [user("做点事"), asst([call("grep")]), toolResult("grep")];
  const r = decide(msgs, { enabled: true, reminderText: "你刚调用了 {tools}" });
  const text = textOf(r.messages[r.messages.length - 1].content);
  assert.ok(text.includes("grep"), `期望含 grep，实际：${text}`);
});

test("没有次数上限：连续多次调用都会提醒", () => {
  // 模拟同一回合里连续 8 次「调工具不说话」
  let msgs = [user("做点事")];
  let reminders = 0;
  for (let i = 0; i < 8; i += 1) {
    msgs = [...msgs, asst([call(`tool${i}`)]), toolResult(`tool${i}`)];
    const r = decide(msgs, { enabled: true, reminderText: DEFAULT_REMINDER_TEXT });
    assert.equal(r.action, "remind", `第 ${i + 1} 次应当提醒，却被放行了`);
    msgs = r.messages;
    reminders += 1;
  }
  assert.equal(reminders, 8, "每一次都该提醒，不能中途静默放行");
});

test("关闭时完全不干预", () => {
  const r = decide([user("做点事"), asst([call("read")])], { enabled: false });
  assert.equal(r.action, "skip");
  assert.equal(r.reason, "disabled");
});

test("模型说过话时返回 skip", () => {
  const r = decide([user("问个事"), asst([say("答案")])], { enabled: true });
  assert.equal(r.action, "skip");
});

console.log("\n[normalizeConfig]");

test("空配置走默认值", () => {
  const c = normalizeConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.reminderText, DEFAULT_REMINDER_TEXT);
});

test("配置里不再有次数上限字段", () => {
  const c = normalizeConfig({ maxPerTurn: 99 });
  assert.equal(c.maxPerTurn, undefined, "上限已移除，旧配置不该再被读出来");
});

test("空文案回落到默认文案", () => {
  assert.equal(normalizeConfig({ reminderText: "   " }).reminderText, DEFAULT_REMINDER_TEXT);
});

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} 个用例失败，${pass} 个通过`);
  for (const f of failures) {
    console.error(`\n--- ${f.name}\n${f.error?.stack || f.error}`);
  }
  process.exit(1);
}
console.log(`全部通过：${pass} 个用例`);
