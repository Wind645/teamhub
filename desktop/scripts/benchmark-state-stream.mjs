// Real Electron IPC + DOM measurement. Uses isolated data and synthetic events;
// never opens user sessions or calls a model. Pass old and new unpacked dirs.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { _electron, expect } from "@playwright/test";

const dirs = process.argv.slice(2);
assert.equal(dirs.length, 2);
const temp = await mkdtemp(join(tmpdir(), "teamhub-live-benchmark-"));
const moduleFile = join(temp, "publisher.cjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/state-stream.ts", import.meta.url))], outfile: moduleFile,
  bundle: true, platform: "node", format: "cjs" });
for (const [version, dir] of dirs.entries()) {
  const env = { ...process.env, TEAMHUB_DESKTOP_DATA: await mkdtemp(join(temp, "data-")) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT;
  const app = await _electron.launch({ executablePath: resolve(dir, "TeamHub.exe"), env, timeout: 20000 });
  const pages = [], errors = [];
  try {
    for (const peer of ["latency-a", "latency-b", "latency-c"]) {
      if (pages.length) await pages.at(-1).evaluate(() => window.teamhub.memberPicker());
      await expect.poll(() => app.windows().some(p => p.url().includes("view=members"))).toBe(true);
      const picker = app.windows().find(p => p.url().includes("view=members"));
      await picker.getByRole("textbox", { name: "成员 ID" }).fill(peer);
      const opened = app.waitForEvent("window");
      await picker.getByRole("button", { name: "打开成员窗口" }).click();
      const page = await opened;
      page.on("pageerror", e => errors.push(e.message));
      await expect(page.locator(".topbar-title strong")).toHaveText(peer);
      await page.evaluate(() => {
        window.lags = []; window.seen = new Set();
        new MutationObserver(() => {
          for (const node of document.querySelectorAll(".notice")) {
            const match = node.textContent.match(/LIVE-(\d+)-(\d+)/);
            if (match && !window.seen.has(match[0])) { window.seen.add(match[0]); window.lags.push(Date.now() - Number(match[1])); }
          }
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      pages.push(page);
    }
    const snapshots = await Promise.all(pages.map(page => page.evaluate(() => window.teamhub.state())));
    await app.evaluate(({ BrowserWindow, ipcMain }, { snapshots, moduleFile, version }) => {
      const { StatePublisher } = process.mainModule.require(moduleFile);
      const publisher = new StatePublisher();
      publisher.revision = 100000; // distinct from the app's own initial snapshot
      const targets = snapshots.map(s => {
        const wc = BrowserWindow.getAllWindows().find(w => w.getTitle().includes(s.peer)).webContents;
        s.active = "fixture";
        s.conversations = [{ id: "group", members: [{ id: "fixture", cwd: "benchmark", peer: s.peer, approvalMode: "request" }] }];
        const events = [{ seq: 1, type: "status", data: "running", turn: "t" }];
        for (let i = 0; i < 300; i++) {
          events.push({ seq: events.length + 1, type: "request", turn: "t", data: { request: i, call: { id: `c${i}`, name: "Bash", args: { command: `echo ${i}` } } } });
          events.push({ seq: events.length + 1, type: "result", turn: "t", data: { request: i, result: { ok: true, value: "x".repeat(8000) } } });
        }
        s.sessions = { fixture: { phase: "ready", events } };
        return { wc, s };
      });
      ipcMain.on("teamhub:ack-state", (event, revision) => publisher.ack(event.sender, revision));
      let bytes = 0, packets = 0;
      for (const { wc, s } of targets) {
        const original = wc.send.bind(wc);
        wc.send = (channel, payload) => {
          if (channel === "teamhub:live-state" || channel === "teamhub:state") { bytes += Buffer.byteLength(JSON.stringify(payload)); packets++; }
          return original(channel, payload);
        };
        if (version) publisher.watch(wc, () => s);
        else wc.send("teamhub:state", s);
      }
      globalThis.liveBenchmark = { targets, publisher, stats: () => ({ bytes, packets }), version };
    }, { snapshots, moduleFile, version });
    for (const page of pages) await expect(page.locator(".tool")).toHaveCount(80);
    await app.evaluate(() => {
      const fixture = globalThis.liveBenchmark;
      let tick = 0, lastSent = 0;
      fixture.timer = setInterval(() => {
        const now = Date.now(); tick++;
        for (const { wc, s } of fixture.targets) {
          const events = s.sessions.fixture.events;
          events.push({ seq: events.length + 1, turn: "t", type: "notice", data: `LIVE-${now}-${tick}` });
          if (tick === 100) events.push({ seq: events.length + 1, turn: "t", type: "status", data: "completed" });
          if (tick === 100 || now - lastSent >= (fixture.version ? 16 : 100)) {
            if (fixture.version) fixture.publisher.publish(wc, () => s);
            else wc.send("teamhub:state", s);
          }
        }
        if (now - lastSent >= (fixture.version ? 16 : 100)) lastSent = now;
        if (tick === 100) { clearInterval(fixture.timer); fixture.finishedAt = now; }
      }, 10);
    });
    // Typing must remain usable while all three windows receive progress.
    await pages[2].getByRole("textbox", { name: "任务" }).fill("typing remains responsive");
    for (const page of pages) await expect(page.locator(".composer-area .status")).toContainText("已完成", { timeout: 15000 });
    const metrics = await app.evaluate(() => ({ ...globalThis.liveBenchmark.stats(), finishedAt: globalThis.liveBenchmark.finishedAt }));
    const lags = (await Promise.all(pages.map(page => page.evaluate(() => window.lags)))).flat().sort((a, b) => a - b);
    assert.ok(lags.length >= 200, "all three views must display progress");
    assert.deepEqual(errors, []);
    const result = { version: version ? "incremental" : "previous", ...metrics, finishedAt: undefined,
      samples: lags.length, medianMs: lags[Math.floor(lags.length / 2)], p95Ms: lags[Math.floor(lags.length * .95)], maxMs: lags.at(-1) };
    console.log(JSON.stringify(result));
    if (version) {
      assert.ok(result.p95Ms < 1000, "representative local updates should not lag by seconds");
      // Approval arriving while a window is minimized must appear on restore.
      await (await app.browserWindow(pages[0])).evaluate(win => win.minimize());
      await app.evaluate(() => {
        const { targets, publisher } = globalThis.liveBenchmark;
        const { wc, s } = targets[0], state = s.sessions.fixture;
        state.pending = { request: 999, turn: "next", callId: "approval", name: "Bash", args: { command: "echo approval" } };
        state.events.push({ seq: state.events.length + 1, turn: "next", type: "request", data: { request: 999, call: { id: "approval", name: "Bash", args: { command: "echo approval" } } } });
        publisher.publish(wc, () => s);
      });
      await (await app.browserWindow(pages[0])).evaluate(win => win.restore());
      await expect(pages[0].getByRole("button", { name: "允许一次", exact: true })).toBeVisible();
      await expect(pages[2].getByRole("textbox", { name: "任务" })).toHaveValue("typing remains responsive");
    }
  } finally { await app.close(); }
}
