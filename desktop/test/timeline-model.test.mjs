import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { build, transform } from "esbuild";
import asar from "@electron/asar";

const dir = await mkdtemp(join(tmpdir(), "teamhub-timeline-"));
const file = join(dir, "timeline.cjs");
await build({ entryPoints: [fileURLToPath(new URL("../ui/timeline-model.ts", import.meta.url))],
  outfile: file, platform: "node", format: "cjs", bundle: true });
const { activeEvents, timelineRows, toolIndex } = createRequire(import.meta.url)(file);
// Compare directly with the distributed implementation, including its exact
// streaming/final deduplication behavior, rather than inventing new semantics.
const archive = fileURLToPath(new URL("../release/win-unpacked/resources/app.asar", import.meta.url));
const ui = (await transform(asar.extractFile(archive, join("build", "ui", "assets", "index-3zCRhiFA.js")).toString(), { format: "esm" })).code;
const legacyRows = new Function(`return (${ui.slice(ui.indexOf("function ph(e, t) {"), ui.indexOf("const te = window.teamhub"))})`)();
const legacyActive = new Function(`return (${ui.slice(ui.indexOf("function Cn(e) {"), ui.indexOf("function il("))})`)();
const make = () => {
  let seq = 0;
  return (type, data, turn = "t") => ({ seq: ++seq, at: 0, type, data, turn });
};

test("every incremental prefix matches original timeline including rollback, end, status, mixed chunks and finals", () => {
  const ev = make(), events = [ev("session", {}), ev("user", "task"), ev("status", "running")];
  for (let i = 0; i < 100; i++) {
    events.push(ev("model", {}));
    for (const kind of ["reasoning", "text"]) for (let j = 0; j < 3; j++) {
      events.push(ev("assistant_output", { type: "delta", id: `s${i}`, kind, text: `${i}:${j}` }));
    }
    events.push(ev("assistant_output", { type: "end", id: i % 2 ? `s${i}` : "different" }));
    events.push(ev("assistant", { text: "answer", streamedText: i % 2 === 0, calls: i % 3 ? [] : [{ id: "call" }] }));
    events.push(ev("final", "answer"));
    events.push(ev("request", { request: i }), ev("result", { request: i }));
    events.push(ev("status", "completed"));
    if (i % 7 === 0) events.push(ev("rollback", 2));
    events.push(ev("resume", "continue"), ev("notice", "notice"));
  }
  let oldRows, oldSerialized;
  for (let n = 1; n <= events.length; n++) {
    const input = events.slice(0, n);
    const active = activeEvents(input);
    assert.deepEqual(active, legacyActive(input));
    for (const running of [true, false, true]) {
      const rows = timelineRows(active, running);
      assert.deepEqual(rows, legacyRows(active, running));
      if (oldRows) assert.equal(JSON.stringify(oldRows), oldSerialized, "previous render must remain immutable");
      oldRows = rows; oldSerialized = JSON.stringify(rows);
    }
  }
  // Reopening from fresh parsed JSON must work even if sequence IDs repeat.
  const replacement = JSON.parse(JSON.stringify(events.slice(0, 14)));
  assert.deepEqual(timelineRows(activeEvents(replacement), true), legacyRows(legacyActive(replacement), true));
});

test("tool index shares unchanged maps but removes rolled-back results", () => {
  const ev = make(), first = ev("session", {}), result = ev("result", { request: 1 });
  const a = [first, result];
  const index = toolIndex(a);
  const b = [...a, ev("assistant_output", { id: "x", type: "delta", text: "hi", kind: "text" })];
  assert.equal(toolIndex(b), index);
  const c = [...b, ev("uncertain", { request: 2 })];
  assert.equal(toolIndex(c).uncertain.has(2), true);
  assert.equal(index.uncertain.has(2), false);
  const rolledBack = activeEvents([...c, ev("rollback", first.seq)]);
  assert.equal(toolIndex(rolledBack).results.size, 0);
  assert.equal(toolIndex(rolledBack).uncertain.size, 0);
});

test("long streaming history reducer benchmark", () => {
  const ev = make();
  const history = [ev("session", {}), ev("status", "running")];
  for (let i = 0; i < 50000; i++) history.push(ev("assistant_output", { id: "stream", type: "delta", kind: "text", text: "chunk " }));
  let events = history;
  const inputs = [];
  for (let i = 0; i < 100; i++) { events = [...events, ev("assistant_output", { id: "stream", type: "delta", kind: "text", text: "tail " })]; inputs.push(events); }
  const time = reducer => {
    const start = performance.now();
    let last;
    for (const input of inputs) last = reducer(input);
    return { ms: performance.now() - start, last };
  };
  const before = time(input => legacyRows(legacyActive(input), true));
  const after = time(input => timelineRows(activeEvents(input), true));
  assert.deepEqual(after.last, before.last);
  console.log(JSON.stringify({ historyChunks: 50000, updates: 100, previousReducerMs: Math.round(before.ms), incrementalReducerMs: Math.round(after.ms) }));
});
