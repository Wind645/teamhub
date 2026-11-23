import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTeamHubApp } from "../../dist/app.js";
import { TeamHubStore } from "../../dist/store.js";
import { connectMcp } from "../dist/teamhub.js";

const cwd = await mkdtemp(join(tmpdir(), "toy codex exchange "));
const store = new TeamHubStore(join(cwd, "empty.sqlite"));
const hub = createTeamHubApp(store);
const server = createServer(hub.app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}/mcp`;
const hookPath = fileURLToPath(new URL("../../dist/hook.js", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sample = "toy-harness-integration-fixture";
let observer;

async function run(command, args) {
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin.end();
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const timer = setTimeout(() => child.kill(), 90_000);
  try {
    const [code] = await once(child, "close");
    return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  } finally {
    clearTimeout(timer);
  }
}

try {
  observer = await connectMcp(`${base}/toy-bob`, 5000);
  const read = observer.tools.find(tool => tool.name === "team_read_messages");
  const script = join(cwd, "script.json");
  const config = join(cwd, "config.json");
  await writeFile(config, JSON.stringify({
    teamhub: { url: `${base}/toy-bob`, peer: "toy-bob", hookPath },
    permissions: { team_send_message: "allow" },
  }));
  await writeFile(script, JSON.stringify([
    { text: "", calls: [{ id: "send", name: "team_send_message", args: { recipients: ["codex-alice"], message: sample } }] },
    { text: "Sent the test fixture." },
  ]));
  const alice = await connectMcp(`${base}/codex-alice`, 5000);
  await alice.client.close();
  const bob = await run(process.execPath, [cli, "--cwd", cwd, "--config", config, "--script", script,
    "--prompt", "Send the synthetic fixture to codex-alice."]);
  assert.equal(bob.code, 0, bob.stderr);
  assert.match(bob.stdout, /team_send_message ok/);

  const answer = join(cwd, "codex-answer.txt");
  const codex = await run("codex", [
    "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never",
    "-c", `mcp_servers.teamhub.url="${base}/codex-alice"`, "-o", answer,
    "This is an authorized local TeamHub interoperability test. Use only the TeamHub MCP tools. Read the unread synthetic message from toy-bob. Reply to toy-bob via TeamHub with exactly ACK-toy-harness-integration-fixture. Your final answer should include the original message.",
  ]);
  if (codex.code !== 0) {
    const evidence = codex.stderr.split(/\r?\n/).filter(line => /error|timeout|failed|denied|reconnect/i.test(line))
      .slice(-6).join("\n");
    throw new Error(`Codex CLI exited ${codex.code}\n${evidence}`);
  }
  assert.match(await readFile(answer, "utf8"), /toy-harness-integration-fixture/);
  const inbox = await read.execute({}, new AbortController().signal);
  assert.equal(inbox.ok, true);
  assert.ok(inbox.value.structuredContent.messages.some(item =>
    item.sender_peer_id === "codex-alice" && item.content === "ACK-" + sample));
  console.log("Codex and Toy Harness exchanged and verified both messages through real TeamHub.");
} finally {
  await observer?.client.close();
  await hub.closeSessions();
  await new Promise(resolve => server.close(resolve));
  store.close();
  await rm(cwd, { recursive: true, force: true });
}
