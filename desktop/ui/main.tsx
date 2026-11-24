import React, { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUp, Check, ChevronDown, CircleAlert, FileText, Folder, FolderOpen, History, Menu, Plus, RotateCcw, Settings, Square, Terminal, Users, X } from "lucide-react";
import Markdown from "react-markdown";
import gfm from "remark-gfm";
import type { Api, Command, Issue, LocalMember, Member, Pending, Profile, SessionState, Snapshot } from "../src/protocol";
import type { Event } from "../../toy-harness/src/journal";
import "./style.css";

declare global { interface Window { teamhub: Api } }
const api = window.teamhub;
const name = (member?: Member) => member?.peer ?? "助手";
const base = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
const phases: Record<string, string> = { running: "运行中", completed: "已完成", interrupted: "已中断", failed: "失败", paused: "已暂停", idle: "就绪" };
const issueNames = { credential: "缺少模型密钥", model: "模型连接失败", hub: "Hub 离线", session: "会话不可用" };
const stringify = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
const friendly = (text: string) => ({
  "Denied by local tool policy": "已按本地工具权限拒绝",
  "Tool call skipped because a newer user instruction arrived": "已跳过旧调用，等待处理追加指令",
  "User interrupted": "用户已中断",
} as Record<string, string>)[text] ?? text;
function activeEvents(events: Event[]) {
  let result: Event[] = [];
  for (const event of events) {
    if (event.type === "rollback") result = result.filter(item => item.seq <= Number(event.data));
    else result.push(event);
  }
  return result;
}
function status(state?: SessionState, events = activeEvents(state?.events ?? [])) {
  if (state?.pending) return { key: "pending", text: "等待审批" };
  if (state?.phase === "starting") return { key: "running", text: "连接中" };
  const last = String(events.findLast(event => event.type === "status")?.data ?? "idle");
  const key = last === "running" && state?.phase !== "ready" ? "paused" : last;
  return { key, text: phases[key] ?? key };
}
function IconButton({ label, click, children, pressed }: { label: string; click: () => void; children: ReactNode; pressed?: boolean }) {
  return <button type="button" className="icon-button" title={label} aria-label={label} aria-pressed={pressed} onClick={click}>{children}</button>;
}
function BrandMark() {
  return <img className="brand-mark" src="./teamhub.png" alt="" width={32} height={32} />;
}
function Status({ state }: { state?: SessionState }) {
  const label = status(state);
  return <span className={"status " + label.key}><i />{label.text}</span>;
}
function RichText({ text }: { text: string }) {
  return <div className="markdown"><Markdown skipHtml remarkPlugins={[gfm]} components={{
    a: ({ children }) => <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
  }}>{text}</Markdown></div>;
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

function ToolRow({ event, events, pending, member, act, report }: {
  event: Event; events: Event[]; pending?: Pending; member: Member;
  act: (request: Pending, allow: boolean) => Promise<unknown>; report: (error: unknown) => void;
}) {
  const { request, call } = event.data as { request: number; call: { name: string; id: string; args?: Record<string, unknown> } };
  const resultEvent = events.find(item => item.type === "result" && (item.data as { request: number }).request === request);
  const result = (resultEvent?.data as { result: { ok: boolean; value?: unknown; artifact?: string; reason?: string } } | undefined)?.result;
  const uncertain = events.some(item => item.type === "uncertain" && (item.data as { request: number }).request === request);
  const approval = pending?.request === request && pending.turn === event.turn && pending.callId === call.id ? pending : undefined;
  const [answered, setAnswered] = useState(false);
  const args = approval?.args ?? call.args ?? {};
  const patch = typeof args.input === "string" && call.name === "apply_patch" ? args.input : undefined;
  const command = args.command ? String(args.command) : undefined;
  const recipient = Array.isArray(args.recipients) ? args.recipients.join("、") : undefined;
  const object = patch?.match(/^\*\*\* (?:Add|Update) File: (.+)$/m)?.[1] ??
    (args.path ? String(args.path) : command ?? recipient);
  const state = uncertain ? "待核实" : result ? result.ok ? "成功" : "未完成" : approval ? "等待审批" : "进行中";
  const detail = patch ?? (command ? command + "\n\n工作目录  " + member.cwd :
    recipient ? "收件人  " + recipient + "\n\n" + stringify(args.message) : stringify(args));
  const handle = (allow: boolean) => {
    if (!approval || answered) return;
    setAnswered(true);
    void act(approval, allow).catch(error => { setAnswered(false); report(error); });
  };
  return <div className="tool">
    <details>
      <summary><Terminal size={15} /><span className="tool-title"><code>{call.name}</code>{object && <span title={object}> · {object}</span>}</span>
        <span className={"tool-state " + (approval || uncertain ? "attention" : "")}>{state}</span><ChevronDown size={15} className="chevron" /></summary>
      <div className="tool-body">
        <pre>{detail}</pre>
        {result?.reason && <p>{friendly(result.reason)}</p>}
        {result?.value !== undefined && <Disclosure label="工具输出" text={stringify(result.value)} />}
      </div>
    </details>
    {approval && <section className="approval" aria-label="工具审批">
      <div className="approval-title"><CircleAlert size={16} /><strong>允许此工具调用？</strong></div>
      <pre>{detail}</pre>
      <div className="actions"><button disabled={answered} onClick={() => handle(false)}>拒绝</button>
        <button className="primary" disabled={answered} onClick={() => handle(true)}><Check size={16} />允许一次</button></div>
    </section>}
    {result?.artifact && resultEvent && <div className="artifact">
      <FileText size={15} /><button title={result.artifact} onClick={() => void api.artifact(member.id, resultEvent.seq, "open").catch(report)}>{result.artifact}</button>
      <IconButton label="在文件夹中定位" click={() => void api.artifact(member.id, resultEvent.seq, "show").catch(report)}><FolderOpen size={15} /></IconButton>
    </div>}
  </div>;
}

function NewConversation({ run, profile, report }: {
  run: (path: string) => Promise<string>; profile: Profile; report: (error: unknown) => void;
}) {
  const [path, setPath] = useState<string>();
  const [starting, setStarting] = useState(false);
  const browse = async () => {
    try {
      const selected = await api.folder();
      if (selected) setPath(selected);
    } catch (error) { report(error); }
  };
  const create = async () => {
    if (!path) return;
    setStarting(true);
    try { await run(path); }
    catch (error) { report(error); setStarting(false); }
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
      <button className="primary" disabled={starting || !path} onClick={() => void create()}>进入对话</button></footer>
  </section></div>;
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

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<"settings" | "checkpoints">();
  const [nav, setNav] = useState(false);
  const [peers, setPeers] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const positions = useRef<Record<string, { top: number; pinned: boolean }>>({});
  const previous = useRef<string | undefined>(undefined);
  const composing = useRef(false);

  useEffect(() => {
    const remove = api.subscribe(setSnapshot);
    void api.state().then(setSnapshot).catch(error => setErrors({ "": String(error) }));
    return remove;
  }, []);
  const id = snapshot?.active;
  const groups = snapshot?.conversations ?? [];
  const group = groups.find(group => group.members.some(member => member.id === id));
  const member = group?.members.find(member => member.id === id);
  const state = id ? snapshot?.sessions[id] : undefined;
  const events = activeEvents(state?.events ?? []);
  const phase = status(state, events);
  const running = phase.key === "running" && state?.phase === "ready" || phase.key === "pending";
  const resumable = ["paused", "failed", "interrupted"].includes(phase.key);
  const draft = id ? drafts[id] ?? "" : "";
  const report = (error: unknown) => setErrors(previous => ({ ...previous, [id ?? ""]: error instanceof Error ? error.message : String(error) }));
  const send = (command: Command) => id ? api.command(id, command) : Promise.resolve(undefined);
  const focusPending = () => {
    if (!id || !state?.pending) return;
    requestAnimationFrame(() => document.getElementById("approval-" + state.pending?.request)?.scrollIntoView({ block: "nearest" }));
  };
  const choose = (next?: string) => {
    setNav(false);
    setModal(undefined);
    if (next === id) focusPending();
    void api.select(next).catch(report);
  };
  const submit = async () => {
    if (!id || !draft.trim() || sending === id || state?.phase !== "ready") return;
    setErrors(previous => ({ ...previous, [id]: "" }));
    setSending(id);
    try {
      await send({ type: running ? "steer" : "submit", text: draft.trim() });
      setDrafts(previous => previous[id] === draft ? { ...previous, [id]: "" } : previous);
    } catch (error) { report(error); }
    finally { setSending(previous => previous === id ? undefined : previous); }
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
  }, [id, state?.events.length, state?.pending?.request]);
  useEffect(() => {
    if (id && !draft) composing.current = false;
  }, [id, draft]);

  if (!snapshot) return <main className="loading">{errors[""] || "正在打开 TeamHub…"}</main>;
  const currentIssue = state?.issue ?? (errors[id ?? ""] ? { kind: "session" as const, detail: errors[id ?? ""] } : undefined);
  const mode = snapshot.profile.mode === "offline" ? "离线体验" : snapshot.profile.config.model?.name;
  const workspaceGroups = [...new Set(groups.map(group => group.members[0].cwd))];

  return <div className="app">
    {nav && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setNav(false)} />}
    <aside className={"sidebar" + (nav ? " expanded" : "")} aria-label="会话导航">
      <div className="brand"><BrandMark /><strong>TeamHub</strong></div>
      <button className="new-button" onClick={() => choose()}><Plus size={18} />新建对话</button>
      <div className="workspace-list">
        {workspaceGroups.map(path => <section className="workspace" key={path}>
          <h2 title={path}><Folder size={14} /><span>{base(path)}</span></h2>
          {groups.filter(group => group.members[0].cwd === path).map(item => {
            const first = activeEvents(snapshot.sessions[item.members[0].id]?.events ?? []).find(event => event.type === "user");
            const label = String(first?.data ?? "新对话");
            return <div className="conversation" key={item.id}>
              {item.members.map(current => <button key={current.id} aria-current={id === current.id ? "page" : undefined}
                className="session-button" onClick={() => choose(current.id)}>
                <span title={label}>{label}</span>
                <Status state={snapshot.sessions[current.id]} />
              </button>)}
            </div>;
          })}
        </section>)}
      </div>
      <div className="sidebar-bottom">
        <button onClick={() => void api.importSession().then(value => { if (value) setNav(false); }).catch(report)}><History size={17} />导入会话</button>
        <button onClick={() => { setModal("settings"); setNav(false); }}><Settings size={17} />设置</button>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="mobile-nav"><IconButton label="会话导航" click={() => setNav(value => !value)}><Menu size={20} /></IconButton></div>
        <div className="topbar-title">
          <strong title={snapshot.peer}>{snapshot.peer}</strong>
          {member && <code title={member.cwd}>{member.cwd}</code>}
        </div>
        <span className="model-label" title={mode}>{mode}</span>
        {member?.peer && <IconButton label="协作状态" click={() => setPeers(value => !value)} pressed={peers}><Users size={18} /></IconButton>}
        {member && <IconButton label="检查点" click={() => setModal("checkpoints")}><History size={19} /></IconButton>}
        <IconButton label="新建成员窗口" click={() => void api.memberPicker().catch(report)}><Users size={18} /></IconButton>
        <IconButton label="模型设置" click={() => setModal("settings")}><Settings size={18} /></IconButton>
      </header>
      {!group || !member || !id ? <>
        {currentIssue && <div className="issue-wrap"><IssueBox issue={currentIssue} settings={() => setModal("settings")} /></div>}
        <NewConversation run={api.create} profile={snapshot.profile} report={report} />
      </> : <div className="session-layout">
        <div className="session-main">
          <div className="timeline-scroll" ref={scroll} onScroll={event => {
            const box = event.currentTarget;
            positions.current[id] = { top: box.scrollTop, pinned: box.scrollHeight - box.clientHeight - box.scrollTop < 36 };
          }}>
            <div className="timeline" aria-label="会话时间线">
              {events.length <= 1 && <div className="empty-session"><FolderOpen size={26} /><h1>{base(member.cwd)}</h1><p>输入任务以开始对话</p>
                {snapshot.profile.mode === "offline" && <button onClick={() => { setDrafts(previous => ({ ...previous, [id]: "生成一份报告" })); composer.current?.focus(); }}>试用：生成一份报告</button>}
              </div>}
              {events.map(event => {
                if (event.type === "user" || event.type === "steer") return <article className="user-message" key={event.seq}>
                  {event.type === "steer" && <strong>追加指令 · 已排队</strong>}<p>{String(event.data)}</p></article>;
                if (event.type === "final") return <article key={event.seq} className="assistant-message"><div className="byline">{name(member)}</div><RichText text={String(event.data)} /></article>;
                if (event.type === "assistant") {
                  const reply = event.data as { text: string; calls?: unknown[] };
                  return reply.text && reply.calls?.length ? <article key={event.seq} className="assistant-message"><div className="byline">{name(member)}</div><RichText text={reply.text} /></article> : null;
                }
                if (event.type === "request") return <div key={event.seq} id={"approval-" + (event.data as { request: number }).request}>
                  <ToolRow event={event} events={events} pending={state?.pending} member={member} report={report}
                    act={(key, allow) => send({ type: "approve", key, allow })} /></div>;
                if (event.type === "notice") return <p className="notice" key={event.seq}>{friendly(String(event.data))}</p>;
                if (event.type === "uncertain") return <p className="notice attention" key={event.seq}>待核实 · 先前调用可能已产生副作用</p>;
                if (event.type === "resume") return <p className="notice" key={event.seq}>继续此回合</p>;
                return null;
              })}
              {currentIssue && <IssueBox issue={currentIssue} settings={() => setModal("settings")}
                retry={currentIssue.kind === "hub" || currentIssue.kind === "session" ? () => void api.retry(id).then(() => setErrors(previous => ({ ...previous, [id]: "" }))).catch(report) : undefined} />}
            </div>
          </div>
          <div className="composer-area">
            <div className="composer">
              <textarea ref={composer} aria-label="任务" placeholder={running ? "输入要追加的指令" : "输入任务…"} value={draft}
                onChange={event => setDrafts(previous => ({ ...previous, [id]: event.target.value }))}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; }}
                onKeyDown={event => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
                  event.preventDefault();
                  void submit();
                }} />
              <div className="composer-controls">
                <Status state={state} />
                <div className="actions">
                  {resumable && <button onClick={() => void send({ type: "resume" }).catch(report)}><RotateCcw size={14} />继续此回合</button>}
                  {running && <button onClick={() => void send({ type: "interrupt" }).catch(report)}><Square size={13} />中断</button>}
                  <button className="primary" disabled={!draft.trim() || sending === id || state?.phase !== "ready"} onClick={() => void submit()}>
                    <ArrowUp size={16} />{running ? "追加指令" : "发送"}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        {peers && member.peer && <PeerPanel member={member} close={() => setPeers(false)} />}
      </div>}
    </main>
    {modal === "settings" && <ModelSettings snapshot={snapshot} close={() => setModal(undefined)} report={error => {
      report(error);
      setModal(undefined);
    }} />}
    {modal === "checkpoints" && member && <Modal title="检查点" close={() => setModal(undefined)}>
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
