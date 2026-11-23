import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connectMcp, createHook, teamHooks } from "../dist/teamhub.js";
import { Journal } from "../dist/journal.js";
import { Runtime } from "../dist/runtime.js";
import { localTools, Registry } from "../dist/tools.js";
import { createTeamHubApp } from "../../dist/app.js";
import { TeamHubStore } from "../../dist/store.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const signal = new AbortController().signal;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
const addPatch = (file, value = "written") => ({
  input: `*** Begin Patch\n*** Add File: ${file}\n+${value}\n*** End Patch`,
});

const updateShared = (before, after) => ({
  input: `*** Begin Patch\n*** Update File: overlap.txt\n@@\n-${before}\n+${after}\n*** End Patch`,
});
const action = (id, name, args) => ({ id, name, args });
const plan = (id, turn_id) => action(id, "team_update_state", {
  turn_id, intent_summary: "Edit shared file", planned_paths: ["overlap.txt"], status: "working",
});
const turnOf = messages => /Active turn ID: ([\w-]+)/.exec(messages[0].content)[1];

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "toy hub integration "));
  const cwd = join(dir, "local repo");
  await mkdir(cwd);
  git(cwd, "init", "-b", "main");
  await writeFile(join(cwd, "overlap.txt"), "original\n");
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Harness", "-c", "user.email=harness@example.test", "commit", "-m", "fixture");
  const remote = join(dir, "bare remote");
  git(dir, "init", "--bare", remote);
  git(cwd, "remote", "add", "origin", remote);
  // Import resolution uses the root project's dependencies. The hook path also contains spaces.
  const hookPath = join(root, "dist", `integration hook ${process.pid} ${Date.now()}.js`);
  await copyFile(join(root, "dist", "hook.js"), hookPath);
  return { dir, cwd, hookPath, remote };
}

async function runCli(f, config, args, onOutput) {
  const file = join(f.dir, "config.json");
  await writeFile(file, JSON.stringify(config));
  const sessions = join(f.dir, "sessions");
  const child = spawn(process.execPath, [cli, "--cwd", f.cwd, "--config", file,
    "--sessions", sessions, ...args], {
    env: { ...process.env, TEST_HARNESS_KEY: "local-test-only" },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", data => {
    stdout += data;
    onOutput?.(stdout, child);
  });
  child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 30_000);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  const [id] = /(?<=\[session\] )[a-z0-9-]+/.exec(stdout) ?? [];
  const events = id ? (await readFile(join(sessions, id + ".jsonl"), "utf8")).trim().split("\n").map(JSON.parse) : [];
  return { code, stdout, stderr, events };
}

for (const status of ["paused", "failed"]) {
  test(`a ${status} peer releases the path before exit and /resume checks Bob's claim`, { timeout: 45000 }, async () => {
    const f = await fixture();
    const store = new TeamHubStore(join(f.dir, "handoff.sqlite"));
    const hub = createTeamHubApp(store);
    const http = createServer(hub.app);
    const base = await listen(http);
    const bob = { url: `${base}/mcp/bob`, peer: "bob", hookPath: f.hookPath };
    const remote = await connectMcp(bob.url, 5000);
    const file = join(f.cwd, "overlap.txt");
    const aSettled = Promise.withResolvers();
    const aResettled = Promise.withResolvers();
    const bPatched = Promise.withResolvers();
    const finishB = Promise.withResolvers();
    const turns = [];
    const modelErrors = [];
    let child;
    let runA;
    let runB;
    const resumeStep = status === "paused" ? 2 : 3;
    const model = createServer(async (req, res) => {
      try {
        const chunks = await Array.fromAsync(req);
        const { messages } = JSON.parse(Buffer.concat(chunks));
        const turn = turnOf(messages);
        const step = turns.push(turn);
        if (step === 2 && status === "failed") {
          res.writeHead(503).end();
          return;
        }
        if (step === resumeStep && modelErrors.length === 0) {
          assert.match(JSON.stringify(messages), /This turn resumed. Register a fresh plan before editing/);
        }
        const calls = step === 1 ? [plan("a-plan", turn)] : step === resumeStep ? [
          plan("a-replan", turn), action("a-patch", "apply_patch", updateShared("bob took over", "alice overwrote")),
        ] : [];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: {
          content: calls.length ? null : "The shared file is held by Bob.",
          tool_calls: calls.map(({ id, name, args }) => ({ id, function: { name, arguments: JSON.stringify(args) } })),
        } }] }));
      } catch (error) {
        modelErrors.push(error);
        res.writeHead(500).end();
      }
    });
    const endpoint = await listen(model);
    const registry = new Registry();
    for (const tool of [...localTools(f.cwd, 4000, 12000), ...remote.tools]) {
      registry.add({ ...tool, permission: tool.name === "apply_patch" ? "allow" : tool.permission });
    }
    let bobStep = 0;
    const bobRuntime = new Runtime({
      journal: new Journal(join(f.dir, "bob-sessions"), f.cwd),
      model: { async next(messages) {
        if (++bobStep === 1) return { text: "", calls: [
          plan("b-plan", turnOf(messages)), action("b-patch", "apply_patch", updateShared("original", "bob took over")),
        ] };
        bPatched.resolve(JSON.parse(messages.find(message => message.id === "b-patch").content));
        await finishB.promise;
        return { text: "Bob finished." };
      } },
      registry, instructions: "Use the shared fixture.", steps: 4, context: 8000, turnTimeout: 30000,
      approve: async () => false,
      hook: createHook(teamHooks(bob), f.cwd, 5000, () => {}, bob),
    });
    try {
      runA = runCli(f, {
        model: { endpoint, name: "local fixture", keyEnv: "TEST_HARNESS_KEY" },
        teamhub: { ...bob, url: `${base}/mcp/alice`, peer: "alice" },
        permissions: { apply_patch: "allow" }, steps: status === "paused" ? 1 : 3,
      }, [], (stdout, running) => {
        if (!child && stdout.includes("/checkpoints")) {
          child = running;
          child.stdin.write("Edit overlap.txt.\n");
        }
        const outcomes = stdout.match(/^\[status\] "(paused|failed|completed)"\r?$/gm) ?? [];
        if (outcomes.length >= 1) aSettled.resolve();
        if (outcomes.length >= 2) aResettled.resolve();
      });
      const exited = runA.then(({ stdout, stderr }) => { throw new Error(stdout + stderr); });
      await Promise.race([aSettled.promise, exited]);
      const alice = store.getActiveStates("bob").find(peer => peer.peer_id === "alice");
      assert.equal(alice.turn_id, turns[0]);
      assert.equal(child.exitCode, null);
      await bobRuntime.start();
      runB = bobRuntime.submit("Take over overlap.txt.");
      const result = await Promise.race([bPatched.promise, exited, runB.then(() => {
        throw new Error("Bob finished before returning a patch result");
      })]);
      const content = await readFile(file, "utf8");
      assert.equal(result.ok, true, JSON.stringify({ result, content }));
      assert.equal(content, "bob took over\n");
      assert.deepEqual(alice.planned_paths, []);
      assert.equal(child.exitCode, null);
      assert.deepEqual(store.getActiveStates("alice").find(peer => peer.peer_id === "bob").planned_paths, ["overlap.txt"]);
      child.stdin.write("/resume\n");
      await Promise.race([aResettled.promise, exited]);
      assert.equal(await readFile(file, "utf8"), "bob took over\n");
      child.stdin.end("/exit\n");
      const report = await runA;
      assert.equal(report.code, 0, report.stderr);
      assert.deepEqual(modelErrors, []);
      assert.ok(turns.length >= resumeStep);
      assert.deepEqual([...new Set(turns)], [alice.turn_id]);
      const results = report.events.filter(event => event.type === "result");
      assert.equal(results.find(event => event.data.id === "a-plan").data.result.ok, true);
      assert.equal(results.find(event => event.data.id === "a-replan").data.result.ok, true);
      assert.match(results.find(event => event.data.id === "a-patch").data.result.reason, /overlaps active work from bob/);
      assert.equal(report.events.some(event => event.type === "execute" && event.data.call.id === "a-patch"), false);
      assert.equal(report.events.filter(e => e.type === "hook" && e.data.name === "UserPromptSubmit").length, 1);
      assert.deepEqual(report.events.filter(e => e.type === "hook" && e.data.name === "TurnResume").map(e => e.turn), [alice.turn_id]);
      assert.match(report.stdout, status === "paused" ? /Model step budget reached/ : /Model HTTP 503/);
      assert.equal(store.getActiveStates("bob").find(peer => peer.peer_id === "alice").status, "offline");
    } finally {
      if (child && !child.stdin.writableEnded) child.stdin.end("/exit\n");
      finishB.resolve();
      await runB;
      await runA;
      await bobRuntime.end();
      await remote.client.close();
      await hub.closeSessions();
      http.close();
      model.close();
      store.close();
      await rm(f.hookPath, { force: true });
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

test("real TeamHub: hooks and MCP on normal CLI, conflict, messages, push, lifecycle", async () => {
  const f = await fixture();
  const store = new TeamHubStore(join(f.dir, "fresh.sqlite"));
  const hub = createTeamHubApp(store);
  const http = createServer(hub.app);
  const base = await listen(http);
  const alice = await connectMcp(`${base}/mcp/alice`, 5000);
  const send = async (name, args) => {
    const result = await alice.tools.find(tool => tool.name === name).execute(args, signal);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value.structuredContent;
  };
  const modelErrors = [];
  let step = 0;
  let id;
  const steps = [
    () => [["blocked-no-plan", "apply_patch", addPatch("unplanned.txt")]],
    () => [["state", "team_get_state", {}], ["peers", "team_list_peers", {}],
      ["plan", "team_update_state", { turn_id: id, intent_summary: "edit", planned_paths: ["overlap.txt"], status: "working" }]],
    () => [["overlap", "apply_patch", { input: "*** Begin Patch\n*** Update File: overlap.txt\n@@\n-original\n+incorrect\n*** End Patch" }],
      ["push", "Bash", { command: "git push origin HEAD:main" }]],
  ];
  steps.push(async () => {
    assert.equal(await readFile(join(f.cwd, "overlap.txt"), "utf8"), "original\n");
    assert.equal(git(f.remote, "for-each-ref").trim(), "");
    await send("team_send_message", { recipients: ["bob"], message: "Please use separate.txt" });
    return [["inbox", "team_read_messages", {}], ["again", "team_read_messages", {}],
      ["send", "team_send_message", { recipients: ["alice"], message: "I will use separate.txt" }]];
  });
  steps.push(() => [["replan", "team_update_state", {
    turn_id: id, intent_summary: "edit separate file", planned_paths: ["separate.txt"], status: "working",
  }], ["patch", "apply_patch", addPatch("separate.txt")]]);
  const model = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      id = /Active turn ID: ([\w-]+)/.exec(body.messages[0].content)[1];
      const tools = body.tools.map(tool => tool.function.name);
      for (const name of ["team_begin_turn", "team_update_state", "team_get_state",
        "team_list_peers", "team_send_message", "team_read_messages"]) assert.ok(tools.includes(name));
      if (step === 0) assert.match(JSON.stringify(body.messages), /Before modifying files or Git state/);
      const calls = await steps[step++]?.();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: calls ? {
        content: null,
        tool_calls: calls.map(([id, name, args]) => ({ id, function: { name, arguments: JSON.stringify(args) } })),
      } : { content: "Coordination finished." } }] }));
    } catch (error) {
      modelErrors.push(error);
      res.writeHead(500).end();
    }
  });
  try {
    await send("team_begin_turn", { turn_id: "alice-turn", raw_intent: "edit overlap.txt", cwd: f.cwd, branch: "main" });
    await send("team_update_state", {
      turn_id: "alice-turn", intent_summary: "edit overlap", planned_paths: ["overlap.txt"], status: "working",
    });
    const endpoint = await listen(model);
    const config = {
      model: { endpoint, name: "wire fixture", keyEnv: "TEST_HARNESS_KEY" },
      teamhub: { url: `${base}/mcp/bob`, peer: "bob", hookPath: f.hookPath },
      permissions: { apply_patch: "allow", Bash: "allow", team_send_message: "allow", team_read_messages: "allow" },
    };
    let idle;
    let sent = false;
    let finishing = false;
    const report = await runCli(f, config, [], (stdout, child) => {
      if (!sent && stdout.includes("/checkpoints")) {
        sent = true;
        child.stdin.write("Coordinate a local edit.\n");
      }
      if (!finishing && stdout.includes('[status] "completed"')) {
        finishing = true;
        void send("team_get_state", { include_stale: true }).then(data => {
          idle = data.peers.find(peer => peer.peer_id === "bob");
          child.stdin.end("/exit\n");
        }).catch(error => { modelErrors.push(error); child.stdin.end("/exit\n"); });
      }
    });
    assert.deepEqual(modelErrors, []);
    assert.equal(report.code, 0, report.stderr);
    const byId = Object.fromEntries(report.events.filter(e => e.type === "result").map(e => [e.data.id, e.data.result]));
    assert.match(byId["blocked-no-plan"].reason, /team_update_state/);
    assert.match(byId.overlap.reason, /overlaps active work from alice/);
    assert.match(byId.push.reason, /same branch/);
    assert.equal(report.events.some(e => e.type === "execute" && ["push", "overlap", "blocked-no-plan"].includes(e.data.call.id)), false);
    assert.equal(byId.state.value.structuredContent.peers.find(peer => peer.is_self).turn_id, id);
    assert.equal(byId.peers.value.structuredContent.peers.length, 2);
    assert.match(byId.inbox.value.structuredContent.messages[0].content, /separate.txt/);
    assert.equal(byId.again.value.structuredContent.count, 0);
    assert.equal((await send("team_read_messages", {})).messages[0].sender_peer_id, "bob");
    assert.equal(await readFile(join(f.cwd, "separate.txt"), "utf8"), "written\n");
    assert.deepEqual((await readdir(f.cwd)).sort(), [".git", "overlap.txt", "separate.txt"]);
    assert.equal(idle.status, "idle");
    assert.deepEqual(idle.planned_paths, []);
    assert.equal((await send("team_get_state", { include_stale: true })).peers.find(peer => peer.peer_id === "bob").status, "offline");

    let interruptSent = false;
    let interrupted;
    let closing = false;
    // Start another turn and use a hanging approved shell command to exercise real Interrupt.
    steps.length = 0;
    step = 0;
    steps.push(() => [
      ["interrupt-plan", "team_update_state", {
        turn_id: id, intent_summary: "verify fixture", planned_paths: ["separate.txt"], status: "working",
      }],
      ["hang", "Bash", { command: "node -e \"setInterval(() => {}, 1000)\"" }],
    ]);
    const interruptedRun = await runCli(f, config, [], (stdout, child) => {
      if (stdout.includes("/checkpoints") && !closing) {
        closing = true;
        child.stdin.write("Interrupt this local verification.\n");
      }
      if (!interruptSent && stdout.includes("[execute hang]")) {
        interruptSent = true;
        child.stdin.write("/interrupt\n");
      }
      if (stdout.includes('[status] "interrupted"') && interrupted === undefined) {
        interrupted = "checking";
        void send("team_get_state", { include_stale: true }).then(data => {
          interrupted = data.peers.find(peer => peer.peer_id === "bob");
          child.stdin.end("/exit\n");
        }).catch(error => { modelErrors.push(error); child.stdin.end("/exit\n"); });
      }
    });
    assert.deepEqual(modelErrors, []);
    assert.equal(interruptedRun.code, 0);
    assert.equal(interrupted.status, "interrupted");
    assert.deepEqual(interrupted.planned_paths, []);
    assert.equal(interruptedRun.events.some(e => e.type === "hook" && e.data.name === "Stop"), false);
    assert.equal((await send("team_get_state", { include_stale: true })).peers.find(peer => peer.peer_id === "bob").status, "offline");
  } finally {
    await alice.client.close();
    await hub.closeSessions();
    http.close();
    model.close();
    store.close();
    await rm(f.hookPath, { force: true });
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("real hook process: TeamHub unavailable fails open by default and can stop closed", async () => {
  const f = await fixture();
  const port = createServer();
  const base = await listen(port);
  await new Promise(resolve => port.close(resolve));
  const script = join(f.dir, "script.json");
  await writeFile(script, JSON.stringify([
    { text: "", calls: [{ id: "patch", name: "apply_patch", args: addPatch("offline.txt") }] },
    { text: "Done offline." },
  ]));
  const config = {
    teamhub: { url: `${base}/mcp/bob`, peer: "bob", hookPath: f.hookPath },
    permissions: { apply_patch: "allow" },
  };
  try {
    const open = await runCli(f, config, ["--script", script, "--prompt", "Write offline fixture"]);
    assert.equal(open.code, 0, open.stderr);
    assert.match(open.stdout, /coordination check skipped/);
    assert.match(open.stderr, /hook stderr/);
    assert.equal(await readFile(join(f.cwd, "offline.txt"), "utf8"), "written\n");
    const closed = await runCli(f, { ...config, teamhub: { ...config.teamhub, failClosed: true } },
      ["--script", script, "--prompt", "This should stop"]);
    assert.equal(closed.code, 1);
    assert.match(closed.stderr, /Team Hub hook failed/);
    assert.equal(closed.events.some(e => e.type === "execute"), false);
  } finally {
    await rm(f.hookPath, { force: true });
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("outage during release preserves the original local outcome in both hook modes", { timeout: 45000 }, async () => {
  const f = await fixture();
  const store = new TeamHubStore(join(f.dir, "release-outage.sqlite"));
  const hub = createTeamHubApp(store);
  let available = true;
  const http = createServer((req, res) => {
    if (available) hub.app(req, res);
    else res.writeHead(503).end();
  });
  const base = await listen(http);
  try {
    for (const failClosed of [false, true]) {
      for (const status of ["paused", "failed"]) {
        const team = { url: `${base}/mcp/alice`, peer: "alice", hookPath: f.hookPath, failClosed };
        const host = createHook(teamHooks(team), f.cwd, 5000, () => {}, team);
        const journal = new Journal(join(f.dir, "outage-sessions"), f.cwd);
        const registry = new Registry();
        const [read] = localTools(f.cwd, 4000, 12000);
        registry.add(read);
        const runtime = new Runtime({
          journal, registry, approve: async () => false, instructions: "Use the fixture.",
          steps: 1, context: 8000, turnTimeout: 10000,
          model: { async next() {
            if (status === "failed") throw new Error("Original model failure");
            return { text: "", calls: [action("read", "read_file", { path: "overlap.txt" })] };
          } },
          hook: async input => {
            if (input.hook_event_name !== "TurnRelease") return host(input);
            available = false;
            try { return await host(input); }
            finally { available = true; }
          },
        });
        await runtime.start();
        try {
          await runtime.submit("Verify local outcome during a TeamHub outage.");
          assert.equal(journal.events.at(-1).data, status);
          const notices = journal.events.filter(e => e.type === "notice").map(e => e.data);
          assert.match(notices[0], status === "paused" ? /Model step budget reached/ : /Original model failure/);
          assert.match(notices[1], failClosed ? /Team Hub hook failed/ : /coordination check skipped/);
        } finally {
          await runtime.end();
        }
      }
    }
  } finally {
    await hub.closeSessions();
    http.close();
    store.close();
    await rm(f.hookPath, { force: true });
    await rm(f.dir, { recursive: true, force: true });
  }
});
