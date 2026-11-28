import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell } from "electron";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { roomTranscript, type RoomMessage } from "./protocol.js";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Event } from "../../toy-harness/src/journal.js";
import schoolPreset from "../../toy-harness/examples/sustech.deepseek.json";
import type { ModelConfig } from "../../toy-harness/src/model.js";
import { accessModes, approvalModes, type Api, type ApprovalMode, type Command, type Conversation, type Issue, type Member, type Peer, type Profile, type SessionState, type Snapshot, type WorkerMessage, type WorkerRequest } from "./protocol.js";
import { initialProfile, migrateIndex, peerId, type MemberIndex, type MemberRecord } from "./members.js";
import { memberPet, PetActivity, type PetPreferences } from "./pet-state.js";
import { PetWindow } from "./pet-window.js";
import { coalesceUpdates, protectRenderer } from "./ui-health.js";
import { StatePublisher } from "./state-stream.js";

if (process.env.TEAMHUB_DESKTOP_DATA) app.setPath("userData", resolve(process.env.TEAMHUB_DESKTOP_DATA));
const data = app.getPath("userData");
const runtimeDir = app.isPackaged ? join(process.resourcesPath, "runtime") : join(__dirname, "runtime");
const bundledNode = join(runtimeDir, "node.exe");
const node = existsSync(bundledNode) ? bundledNode : process.execPath;
const school = schoolPreset.model as ModelConfig;
const indexPath = join(data, "desktop.json");
const petPath = join(data, "desktop-pets.json");
type Credential = { identity: string; value: string };
type MemberWindow = { window: BrowserWindow; record: MemberRecord; closing: boolean; saving: boolean; pickedWorkspace?: string };
const roomVersions = new Map<string, number>();
function roomFile(path: string) {
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  return join(data, "rooms", createHash("sha256").update(key).digest("hex") + ".json");
}
function readRoom(file: string): RoomMessage[] {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}
const sessions: Record<string, SessionState> = Object.create(null);
const workers = new Map<string, Worker>();
const windows = new Map<Peer, MemberWindow>();
const focusOrder = new Set<Peer>();
const startingTurns = new Set<Peer>();
const startingConversations = new Map<Peer, Member>();
const credentials = new Map<Peer, Credential>();
let index: MemberIndex = { version: 2, externalHub: "", members: [] };
let picker: BrowserWindow | undefined;
let ownedHub: { child: ChildProcess; promise: Promise<string> } | undefined;
let quitting = false;
let finished = false;
let changingHub = false;
let petPreferences: PetPreferences = { enabled: false };
const pets = new PetWindow(() => petPreferences, position => {
  try { savePets({ ...petPreferences, position }); }
  catch (cause) { console.error("Could not save desktop pet position", cause); }
}, focusPet, publishPets);

function savePets(next: PetPreferences) {
  atomic(petPath, JSON.stringify(next));
  petPreferences = next;
}

function petFor(record: MemberRecord, now: number) {
  return memberPet(conversationsOf(record).map(({ id }) => ({
    id, state: sessions[id], activity: workers.get(id)?.activity,
  })), record.active, now);
}

function publishPets() {
  if (!petPreferences.enabled || quitting) { pets.close(); return; }
  const now = Date.now();
  const recent = [...focusOrder].reverse();
  const order = [...new Set([...recent, ...windows.keys()])];
  let until: number | undefined;
  const members = order.flatMap(peer => {
    const owner = windows.get(peer);
    if (!owner) return [];
    const view = petFor(owner.record, now);
    if (view.until !== undefined) until = Math.min(until ?? Infinity, view.until);
    return [{ peer, ...view.status, lead: peer === order[0] }];
  });
  pets.update(members, until);
}

function focusPet(peer: Peer) {
  const owner = windows.get(peer);
  if (!owner || owner.closing || owner.window.isDestroyed() || quitting) return;
  focus(owner.window);
  const { target } = petFor(owner.record, Date.now());
  if (target && owner.record.active !== target) {
    try { select(owner, target); }
    catch (cause) { dialog.showErrorBox("无法打开待审批会话", String(cause)); }
  }
}

function error(kind: Issue["kind"], detail: string) { return { kind, detail }; }
function identity(profile: Profile) { return JSON.stringify(profile.config.model ?? null); }
function currentKey(peer: Peer, profile: Profile) {
  const key = credentials.get(peer);
  return key?.identity === identity(profile) ? key.value
    : profile.config.model?.keyEnv ? process.env[profile.config.model.keyEnv] : undefined;
}
function secureStorageAvailable() {
  return safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
}
function atomic(path: string, contents: string | Buffer) {
  const temp = path + ".tmp";
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, path);
}
function persist() { atomic(indexPath, JSON.stringify(index, null, 2)); }
const directory = (member: Member) => member.directory ?? join(data, "sessions");
const journalFile = (member: Member) => join(directory(member), member.id + ".jsonl");
const conversationsOf = (record: MemberRecord) => record.conversations.flatMap(group => group.members);
const memberOf = (record: MemberRecord, id?: string) => conversationsOf(record).find(member => member.id === id);
const keyPath = (peer: Peer) => join(data, "model-key-" + peer + ".bin");

function readLog(file: string): Event[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const end = text.lastIndexOf("\n");
  const complete = end >= 0 ? text.slice(0, end).trim() : "";
  return complete ? complete.split("\n").map(line => JSON.parse(line) as Event) : [];
}
function restore(member: Member): SessionState {
  try { return { phase: "idle", events: readLog(journalFile(member)) }; }
  catch (cause) { return { phase: "idle", events: [], issue: error("session", String(cause)) }; }
}
function load() {
  mkdirSync(data, { recursive: true });
  if (existsSync(petPath)) {
    try {
      const { enabled, position } = JSON.parse(readFileSync(petPath, "utf8"));
      petPreferences = {
        enabled: enabled === true,
        position: position && Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y) ?
          { x: position.x, y: position.y } : undefined,
      };
    } catch (cause) { console.error("Could not read desktop pet preferences", cause); }
  }
  if (existsSync(indexPath)) {
    const original = readFileSync(indexPath, "utf8");
    const saved = JSON.parse(original);
    if (saved.version === 2) index = saved;
    else {
      index = migrateIndex(saved);
      const backup = join(data, "desktop-v1.json");
      if (!existsSync(backup)) atomic(backup, original);
      const oldKey = join(data, "model-key.bin");
      if (secureStorageAvailable() && existsSync(oldKey)) {
        const encrypted = readFileSync(oldKey);
        for (const record of index.members) if (!existsSync(keyPath(record.peer))) atomic(keyPath(record.peer), encrypted);
      }
      persist();
    }
  }
  let movedApprovalMode = false;
  for (const record of index.members) {
    const { approvalMode, ...profile } = record.profile as Profile & { approvalMode?: ApprovalMode };
    if (approvalMode !== undefined) {
      if (approvalModes.includes(approvalMode)) {
        for (const member of conversationsOf(record)) member.approvalMode ??= approvalMode;
      }
      record.profile = profile;
      movedApprovalMode = true;
    }
    for (const member of conversationsOf(record)) sessions[member.id] = restore(member);
    if (secureStorageAvailable() && existsSync(keyPath(record.peer))) {
      try { credentials.set(record.peer, JSON.parse(safeStorage.decryptString(readFileSync(keyPath(record.peer))))); }
      catch (cause) { console.error("Could not restore model credential", String(cause)); }
    }
  }
  if (movedApprovalMode) persist();
}
function accessible(actor: MemberRecord, id?: string, write = false) {
  for (const record of index.members) {
    const member = memberOf(record, id);
    if (member && (record === actor || member.access === "edit" || !write && member.access === "view")) return { record, member };
  }
}
function editable(actor: MemberRecord, id: string) {
  const target = accessible(actor, id, true);
  if (!target || actor.active !== id) throw new Error("没有此对话的编辑权限");
  const host = windows.get(target.record.peer);
  if (host?.closing || host?.saving) throw new Error("所有者窗口正在切换状态");
  return target;
}
const snapshot = (record: MemberRecord): Snapshot => {
  const conversations = index.members.flatMap(host => host.conversations.flatMap(group => {
    const members = group.members.filter(m => host === record || m.access === "view" || m.access === "edit");
    return members.length ? [{ ...group, members: members.map(m => ({ ...m, peer: host.peer })) }] : [];
  }));
  return {
  roomVersions: Object.fromEntries([...new Set([...conversations.flatMap(g => g.members.map(m => m.cwd)), windows.get(record.peer)?.pickedWorkspace].filter((p): p is string => Boolean(p)))].map(p => [p, roomVersions.get(roomFile(p)) ?? 0])),
  peer: record.peer, profile: { ...record.profile, externalHub: index.externalHub },
  conversations, active: accessible(record, record.active) ? record.active : undefined,
  sessions: Object.fromEntries(conversations.flatMap(group => group.members.map(m => [m.id, sessions[m.id]]))),
  school, hasKey: Boolean(currentKey(record.peer, record.profile)), canStoreKey: secureStorageAvailable(),
  petsEnabled: petPreferences.enabled,
  };
};
const statePublisher = new StatePublisher();
function publish(peer?: Peer) {
  const shared = index.members.find(host => host.peer === peer)?.conversations.some(group => group.members.some(m => m.access === "edit" || m.access === "view"));
  for (const [id, { window, record }] of windows) {
    if ((peer === undefined || id === peer || shared) && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      statePublisher.publish(window.webContents, () => snapshot(record));
    }
  }
  publishPets();
}
const publishWorker = coalesceUpdates<Peer>(publish);
function child(entry: string, extra: NodeJS.ProcessEnv = {}, keyEnv?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...extra,
    ...(node === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
  for (const name of new Set([keyEnv, ...index.members.map(record => record.profile.config.model?.keyEnv)])) {
    if (name) delete env[name];
  }
  if (node !== process.execPath) {
    const pathKey = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = dirname(node) + (process.platform === "win32" ? ";" : ":") + (env[pathKey] ?? "");
  }
  const proc = fork(join(runtimeDir, entry + ".cjs"), [], {
    execPath: node, env, cwd: data, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  proc.stderr?.setEncoding("utf8");
  return proc;
}
function exited(proc: ChildProcess) {
  return proc.exitCode !== null || proc.signalCode !== null;
}
async function waitExit(proc: ChildProcess, timeout: number) {
  if (exited(proc) || !proc.pid) return;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { proc.off("exit", exit); reject(new Error("Process shutdown timed out")); }, timeout);
    const exit = () => { clearTimeout(timer); done(); };
    proc.once("exit", exit);
  });
}
async function killTree(proc: ChildProcess) {
  if (exited(proc) || !proc.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>(done => {
      const kill = spawn("taskkill.exe", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      kill.once("error", () => { proc.kill(); done(); });
      kill.once("exit", code => { if (code && !exited(proc)) proc.kill(); done(); });
    });
  } else proc.kill("SIGKILL");
  await waitExit(proc, 2000).catch(() => {});
}

function hubOrigin(text: string) {
  const url = new URL(text);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Hub 地址须为本机 HTTP 服务，例如 http://127.0.0.1:7878");
  }
  return url.origin;
}
async function checkHub(base: string) {
  const response = await fetch(base + "/health", { signal: AbortSignal.timeout(2500), redirect: "error" });
  if (!response.ok) throw new Error("Hub 健康检查失败");
  const info = await response.json();
  if (!info.ok || info.service !== "teamhub") throw new Error("该地址未返回 TeamHub 健康状态");
}
async function hub(external: string) {
  if (external) {
    const base = hubOrigin(external);
    await checkHub(base);
    return base;
  }
  if (!ownedHub) {
    const proc = child("hub", { TEAMHUB_HOST: "127.0.0.1", TEAMHUB_PORT: "0", TEAMHUB_DB: join(data, "teamhub.sqlite") });
    let stderr = "";
    proc.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-6000); });
    const promise = new Promise<string>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Hub 启动超时")), 6000);
      const failed = (cause: unknown) => { clearTimeout(timer); reject(cause); };
      proc.once("error", failed);
      proc.once("exit", code => failed(new Error(stderr || `Hub 已退出（${code}）`)));
      proc.once("message", async (message: { type?: string; port?: number }) => {
        clearTimeout(timer);
        try {
          if (message.type !== "listening" || !message.port) throw new Error("Hub 未返回监听端口");
          const base = "http://127.0.0.1:" + message.port;
          await checkHub(base);
          done(base);
        } catch (cause) { reject(cause); }
      });
    });
    ownedHub = { child: proc, promise };
    proc.once("exit", () => { if (ownedHub?.child === proc) ownedHub = undefined; });
    void promise.catch(() => {
      if (ownedHub?.child === proc) ownedHub = undefined;
      return killTree(proc);
    });
  }
  return ownedHub.promise;
}

class Worker {
  proc?: ChildProcess;
  ready: Promise<void>;
  activity = new PetActivity();
  private seq = 0;
  private readonly requests = new Map<number, { resolve: (value: unknown) => void; reject: (issue: Issue) => void }>();

  private closing = false;

  constructor(private member: Member, private peer: Peer, profile: Profile) {
    this.ready = this.start(profile);
  }

  private async start(profile: Profile) {
    const member = this.member;
    const state = sessions[member.id];
    state.phase = "starting";
    state.issue = undefined;
    try {
      let teamUrl: string | undefined;
      if (member.peer) {
        try { teamUrl = await hub(index.externalHub) + "/mcp/" + encodeURIComponent(this.peer); }
        catch (cause) { throw error("hub", String(cause)); }
      }
      if (quitting || this.closing) { state.phase = "idle"; return; }
      const proc = this.proc = child("worker", {}, profile.config.model?.keyEnv);
      let stderr = "";
      proc.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-6000); });
      await new Promise<void>((ready, reject) => {
        let started = false;
        const timer = setTimeout(() => reject(error("session", "会话启动超时")), 25_000);
        proc.once("error", cause => { clearTimeout(timer); reject(error("session", String(cause))); });
        proc.once("exit", code => {
          clearTimeout(timer);
          const problem = state.issue ?? error("session", stderr || `会话进程已退出（${code}）`);
          for (const request of this.requests.values()) request.reject(problem);
          this.requests.clear();
          if (!workers.has(member.id) || workers.get(member.id) === this) {
            state.phase = "idle";
            state.pending = undefined;
          }
          if (workers.get(member.id) === this) {
            workers.delete(member.id);
            state.issue = problem;
          }
          publish(this.peer);
          reject(problem);
        });
        proc.on("message", (message: WorkerMessage) => {
          const current = workers.get(member.id);
          if (current !== this && (current || !this.closing)) return;
          if (message.type === "ready") {
            clearTimeout(timer);
            started = true;
            state.events = message.events;
            this.activity = new PetActivity(message.events);
            state.phase = "ready";
            ready();
          } else if (message.type === "event") {
            state.events.push(message.event);
            if (started) this.activity.observe(message.event);
            if (message.event.type === "status" && message.event.data === "failed") {
              const notice = String(state.events.findLast(item => item.turn === message.event.turn && item.type === "notice")?.data ?? "");
              if (/credential environment variable/.test(notice)) state.issue = error("credential", notice);
              else if (/TeamHub|MCP|session expired/i.test(notice)) state.issue = error("hub", notice);
              else if (/fetch failed|Model HTTP|Model stream:|(?:Chat Completions|Responses) stream|Missing (Chat Completions|Responses)/i.test(notice)) state.issue = error("model", notice);
            }
          } else if (message.type === "pending") {
            state.pending = message.pending;
            this.activity.observeApproval(message.pending);
          } else if (message.type === "fatal") {
            if (!started) { clearTimeout(timer); reject(message.issue); }
            state.issue = message.issue;
          } else if (message.type === "response") {
            const request = this.requests.get(message.id);
            this.requests.delete(message.id);
            if (message.issue) request?.reject(message.issue);
            else request?.resolve(message.result);
          }
          if (message.type === "event" && message.event.type !== "status") publishWorker(this.peer);
          else publish(this.peer);
        });
        const message: WorkerRequest = {
          type: "init", member, directory: directory(member), exists: existsSync(journalFile(member)),
          profile, teamUrl, hookPath: join(runtimeDir, "hook.mjs"), key: currentKey(this.peer, profile),
        };
        proc.send(message, cause => { if (cause) { clearTimeout(timer); reject(error("session", String(cause))); } });
      });
    } catch (cause) {
      const issue = cause && typeof cause === "object" && "kind" in cause ? cause as Issue : error("session", String(cause));
      if (workers.get(member.id) === this) {
        state.issue = issue;
        state.phase = "idle";
      }
      if (this.proc) await killTree(this.proc);
      if (workers.get(member.id) === this) workers.delete(member.id);
      throw issue;
    } finally { publish(this.peer); }
  }

  async send(command: Command) {
    await this.ready;
    if (!this.proc?.connected) throw error("session", "会话进程未连接，请重试。");
    const proc = this.proc;
    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.seq;
      this.requests.set(id, { resolve, reject });
      const message: WorkerRequest = { type: "command", id, command };
      proc.send(message, cause => {
        if (cause) { this.requests.delete(id); reject(error("session", String(cause))); }
      });
    });
  }

  async close() {
    this.closing = true;
    try {
      await Promise.race([
        this.send({ type: "close" }).then(() => this.proc && waitExit(this.proc, 1500)),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("会话关闭超时")), 12_000);
          timer.unref();
        }),
      ]);
    } catch {
      if (this.proc) await killTree(this.proc);
    }
  }
}

function start(record: MemberRecord, member: Member) {
  let worker = workers.get(member.id);
  if (!worker) {
    worker = new Worker(member, record.peer, record.profile);
    workers.set(member.id, worker);
    void worker.ready.catch(() => {});
    publishPets();
  }
  return worker;
}
function warm(record: MemberRecord) {
  const target = accessible(record, record.active, true);
  if (target) start(target.record, target.member);
}
function isRunning(state: SessionState) {
  return Boolean(state.pending || state.phase === "ready" && activeEvents(state.events).findLast(event => event.type === "status")?.data === "running");
}
function hasWork(record: MemberRecord) {
  return startingTurns.has(record.peer) ||
    conversationsOf(record).some(({ id }) => sessions[id].phase === "starting" || isRunning(sessions[id]));
}
async function stopWorkers(record: MemberRecord) {
  const members = conversationsOf(record);
  const starting = startingConversations.get(record.peer);
  if (starting) members.push(starting);
  await Promise.all(members.map(async ({ id }) => {
    const worker = workers.get(id);
    if (!worker) return;
    workers.delete(id);
    await worker.close();
  }));
}
async function stopHub() {
  const proc = ownedHub?.child;
  ownedHub = undefined;
  if (!proc || exited(proc)) return;
  try {
    if (proc.connected) proc.disconnect();
    await waitExit(proc, 3500);
  } catch { await killTree(proc); }
}
async function confirmClose(window: BrowserWindow, message: string, quit: boolean) {
  const answer = await dialog.showMessageBox(window, {
    type: "question", title: quit ? "退出 TeamHub" : "关闭成员窗口", message,
    buttons: ["返回", quit ? "中断并退出" : "中断并关闭"], defaultId: 0, cancelId: 0, noLink: true,
  });
  return answer.response === 1;
}

function activeEvents(events: Event[]) {
  let result: Event[] = [];
  for (const event of events) {
    if (event.type === "rollback") result = result.filter(item => item.seq <= Number(event.data));
    else result.push(event);
  }
  return result;
}
function profileOf(value: Profile): Profile {
  if (!value || !["offline", "model"].includes(value.mode) || typeof value.externalHub !== "string" ||
      !value.config || typeof value.config !== "object") throw new Error("模型设置格式无效");
  const { model, permissions, allowedCommands, hookTimeout, steps, context, commandTimeout, outputLimit, turnTimeout, autoPause } = value.config;
  if (autoPause !== undefined && typeof autoPause !== "boolean") throw new Error("自动暂停设置必须为开或关");
  if (value.mode === "model" || model) {
    if (!model || !model.name?.trim() || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(model.keyEnv) ||
        (model.protocol && !["chat", "responses"].includes(model.protocol))) throw new Error("请填写模型、协议和密钥环境变量名");
    const url = new URL(model.endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("模型 endpoint 格式无效");
  }
  if (permissions && (typeof permissions !== "object" || Array.isArray(permissions) ||
      Object.values(permissions).some(item => !["allow", "ask", "deny"].includes(item)))) throw new Error("工具权限格式无效");
  if (allowedCommands && (!Array.isArray(allowedCommands) || allowedCommands.some(command => typeof command !== "string"))) {
    throw new Error("命令限制格式无效");
  }
  return { mode: value.mode, externalHub: value.externalHub.trim() ? hubOrigin(value.externalHub.trim()) : "",
    config: { model: model && { name: model.name, endpoint: model.endpoint, protocol: model.protocol, keyEnv: model.keyEnv },
      permissions, allowedCommands, hookTimeout, steps, context, commandTimeout, outputLimit, turnTimeout, autoPause } };
}
function select({ window, record }: MemberWindow, id?: string) {
  const member = accessible(record, id)?.member;
  if (id && !member) throw new Error("找不到会话");
  record.active = id;
  if (member) record.cwd = member.cwd;
  persist();
  titleMember(window, record);
  warm(record);
  publish(record.peer);
}
function checkNewTurn(record: MemberRecord, id?: string) {
  if (startingTurns.has(record.peer) || conversationsOf(record).some(other => other.id !== id && isRunning(sessions[other.id]))) {
    throw error("session", "此成员已有回合在运行。请先完成或中断该回合。");
  }
  if (record.profile.mode === "model" && !currentKey(record.peer, record.profile)) {
    throw error("credential", `请输入本次使用的密钥，或在启动前设置 ${record.profile.config.model?.keyEnv}。`);
  }
}
function validatePrompt(text: string) {
  if (typeof text !== "string" || !text.trim() || text.length > 100_000) throw new Error("任务内容无效");
}
function add(owner: MemberWindow, group: Conversation) {
  owner.record.conversations.unshift(group);
  for (const member of group.members) sessions[member.id] = restore(member);
  select(owner, group.members[0].id);
  return group.members[0].id;
}
function memberApi(owner: MemberWindow): Omit<Api, "subscribe" | "members" | "openMember" | "watchState" | "ackState"> {
  const { window, record } = owner;
  function checkedRoom(path: string) {
    if (owner.pickedWorkspace !== path && !index.members.some(host => conversationsOf(host).some(m =>
      m.cwd === path && (host === record || m.access === "edit" || m.access === "view")))) throw new Error("无法访问此工作区");
    return roomFile(path);
  }
  return {
    async room(path) { return readRoom(checkedRoom(path)); },
    async postRoom(path, text) {
      const file = checkedRoom(path);
      if (typeof text !== "string" || !text.trim() || text.length > 20000) throw new Error("请输入 1 至 20000 字的消息");
      const messages = readRoom(file);
      messages.push({ id: randomUUID(), peer: record.peer, at: new Date().toISOString(), text: text.trim() });
      mkdirSync(dirname(file), { recursive: true });
      atomic(file, JSON.stringify(messages));
      roomVersions.set(file, (roomVersions.get(file) ?? 0) + 1);
      publish();
    },
    async exportRoom(path) {
      const messages = readRoom(checkedRoom(path));
      const result = await dialog.showSaveDialog(window, { defaultPath: basename(path) + "-聊天室.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
      if (!result.canceled && result.filePath) writeFileSync(result.filePath, "# " + basename(path) + " · 聊天室\n\n" + roomTranscript(messages) + "\n");
    },
    async memberPicker() { openPicker(); },
    async setPetsEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new Error("桌宠设置无效");
      savePets({ ...petPreferences, enabled });
      publish();
    },
    async state() { return snapshot(record); },
    async folder() {
      const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "选择项目文件夹", defaultPath: record.cwd });
      if (result.canceled) return undefined;
      owner.pickedWorkspace = realpathSync(result.filePaths[0]);
      return owner.pickedWorkspace;
    },
    async create(path, text, approvalMode = "request") {
      validatePrompt(text);
      if (!approvalModes.includes(approvalMode)) throw new Error("权限模式无效");
      if (typeof path !== "string" || !isAbsolute(path)) throw new Error("请选择工作目录");
      const cwd = realpathSync(path);
      if (!statSync(cwd).isDirectory()) throw new Error("工作目录不可用");
      const member = { id: randomUUID(), cwd, peer: record.peer, approvalMode };
      const { id } = member;
      const state = restore(member);
      try { checkNewTurn(record); }
      catch (cause) { return { issue: cause as Issue }; }
      startingTurns.add(record.peer);
      startingConversations.set(record.peer, member);
      sessions[id] = state;
      try {
        const worker = start(record, member);
        try { await worker.send({ type: "submit", text, approvalMode }); }
        catch (cause) { if (!state.events.some(event => event.type === "user")) throw cause; }
        if (!state.events.some(event => event.type === "user")) throw state.issue ?? error("session", "首条消息未写入，请重试。");
        record.conversations.unshift({ id: randomUUID(), created: Date.now(), members: [member] });
        startingConversations.delete(record.peer);
        if (window.isDestroyed() || owner.closing || quitting) persist();
        else select(owner, id);
        return { id };
      } catch (cause) {
        return { issue: cause && typeof cause === "object" && "kind" in cause ? cause as Issue : error("session", String(cause)) };
      } finally {
        if (startingConversations.delete(record.peer)) {
          const worker = workers.get(id);
          workers.delete(id);
          try {
            await worker?.close();
            if (!state.events.some(event => event.type === "user")) rmSync(journalFile(member), { force: true });
          } finally { delete sessions[id]; }
        }
        startingTurns.delete(record.peer);
      }
    },
    async importSession() {
      const result = await dialog.showOpenDialog(window!, { properties: ["openFile"], title: "导入会话日志", filters: [{ name: "会话日志", extensions: ["jsonl"] }] });
      if (result.canceled) return;
      const file = realpathSync(result.filePaths[0]);
      const id = basename(file, ".jsonl");
      const events = readLog(file);
      const cwd = events[0]?.data;
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || events[0]?.type !== "session" || typeof cwd !== "string" ||
          !isAbsolute(cwd) || events.some((item, i) => item.seq !== i + 1)) throw new Error("会话日志格式无效");
      const existing = memberOf(record, id);
      if (existing) {
        if (journalFile(existing) !== file) throw new Error("已有同 ID 的会话");
        select(owner, id);
        return id;
      }
      if (index.members.some(other => memberOf(other, id))) throw new Error("该会话已归属另一个成员");
      return add(owner, { id: randomUUID(), created: Date.now(), members: [{ id, cwd, directory: dirname(file), peer: record.peer }] });
    },
    async select(id) { select(owner, id); },
    async setAccess(id, mode) {
      const member = memberOf(record, id);
      if (!member || !accessModes.includes(mode)) throw new Error("仅所有者可修改访问权限");
      const previous = member.access;
      member.access = mode;
      try { persist(); } catch (cause) { member.access = previous; throw cause; }
      publish();
    },
    async setApprovalMode(id, mode) {
      const { member, record } = editable(owner.record, id);
      if (!member || !approvalModes.includes(mode)) throw new Error("无效的会话或权限模式");
      const previous = member.approvalMode;
      member.approvalMode = mode;
      try { persist(); }
      catch (error) { member.approvalMode = previous; throw error; }
      publish(record.peer);
    },
    async command(id, command) {
      if (owner.saving || owner.closing || changingHub || quitting) throw new Error("应用正在切换状态，请稍后重试");
      const { record, member } = editable(owner.record, id);
      if (!member || !command || !["submit", "steer", "approve", "interrupt", "resume", "rollback"].includes(command.type)) {
        throw new Error("无效的会话操作");
      }
      if (command.type === "submit" || command.type === "steer") validatePrompt(command.text);
      if (command.type === "approve" && !workers.has(id)) return false;
      const state = sessions[id];
      if (command.type === "submit" || command.type === "resume") {
        try { checkNewTurn(record, id); }
        catch (cause) {
          const issue = cause as Issue;
          if (issue.kind === "credential") { state.issue = issue; publish(record.peer); }
          throw issue;
        }
        state.issue = undefined;
        startingTurns.add(record.peer);
        try { return await start(record, member).send({ ...command, approvalMode: member.approvalMode }); }
        finally { startingTurns.delete(record.peer); }
      }
      return start(record, member).send(command);
    },
    async retry(id) {
      const { record, member } = editable(owner.record, id);
      if (!member) throw new Error("找不到会话");
      const worker = workers.get(id);
      if (worker && sessions[id].events.findLast(item => item.type === "status")?.data !== "running") {
        workers.delete(id);
        await worker.close();
      }
      editable(owner.record, id);
      await start(record, member).ready;
    },
    async peers(id) {
      const member = memberOf(record, id);
      if (!member?.peer) return [];
      return start(record, member).send({ type: "peers" });
    },
    async importProfile() {
      const result = await dialog.showOpenDialog(window!, { properties: ["openFile"], title: "导入模型配置", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (result.canceled) return;
      return profileOf({ mode: "model", config: JSON.parse(readFileSync(result.filePaths[0], "utf8").replace(/^\uFEFF/, "")), externalHub: index.externalHub });
    },
    async saveProfile(value, enteredKey, saveKey, clear) {
      const profile = profileOf(value);
      const switchHub = index.externalHub !== profile.externalHub;
      if (owner.saving || changingHub || hasWork(record) || switchHub &&
          (index.members.some(hasWork) || [...windows.values()].some(other => other.saving || other.closing))) {
        throw new Error("请先等受影响的会话结束，或中断回合。");
      }
      if (enteredKey !== undefined && typeof enteredKey !== "string") throw new Error("密钥格式无效");
      owner.saving = true;
      changingHub = switchHub;
      try {
        if (saveKey && !secureStorageAvailable()) throw new Error("系统安全存储不可用");
        const affected = switchHub ? index.members : [record];
        await Promise.all(affected.map(stopWorkers));
        if (switchHub) await stopHub();
        if (clear) {
          rmSync(keyPath(record.peer), { force: true });
          credentials.delete(record.peer);
        }
        if (enteredKey?.trim()) {
          const next = { identity: identity(profile), value: enteredKey.trim() };
          if (saveKey) atomic(keyPath(record.peer), safeStorage.encryptString(JSON.stringify(next)));
          credentials.set(record.peer, next);
        }
        record.profile = profile;
        index.externalHub = profile.externalHub;
        persist();
        for (const item of affected) if (!windows.get(item.peer)?.closing) warm(item);
      } finally {
        if (switchHub) changingHub = false;
        owner.saving = false;
        publish(switchHub ? undefined : record.peer);
      }
    },
    async artifact(id, seq, action) {
      const member = memberOf(record, id);
      const event = activeEvents(sessions[id]?.events ?? []).find(item => item.seq === seq && item.type === "result");
      const path = (event?.data as { result?: { artifact?: string } } | undefined)?.result?.artifact;
      if (!member || !path || !["open", "show"].includes(action)) throw new Error("找不到该产物");
      const root = realpathSync(member.cwd);
      const target = realpathSync(resolve(root, path));
      const rel = relative(root, target);
      if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw new Error("产物不在工作区内");
      if (action === "show") shell.showItemInFolder(target);
      else {
        const failure = await shell.openPath(target);
        if (failure) throw new Error(failure);
      }
    },
    async confirm(title, detail) {
      const answer = await dialog.showMessageBox(window!, {
        type: "question", title, message: title, detail, buttons: ["取消", "恢复历史"], defaultId: 0, cancelId: 0, noLink: true,
      });
      return answer.response === 1;
    },
  };
}

function focus(window: BrowserWindow) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function titleMember(window: BrowserWindow, record: MemberRecord) {
  window.setTitle(`TeamHub · ${record.peer} · ${record.cwd ?? "未选择工作目录"}`);
}
function createWindow(title: string, chooser = false) {
  const window = new BrowserWindow({
    title, width: chooser ? 520 : 1280, height: chooser ? 520 : 800,
    minWidth: chooser ? 380 : 530, minHeight: 440, show: false,
    icon: join(__dirname, "ui", "teamhub.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#211c19" : "#faf6ed",
    webPreferences: { preload: join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  protectRenderer(window, dialog, data);
  window.webContents.on("will-navigate", event => {
    if (event.url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on("page-title-updated", event => event.preventDefault());
  window.once("ready-to-show", () => focus(window));
  return window;
}
function loadWindow(window: BrowserWindow, chooser = false) {
  return window.loadFile(join(__dirname, "ui", "index.html"), { query: chooser ? { view: "members" } : {} });
}
function openPicker() {
  if (picker && !picker.isDestroyed()) { focus(picker); return; }
  if (quitting || changingHub) return;
  const window = picker = createWindow("TeamHub · 选择成员", true);
  window.on("closed", () => { if (picker === window) picker = undefined; });
  void loadWindow(window, true).catch(cause => {
    dialog.showErrorBox("成员选择器打开失败", String(cause));
    window.destroy();
  });
}
async function openMember(input: string) {
  if (quitting || changingHub) throw new Error("TeamHub 正在切换状态，请稍后重试");
  const peer = peerId(input);
  const existing = windows.get(peer);
  if (existing) {
    if (existing.closing) throw new Error("该成员正在关闭，请稍后重试");
    focus(existing.window);
    picker?.close();
    return;
  }
  let record = index.members.find(item => item.peer === peer);
  if (!record) {
    record = { peer, profile: { ...initialProfile }, conversations: [] };
    index.members.push(record);
    persist();
  }
  const window = createWindow("TeamHub");
  const owner = { window, record, closing: false, saving: false };
  windows.set(peer, owner);
  titleMember(window, record);
  window.on("focus", () => {
    focusOrder.delete(peer);
    focusOrder.add(peer);
    publishPets();
  });
  window.on("close", event => {
    if (finished) return;
    event.preventDefault();
    if (quitting || owner.closing || owner.saving || changingHub) return;
    owner.closing = true;
    void (async () => {
      try {
        if (hasWork(owner.record) && !await confirmClose(window, "此成员还有会话正在工作。", false)) return;
        await stopWorkers(owner.record);
        window.destroy();
      } finally { owner.closing = false; }
    })().catch(cause => dialog.showErrorBox("关闭成员窗口失败", String(cause)));
  });
  window.on("closed", () => {
    if (windows.get(peer) !== owner) return;
    windows.delete(peer);
    focusOrder.delete(peer);
    publishPets();
  });
  try {
    await loadWindow(window);
    warm(record);
    publish(peer);
    picker?.close();
  } catch (cause) {
    window.destroy();
    throw cause;
  }
}
async function prepareQuit() {
  if (quitting || changingHub || [...windows.values()].some(owner => owner.saving || owner.closing)) return;
  quitting = true;
  const busy = [...windows.values()].find(owner => hasWork(owner.record));
  if (busy && !await confirmClose(busy.window, "还有成员正在工作。", true)) {
    quitting = false;
    return;
  }
  await Promise.all(index.members.map(stopWorkers));
  await stopHub();
  pets.close();
  credentials.clear();
  finished = true;
  app.quit();
}
function registerApi() {
  for (const channel of ["watch-state", "ack-state"]) ipcMain.on("teamhub:" + channel, (event, revision) => {
    if (event.senderFrame !== event.sender.mainFrame) return;
    const owner = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!owner || owner.closing || quitting) return;
    if (channel === "watch-state") statePublisher.watch(event.sender, () => snapshot(owner.record));
    else if (Number.isSafeInteger(revision)) statePublisher.ack(event.sender, revision);
  });
  const pickerApi = {
    async members() {
      return index.members.map(({ peer, cwd }) => ({ peer, cwd, open: windows.has(peer) }));
    },
    openMember,
  };
  const channels: Array<keyof Omit<Api, "subscribe" | "watchState" | "ackState">> = [
    "members", "openMember", "memberPicker", "state", "folder", "create", "importSession", "room", "postRoom", "exportRoom",
    "select", "setAccess", "setApprovalMode", "command", "retry", "peers", "importProfile", "saveProfile", "artifact", "confirm", "setPetsEnabled",
  ];
  for (const name of channels) ipcMain.handle("teamhub:" + name, async (event, ...args) => {
    try {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error("无效的应用请求");
      const owner = [...windows.values()].find(item => item.window.webContents === event.sender);
      const fromPicker = picker?.webContents === event.sender;
      const picks = name === "members" || name === "openMember";
      if ((picks && !fromPicker) || (!picks && (!owner || owner.closing || quitting ||
          (changingHub || owner.saving) && !["state", "confirm"].includes(name)))) throw new Error("无效的应用请求或窗口正在切换状态");
      const method = picks ? pickerApi[name] : memberApi(owner!)[name];
      return { ok: true, value: await (method as (...input: unknown[]) => unknown)(...args) };
    } catch (cause) {
      const issue = cause && typeof cause === "object" && "kind" in cause ? cause as Issue : error("session", String(cause));
      return { ok: false, issue };
    }
  });
}

if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on("second-instance", () => { void app.whenReady().then(openPicker); });
  app.on("window-all-closed", () => { void prepareQuit(); });
  app.on("before-quit", event => {
    if (!finished) { event.preventDefault(); void prepareQuit(); }
  });
  void app.whenReady().then(() => {
    load();
    registerApi();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "窗口", submenu: [
        { label: "新建成员窗口", accelerator: "CmdOrCtrl+Shift+N", click: openPicker },
        { type: "separator" },
        { label: "关闭当前窗口", role: "close" },
        { label: "退出 TeamHub", role: "quit" },
      ] },
      { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    ]));
    openPicker();
  }).catch(cause => {
    dialog.showErrorBox("TeamHub 启动失败", String(cause));
    finished = true;
    app.quit();
  });
}
