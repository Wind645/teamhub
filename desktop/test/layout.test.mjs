import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import asar from "@electron/asar";
import { chromium, expect } from "@playwright/test";

test("long conversations stay inside the window with a visible composer and independent scrolling", { timeout: 30000 }, async () => {
  const archive = resolve(process.env.TEAMHUB_LAYOUT_DIR ?? "desktop/release/win-unpacked-layout-20261126", "resources/app.asar");
  const server = createServer((request, response) => {
    try {
      const parts = request.url.split("?")[0].split("/").filter(Boolean);
      assert.ok(!parts.includes(".."));
      const file = join("build", "ui", ...(parts.length ? parts : ["index.html"]));
      response.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      response.end(asar.extractFile(archive, file));
    } catch { response.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const events = [{ seq: 1, turn: "t", type: "user", data: "布局测试" }];
      const sessions = { active: { phase: "ready", events } };
      const conversations = [{ id: "group", members: [{ id: "active", cwd: "demo", peer: "layout", approvalMode: "request" }] }];
      for (let i = 0; i < 80; i++) {
        const id = `old-${i}`;
        sessions[id] = { phase: "idle", events: [{ seq: 1, type: "user", data: `历史任务 ${i}` }] };
        conversations.push({ id, members: [{ id, cwd: `project-${i}`, peer: "layout" }] });
      }
      window.fixture = { peer: "layout", profile: { mode: "offline", config: {} }, school: {}, active: "active", conversations, sessions };
      window.teamhub = { state: async () => window.fixture, subscribe: callback => { window.pushSnapshot = callback; return () => {}; } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await expect(page.getByRole("textbox", { name: "任务" })).toBeVisible();
    const geometry = () => page.evaluate(() => {
      const composer = document.querySelector(".composer-area").getBoundingClientRect();
      const box = document.querySelector(".timeline-scroll");
      return { page: document.documentElement.scrollHeight, viewport: innerHeight,
        composerTop: composer.top, composerBottom: composer.bottom, historyHeight: box.clientHeight,
        historyScroll: box.scrollHeight, sidebarScroll: document.querySelector(".workspace-list").scrollHeight };
    });
    for (const size of [{ width: 1280, height: 720 }, { width: 900, height: 620 }, { width: 680, height: 500 }]) {
      await page.setViewportSize(size);
      await page.evaluate(width => {
        const id = `active-${width}`;
        window.fixture = { ...window.fixture, active: id, conversations: window.fixture.conversations.map((group, index) =>
          index ? group : { ...group, members: group.members.map(member => ({ ...member, id })) }) };
      }, size.width);
      for (const count of [1, 50, 180]) {
        await page.evaluate(count => {
          const events = Array.from({ length: count }, (_, i) => ({ seq: i + 1, turn: "t", type: "final",
            data: `回复 ${i}\n\n` + "长内容测试，需要在聊天区域滚动。\n".repeat(25) }));
          window.pushSnapshot({ ...window.fixture, sessions: { ...window.fixture.sessions, [window.fixture.active]: { phase: "ready", events } } });
        }, count);
        await expect(page.locator(".assistant-message").last()).toContainText(`回复 ${count - 1}`);
        const box = await geometry();
        assert.ok(box.page <= box.viewport + 1, JSON.stringify({ size, count, ...box }));
        assert.ok(box.composerBottom <= size.height + 1 && box.composerTop >= 0, "composer must stay within the viewport");
        assert.ok(box.historyHeight > 0, "history area must remain visible");
        if (count > 1) assert.ok(box.historyScroll > box.historyHeight, "history scrolls internally");
      }
      const before = await geometry();
      await page.getByRole("button", { name: /查看更早的消息/ }).click();
      await expect(page.locator(".assistant-message")).toHaveCount(160);
      const after = await geometry();
      assert.equal(after.page, before.page);
      assert.equal(after.composerBottom, before.composerBottom);
      if (size.width > 760) {
        await page.locator(".workspace-list .session-button").last().scrollIntoViewIfNeeded();
        const sidebar = await page.locator(".workspace-list").evaluate(box => ({ height: box.clientHeight, scroll: box.scrollHeight, top: box.scrollTop }));
        assert.ok(sidebar.height > 0 && sidebar.scroll > sidebar.height && sidebar.top > 0, "sidebar scrolls without growing the page");
      }
      await page.evaluate(() => {
        const events = [{ seq: 1, turn: "stream", type: "status", data: "running" },
          { seq: 2, turn: "stream", type: "assistant_output", data: { id: "s", type: "delta", kind: "text", text: "正在输出一行内容\n".repeat(500) } }];
        window.pushSnapshot({ ...window.fixture, sessions: { ...window.fixture.sessions, [window.fixture.active]: { phase: "ready", events } } });
      });
      await expect(page.locator(".live-text")).toBeVisible();
      const streaming = await geometry();
      assert.ok(streaming.page <= size.height + 1 && streaming.composerBottom <= size.height + 1);
      assert.ok(streaming.historyScroll > streaming.historyHeight);
      await page.getByRole("textbox", { name: "任务" }).fill("输入框仍然可用");
      await expect(page.getByRole("textbox", { name: "任务" })).toHaveValue("输入框仍然可用");
      // Settings must retain its own scrollbar, including the save button.
      await page.getByRole("button", { name: "模型设置", exact: true }).click();
      await page.getByRole("button", { name: "保存设置", exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "保存设置", exact: true })).toBeInViewport();
      await page.getByRole("button", { name: "关闭", exact: true }).click();
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
