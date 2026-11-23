import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Journal } from "../dist/journal.js";
import { ScriptModel } from "../dist/model.js";
import { Runtime } from "../dist/runtime.js";
import { localTools, Registry } from "../dist/tools.js";

export const action = (id, name, args) => ({ id, name, args });

test("read, failed test, approved patch, successful test, final grounded in results", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "toy harness core "));
  await writeFile(join(cwd, "value.mjs"), "export const value = 3;\n");
  await writeFile(join(cwd, "check.mjs"), "import { value } from './value.mjs'; process.exitCode = value === 4 ? 0 : 1;\n");
  const registry = new Registry();
  localTools(cwd, 4000, 12000).forEach(tool => registry.add(tool));
  const journal = new Journal(join(cwd, "sessions"), cwd);
  const model = new ScriptModel([
    { text: "", calls: [action("read", "read_file", { path: "value.mjs" }), action("before", "Bash", { command: "node check.mjs" })] },
    messages => {
      const observations = messages.filter(item => item.role === "tool");
      assert.deepEqual(observations.map(item => item.id), ["read", "before"]);
      assert.match(observations[0].content, /value = 3/);
      assert.match(observations[1].content, /"exitCode":1/);
      return { text: "", calls: [action("patch", "apply_patch", { input: "*** Begin Patch\n*** Update File: value.mjs\n@@\n-export const value = 3;\n+export const value = 4;\n*** End Patch" }),
        action("after", "Bash", { command: "node check.mjs" })] };
    },
    messages => {
      assert.match(messages.at(-1).content, /"exitCode":0/);
      return { text: "Updated value.mjs and reran node check.mjs (exit 0)." };
    },
  ]);
  const runtime = new Runtime({
    journal, model, registry, instructions: "Fix the fixture.", approve: async () => true,
    steps: 6, context: 8000, turnTimeout: 10000,
  });
  await runtime.start();
  assert.match(await runtime.submit("Fix the failing check"), /exit 0/);
  await runtime.end();
  assert.equal(await readFile(join(cwd, "value.mjs"), "utf8"), "export const value = 4;\n");
  assert.equal(journal.events.filter(e => e.type === "result").length, 4);
  assert.equal(new Set(journal.events.flatMap(e => e.turn ?? [])).size, 1);
});

test("small context recalls the first constraint and preserves complete journal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "toy harness context "));
  const registry = new Registry();
  localTools(cwd, 4000, 12000).forEach(tool => registry.add(tool));
  const directory = join(cwd, "sessions");
  const journal = new Journal(directory, cwd);
  const filler = Array.from({ length: 15 }, (_, index) => ({ text: `Acknowledged ${index}: ` + "x".repeat(420) }));
  const model = new ScriptModel([
    { text: "I will preserve the heading." }, ...filler,
    messages => {
      const summary = messages.find(message => message.content.includes("Summary of earlier recorded events"));
      assert.match(summary.content, /# Pilot findings/);
      assert.match(messages[0].content, /Always cite filenames/);
      assert.match(messages.at(-1).content, /Which heading/);
      assert.ok(JSON.stringify(messages).length <= 3000);
      assert.equal(messages.some(message => message.content.includes("Acknowledged 0:")), false);
      return { text: "# Pilot findings" };
    },
  ]);
  const runtime = new Runtime({
    journal, model, registry, instructions: "Always cite filenames.",
    approve: async () => false, steps: 3, context: 3000, turnTimeout: 10000,
  });
  await runtime.start();
  await runtime.submit("Preserve the exact heading # Pilot findings.");
  for (let index = 0; index < filler.length; index++) {
    await runtime.submit(`Filler note ${index}: ` + "y".repeat(300));
  }
  assert.equal(await runtime.submit("Which heading must be retained?"), "# Pilot findings");
  await runtime.end();
  const restored = new Journal(directory, cwd, journal.id);
  assert.equal(restored.events.filter(event => event.type === "user").length, 17);
  assert.ok(restored.events.some(event => event.type === "model" && event.data.compressed > 0));
  assert.ok(restored.events.some(event => event.type === "final" && event.data.startsWith("Acknowledged 0:")));
});

