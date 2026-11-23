import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const { values: options, positionals } = parseArgs({
  options: { live: { type: "string" } }, allowPositionals: true,
});
const output = join(project, ".demo-output");
mkdirSync(output, { recursive: true });
const run = mkdtempSync(join(output, "run-"));
const call = (name, args) => ({ id: name + "-" + ++counter, name, args });
const reply = (...calls) => ({ text: "", calls });
const final = text => ({ text });
let counter = 0;
const patch = (operation, file, lines) => call("apply_patch", {
  input: ["*** Begin Patch", `*** ${operation} File: ${file}`, ...lines, "*** End Patch"].join("\n"),
});

export const scenarios = {
  code: {
    prompts: ["Fix the failing total calculation. Read math.mjs and run node check.mjs before and after editing."],
    steps: [
      reply(call("read_file", { path: "math.mjs" }), call("Bash", { command: "node check.mjs" })),
      reply(patch("Update", "math.mjs", ["@@", "-  return items.reduce((sum, item) => sum + item, 1);", "+  return items.reduce((sum, item) => sum + item, 0);"])),
      reply(call("Bash", { command: "node check.mjs" })),
      final("Fixed the starting sum in math.mjs. Both checks passed (exit 0)."),
    ],
    verify(cwd, events, live) {
      assert.equal(readFileSync(join(cwd, "math.mjs"), "utf8"),
        readFileSync(join(project, "demo/fixtures/code/math.mjs"), "utf8").replace("item, 1", "item, 0"));
      assert.deepEqual(events.filter(e => e.type === "result" && e.data.name === "Bash")
        .map(e => e.data.result.value.exitCode), [1, 0]);
      assert.match(events.findLast(e => e.type === "final").data, live ? /pass|exit (?:code )?0/i : /exit 0/);
    },
  },
  report: {
    prompts: [
      "Read north.txt and south.txt. Create report.md with a shared finding, one difference and both source filenames. Preserve the exact heading # Pilot findings for all future revisions.",
      "Revise report.md. Add a one-sentence conclusion and keep the original heading and source filenames.",
    ],
    steps: [
      reply(call("read_file", { path: "north.txt" }), call("read_file", { path: "south.txt" })),
      reply(patch("Add", "report.md", ["+# Pilot findings", "+",
        "+Both pilots recommend a weekly status summary.", "+North prefers Monday and South prefers Friday.",
        "+", "+Sources: north.txt, south.txt"])),
      final("Created report.md with the common recommendation, scheduling difference and both sources."),
      reply(call("read_file", { path: "report.md" })),
      reply(patch("Update", "report.md", ["@@", " Sources: north.txt, south.txt", "+", "+Conclusion: Publish weekly and agree on a shared day."])),
      final("Added the conclusion and preserved the requested heading and source names."),
    ],
    verify(cwd, events, live) {
      const report = readFileSync(join(cwd, "report.md"), "utf8");
      assert.match(report, /^# Pilot findings\n/);
      assert.match(report, /weekly status summary/i);
      assert.match(report, /North[\s\S]*Monday/i);
      assert.match(report, /South[\s\S]*Friday/i);
      assert.match(report, /north\.txt/);
      assert.match(report, /south\.txt/);
      if (!live) assert.match(report, /Conclusion: Publish weekly and agree on a shared day/);
      assert.equal(events.filter(e => e.type === "status" && e.data === "completed").length, 2);
    },
  },
};

for (const name of positionals.length ? positionals : Object.keys(scenarios)) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`Choose a demo: code, report`);
  const cwd = join(run, name + " workspace");
  cpSync(join(project, "demo/fixtures", name), cwd, { recursive: true });
  const script = join(run, `${name}.json`);
  const sessions = join(run, `${name}-sessions`);
  const config = join(run, "demo-config.json");
  writeFileSync(script, JSON.stringify(scenario.steps));
  const live = options.live ? JSON.parse(readFileSync(options.live, "utf8")) : undefined;
  if (live && (!live.model || live.teamhub || live.hooks)) throw new Error("Live demo requires a standalone model config");
  writeFileSync(config, JSON.stringify({
    model: live?.model,
    permissions: { apply_patch: "allow", Bash: name === "code" ? "allow" : "deny" },
    allowedCommands: ["node check.mjs"],
    context: live ? 24000 : 4000,
  }));
  const result = spawnSync(process.execPath, [
    resolve(project, "dist/cli.js"), "--cwd", cwd, "--config", config,
    ...(live ? [] : ["--script", script]),
    "--sessions", sessions, ...scenario.prompts.flatMap(prompt => ["--prompt", prompt]),
  ], { encoding: "utf8", timeout: live ? 360_000 : 30_000 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.equal(result.status, 0, String(result.error ?? result.stderr));
  const events = readFileSync(join(sessions, readdirSync(sessions).find(file => file.endsWith(".jsonl"))), "utf8")
    .trim().split("\n").map(JSON.parse);
  scenario.verify(cwd, events, live);
  console.log(`[demo passed] ${name} ${cwd}`);
}
