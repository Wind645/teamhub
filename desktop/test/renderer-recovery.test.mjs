import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, expect } from "@playwright/test";

test("timeline survives bursts, pause and approval; rendering errors offer reload", { timeout: 60000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), "teamhub-renderer-test-"));
  const executablePath = process.env.TEAMHUB_TEST_EXE;
  const env = { ...process.env, TEAMHUB_DESKTOP_DATA: data };
  delete env.NODE_TEST_CONTEXT;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath,
    args: executablePath ? [] : [resolve(fileURLToPath(new URL("../", import.meta.url)))], env });
  try {
    const picker = await app.firstWindow();
    await picker.getByRole("textbox", { name: "成员 ID" }).fill("repro");
    const opened = app.waitForEvent("window");
    await picker.getByRole("button", { name: "打开成员窗口" }).click();
    const page = await opened;
    await expect(page.locator(".topbar-title strong")).toHaveText("repro");
    const snapshot = await page.evaluate(() => window.teamhub.state());
    snapshot.active = "fixture";
    snapshot.conversations = [{ id: "group", created: 0, members: [{ id: "fixture", cwd: data, peer: "repro", approvalMode: "full" }] }];
    const events = [{ seq: 1, at: 0, type: "user", data: "测试连续输出" }];
    for (let seq = 2; seq <= 502; seq++) events.push({ seq, at: 0, turn: "t1", type: "assistant_output", data: { id: "m1", type: "delta", kind: "text", text: "片段 " } });
    events.push({ seq: 503, at: 0, turn: "t1", type: "assistant", data: { text: "流式输出完成", streamedText: true, calls: [] } },
      { seq: 504, at: 0, type: "notice", data: "Model step budget reached. Use /resume to continue." },
      { seq: 505, at: 0, type: "status", data: "paused" });
    snapshot.sessions = { fixture: { phase: "ready", events } };
    const send = async value => app.evaluate(({ BrowserWindow }, state) => {
      BrowserWindow.getAllWindows().find(w => w.getTitle().includes("repro")).webContents.send("teamhub:state", state);
    }, value);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await send(snapshot);
    await expect(page.getByRole("button", { name: "继续此回合", exact: true })).toBeVisible();
    // A pending request must remain visible after the same long history.
    events.push({ seq: 506, at: 0, turn: "t2", type: "resume", data: null },
      { seq: 507, at: 0, turn: "t2", type: "status", data: "running" },
      { seq: 508, at: 0, turn: "t2", type: "request", data: { request: 1, call: { id: "call1", name: "Bash", args: { command: "node -v" } } } });
    snapshot.sessions.fixture.pending = { turn: "t2", request: 1, callId: "call1", name: "Bash", args: { command: "node -v" } };
    await send(snapshot);
    await expect(page.getByRole("button", { name: "允许一次", exact: true })).toBeVisible();
    delete snapshot.sessions.fixture.pending;
    events.push({ seq: 509, at: 0, turn: "t2", type: "result", data: { request: 1, result: { ok: true, value: "v24" } } },
      { seq: 510, at: 0, type: "final", data: "验证结束" },
      { seq: 511, at: 0, type: "status", data: "completed" });
    await send(snapshot);
    await expect(page.getByText("验证结束", { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    // An unexpected render-time shape used to unmount the entire root silently.
    await send({ ...snapshot, conversations: [{ id: "bad", members: [] }] });
    await expect(page.getByRole("heading", { name: "界面显示遇到错误" })).toBeVisible();
    await page.getByRole("button", { name: "重新加载界面", exact: true }).click();
    await expect(page.locator(".topbar-title strong")).toHaveText("repro");
    await expect(page.locator(".renderer-recovery")).toHaveCount(0);
    // Fixture snapshots never go to disk or submit a model/tool task.
    const restored = await page.evaluate(() => window.teamhub.state());
    assert.equal(restored.conversations.length, 0);
    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
      BrowserWindow.getAllWindows().find(w => w.getTitle().includes("repro")).webContents.forcefullyCrashRenderer();
    });
    await expect.poll(async () => {
      const log = await readFile(join(data, "renderer-health.jsonl"), "utf8").catch(() => "");
      return log.includes('"type":"render-process-gone"');
    }).toBe(true);
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows().find(w => w.getTitle().includes("repro"))?.webContents;
      if (!contents || contents.isLoading() || contents.isCrashed()) return "";
      return contents.executeJavaScript('document.querySelector(".topbar-title strong")?.textContent').catch(() => "");
    })).toBe("repro");
  } finally { await app.close(); }
});
