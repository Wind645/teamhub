import React, { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { subscribeLiveState } from "./live-state.js";
import { activeEvents, timelineRows } from "./timeline-model.js";
import { createRoot } from "react-dom/client";
import { ArrowUp, Check, ChevronDown, CircleAlert, Clock, FileText, Folder, FolderOpen, Hand, History, LoaderCircle, Menu, Plus, RotateCcw, Settings, ShieldAlert, ShieldCheck, Square, Terminal, Users, X } from "lucide-react";
import Markdown from "react-markdown";
import gfm from "remark-gfm";
import { Download, MessagesSquare, Quote } from "lucide-react";
import { roomTranscript, type RoomMessage } from "../src/protocol";
import { accessModes, type AccessMode, approvalModes, type Api, type ApprovalMode, type Command, type Issue, type LocalMember, type Member, type Pending, type Profile, type SessionState, type Snapshot } from "../src/protocol";
import type { Event } from "../../toy-harness/src/journal";
import "./style.css";
import { HistoryWindow, toolIndex } from "./history-performance";

declare global { interface Window { teamhub: Api } }
const api = window.teamhub;
const name = (member?: Member) => member?.peer ?? "助手";
const base = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
const accessLabels = { private: "私有", view: "他人可观看", edit: "他人可编辑" };
const phases: Record<string, string> = { running: "运行中", completed: "已完成", interrupted: "已中断", failed: "失败", paused: "已暂停", idle: "就绪" };
const issueNames = { credential: "缺少模型密钥", model: "模型连接失败", hub: "Hub 离线", session: "会话不可用" };
const approvalOptions = {
  request: { label: "请求批准", detail: "逐次确认需要审批的工具调用。", icon: Hand },
  auto: { label: "自动审批", detail: "工作区补丁自动通过，Shell 和需审批的协作操作仍需确认。", icon: ShieldCheck },
  full: { label: "完全访问", detail: "跳过手动审批，Shell 使用当前系统用户的权限。", icon: ShieldAlert },
};
const stringify = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
const friendly = (text: string) => ({
  "Denied by local tool policy": "已按本地工具权限拒绝",
  "Tool call skipped because a newer user instruction arrived": "已跳过旧调用，等待处理追加指令",
  "User interrupted": "用户已中断",
} as Record<string, string>)[text] ?? text;
function status(state?: SessionState, events = activeEvents(state?.events ?? [])) {
  if (state?.pending) return { key: "pending", text: "等待审批" };
  if (state?.phase === "starting") return { key: "running", text: "连接中" };
  const last = String(events.findLast(event => event.type === "status")?.data ?? "idle");
  const key = last === "running" && state?.phase !== "ready" ? "paused" : last;
  return { key, text: phases[key] ?? key };
}
function IconButton({ label, click, children, pressed, disabled }: {
  label: string; click: () => void; children: ReactNode; pressed?: boolean; disabled?: boolean;
}) {
  return <button type="button" className="icon-button" title={label} aria-label={label} aria-pressed={pressed}
    disabled={disabled} onClick={click}>{children}</button>;
}
function BrandMark() {
  return <img className="brand-mark" src="./teamhub.png" alt="" width={32} height={32} />;
}
const Status = React.memo(function Status({ state }: { state?: SessionState }) {
  const label = status(state);
  return <span className={"status " + label.key}><i />{label.text}</span>;
});
const RichText = React.memo(function RichText({ text }: { text: string }) {
  return <div className="markdown"><Markdown skipHtml remarkPlugins={[gfm]} components={{
    a: ({ children }) => <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
  }}>{text}</Markdown></div>;
});
function Reasoning({ id, text, active }: { id: string; text: string; active: boolean }) {
  const [choice, setChoice] = useState<boolean>();
  const expanded = choice ?? active;
  return <div className="reasoning">
    <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setChoice(!expanded)}>
      <ChevronDown size={15} aria-hidden="true" />{active ? "思考中" : "思考过程"}
    </button>
    {expanded && <div id={id} className="reasoning-body">{active ? <div className="streaming-text">{text}</div> : <RichText text={text} />}</div>}
  </div>;
}
function Disclosure({ label, text }: { label: string; text: string }) {
  return <details className="disclosure"><summary>{label}</summary><pre>{text}</pre></details>;
}
function IssueBox({ issue, settings, retry }: { issue: Issue; settings: () => void; retry?: () => void }) {
  return <section className="issue" role="alert">
    <div><CircleAlert size={16} /><strong>{issueNames[issue.kind]}</strong></div>
    <details><summary>错误详情</summary><pre>{issue.detail}</pre></details>
    <div className="actions">
      {issue.kind !== "session" && <button onClick={settings}>{issue.kind === "hub" ? "Hub 设置" : "模型设置"}</button>}
      {retry && <button onClick={retry}><RotateCcw size={14} />重试连接</button>}
      <button onClick={event => {
        const button = event.currentTarget;
        void navigator.clipboard.writeText(issue.detail).then(() => { button.textContent = "已复制"; }).catch(() => {});
      }}>复制详情</button>
    </div>
  </section>;
}

function ToolRow({ event, events, pending, member, act, report, shared, readOnly }: {
  event: Event; events: Event[]; pending?: Pending; member: Member; shared: boolean; readOnly: boolean;
  act: (request: Pending, allow: boolean) => Promise<unknown>; report: (error: unknown) => void;
}) {
  const { request, call } = event.data as { request: number; call: { name: string; id: string; args?: Record<string, unknown> } };
  const resultEvent = toolIndex(events).results.get(request);
  const result = (resultEvent?.data as { result: { ok: boolean; value?: unknown; artifact?: string; reason?: string } } | undefined)?.result;
  const uncertain = toolIndex(events).uncertain.has(request);
  const approval = pending?.request === request && pending.turn === event.turn && pending.callId === call.id ? pending : undefined;
  const [answered, setAnswered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const args = approval?.args ?? call.args ?? {};
  const patch = typeof args.input === "string" && call.name === "apply_patch" ? args.input : undefined;
  const command = args.command ? String(args.command) : undefined;
  const recipient = Array.isArray(args.recipients) ? args.recipients.join("、") : undefined;
  const object = patch?.match(/^\*\*\* (?:Add|Update) File: (.+)$/m)?.[1] ??
    (args.path ? String(args.path) : command ?? recipient);
  const state = uncertain ? "待核实" : result ? result.ok ? "成功" : "未完成" : approval ? "等待审批" : "进行中";
  const detail = expanded || approval ? patch ?? (command ? command + "\n\n工作目录  " + member.cwd :
    recipient ? "收件人  " + recipient + "\n\n" + stringify(args.message) : stringify(args)) : "";
  const handle = (allow: boolean) => {
    if (!approval || answered) return;
    setAnswered(true);
    void act(approval, allow).catch(error => { setAnswered(false); report(error); });
  };
  return <div className="tool">
    <details onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
      <summary><Terminal size={15} /><span className="tool-title"><code>{call.name}</code>{object && <span title={object}> · {object}</span>}</span>
        <span className={"tool-state " + (approval || uncertain ? "attention" : "")}>{state}</span><ChevronDown size={15} className="chevron" /></summary>
      {expanded && <div className="tool-body">
        <pre>{detail}</pre>
        {result?.reason && <p>{friendly(result.reason)}</p>}
        {result?.value !== undefined && <Disclosure label="工具输出" text={stringify(result.value)} />}
      </div>}
    </details>
    {!readOnly && approval && <section className="approval" aria-label="工具审批">
      <div className="approval-title"><CircleAlert size={16} /><strong>允许此工具调用？</strong></div>
      <pre>{detail}</pre>
      <div className="actions"><button disabled={answered} onClick={() => handle(false)}>拒绝</button>
        <button className="primary" disabled={answered} onClick={() => handle(true)}><Check size={16} />允许一次</button></div>
    </section>}
    {!shared && result?.artifact && resultEvent && <div className="artifact">
      <FileText size={15} /><button title={result.artifact} onClick={() => void api.artifact(member.id, resultEvent.seq, "open").catch(report)}>{result.artifact}</button>
      <IconButton label="在文件夹中定位" click={() => void api.artifact(member.id, resultEvent.seq, "show").catch(report)}><FolderOpen size={15} /></IconButton>
    </div>}
  </div>;
}

function NewConversation({ open, profile, report }: {
  open: (path: string) => void; profile: Profile; report: (error: unknown) => void;
}) {
  const [path, setPath] = useState<string>();
  const browse = async () => {
    try {
      const selected = await api.folder();
      if (selected) setPath(selected);
    } catch (error) { report(error); }
  };
  return <div className="new-scroll"><section className="new-conversation">
    <div className="workspace-icon"><FolderOpen size={25} /></div>
    <h1>新建对话</h1>
    <div className="path-list">
      <div className="path-row">
        <div className="path-info"><strong>项目文件夹</strong>{path && <code title={path}>{path}</code>}</div>
        <button onClick={() => void browse()}><Folder size={16} />{path ? "更换" : "选择项目文件夹"}</button>
      </div>
    </div>
    <footer className="new-actions"><span className="muted">{profile.mode === "offline" ? "离线体验" : profile.config.model?.name}</span>
      <button className="primary" disabled={!path} onClick={() => { if (path) open(path); }}>进入对话</button></footer>
  </section></div>;
}

function ApprovalPicker({ mode, disabled, running, select }: {
  mode: ApprovalMode; disabled: boolean; running: boolean; select: (mode: ApprovalMode) => void;
}) {
  const picker = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const CurrentIcon = approvalOptions[mode].icon;
  const close = () => {
    if (picker.current) picker.current.open = false;
    trigger.current?.focus();
  };
  return <details className="approval-picker" ref={picker}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}
    onKeyDown={event => {
      if (event.key === "Escape" && picker.current?.open) { event.preventDefault(); close(); }
    }}>
    <summary ref={trigger} aria-label={`工具权限：${approvalOptions[mode].label}`} aria-disabled={disabled}
      data-mode={mode} onClick={event => { if (disabled) event.preventDefault(); }}>
      <CurrentIcon size={15} aria-hidden="true" />{approvalOptions[mode].label}<ChevronDown size={13} aria-hidden="true" />
    </summary>
    <div className="approval-options" role="group" aria-label="工具权限">
      <div className="approval-options-heading">{running ? "下次运行时生效" : "此对话的工具权限"}</div>
      {approvalModes.map(value => {
        const { label, detail, icon: Icon } = approvalOptions[value];
        return <button key={value} type="button" data-mode={value} aria-label={label} aria-pressed={mode === value}
          disabled={disabled} onClick={() => { close(); select(value); }}>
          <Icon size={17} aria-hidden="true" />
          <span><strong>{label}</strong><small>{detail}</small></span>
          {mode === value && <Check size={16} aria-hidden="true" />}
        </button>;
      })}
    </div>
  </details>;
}

function ModelSettings({ snapshot, close, report }: { snapshot: Snapshot; close: () => void; report: (value: unknown) => void }) {
  const [profile, setProfile] = useState(snapshot.profile);
  const [key, setKey] = useState("");
  const [persist, setPersist] = useState(false);
  const [clear, setClear] = useState(false);
  const [saving, setSaving] = useState(false);
  const model = profile.config.model ?? { endpoint: "", name: "", keyEnv: "OPENAI_API_KEY", protocol: "chat" };
  const field = (key: keyof typeof model, value: string) =>
    setProfile({ ...profile, config: { ...profile.config, model: { ...model, [key]: value } } });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try { await api.saveProfile(profile, key, persist, clear); close(); }
    catch (error) { report(error); setSaving(false); }
  };
  return <Modal title="设置" close={close}>
    <form className="settings-form" onSubmit={event => void save(event)}>
      <label className="checkbox"><input type="checkbox" role="switch" checked={profile.config.autoPause !== false}
        onChange={event => setProfile({ ...profile, config: { ...profile.config, autoPause: event.target.checked } })} />达到运行上限后自动暂停</label>
      <p className="muted">开启：达到步数或单轮时间上限后，需要手动继续。关闭：不因这两项上限暂停，仍可手动停止，审批和错误处理保持不变。仅影响当前成员；任务结束或停止后保存，下次运行或继续此回合时生效。</p>
      <label className="checkbox"><input type="checkbox" checked={snapshot.petsEnabled}
        onChange={event => void api.setPetsEnabled(event.target.checked).catch(report)} />显示桌宠</label>
      <div className="segment" aria-label="模型来源">
        <button type="button" aria-pressed={profile.mode === "offline"} onClick={() => setProfile({ ...profile, mode: "offline" })}>离线体验</button>
        <button type="button" aria-pressed={profile.mode === "model"} onClick={() => setProfile({ ...profile, mode: "model" })}>API 模型</button>
      </div>
      <div className="actions">
        <button type="button" onClick={() => void api.importProfile().then(value => { if (value) setProfile(value); }).catch(report)}><FileText size={15} />导入模型配置</button>
        <button type="button" onClick={() => setProfile({ ...profile, mode: "model", config: { ...profile.config, model: snapshot.school } })}>学校 DeepSeek</button>
      </div>
      {profile.mode === "model" && <>
        <label>Endpoint<input required type="url" value={model.endpoint} onChange={e => field("endpoint", e.target.value)} /></label>
        <div className="settings-grid">
          <label>模型<input required value={model.name} onChange={e => field("name", e.target.value)} /></label>
          <label>协议<select value={model.protocol ?? "chat"} onChange={e => field("protocol", e.target.value)}><option value="chat">Chat Completions</option><option value="responses">Responses</option></select></label>
        </div>
        <label>密钥环境变量<input required value={model.keyEnv} onChange={e => field("keyEnv", e.target.value)} /></label>
        <label>本次使用的密钥<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} /></label>
        <div className="actions"><label className="checkbox"><input type="checkbox" disabled={!snapshot.canStoreKey || !key} checked={persist} onChange={e => setPersist(e.target.checked)} />保存到系统安全存储</label>
          {snapshot.hasKey && <label className="checkbox"><input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)} />清除已输入或保存的密钥</label>}</div>
      </>}
      <label>共享 Hub 地址<input type="url" placeholder="留空时启动本地 Hub" value={profile.externalHub} onChange={e => setProfile({ ...profile, externalHub: e.target.value })} /></label>
      {profile.config.permissions && <Disclosure label="已导入的工具权限" text={stringify(profile.config.permissions)} />}
      {profile.config.allowedCommands && <Disclosure label="已导入的命令限制" text={stringify(profile.config.allowedCommands)} />}
      <footer className="modal-footer"><button type="button" onClick={close}>取消</button><button className="primary" disabled={saving}>保存设置</button></footer>
    </form>
  </Modal>;
}
function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>{title}</h2><IconButton label="关闭" click={close}><X size={19} /></IconButton></header>
    {children}
  </dialog>;
}

function PeerPanel({ member, close }: { member: Member; close: () => void }) {
  const [details, setDetails] = useState<unknown>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    let current = true;
    let timeout: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.peers(member.id);
        if (current) { setDetails(next); setFailure(undefined); }
      } catch (error) { if (current) setFailure(String(error)); }
      if (current) timeout = setTimeout(() => void refresh(), 3000);
    };
    setDetails(undefined);
    setFailure(undefined);
    void refresh();
    return () => { current = false; clearTimeout(timeout); };
  }, [member.id]);
  const [states, peers] = (Array.isArray(details) ? details : []) as [
    { peers?: Array<Record<string, unknown>> } | undefined, { peers?: Array<Record<string, unknown>> } | undefined,
  ];
  return <aside className="peer-panel" aria-label="协作侧栏">
    <header><h2>协作状态</h2><IconButton label="关闭协作侧栏" click={close}><X size={17} /></IconButton></header>
    {failure ? <IssueBox issue={{ kind: "hub", detail: failure }} settings={close} /> : <>
      <p className="muted">{details ? "Hub 已连接" : "正在读取协作状态"}</p>
      {peers?.peers?.map(peer => {
        const id = String(peer.peer_id);
        const state = states?.peers?.find(item => item.peer_id === id);
        return <div className="peer-item" key={id}><strong>{id}</strong>
          {state?.status ? <span>{String(state.status)}</span> : null}
          {state?.intent_summary ? <p>{String(state.intent_summary)}</p> : null}
        </div>;
      })}
      {details !== undefined && <Disclosure label="Peer 详情" text={stringify(details)} />}
    </>}
  </aside>;
}

function MemberAvatar({ peer }: { peer: string }) {
  let hash = 0;
  for (const char of peer) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return <span className="room-avatar" aria-hidden="true" style={{ backgroundColor: `hsl(${hash % 360} 38% 37%)` }}>
    {Array.from(peer.trim())[0]?.toUpperCase()}
  </span>;
}
function WorkspaceRoom({ path, version, close, cite, ask }: {
  path: string; version: number; close: () => void; cite?: (messages: RoomMessage[]) => void; ask: (messages: RoomMessage[]) => void;
}) {
  const [messages, setMessages] = useState<RoomMessage[]>();
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<{ id: string; checked: boolean } | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  function toggle(index: number, extend: boolean) {
    if (!messages) return;
    const id = messages[index].id;
    const start = extend && selected.length && anchor.current?.id !== id
      ? messages.findIndex(m => m.id === anchor.current?.id) : -1;
    const checked = start >= 0 ? anchor.current!.checked : !selected.includes(id);
    if (start < 0) anchor.current = { id, checked };
    const from = start < 0 ? index : Math.min(start, index);
    const ids = messages.slice(from, Math.max(index, start) + 1).map(m => m.id);
    setSelected(prev => {
      const next = new Set(prev);
      for (const key of ids) { if (checked) next.add(key); else next.delete(key); }
      return [...next];
    });
  }
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    let active = true;
    api.room(path).then(rows => { if (active) setMessages(rows); }).catch(e => {
      if (active) { setMessages(undefined); setError(String(e)); }
    });
    return () => { active = false; };
  }, [path, version]);
  useLayoutEffect(() => {
    if (list.current && pinned.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);
  const chosen = messages?.filter(m => selected.includes(m.id)) ?? [];
  async function post() {
    if (busy || !input.trim()) return;
    setBusy(true);
    setError("");
    try { await api.postRoom(path, input); setInput(""); pinned.current = true; }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <section className="session-layout" aria-label="工作区聊天室"><div className="session-main">
      <div className="room-toolbar room-heading"><IconButton label="返回对话" click={close}><ChevronDown size={16} style={{ transform: "rotate(90deg)" }}/></IconButton><strong>聊天室</strong><span>{messages ? messages.length + " 条消息" : "正在读取…"}</span>
        <small title="按住 Shift 点击起点和终点，可整段选择"><span aria-hidden="true" style={{ marginRight: 4 }}>💡</span>批量选择请按shift</small>
        <button disabled={!messages?.length} onClick={() => void api.exportRoom(path).catch(e => setError(String(e)))}><Download size={15}/>导出 Markdown</button></div>
      <div className="room-list timeline-scroll" ref={list} onScroll={e => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        <div className="timeline">{messages?.length === 0 && <p>还没有消息，来聊聊这个工作区吧。</p>}
        {messages?.map((m, index) => {
          const previous = messages[index - 1];
          const gap = previous ? Date.parse(m.at) - Date.parse(previous.at) : Infinity;
          const continued = previous?.peer === m.peer && gap >= 0 && gap < 5 * 60_000;
          return <article key={m.id} className={continued ? "room-continuation" : undefined}
            onPointerDown={e => { press.current = { x: e.clientX, y: e.clientY }; }}
            onMouseDown={e => { if (e.shiftKey && e.button === 0) e.preventDefault(); }}
            onClick={e => {
              if ((e.target as Element).closest("input, button, a")) return;
              const start = press.current;
              if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
              if (!e.shiftKey && window.getSelection()?.isCollapsed === false) return;
              toggle(index, e.shiftKey);
            }}>
          <input aria-label={"选择 " + m.peer + " 的消息"} title="按住 Shift 点击可选择或取消整段" type="checkbox" checked={selected.includes(m.id)}
            onClick={e => toggle(index, e.shiftKey)} readOnly/>
          {!continued && <MemberAvatar peer={m.peer}/>}
          <div>{!continued && <><strong>{m.peer}</strong> <time dateTime={m.at}>{new Date(m.at).toLocaleString("zh-CN")}</time></>}
            <RichText text={m.text}/></div></article>;
        })}</div>
      </div>
      <div className="composer-area"><div className="composer">{chosen.length > 0 && <div className="room-toolbar"><span>已选 {chosen.length} 条</span>
        {cite && <button onClick={() => cite(chosen)}>引用到当前对话</button>}
        <button onClick={() => ask(chosen)}>新建对话问 AI</button></div>}
      {error && <p role="alert">{error}</p>}
      <textarea aria-label="聊天室消息" placeholder="写消息，支持 Markdown…" maxLength={20000} readOnly={busy} value={input}
        onChange={e => setInput(e.target.value)} onKeyDown={e => {
          if (e.key === "Enter" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void post(); }
        }}/>
      <div className="composer-controls"><div className="actions"><button className="primary" disabled={busy || !input.trim()} onClick={() => void post()}><ArrowUp size={15}/>发送消息</button></div></div>
    </div></div></div></section>;
}

function App() {
  const [roomPath, setRoomPath] = useState<string>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [citations, setCitations] = useState<Record<string, RoomMessage[]>>({});
  const [modal, setModal] = useState<"settings" | "checkpoints">();
  const [nav, setNav] = useState(false);
  const [peers, setPeers] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string>();
  const [newChat, setNewChat] = useState<{ path?: string }>();
  const [draftApprovalMode, setDraftApprovalMode] = useState<ApprovalMode>("request");
  const [savingApproval, setSavingApproval] = useState(false);
  const [newIssue, setNewIssue] = useState<Issue>();
  const [creating, setCreating] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const positions = useRef<Record<string, { top: number; pinned: boolean }>>({});
  const previous = useRef<string | undefined>(undefined);
  const composing = useRef(false);

  useEffect(() => {
    return subscribeLiveState(api, setSnapshot, error => setErrors({ "": String(error) }));
  }, []);
  const id = newChat ? undefined : snapshot?.active;
  const groups = snapshot?.conversations ?? [];
  const group = groups.find(group => group.members.some(member => member.id === id));
  const member = group?.members.find(member => member.id === id);
  const shared = Boolean(member && member.peer !== snapshot?.peer);
  const readOnly = shared && member?.access !== "edit";
  const state = id ? snapshot?.sessions[id] : undefined;
  const events = activeEvents(state?.events ?? []);
  const phase = status(state, events);
  const working = phase.key === "running" && state?.phase === "ready";
  const waitingForApproval = phase.key === "pending";
  const running = working || waitingForApproval;
  const rows = timelineRows(events, working && !state?.issue);
  const lastRow = rows.at(-1);
  let activityText: string | undefined;
  if (!state?.issue) {
    if (waitingForApproval || state?.phase === "starting") activityText = phase.text;
    else if (working) {
      activityText = "正在运行";
      if (lastRow?.kind === "reasoning" && lastRow.active) activityText = "正在思考";
      if (lastRow?.kind === "text" && lastRow.active) activityText = "正在回复";
    }
  }
  const resumable = ["paused", "failed", "interrupted"].includes(phase.key);
  const draftKey = id ?? "";
  const draft = drafts[draftKey] ?? "";
  const attached = citations[draftKey] ?? [];
  const canSend = Boolean(draft.trim() || attached.length);
  const cwd = member?.cwd ?? newChat?.path;
  const approvalMode = member ? member.approvalMode ?? "request" : draftApprovalMode;
  const report = (error: unknown) => setErrors(previous => ({ ...previous, [id ?? ""]: error instanceof Error ? error.message : String(error) }));
  const send = (command: Command) => id ? api.command(id, command) : Promise.resolve(undefined);
  const focusPending = () => {
    if (!id || !state?.pending) return;
    requestAnimationFrame(() => document.getElementById("approval-" + state.pending?.request)?.scrollIntoView({ block: "nearest" }));
  };
  const choose = (next: string) => {
    if (creating) return;
    setNav(false);
    setModal(undefined);
    if (next === id) focusPending();
    void api.select(next).then(closeDraft).catch(report);
  };
  const closeDraft = () => {
    setRoomPath(undefined);
    setNewChat(undefined);
    setDraftApprovalMode("request");
    setNewIssue(undefined);
    setDrafts(previous => ({ ...previous, "": "" }));
    setCitations(previous => ({ ...previous, "": [] }));
    setErrors(previous => ({ ...previous, "": "" }));
  };
  const openDraft = (path?: string) => {
    if (creating) return;
    closeDraft();
    setNewChat({ path });
    setNav(false);
    setModal(undefined);
  };
  const submit = async () => {
    if (readOnly || !canSend || savingApproval) return;
    const text = attached.length ? [draft.trim(), "引用的工作区聊天记录", roomTranscript(attached)
      .split("\n").map(line => "> " + line).join("\n")].filter(Boolean).join("\n\n") : draft.trim();
    if (!id) {
      if (!cwd || creating) return;
      setCreating(true);
      setNewIssue(undefined);
      setErrors(previous => ({ ...previous, "": "" }));
      try {
        const result = await api.create(cwd, text, approvalMode);
        if ("issue" in result) setNewIssue(result.issue);
        else {
          setSnapshot(await api.state());
          closeDraft();
        }
      } catch (error) { report(error); }
      finally { setCreating(false); }
      return;
    }
    if (sending === id || state?.phase !== "ready") return;
    setErrors(previous => ({ ...previous, [id]: "" }));
    setSending(id);
    try {
      await send({ type: running ? "steer" : "submit", text });
      setCitations(prev => ({ ...prev, [id]: (prev[id] ?? []).filter(m => !attached.includes(m)) }));
      setDrafts(previous => previous[id] === draft ? { ...previous, [id]: "" } : previous);
    } catch (error) { report(error); }
    finally { setSending(previous => previous === id ? undefined : previous); }
  };
  const selectApprovalMode = async (next: ApprovalMode) => {
    if (next === approvalMode) return;
    if (!id) { setDraftApprovalMode(next); return; }
    setSavingApproval(true);
    try { await api.setApprovalMode(id, next); }
    catch (error) { report(error); }
    finally { setSavingApproval(false); }
  };
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || !id) { previous.current = id; return; }
    if (previous.current !== id) {
      const position = positions.current[id];
      element.scrollTop = position && !position.pinned ? position.top : element.scrollHeight;
      previous.current = id;
      composer.current?.focus();
      focusPending();
    } else if (positions.current[id]?.pinned !== false) {
      element.scrollTop = element.scrollHeight;
    }
  }, [roomPath, id, state?.events.length, state?.pending?.request, activityText]);
  useEffect(() => {
    composing.current = false;
    if (newChat?.path) composer.current?.focus();
  }, [id, newChat]);

  if (!snapshot) return <main className="loading">{errors[""] || "正在打开 TeamHub…"}</main>;
  const currentIssue = state?.issue ?? newIssue ?? (errors[draftKey] ? { kind: "session" as const, detail: errors[draftKey] } : undefined);
  const mode = snapshot.profile.mode === "offline" ? "离线体验" : snapshot.profile.config.model?.name;
  const workspaceGroups = [...new Set([...groups.map(group => group.members[0].cwd), ...(newChat?.path ? [newChat.path] : [])])];
  const showingRoom = Boolean(roomPath && workspaceGroups.includes(roomPath));

  return <div className="app">
    {nav && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setNav(false)} />}
    <aside className={"sidebar" + (nav ? " expanded" : "")} aria-label="会话导航">
      <div className="brand"><BrandMark /><strong>TeamHub</strong></div>
      <button className="new-button" disabled={creating} onClick={() => openDraft()}><Plus size={18} />新建对话</button>
      <div className="workspace-list">
        {workspaceGroups.map(path => <section className="workspace" key={path}>
          <div className="workspace-heading">
            <h2 title={path}><Folder size={14} /><span>{base(path)}</span></h2>
            <IconButton label={`在 ${base(path)} 中新建对话`} click={() => openDraft(path)} disabled={creating}>
              <Plus size={14} />
            </IconButton>
          </div>
          <button aria-current={roomPath === path ? "page" : undefined} className="session-button room-entry" disabled={creating} onClick={() => { setRoomPath(path); setNav(false); }}><MessagesSquare size={15}/>聊天室</button>
          {groups.filter(group => group.members[0].cwd === path).map(item => {
            const first = activeEvents(snapshot.sessions[item.members[0].id]?.events ?? []).find(event => event.type === "user");
            const label = String(first?.data ?? "新对话");
            return <div className="conversation" key={item.members[0].id}>
              {item.members.map(current => <button key={current.id} disabled={creating} aria-current={!showingRoom && id === current.id ? "page" : undefined}
                className="session-button" onClick={() => choose(current.id)}>
                <span title={label}>{current.peer !== snapshot.peer && `${current.peer} · `}{label}</span>
                <Status state={snapshot.sessions[current.id]} />
              </button>)}
            </div>;
          })}
        </section>)}
      </div>
      <div className="sidebar-bottom">
        <button disabled={creating} onClick={() => void api.importSession().then(value => {
          if (value) { closeDraft(); setNav(false); }
        }).catch(report)}><History size={17} />导入会话</button>
        <button onClick={() => { setModal("settings"); setNav(false); }}><Settings size={17} />设置</button>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="mobile-nav"><IconButton label="会话导航" click={() => setNav(value => !value)}><Menu size={20} /></IconButton></div>
        <div className="topbar-title">
          <strong title={snapshot.peer}>{snapshot.peer}</strong>
          {(showingRoom || cwd) && <code title={showingRoom ? roomPath : cwd}>{showingRoom ? roomPath : cwd}</code>}
        </div>
        {!showingRoom && member && (shared ? <span>{member.peer} · {readOnly ? "只读" : "可编辑"}</span> :
          <span className="access-picker"><select aria-label="对话访问权限" title="对话访问权限" value={member.access ?? "private"}
            onChange={event => void api.setAccess(member.id, event.target.value as AccessMode).catch(report)}>
            {accessModes.map(mode => <option key={mode} value={mode}>{accessLabels[mode]}</option>)}
          </select><ChevronDown size={13} aria-hidden="true" /></span>)}
        {!showingRoom && !shared && <span className="model-label" title={mode}>{mode}</span>}
        {!showingRoom && !shared && member?.peer && <IconButton label="协作状态" click={() => setPeers(value => !value)} pressed={peers}><Users size={18} /></IconButton>}
        {!showingRoom && member && !readOnly && <IconButton label="检查点" click={() => setModal("checkpoints")}><History size={19} /></IconButton>}
        <IconButton label="新建成员窗口" click={() => void api.memberPicker().catch(report)}><Plus size={18} /></IconButton>
        <IconButton label="模型设置" click={() => setModal("settings")}><Settings size={18} /></IconButton>
      </header>
      {showingRoom && roomPath ? <WorkspaceRoom key={roomPath}
      path={roomPath} version={snapshot.roomVersions?.[roomPath] ?? 0} close={() => setRoomPath(undefined)}
      cite={cwd === roomPath && !readOnly ? messages => {
        setCitations(prev => {
          const current = prev[draftKey] ?? [];
          return { ...prev, [draftKey]: [...current, ...messages.filter(m => !current.some(c => c.id === m.id))] };
        });
        setRoomPath(undefined);
        requestAnimationFrame(() => composer.current?.focus());
      } : undefined}
      ask={messages => {
        openDraft(roomPath);
        setCitations(prev => ({ ...prev, "": messages }));
        setRoomPath(undefined);
      }}/> : !cwd ? <>
        {currentIssue && <div className="issue-wrap"><IssueBox issue={currentIssue} settings={() => setModal("settings")} /></div>}
        <NewConversation key={newChat ? "new" : "initial"} open={openDraft} profile={snapshot.profile} report={report} />
      </> : <div className="session-layout">
        <div className="session-main">
          <div className="timeline-scroll" ref={scroll} onScroll={event => {
            if (!id) return;
            const box = event.currentTarget;
            const prior = positions.current[id];
            const nearBottom = box.scrollHeight - box.clientHeight - box.scrollTop < 36;
            positions.current[id] = {
              top: box.scrollTop,
              pinned: nearBottom && (prior?.pinned !== false || box.scrollTop > prior.top),
            };
          }}>
            <div className="timeline" aria-label="会话时间线">
              {events.length <= 1 && <div className="empty-session"><FolderOpen size={26} /><h1>{base(cwd)}</h1><p>输入任务以开始对话</p>
                {snapshot.profile.mode === "offline" && <button disabled={creating} onClick={() => { setDrafts(previous => ({ ...previous, [draftKey]: "生成一份报告" })); composer.current?.focus(); }}>试用：生成一份报告</button>}
              </div>}
              {member && <HistoryWindow key={id} items={rows}
                pendingSeq={state?.pending ? events.find(event => event.type === "request" &&
                  (event.data as { request: number }).request === state.pending?.request && event.turn === state.pending.turn)?.seq : undefined}>
                {row => {
                if (row.kind !== "event") {
                  if (row.kind === "reasoning") return <Reasoning key={id + ":" + row.seq} id={"reasoning-" + row.seq}
                    text={row.text} active={row.active} />;
                  return <article key={row.seq} className="assistant-message">
                    <div className="byline">{name(member)}</div>{row.active ? <div className="streaming-text">{row.text}</div> : <RichText text={row.text} />}</article>;
                }
                const { event } = row;
                if (event.type === "user" || event.type === "steer") return <article className="user-message" key={event.seq}>
                  {event.type === "steer" && <strong>追加指令 · 已排队</strong>}<p>{String(event.data)}</p></article>;
                if (event.type === "request") return <div key={event.seq} id={"approval-" + (event.data as { request: number }).request}>
                  <ToolRow shared={shared} readOnly={readOnly} event={event} events={events} pending={state?.pending} member={member} report={report}
                    act={(key, allow) => send({ type: "approve", key, allow })} /></div>;
                if (event.type === "notice") return <p className="notice" key={event.seq}>{friendly(String(event.data))}</p>;
                if (event.type === "uncertain") return <p className="notice attention" key={event.seq}>待核实 · 先前调用可能已产生副作用</p>;
                if (event.type === "resume") return <p className="notice" key={event.seq}>继续此回合</p>;
                return null;
              }}</HistoryWindow>}
              {currentIssue && <IssueBox issue={currentIssue} settings={() => setModal("settings")}
                retry={!readOnly && id && (currentIssue.kind === "hub" || currentIssue.kind === "session") ? () => void api.retry(id).then(() => setErrors(previous => ({ ...previous, [id]: "" }))).catch(report) : undefined} />}
              {member && <div className="timeline-activity" role="status">
                {activityText && <>
                  {waitingForApproval ? <Clock size={15} aria-hidden="true" /> :
                    <LoaderCircle size={15} className="timeline-activity-spinner" aria-hidden="true" />}
                  <span>{activityText}</span>
                </>}
              </div>}
            </div>
          </div>
          {!readOnly && <div className="composer-area">
            <div className="composer">
              {attached.length > 0 && <div className="citation-list" aria-label="引用的聊天消息">
                {attached.map(m => <div className="citation" key={m.id}>
                  <Quote size={14} aria-hidden="true"/><strong>{m.peer}</strong><span title={m.text}>{m.text}</span>
                  <IconButton label={`移除 ${m.peer} 的引用`} disabled={creating} click={() => setCitations(prev =>
                    ({ ...prev, [draftKey]: prev[draftKey].filter(item => item.id !== m.id) }))}><X size={14}/></IconButton>
                </div>)}
              </div>}
              <textarea ref={composer} aria-label="任务" placeholder={running ? "输入要追加的指令" : "输入任务…"} value={draft}
                readOnly={creating} onChange={event => setDrafts(previous => ({ ...previous, [draftKey]: event.target.value }))}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; }}
                onKeyDown={event => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
                  event.preventDefault();
                  void submit();
                }} />
              <div className="composer-controls">
                <div className="composer-context">
                  <IconButton label="引用工作区聊天记录" disabled={creating} click={() => setRoomPath(cwd)}><Quote size={15}/></IconButton>
                  <ApprovalPicker key={id ?? "draft"} mode={approvalMode} disabled={creating || savingApproval} running={running}
                    select={next => void selectApprovalMode(next)} />
                  <Status state={creating ? { phase: "starting", events: [] } : state} />
                </div>
                <div className="actions">
                  {resumable && <button disabled={savingApproval} onClick={() => void send({ type: "resume" }).catch(report)}><RotateCcw size={14} />继续此回合</button>}
                  {running && <button onClick={() => void send({ type: "interrupt" }).catch(report)}><Square size={13} />中断</button>}
                  <button className="primary" disabled={!canSend || creating || savingApproval || Boolean(id && (sending === id || state?.phase !== "ready"))} onClick={() => void submit()}>
                    <ArrowUp size={16} />{running ? "追加指令" : "发送"}</button>
                </div>
              </div>
            </div>
          </div>}
        </div>
        {peers && !shared && member?.peer && <PeerPanel member={member} close={() => setPeers(false)} />}
      </div>}
    </main>

    {modal === "settings" && <ModelSettings snapshot={snapshot} close={() => setModal(undefined)} report={error => {
      report(error);
      setModal(undefined);
    }} />}
    {modal === "checkpoints" && !readOnly && member && <Modal title="检查点" close={() => setModal(undefined)}>
      <div className="checkpoints"><p>仅恢复对话历史，已修改的文件会保留。</p>
        {events.filter(event => event.type === "session" || event.type === "status" && event.data !== "running").toReversed().map(event => {
          const count = events.filter(item => item.seq > event.seq && ["user", "steer", "final", "request"].includes(item.type)).length;
          return <button disabled={running || !count} key={event.seq} onClick={() => void (async () => {
            const yes = await api.confirm("恢复到检查点 #" + event.seq, "将从可见历史移除后续 " + count + " 条消息或工具调用。仅恢复对话历史，已修改的文件会保留。");
            if (yes) { await send({ type: "rollback", seq: event.seq }); setModal(undefined); }
          })().catch(report)}>
            <History size={16} /><span>#{event.seq} · {event.type === "session" ? "会话开始" : phases[String(event.data)]}</span>
            <small>{new Date(event.at).toLocaleString("zh-CN")}</small></button>;
        })}
      </div>
    </Modal>}
  </div>;
}

function MemberPicker() {
  const [members, setMembers] = useState<LocalMember[]>([]);
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api.members().then(setMembers).catch(cause => setError(String(cause))); }, []);
  const open = async (peer: string) => {
    setBusy(true);
    setError("");
    try { await api.openMember(peer); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  };
  return <main className="member-picker">
    <header className="brand"><BrandMark /><h1>选择成员</h1></header>
    {members.length > 0 && <section className="member-list" aria-label="本地成员">
      {members.map(member => <button key={member.peer} disabled={busy} onClick={() => void open(member.peer)}>
        <span><strong>{member.peer}</strong>{member.cwd && <code title={member.cwd}>{member.cwd}</code>}</span>
        {member.open && <span className="status running"><i />已打开</span>}
      </button>)}
    </section>}
    <form className="member-form" onSubmit={event => { event.preventDefault(); if (id.trim() && !busy) void open(id); }}>
      <label htmlFor="member-id">成员 ID</label>
      <div>
        <input id="member-id" autoFocus autoComplete="off" maxLength={64} spellCheck={false} placeholder="例如 alice、bob、carol" value={id} onChange={event => setId(event.target.value)} />
        <button className="primary" disabled={busy || !id.trim()}><Plus size={16} />打开成员窗口</button>
      </div>
    </form>
    {error && <p className="attention" role="alert">{error}</p>}
  </main>;
}

const chooser = new URLSearchParams(location.search).get("view") === "members";
createRoot(document.getElementById("root")!).render(chooser ? <MemberPicker /> : <App />);
