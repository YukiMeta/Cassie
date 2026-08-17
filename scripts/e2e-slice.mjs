#!/usr/bin/env node
/**
 * E2E 垂直切片验证（CDP 驱动 headless Chrome）：
 * 载入演示项目 → 全生命期替换 → 计划 → 提交 → 画面变磨砂银 → 撤销 → 提前露出 → 生命周期 2.0s。
 * 验收：Cassie 发出的语义修改，确定性地改变真实时间线，且撤销成立。
 */
import { spawn } from "node:child_process";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    // 每次运行全新 profile：自动保存不跨运行污染
    `--user-data-dir=/tmp/cassie-e2e-profile-${process.pid}`,
    "--window-size=1728,1080",
    "http://localhost:5199/?demo=1",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome 尚未就绪 */
    }
    await sleep(500);
  }
  throw new Error("CDP 目标未就绪");
}

const wsUrl = await getTarget();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evalJS(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}

let failures = 0;
const assert = (cond, msg, detail = "") => {
  if (cond) console.log(`✓ ${msg}`);
  else {
    failures++;
    console.error(`✗ ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

try {
  // 等待编辑器就绪
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evalJS(`!!document.querySelector(".app")`);
    if (ready) break;
    await sleep(500);
  }
  assert(ready, "演示项目载入，编辑器渲染");

  // 1. 初始外观：玻璃紫瓶（playhead 8s 处顶层 clip = 香水瓶）
  await sleep(1200);
  let filter = await evalJS(`document.querySelector(".stage-video")?.style.filter`);
  assert(filter?.includes("hue-rotate(-8deg)"), "初始外观滤镜 = glass_violet", filter);

  // 2. 快速指令：全生命期替换 → 生成计划
  await evalJS(`document.querySelectorAll(".quick-prompts button")[1].click()`);
  await evalJS(`document.querySelector(".plan-btn").click()`);
  await sleep(900);
  const status1 = await evalJS(`document.querySelector(".agent-status")?.textContent`);
  assert(status1 === "PLANNED", "计划生成（PLANNED）", status1);
  const impactTags = await evalJS(`[...document.querySelectorAll(".impact-tag")].map(x => x.textContent).join(",")`);
  assert(
    impactTags.includes("CHANGE") && impactTags.includes("RECHECK") && impactTags.includes("REFLOW"),
    "影响分析渲染：主状态/关系/构图",
    impactTags,
  );

  // 3. 提交 → 画面变磨砂银
  await evalJS(`document.querySelector(".execute-btn").click()`);
  await sleep(900);
  const status2 = await evalJS(`document.querySelector(".agent-status")?.textContent`);
  assert(status2 === "已提交", "事务提交（COMMITTED）", status2);
  filter = await evalJS(`document.querySelector(".stage-video")?.style.filter`);
  assert(filter?.includes("saturate(0.2)"), "提交后画面 = matte_silver", filter);

  // 4. ⌘Z 撤销 → 回到玻璃紫
  await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
  await sleep(600);
  filter = await evalJS(`document.querySelector(".stage-video")?.style.filter`);
  assert(filter?.includes("hue-rotate(-8deg)"), "⌘Z 撤销后回到 glass_violet", filter);

  // 5. 提前露出：生命周期 4.0→15.0 变 2.0→13.0
  await evalJS(`document.querySelectorAll(".quick-prompts button")[2].click()`);
  await evalJS(`document.querySelector(".plan-btn").click()`);
  await sleep(900);
  await evalJS(`document.querySelector(".execute-btn").click()`);
  await sleep(900);
  const tracks = await evalJS(`[...document.querySelectorAll(".semantic-track .track-label small")].map(x => x.textContent).join(" | ")`);
  assert(tracks?.includes("2.0s—13.0s"), "语义轨：香水瓶生命周期 2.0s—13.0s", tracks);
  const readout = await evalJS(`document.querySelector(".selection-readout")?.textContent`);
  console.log(`  时间线读值: ${readout}`);

  // 6. 硬锁阻断：锁定商品后编译失败
  await evalJS(`document.querySelector(".asset-card .lock-btn").click()`);
  await sleep(300);
  await evalJS(`document.querySelector(".plan-btn").click()`);
  await sleep(900);
  const failed = await evalJS(`document.querySelector(".agent-status")?.textContent`);
  assert(failed === "需要修正" || failed === "FAILED", "硬锁阻断：锁定主体后编译失败", failed);
  await evalJS(`document.querySelector(".asset-card .lock-btn").click()`);
  await sleep(300);

  // ---------- 交互逻辑排查 ----------

  const rectOf = async (selector) =>
    await evalJS(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const mouse = (type, x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  const dragMouse = async (from, to, steps = 8) => {
    await mouse("mousePressed", from.x, from.y, { buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1 });
      await sleep(30);
    }
    await mouse("mouseReleased", to.x, to.y);
    await sleep(400);
  };

  // 7. 舞台缩放：＋/－/适应
  const zoomBtn = await rectOf(".stage-toolbar .tool-group:last-child .tool-btn:last-child");
  await mouse("mousePressed", zoomBtn.x + zoomBtn.w / 2, zoomBtn.y + zoomBtn.h / 2);
  await mouse("mouseReleased", zoomBtn.x + zoomBtn.w / 2, zoomBtn.y + zoomBtn.h / 2);
  await sleep(300);
  const zoomText = await evalJS(`document.querySelector(".stage-toolbar .zoom")?.textContent`);
  assert(zoomText?.includes("125"), "舞台放大 + → 125%", zoomText);
  await evalJS(`document.querySelector(".stage-toolbar .zoom").click()`);
  await sleep(300);
  const zoomBack = await evalJS(`document.querySelector(".stage-toolbar .zoom")?.textContent`);
  assert(zoomBack?.includes("100"), "适应画布 → 100%", zoomBack);

  // 8. 安全框开关
  let safeVisible = await evalJS(`!!document.querySelector(".video-frame .safe-frame")`);
  await evalJS(`[...document.querySelectorAll(".stage-toolbar .tool-btn")].find(b => b.textContent.includes("安全框")).click()`);
  await sleep(300);
  let safeHidden = await evalJS(`!document.querySelector(".video-frame .safe-frame")`);
  assert(safeVisible && safeHidden, "安全框开关：显示 → 隐藏");
  await evalJS(`[...document.querySelectorAll(".stage-toolbar .tool-btn")].find(b => b.textContent.includes("安全框")).click()`);
  await sleep(300);

  // 9. 时间线缩放
  const tlZoomBefore = await evalJS(`(() => { const el = document.querySelector(".timeline-clip"); return el ? parseFloat(el.style.width) : -1; })()`);
  await evalJS(`[...document.querySelectorAll(".timeline-tools .secondary-btn")].find(b => b.textContent.trim() === "＋").click()`);
  await sleep(400);
  const tlZoomAfter = await evalJS(`(() => { const el = document.querySelector(".timeline-clip"); return el ? parseFloat(el.style.width) : -1; })()`);
  assert(tlZoomBefore > 0 && Math.abs(tlZoomAfter - tlZoomBefore * 2) < 0.01, `时间线放大 2×：${tlZoomBefore.toFixed(1)}% → ${tlZoomAfter.toFixed(1)}%`);
  await evalJS(`[...document.querySelectorAll(".timeline-tools .secondary-btn")].find(b => b.textContent.trim() === "−").click()`);
  await sleep(300);

  // 10. 片段拖拽移动（2s）+ 撤销（用 clip 真实位置断言，selection-readout 依赖选中状态不可靠）
  const bottleStartUs = async () =>
    await evalJS(`(() => { const s = window.__cassie.getState(); const p = s.adapter.getProject(); const c = p.tracks.flatMap(t => t.clips).find(c => c.assetId && p.assets[c.assetId]?.name === "bottle.mp4"); return c ? c.startUs : -1; })()`);
  const startBefore = await bottleStartUs();
  const bottleClip = await rectOf(`.timeline-clip[data-clip-id]`);
  await dragMouse(
    { x: bottleClip.x + bottleClip.w / 2, y: bottleClip.y + bottleClip.h / 2 },
    { x: bottleClip.x + bottleClip.w / 2 + 100, y: bottleClip.y + bottleClip.h / 2 },
  );
  const startAfterDrag = await bottleStartUs();
  assert(startAfterDrag !== startBefore, `片段拖拽移动生效（${startBefore / 1e6}s → ${startAfterDrag / 1e6}s）`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
  await sleep(400);
  const startAfterUndo = await bottleStartUs();
  assert(startAfterUndo === startBefore, `⌘Z 撤销拖拽，回到原位（${startAfterUndo / 1e6}s）`);

  // 11. 空格播放/暂停
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await sleep(600);
  const playing = await evalJS(`document.querySelector(".play-btn")?.textContent`);
  assert(playing === "❚❚", "空格开始播放", playing);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await sleep(300);
  const paused = await evalJS(`document.querySelector(".play-btn")?.textContent`);
  assert(paused === "▶", "空格暂停", paused);

  // 12. 面板分隔条拖拽（左栏 +40px）
  const divider = await rectOf(".panel-divider.left");
  const colsBefore = await evalJS(`document.querySelector(".app")?.style.gridTemplateColumns`);
  await dragMouse({ x: divider.x + divider.w / 2, y: divider.y + 60 }, { x: divider.x + divider.w / 2 + 40, y: divider.y + 60 }, 6);
  const colsAfter = await evalJS(`document.querySelector(".app")?.style.gridTemplateColumns`);
  const wBefore = parseInt(colsBefore);
  const wAfter = parseInt(colsAfter);
  assert(!isNaN(wAfter) && wAfter - wBefore === 40, `面板拖拽调宽：${wBefore}px → ${wAfter}px`, colsAfter);
  // 拖回
  const divider2 = await rectOf(".panel-divider.left");
  await dragMouse({ x: divider2.x + divider2.w / 2, y: divider2.y + 60 }, { x: divider2.x + divider2.w / 2 - 40, y: divider2.y + 60 }, 6);
  await sleep(300);

  console.log(failures === 0 ? "\nE2E 垂直切片 + 交互排查 全部通过 ✅" : `\n${failures} 项失败 ❌`);
} finally {
  ws.close();
  chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
}
