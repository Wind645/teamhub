import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Journal } from "../dist/journal.js";
import { HttpModel, ScriptModel } from "../dist/model.js";
import { delegateTool, projectSetup } from "../dist/project.js";
import { Runtime } from "../dist/runtime.js";
import { localTools, Registry } from "../dist/tools.js";
import { createHook } from "../dist/teamhub.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const call = (id, name, args) => ({ id, name, args });
const patch = file => ({ input: `*** Begin Patch\n*** Add File: ${file}\n+kept\n*** End Patch` });

async function workspace(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "toy advanced ")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function harness(cwd, journal, model, overrides = {}) {
  const registry = new Registry();
  for (const tool of localTools(cwd, 4000, 12000)) registry.add(tool);
  return new Runtime({
    journal, model, registry, instructions: "Work in the fixture.", approve: async () => true,
    steps: 10, context: 6000, turnTimeout: 10000, ...overrides,
  });
}

test("terminal accepts steering while an actual command is still running", async t => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, "wait.mjs"), `import { existsSync, writeFileSync } from "node:fs";
writeFileSync("ready", "");
const timer = setInterval(() => {
  if (existsSync("release")) { clearInterval(timer); console.log("released"); }
}, 20);`);
  await writeFile(join(cwd, "script.json"), JSON.stringify([
    { text: "", calls: [call("wait", "Bash", { command: "node wait.mjs" })] },
    { text: "Done." },
  ]));
  await writeFile(join(cwd, "config.json"), JSON.stringify({
    permissions: { Bash: "allow" },
    hooks: [{ events: ["UserPromptSubmit"], command: process.execPath, args: ["-e", "console.log('{}')"] }],
  }));
  const sessions = join(cwd, "sessions");
  const child = spawn(process.execPath, [cli, "--cwd", cwd, "--script", join(cwd, "script.json"),
    "--config", join(cwd, "config.json"), "--sessions", sessions],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const completion = once(child, "close");
  const timer = setTimeout(() => child.kill(), 13_000);
  let output = "";
  let errors = "";
  let submitted = false;
  let releasing = false;
  child.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  child.stdout.setEncoding("utf8").on("data", chunk => {
    output += chunk;
    if (!submitted && output.includes("/checkpoints")) {
      submitted = true;
      child.stdin.write("Start the check.\n");
    }
    if (!releasing && output.includes('[steer] "Always cite north.txt."')) {
      releasing = true;
      void writeFile(join(cwd, "release"), "");
    }
    if (chunk.includes('[status] "completed"')) child.stdin.end("/exit\n");
  });
  try {
    for (let attempt = 0; ; attempt++) {
      const ready = await readFile(join(cwd, "ready")).then(() => true, () => false);
      if (ready) break;
      if (attempt === 200) throw new Error(output + errors);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.doesNotMatch(output, /\[result wait\]/);
    child.stdin.write("/steer Always cite north.txt.\n");
    const [code] = await completion;
    assert.equal(code, 0, errors + output);
    const id = /(?<=\[session\] )[a-z0-9-]+/.exec(output)[0];
    const journal = new Journal(sessions, cwd, id);
    const { events } = journal;
    const steering = events.find(e => e.type === "steer");
    assert.ok(steering.seq < events.find(e => e.type === "result").seq);
    assert.equal(events.filter(e => e.type === "hook" && e.data.name === "UserPromptSubmit").length, 1);
    assert.equal(events.findLast(e => e.type === "model").turn, steering.turn);
    assert.equal(new Set(events.flatMap(e => e.turn ?? [])).size, 1);
  } finally {
    clearTimeout(timer);
    child.kill();
    await completion;
  }
});

test("steering received during a tool appears in the next model request", async t => {
  const cwd = await workspace(t);
  const journal = new Journal(join(cwd, "sessions"), cwd);
  let markStarted;
  let release;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const registry = new Registry();
  registry.add({
    name: "wait", description: "wait", schema: { type: "object" }, permission: "allow", effect: false,
    async execute() { markStarted(); await gate; return { ok: true }; },
  });
  const model = new ScriptModel([
    { text: "", calls: [call("gate", "wait", {})] },
    messages => {
      assert.match(messages[0].content, /Always cite north.txt/);
      assert.equal(messages.find(e => e.role === "tool").id, "gate");
      return { text: "Confirmed using north.txt." };
    },
  ]);
  const runtime = harness(cwd, journal, model, { registry, hook: async () => ({}) });
  await runtime.start();
  const pending = runtime.submit("Review the notes.");
  await started;
  runtime.steer("Always cite north.txt");
  release();
  assert.match(await pending, /north.txt/);
  assert.equal(journal.events.filter(e => e.type === "hook" && e.data.name === "UserPromptSubmit").length, 1);
  assert.equal(new Set(journal.events.flatMap(e => e.turn ?? [])).size, 1);
  await runtime.end();
});

test("resume marks unknown effects without replay; rollback rewinds journal and keeps file", async t => {
  const cwd = await workspace(t);
  const directory = join(cwd, "sessions");
  const first = new Journal(directory, cwd);
  const turn = "interrupted-fixture";
  first.add("user", "Create kept.txt", turn);
  first.add("status", "running", turn);
  const action = call("p", "apply_patch", patch("kept.txt"));
  const reply = first.add("assistant", { text: "", calls: [action] }, turn);
  const request = reply.seq * 1000;
  first.add("request", { request, call: action }, turn);
  first.add("execute", { request, call: action, effect: true }, turn);
  await writeFile(join(cwd, "kept.txt"), "kept\n");

  const journal = new Journal(directory, cwd, first.id);
  const model = new ScriptModel([
    messages => {
      assert.match(JSON.stringify(messages), /Unverified action/);
      assert.match(JSON.stringify(messages), /interrupted-fixture/);
      return { text: "", calls: [call("inspect", "read_file", { path: "kept.txt" })] };
    },
    messages => {
      assert.match(messages.find(message => message.role === "tool").content, /kept/);
      return { text: "Verified kept.txt exists." };
    },
    messages => {
      assert.doesNotMatch(JSON.stringify(messages), /kept.txt/);
      return { text: "A fresh turn at the earlier checkpoint." };
    },
  ]);
  const runtime = harness(cwd, journal, model);
  await runtime.start();
  assert.equal(journal.events.findLast(e => e.type === "status").data, "paused");
  assert.equal(journal.events.filter(e => e.type === "uncertain").length, 1);
  assert.match(await runtime.resume(), /Verified/);
  assert.deepEqual(journal.events.filter(e => e.type === "execute").map(e => e.data.call.id), ["p", "inspect"]);
  runtime.rollback(1);
  assert.equal(await readFile(join(cwd, "kept.txt"), "utf8"), "kept\n");
  assert.match(await runtime.submit("Continue from this checkpoint."), /fresh turn/);
  assert.equal(journal.active().some(e => e.turn === turn), false);
  assert.equal(journal.events.some(e => e.turn === turn), true);
  await runtime.end();
});

test("project instructions, on-demand skill and read-only delegation reach the model", async t => {
  const cwd = await workspace(t);
  const other = join(cwd, "other");
  await mkdir(join(cwd, ".skills", "sources"), { recursive: true });
  await mkdir(other);
  await writeFile(join(cwd, "AGENTS.md"), "Preserve source names exactly.");
  await writeFile(join(other, "AGENTS.md"), "Use alternate formatting.");
  await writeFile(join(cwd, ".skills", "sources", "SKILL.md"), "List all note filenames in the report.");
  await writeFile(join(cwd, "north.txt"), "North prefers Monday.");
  const setup = await projectSetup(cwd);
  const switched = await projectSetup(other);
  assert.match(switched.instructions, /alternate formatting/);
  assert.doesNotMatch(switched.instructions, /source names|sources/);
  const registry = new Registry();
  const [read] = localTools(cwd, 4000, 12000);
  registry.add(read);
  setup.tools.forEach(tool => registry.add(tool));
  const steps = new ScriptModel([
    messages => {
      assert.match(messages[0].content, /Preserve source names exactly/);
      assert.match(messages[0].content, /Available skills: sources/);
      assert.doesNotMatch(messages[0].content, /List all note filenames/);
      return { text: "", calls: [call("skill", "load_skill", { name: "sources" })] };
    },
    messages => {
      assert.match(messages.at(-1).content, /List all note filenames/);
      return { text: "", calls: [call("review", "delegate_review", { task: "Verify the day in north.txt." })] };
    },
    messages => {
      assert.match(messages[0].content, /read-only source reviewer/);
      assert.equal(messages.length, 2);
      return { text: "", calls: [
        call("illegal", "apply_patch", patch("bad.txt")),
        call("source", "read_file", { path: "north.txt" }),
      ] };
    },
    messages => {
      assert.match(messages.find(e => e.id === "illegal").content, /Unknown tool/);
      assert.match(messages.at(-1).content, /North prefers Monday/);
      return { text: "Monday (north.txt)" };
    },
    messages => {
      assert.match(messages.at(-1).content, /Monday \(north.txt\)/);
      return { text: "The reviewer verified Monday using north.txt." };
    },
  ]);
  registry.add(delegateTool(steps, read, setup.instructions));
  const runtime = harness(cwd, new Journal(join(cwd, "sessions"), cwd), steps, {
    registry, instructions: setup.instructions,
  });
  await runtime.start();
  assert.match(await runtime.submit("Check the report's source."), /Monday using north.txt/);
  await assert.rejects(readFile(join(cwd, "bad.txt")), { code: "ENOENT" });
  await runtime.end();
});

test("local deny, invalid arguments, path junction, timeout, output cap and step budget", async t => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  const { symlink } = await import("node:fs/promises");
  await writeFile(join(outside, "outside.txt"), "outside");
  await symlink(outside, join(cwd, "link"), "junction");
  const model = new ScriptModel([
    { text: "", calls: [
      call("denied", "apply_patch", patch("denied.txt")),
      call("invalid", "read_file", { path: 5 }),
      call("outside", "read_file", { path: "link/outside.txt" }),
      call("walk", "read_file", { path: "../outside.txt" }),
      call("timeout", "Bash", { command: 'node -e "setInterval(() => {}, 1000)"' }),
      call("cap", "Bash", { command: 'node -e "console.log(0.1.toFixed(100).repeat(1000))"' }),
    ] },
    messages => {
      assert.match(messages.find(e => e.id === "denied").content, /Denied/);
      assert.match(messages.find(e => e.id === "invalid").content, /Invalid arguments/);
      assert.match(messages.find(e => e.id === "outside").content, /junctions/);
      assert.match(messages.find(e => e.id === "walk").content, /traversal/);
      assert.match(messages.find(e => e.id === "timeout").content, /timeout/);
      assert.match(messages.find(e => e.id === "cap").content, /Output limit/);
      return { text: "Recovered after the step limit." };
    },
  ]);
  const registry = new Registry();
  for (const tool of localTools(cwd, 1000, 2000)) registry.add(tool);
  const journal = new Journal(join(cwd, "sessions"), cwd);
  const runtime = harness(cwd, journal, model, { registry, steps: 1, approve: async tool => tool.name === "Bash" });
  await runtime.start();
  assert.equal(await runtime.submit("Exercise the local limits"), "");
  assert.equal(journal.events.at(-1).data, "paused");
  assert.match(await runtime.resume(), /Recovered/);
  await assert.rejects(readFile(join(cwd, "denied.txt")), { code: "ENOENT" });
  await runtime.end();
});

test("hook host reports timeout and child failure", async t => {
  const cwd = await workspace(t);
  const hook = code => createHook([{ events: ["SessionStart"], command: process.execPath, args: ["-e", code] }],
    cwd, 500, () => {});
  await assert.rejects(hook("process.exit(5)")({ hook_event_name: "SessionStart" }), /code 5/);
  await assert.rejects(hook("setInterval(() => {}, 1000)")({ hook_event_name: "SessionStart" }), /timeout/);
});

test("Responses adapter serializes call and result IDs with the configured model", async t => {
  const key = "TEST_HARNESS_RESPONSES_KEY";
  process.env[key] = "local-fixture";
  t.after(() => { delete process.env[key]; });
  let body;
  let authorization;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks));
    authorization = req.headers.authorization;
    res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "verified" }] }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const model = new HttpModel({
    protocol: "responses", endpoint: `http://127.0.0.1:${server.address().port}/responses`,
    name: "fixture-model", keyEnv: key,
  });
  const reply = await model.next([
    { role: "user", content: "Read." },
    { role: "assistant", content: "", calls: [call("call_read", "read_file", { path: "north.txt" })] },
    { role: "tool", id: "call_read", content: "Monday" },
  ], [], new AbortController().signal);
  assert.equal(authorization, "Bearer local-fixture");
  assert.equal(body.model, "fixture-model");
  assert.equal(body.input[1].call_id, body.input[2].call_id);
  assert.equal(body.input[2].output, "Monday");
  assert.equal(reply.text, "verified");
});
