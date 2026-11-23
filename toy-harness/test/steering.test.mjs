import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Journal } from "../dist/journal.js";
import { Runtime } from "../dist/runtime.js";
import { localTools, Registry } from "../dist/tools.js";

const steering = "先别改文件，只解释原因";
const patch = { id: "stale-patch", name: "apply_patch", args: {
  input: "*** Begin Patch\n*** Update File: target.txt\n@@\n-original\n+stale\n*** End Patch",
} };

for (const stage of ["model", "approval", "PreToolUse", "first tool"]) {
  test(`steering at ${stage} prevents stale patch and pairs its result`, { timeout: 5000 }, async t => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "toy steering ")));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const file = join(cwd, "target.txt");
    await writeFile(file, "original\n");
    const registry = new Registry();
    for (const tool of localTools(cwd, 3000, 12000)) {
      registry.add({ ...tool, permission: tool.name === "apply_patch" && stage !== "approval" ? "allow" : tool.permission });
    }
    const reached = Promise.withResolvers();
    const release = Promise.withResolvers();
    const gate = async () => {
      reached.resolve();
      await release.promise;
    };
    const first = { id: "first", name: "first", args: {} };
    registry.add({
      name: "first", description: "Hold the first tool in flight", schema: { type: "object" },
      permission: "allow", effect: false,
      async execute() { await gate(); return { ok: true, value: "actual first result" }; },
    });
    const requests = [];
    const journal = new Journal(join(cwd, "sessions"), cwd);
    const runtime = new Runtime({
      journal, registry, instructions: "Use the fixture.", steps: 4, context: 8000, turnTimeout: 4000,
      model: { async next(messages) {
        requests.push(messages);
        if (requests.length === 1) {
          if (stage === "model") await gate();
          return { text: "", calls: stage === "first tool" ? [first, patch] : [patch] };
        }
        return { text: "Here is the explanation." };
      } },
      approve: async () => { if (stage === "approval") await gate(); return true; },
      hook: async input => {
        if (stage === "PreToolUse" && input.hook_event_name === "PreToolUse") await gate();
        return {};
      },
    });
    await runtime.start();
    const result = runtime.submit("Change the file.");
    await reached.promise;
    runtime.steer(steering);
    release.resolve();
    assert.equal(await result, "Here is the explanation.");

    assert.equal(await readFile(file, "utf8"), "original\n");
    assert.equal(journal.events.some(event => event.type === "execute" && event.data.call.id === patch.id), false);
    assert.equal(requests.length, 2);
    assert.match(requests[1][0].content, new RegExp(steering));
    const modelEvents = journal.events.filter(event => event.type === "model");
    assert.equal(modelEvents[1].turn, modelEvents[0].turn);
    assert.equal(journal.events.filter(event => event.type === "hook" && event.data.name === "UserPromptSubmit").length, 1);
    const asked = requests[1].find(message => message.role === "assistant" && message.calls);
    const results = requests[1].filter(message => message.role === "tool");
    assert.deepEqual(asked.calls.map(call => call.id), results.map(result => result.id));
    const skipped = JSON.parse(results.at(-1).content);
    assert.equal(skipped.ok, false);
    assert.match(skipped.reason, /newer user instruction/i);
    if (stage === "first tool") assert.deepEqual(JSON.parse(results[0].content), { ok: true, value: "actual first result" });
    await runtime.end();
  });
}
