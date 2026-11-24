import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { HttpModel } from "../../toy-harness/src/model.js";
import { openSession, type Config } from "../../toy-harness/src/session.js";
import { ApprovalGate } from "./approval.js";
import { offlineModel } from "./offline.js";
import type { ApprovalMode, Command, Issue, WorkerMessage, WorkerRequest } from "./protocol.js";

const send = (message: WorkerMessage) => { if (process.connected) process.send?.(message); };
const gate = new ApprovalGate(pending => send({ type: "pending", pending }));
let session: Awaited<ReturnType<typeof openSession>> | undefined;
let initialization: Promise<void> | undefined;
let work: Promise<unknown> | undefined;
let closing = false;
let credential: string | undefined;
let approvalMode: ApprovalMode = "request";

const issue = (error: unknown, kind: Issue["kind"] = "session"): Issue => {
  const detail = String(error);
  return { detail, kind: /TeamHub|MCP/i.test(detail) ? "hub" : kind };
};

async function initialize(message: Extract<WorkerRequest, { type: "init" }>) {
  const { member, directory, exists, profile, teamUrl, hookPath } = message;
  credential = message.key;
  const config: Config = { ...profile.config };
  if (teamUrl && member.peer) {
    config.teamhub = { url: teamUrl, peer: member.peer, hookPath, failClosed: true };
  }
  session = await openSession({
    cwd: await realpath(resolve(member.cwd)), directory,
    id: exists ? member.id : undefined, createId: member.id, config,
    model: journal => profile.mode === "offline" ? offlineModel(journal, member.peer)
      : new HttpModel(profile.config.model!, () => credential),
    async approve(tool, args, signal, identity) {
      if (approvalMode === "full" || approvalMode === "auto" && tool.name === "apply_patch") return true;
      return gate.wait({ ...identity, name: tool.name, args }, signal);
    },
    emit: event => send({ type: "event", event }), log: text => console.error(text),
    requireHub: Boolean(teamUrl),
  });
  await session.runtime.start();
  send({ type: "ready", events: session.journal.events });
}

async function close() {
  if (closing) return;
  closing = true;
  await initialization?.catch(() => {});
  session?.runtime.interrupt();
  await work?.catch(() => {});
  try { await session?.close(); }
  finally { credential = undefined; }
}

async function dispatch(command: Command) {
  if (command.type === "close") return close();
  if (!session || closing) throw new Error("Session is not ready");
  const { runtime, remote } = session;
  if (command.type === "approve") return gate.answer(command.key, command.allow);
  if (command.type === "interrupt") return runtime.interrupt();
  if (command.type === "rollback") return runtime.rollback(command.seq);
  if (command.type === "steer") return runtime.steer(command.text);
  if (command.type === "peers") {
    if (!remote) return [];
    const replies = await Promise.all(["team_get_state", "team_list_peers"].map(name =>
      remote.client.callTool({ name, arguments: {} }, { timeout: 2500 })));
    if (replies.some(reply => reply.isError)) throw new Error("TeamHub did not return peer status");
    return replies.map(reply => reply.structuredContent);
  }
  if (work || runtime.busy) throw new Error("A turn is already running");
  approvalMode = command.approvalMode ?? "request";
  work = (command.type === "submit" ? runtime.submit(command.text) : runtime.resume())
    .catch(error => send({ type: "fatal", issue: issue(error) }))
    .finally(() => { work = undefined; });
}

process.on("message", (message: WorkerRequest) => {
  if (message.type === "init" && !initialization) {
    initialization = initialize(message);
    void initialization.catch(error => {
      send({ type: "fatal", issue: issue(error) });
      void close().finally(() => process.disconnect());
    });
  } else if (message.type === "command") {
    void dispatch(message.command).then(
      result => {
        send({ type: "response", id: message.id, result });
        if (message.command.type === "close" && process.connected) process.disconnect();
      },
      error => send({ type: "response", id: message.id, issue: issue(error, message.command.type === "peers" ? "hub" : "session") }),
    );
  }
});
process.on("disconnect", () => { void close(); });
