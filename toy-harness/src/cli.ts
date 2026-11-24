import { realpath, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import type { Event } from "./journal.js";
import { HttpModel, ScriptModel, type Args, type Reply } from "./model.js";
import type { Approval } from "./runtime.js";
import { openSession, type Config } from "./session.js";
import type { Result } from "./tools.js";

function show(event: Event) {
  const data = event.data;
  if (event.type === "request") {
    const { call } = data as { call: { name: string; id: string; args: Args } };
    console.log(`[tool ${call.id}] ${call.name} ${JSON.stringify(call.args)}`);
  } else if (event.type === "execute") {
    const { call } = data as { call: { name: string; id: string } };
    console.log(`[execute ${call.id}] ${call.name}`);
  } else if (event.type === "result") {
    const { name, id, result } = data as { name: string; id: string; result: Result };
    const text = result.reason ?? JSON.stringify(result.value) ?? "";
    console.log(`[result ${id}] ${name} ${result.ok ? "ok" : "failed"} ${text.slice(0, 400)}`);
    if (result.artifact) console.log(`[artifact] ${result.artifact}`);
  } else if (event.type === "final") {
    console.log(`\n${String(data)}\n`);
  } else if (["status", "model", "permission", "notice", "uncertain", "steer", "rollback"].includes(event.type)) {
    console.log(`[${event.type}] ${JSON.stringify(data)}`);
    if (event.type === "rollback") console.log("Conversation restored. Files, commands and remote effects remain on disk or at the service.");
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string" }, config: { type: "string" }, script: { type: "string" },
      sessions: { type: "string", default: ".sessions" }, session: { type: "string" },
      prompt: { type: "string", multiple: true }, help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("node dist/cli.js --cwd PATH [--config FILE | --script FILE] [--sessions DIR] [--session ID] [--prompt TEXT ...]");
    return;
  }
  const cwd = await realpath(resolve(values.cwd ?? "."));
  const config: Config = values.config ? JSON.parse(await readFile(values.config, "utf8")) as Config : {};
  const model = values.script
    ? new ScriptModel(JSON.parse(await readFile(values.script, "utf8")) as Reply[])
    : new HttpModel(config.model ?? {
      name: "gpt-4.1-mini", endpoint: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY",
    });

  const interactive = values.prompt === undefined;
  let approval: ((value: boolean) => void) | undefined;
  const approve: Approval = async (tool, args, signal) => {
    if (!interactive) return false;
    console.log(`[approval] ${tool.name} ${JSON.stringify(args)}. Enter /yes or /no`);
    return new Promise(resolveAnswer => {
      const abort = () => approval?.(false);
      approval = value => {
        approval = undefined;
        signal.removeEventListener("abort", abort);
        resolveAnswer(value);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  const session = await openSession({
    cwd, directory: resolve(values.sessions), id: values.session, config,
    model: () => model, approve, emit: show, log: text => console.error(text),
  });
  const { journal, runtime } = session;
  console.log(`[session] ${journal.id} ${journal.file}`);
  console.log("Approved shell commands run with your OS permissions. The workspace directory is their starting directory, not a sandbox.");
  try {
    await runtime.start();
    if (values.prompt) {
      for (const prompt of values.prompt) {
        await runtime.submit(prompt);
        if (journal.events.at(-1)?.data !== "completed") {
          process.exitCode = 1;
          break;
        }
      }
      return;
    }
    const ui = createInterface({
      input: process.stdin, output: process.stdout,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      prompt: "toy> ",
    });
    let work: Promise<unknown> | undefined;
    let closed = false;
    const closedUi = new Promise<void>(done => ui.once("close", () => {
      closed = true;
      done();
    }));
    const prompt = () => { if (!closed) ui.prompt(); };
    const launch = (job: Promise<unknown>) => {
      work = job.catch(error => console.error(String(error))).finally(() => {
        work = undefined;
        prompt();
      });
    };
    const interrupt = () => {
      if (runtime.busy) runtime.interrupt();
      else ui.close();
    };
    process.on("SIGINT", interrupt);
    ui.on("SIGINT", interrupt);
    ui.on("line", raw => {
      const line = raw.trim();
      try {
        if (!line) return;
        if (line === "/exit") { ui.close(); return; }
        if (line === "/interrupt") { runtime.interrupt(); return; }
        if (line === "/yes" || line === "/no") {
          if (!approval) throw new Error("No approval is pending");
          approval(line === "/yes");
          return;
        }
        if (line === "/checkpoints") {
          for (const e of journal.active().filter(e => e.type === "session" || e.type === "status" && e.data !== "running")) {
            console.log(`#${e.seq} ${e.type} ${e.data}`);
          }
          return;
        }
        if (line.startsWith("/rollback ")) { runtime.rollback(Number(line.slice(10))); return; }
        if (runtime.busy) { runtime.steer(line.replace(/^\/steer\s+/, "")); return; }
        if (line === "/resume") launch(runtime.resume());
        else if (line.startsWith("/")) throw new Error("Unknown command");
        else launch(runtime.submit(line));
      } catch (error) {
        console.error(String(error));
      } finally {
        prompt();
      }
    });
    console.log("/yes /no /interrupt /resume /checkpoints /rollback <seq> /exit");
    prompt();
    await closedUi;
    process.off("SIGINT", interrupt);
    runtime.interrupt();
    await work;
  } finally {
    await session.close();
  }
}

main().catch(error => {
  console.error(String(error));
  process.exitCode = 1;
});
