import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, expect } from "@playwright/test";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const exe = process.env.TEAMHUB_TEST_EXE;
const workerPath = exe ? join(dirname(exe), "resources/runtime/worker.cjs") : join(root, "build/runtime/worker.cjs");

test("desktop auto-pause switch saves, survives relaunch and stays per-member", { timeout: 60000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), "teamhub-budget-ui-"));
  const env = { ...process.env, TEAMHUB_DESKTOP_DATA: data };
  delete env.NODE_TEST_CONTEXT;
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath: exe, args: exe ? [] : [root], env });
  let app = await launch();
  const openMember = async peer => {
    await expect.poll(() => app.windows().some(p => p.url().includes("view=members"))).toBe(true);
    const picker = app.windows().find(p => p.url().includes("view=members"));
    await picker.getByRole("textbox", { name: "成员 ID" }).fill(peer);
    const opened = app.waitForEvent("window");
    await picker.getByRole("button", { name: "打开成员窗口" }).click();
    const page = await opened;
    await expect(page.locator(".topbar-title strong")).toHaveText(peer);
    return page;
  };
  const setting = page => page.getByRole("switch", { name: "达到运行上限后自动暂停" });
  try {
    let page = await openMember("budget-alice");
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await expect(setting(page)).toBeChecked();
    await setting(page).uncheck();
    await expect(setting(page)).not.toBeChecked();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator("dialog")).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.teamhub.state())).profile.config.autoPause, false);
    await app.close();
    app = await launch();
    page = await openMember("budget-alice");
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await expect(setting(page)).not.toBeChecked();
    await setting(page).check();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator("dialog")).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.teamhub.state())).profile.config.autoPause, true);
    // Leave Alice disabled so a default-on Bob proves member isolation.
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await setting(page).uncheck();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator("dialog")).toHaveCount(0);
    await page.evaluate(() => window.teamhub.memberPicker());
    const bob = await openMember("budget-bob");
    await bob.getByRole("button", { name: "模型设置", exact: true }).click();
    await expect(setting(bob)).toBeChecked();
  } finally { await app.close(); }
});

test("actual desktop worker respects both budget modes using a local model fixture", { timeout: 30000 }, async () => {
  for (const autoPause of [true, false]) {
    const cwd = await mkdtemp(join(tmpdir(), "teamhub-budget-worker-"));
    await writeFile(join(cwd, "value.txt"), "fixture");
    let calls = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* drain request */ }
      calls++;
      const message = calls <= 18 ? { content: null, tool_calls: [{
        id: `read-${calls}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "value.txt" }) },
      }] } : { content: "done" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }] }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const proc = fork(workerPath, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    const messages = [];
    let stderr = "";
    proc.stderr.on("data", data => { stderr += data; });
    proc.on("message", message => messages.push(message));
    const wait = async predicate => {
      await expect.poll(() => {
        const fatal = messages.find(m => m.type === "fatal");
        if (fatal) throw new Error(JSON.stringify(fatal));
        return messages.some(predicate);
      }, { timeout: 15000, message: stderr }).toBe(true);
      return messages.find(predicate);
    };
    try {
      proc.send({ type: "init", member: { id: "budget-session", cwd }, directory: join(cwd, "sessions"), exists: false,
        profile: { mode: "model", externalHub: "", config: { autoPause, steps: 1, turnTimeout: autoPause ? 10000 : 1,
          model: { name: "fixture", endpoint: `http://127.0.0.1:${server.address().port}`, protocol: "chat", keyEnv: "FIXTURE_KEY" } } },
        key: "local-fixture", hookPath: "unused" });
      await wait(m => m.type === "ready");
      proc.send({ type: "command", id: 1, command: { type: "submit", text: "read fixture" } });
      await wait(m => m.type === "event" && m.event.type === "status" && m.event.data === (autoPause ? "paused" : "completed"));
      assert.equal(calls, autoPause ? 1 : 19);
    } finally {
      if (proc.connected) proc.send({ type: "command", id: 2, command: { type: "close" } });
      const timer = setTimeout(() => proc.kill(), 3000);
      if (proc.exitCode === null) await once(proc, "exit");
      clearTimeout(timer);
      await new Promise(resolve => server.close(resolve));
    }
  }
});
