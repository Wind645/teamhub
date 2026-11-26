import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openSession } from "../dist/session.js";

async function fixture(t, config, next, approve = async () => false) {
  const cwd = await mkdtemp(join(tmpdir(), "teamhub-budget-"));
  await writeFile(join(cwd, "value.txt"), "fixture");
  const session = await openSession({ cwd, directory: join(cwd, "sessions"),
    config: { steps: 1, turnTimeout: 10000, ...config }, model: () => ({ next }),
    approve, emit() {}, log() {} });
  t.after(() => session.close());
  await session.runtime.start();
  return session;
}
const read = n => ({ text: "", calls: [{ id: `read-${n}`, name: "read_file", args: { path: "value.txt" } }] });
const status = session => session.journal.events.findLast(e => e.type === "status")?.data;

test("missing setting and explicit true pause at the step limit and can resume", async t => {
  for (const config of [{}, { autoPause: true }]) {
    let calls = 0;
    const s = await fixture(t, config, async () => ++calls === 1 ? read(calls) : { text: "done" });
    await s.runtime.submit("read fixture");
    assert.equal(status(s), "paused");
    assert.equal(calls, 1);
    assert.equal(await s.runtime.resume(), "done");
    assert.equal(status(s), "completed");
  }
});

test("disabled budgets allow more than 16 model steps and passing the time limit", async t => {
  let calls = 0;
  const s = await fixture(t, { autoPause: false, turnTimeout: 1 }, async () => {
    await delay(3);
    return ++calls <= 18 ? read(calls) : { text: "done" };
  });
  assert.equal(await s.runtime.submit("read fixture"), "done");
  assert.equal(calls, 19);
  assert.equal(status(s), "completed");
  assert.equal(s.journal.events.some(e => e.data === "paused"), false);
});

test("enabled time budget still pauses a slow model request", async t => {
  const s = await fixture(t, { autoPause: true, turnTimeout: 10 }, async (_m, _t, signal) => {
    await delay(2000, undefined, { signal });
    return { text: "unexpected" };
  });
  await s.runtime.submit("wait");
  assert.equal(status(s), "paused");
  assert.ok(s.journal.events.some(e => String(e.data).includes("Turn time budget reached")));
});

test("disabled budgets retain manual interruption and model failures", async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const s = await fixture(t, { autoPause: false }, async (_m, _t, signal) => {
    entered();
    await delay(10000, undefined, { signal });
    return { text: "unexpected" };
  });
  const running = s.runtime.submit("wait");
  await ready;
  s.runtime.interrupt();
  await running;
  assert.equal(status(s), "interrupted");
  const failed = await fixture(t, { autoPause: false }, async () => { throw new Error("Model HTTP 502"); });
  await failed.runtime.submit("test error");
  assert.equal(status(failed), "failed");
});

test("disabled budgets still ask approval and respect denial", async t => {
  let calls = 0, approvals = 0;
  const s = await fixture(t, { autoPause: false }, async () => ++calls === 1 ? {
    text: "", calls: [{ id: "patch", name: "apply_patch", args: { input: "*** Begin Patch\n*** Add File: denied.txt\n+no\n*** End Patch" } }],
  } : { text: "denied" }, async () => { approvals++; return false; });
  await s.runtime.submit("approval fixture");
  assert.equal(approvals, 1);
  assert.equal(s.journal.events.some(e => e.type === "execute"), false);
});
