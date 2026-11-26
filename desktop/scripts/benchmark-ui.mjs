// Offline, synthetic history only. Does not open real sessions or call models.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import asar from "@electron/asar";
import { chromium } from "@playwright/test";

const archives = process.argv.slice(2).map(dir => resolve(dir, "resources/app.asar"));
assert.equal(archives.length, 2, "Pass the previous and optimized unpacked app directories");
const server = createServer((request, response) => {
  try {
    const [, version, ...parts] = request.url.split("?")[0].split("/");
    const file = join("build", "ui", ...parts);
    assert.ok(!file.includes(".."));
    response.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    response.end(asar.extractFile(archives[Number(version)], file));
  } catch { response.writeHead(404).end(); }
}).listen(0, "127.0.0.1");
await new Promise(done => server.once("listening", done));
const browser = await chromium.launch({ channel: process.env.TEAMHUB_TEST_BROWSER_CHANNEL ?? "msedge", headless: true });
try {
  for (let version = 0; version < archives.length; version++) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const state = { peer: "benchmark", profile: { mode: "offline", config: {} }, school: {},
        conversations: [{ id: "group", members: [{ id: "fixture", cwd: "demo", peer: "benchmark", approvalMode: "full" }] }],
        active: "fixture", sessions: { fixture: { phase: "ready", events: [] } } };
      window.fixture = state;
      window.teamhub = { state: async () => state, subscribe: callback => { window.pushSnapshot = callback; return () => {}; }, command: async () => {} };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${version}/index.html`);
    await page.waitForFunction(() => window.pushSnapshot);
    const start = performance.now();
    const timings = await page.evaluate(async () => {
      const events = [];
      let seq = 0;
      for (let request = 1; request <= 300; request++) {
        events.push({ seq: ++seq, at: "", turn: "t", type: "request", data: { request, call: { id: `c${request}`, name: "Bash", args: { command: `echo task-${request}` } } } },
          { seq: ++seq, at: "", turn: "t", type: "result", data: { request, result: { ok: true, value: "synthetic-output ".repeat(1500) } } });
      }
      const times = [];
      for (let i = 0; i < 8; i++) {
        events.push({ seq: ++seq, at: "", type: "notice", data: `progress-${i}` });
        const t = performance.now();
        window.pushSnapshot({ ...window.fixture, sessions: { fixture: { phase: "ready", events: structuredClone(events) } } });
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        times.push(performance.now() - t);
      }
      window.historyEvents = events;
      return times;
    });
    const tools = await page.locator(".tool").count();
    const bodies = await page.locator(".tool-body").count();
    if (version === 1) {
      assert.ok(tools <= 80);
      assert.equal(bodies, 0, "Collapsed tool details must not be mounted");
      const before = tools;
      await page.getByRole("button", { name: /查看更早的消息/ }).click();
      assert.ok(await page.locator(".tool").count() > before);
      await page.locator(".tool > details > summary").last().click();
      await page.locator(".tool-body").waitFor();
      assert.equal(await page.locator(".tool-body").count(), 1);
      // Pending approvals outside the recent history must remain accessible.
      await page.evaluate(() => window.pushSnapshot({ ...window.fixture, sessions: { fixture: { phase: "ready", events: window.historyEvents,
        pending: { turn: "t", request: 1, callId: "c1", name: "Bash", args: { command: "echo task-1" } } } } }));
      await page.getByRole("button", { name: "允许一次", exact: true }).waitFor();
      assert.ok(await page.locator(".approval").innerText().then(text => text.includes("echo task-1")));
      // Rollback/replacement history can be shorter than the loaded anchor.
      await page.evaluate(() => {
        window.streamEvents = [
          { seq: 1, type: "status", data: "running" },
          { seq: 2, turn: "stream", type: "assistant_output", data: { id: "s1", kind: "text", type: "delta", text: "**streaming**" } },
        ];
        window.pushSnapshot({ ...window.fixture, sessions: { fixture: { phase: "ready", events: window.streamEvents } } });
      });
      await page.locator(".live-text").waitFor();
      assert.equal(await page.locator(".live-text").innerText(), "**streaming**");
      await page.evaluate(() => window.pushSnapshot({ ...window.fixture, sessions: { fixture: { phase: "ready", events: [
        ...window.streamEvents, { seq: 3, type: "status", data: "completed" },
      ] } } }));
      await page.locator(".markdown strong").waitFor();
      assert.equal(await page.locator(".live-text").count(), 0);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ version: version ? "optimized" : "previous", mountedTools: tools, mountedToolBodies: bodies,
      renderMs: timings.map(value => Math.round(value)), totalMs: Math.round(performance.now() - start) }));
    await page.close();
  }
} finally { await browser.close(); await new Promise(done => server.close(done)); }
