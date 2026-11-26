import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "teamhub-ui-health-"));
const file = join(dir, "health.cjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/ui-health.ts", import.meta.url))],
  outfile: file, platform: "node", format: "cjs", bundle: true });
const { coalesceUpdates, protectRenderer } = createRequire(import.meta.url)(file);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("stream bursts coalesce per member without losing final status or pending approval", async () => {
  const states = { alice: "running", bob: "running", carol: "running" };
  const sent = [];
  const publish = coalesceUpdates(key => sent.push([key, states[key]]), 10);
  for (let i = 0; i < 10000; i++) for (const key of Object.keys(states)) publish(key);
  states.alice = "paused";
  states.bob = "pending";
  states.carol = "completed";
  await wait(30);
  assert.deepEqual(sent, [["alice", "paused"], ["bob", "pending"], ["carol", "completed"]]);
  states.alice = "running";
  publish("alice");
  await wait(30);
  assert.deepEqual(sent.at(-1), ["alice", "running"]);
});

test("renderer crash logs cause and reloads only the view when requested", async () => {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.id = 7;
  window.isDestroyed = () => false;
  let reloads = 0;
  window.webContents.reload = () => reloads++;
  protectRenderer(window, { showMessageBox: async () => ({ response: 0 }) }, dir);
  window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  await wait(0);
  assert.equal(reloads, 1);
  const log = JSON.parse((await readFile(join(dir, "renderer-health.jsonl"), "utf8")).trim());
  assert.equal(log.reason, "crashed");
  assert.equal(log.exitCode, 1);
  window.webContents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
  await wait(0);
  assert.equal(reloads, 1);
});
