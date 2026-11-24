import assert from "node:assert/strict";
import test from "node:test";
import { PetActivity, memberPet, petLayout } from "../src/pet-state.ts";

const state = { phase: "ready", events: [] };
const call = (command, id = "call") => ({ id, name: "Bash", args: { command } });

function fixture(history = []) {
  const activity = new PetActivity(history);
  let seq = history.at(-1)?.seq ?? 0;
  const event = (type, data, turn = "turn") => ({ type, data, turn, seq: ++seq, at: "" });
  const emit = (type, data, turn, now = 100) => activity.observe(event(type, data, turn), now);
  const begin = (type = "user", turn = "turn") => {
    emit(type, "", turn);
    emit("status", "running", turn);
  };
  const result = (request, id, exitCode, reason, turn) =>
    emit("result", { request, id, name: "Bash", result: { value: { exitCode }, reason } }, turn);
  const label = (overrides = {}, now = 100) => activity.view({ ...state, ...overrides }, now).status.label;
  return { activity, label, begin, emit, event, result };
}

test("only an executed standalone node test with a real exit code flashes a result", () => {
  for (const { command, exit, reason, expected } of [
    { command: "node --test pass.test.mjs", exit: 0, expected: "样本通过" },
    { command: "node.exe --test fail.test.mjs", exit: 1, reason: "Command exited with code 1", expected: "样本失败" },
    { command: "node --test slow.test.mjs", exit: 1, reason: "Cancelled" },
    { command: "node --test slow.test.mjs", exit: 0, reason: "Process timeout" },
    { command: "node check.mjs", exit: 0 },
    { command: "node --test test.mjs & exit /b 0", exit: 0 },
  ]) {
    const { begin, emit, result, label } = fixture();
    begin();
    const request = { request: 1000, call: call(command) };
    emit("request", request);
    assert.equal(label(), "推理中");
    emit("execute", request);
    assert.equal(label(), "代码执行");
    result(1000, "call", exit, reason);
    assert.equal(label(), expected ?? "推理中");
    emit("status", "completed");
    assert.equal(label(), expected ?? "空闲");
    assert.equal(label({}, 5100), "空闲");
  }
});

test("background approvals outrank test results and blocked sessions, including while resuming", () => {
  const { activity, begin, emit, result, label } = fixture();
  begin();
  const earlier = { request: 1000, call: call("node --test") };
  emit("request", earlier);
  emit("execute", earlier);
  result(1000, "call", 0);
  const next = { request: 2000, call: call("node check.mjs") };
  emit("request", next);
  const pending = { turn: "turn", request: 2000, callId: "call", name: "Bash", args: {} };
  activity.observeApproval(pending);
  assert.equal(label({ pending }), "待审批");
  assert.equal(label(), "推理中");
  const background = { id: "background", state: { ...state, pending }, activity };
  const active = { id: "active", state: { ...state, issue: { kind: "hub", detail: "details" } } };
  assert.equal(memberPet([active, background], active.id, 100).target, background.id);
  emit("status", "paused");
  assert.equal(label({ pending }), "待继续");
  begin("resume");
  assert.equal(label({ pending }), "推理中");
  emit("request", { ...next, request: 3000 });
  emit("execute", { ...next, request: 3000 });
  result(2000, "call", 0);
  result(3000, "call", 0, undefined, "old-turn");
  assert.equal(label({ pending }), "代码执行");
  result(3000, "call", 0);
  emit("status", "interrupted");
  assert.equal(label(), "已中断");
});

test("history, delayed events, and rollback cannot resurrect transient states", () => {
  const { activity, begin, emit, event, label } = fixture([{ seq: 30, type: "execute", turn: "old", data: {}, at: "" }]);
  assert.equal(label(), "空闲");
  assert.equal(label({ phase: "starting" }), "连接中");
  begin();
  const request = { request: 42000, call: call("node --test") };
  const delayed = event("execute", request);
  emit("request", request);
  activity.observe(delayed);
  assert.equal(label(), "推理中");
  emit("execute", request);
  assert.equal(label(), "代码执行");
  emit("status", "failed");
  assert.equal(label(), "异常中断");
  emit("rollback", 1);
  assert.equal(label(), "空闲");
});

test("pet window sizes bound the group and wrap under narrow work areas", () => {
  assert.deepEqual(petLayout(2, 340), { rows: [2], width: 240, height: 154 });
  assert.deepEqual(petLayout(6, 250), { rows: [2, 2, 2], width: 240, height: 360 });
  assert.deepEqual(petLayout(2, 120), { rows: [1, 1], width: 120, height: 257 });
});
