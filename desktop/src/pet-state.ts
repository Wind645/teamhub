import type { Event } from "../../toy-harness/src/journal.js";
import type { Issue, SessionState } from "./protocol.js";

export type PetAnimation = "idle" | "loading" | "thinking" | "executing" | "passed" | "failed" | "interrupted";
export type PetStatus = { animation: PetAnimation; label: string; attention?: boolean; reason?: string };
export type PetMember = PetStatus & { peer: string; lead: boolean };
export type PetPreferences = { enabled: boolean; position?: { x: number; y: number } };
export type PetSnapshot = { members: PetMember[] };

type Request = { request: number; call: { id: string; name: string; args?: { command?: unknown } } };
type ToolResult = { request: number; id: string; name: string; result: { value?: { exitCode?: unknown }; reason?: string } };
type ResultFlash = { animation: "passed" | "failed"; until: number };
const idle: PetStatus = { animation: "idle", label: "空闲" };
const testCommand = /^\s*node(?:\.exe)?\s+--test(?:\s|$)/i;
const shellControl = /[&|<>;^%`\r\n]/;

export class PetActivity {
  private sequence = 0;
  private attempt?: string;
  private turn?: string;
  private status?: string;
  private request?: Request;
  private executing = false;
  private flash?: ResultFlash;

  constructor(history: readonly Event[] = []) {
    this.sequence = history.at(-1)?.seq ?? 0;
  }

  observe(event: Event, now = Date.now()) {
    if (event.seq <= this.sequence) return;
    this.sequence = event.seq;
    if (event.type === "rollback") {
      this.attempt = this.turn = this.status = undefined;
      this.request = this.flash = undefined;
      this.executing = false;
      return;
    }
    if (event.type === "user" || event.type === "resume") {
      this.attempt = event.turn;
      this.flash = undefined;
      return;
    }
    if (event.type === "status" && event.data === "running" && event.turn && event.turn === this.attempt) {
      this.turn = event.turn;
      this.attempt = undefined;
      this.status = "running";
      this.request = undefined;
      this.executing = false;
      return;
    }
    if (!this.turn || event.turn !== this.turn || this.status !== "running") return;
    if (event.type === "status") {
      this.status = String(event.data);
      this.request = undefined;
      this.executing = false;
      if (this.status !== "completed") this.flash = undefined;
    } else if (event.type === "request") {
      this.request = event.data as Request;
      this.executing = false;
    } else if (event.type === "execute") {
      const execution = event.data as Request;
      if (this.request?.request !== execution.request || this.request.call.id !== execution.call.id) return;
      this.executing = true;
      this.flash = undefined;
    } else if (event.type === "result") {
      const outcome = event.data as ToolResult;
      if (this.request?.request !== outcome.request || this.request.call.id !== outcome.id) return;
      const command = this.request.call.args?.command;
      const exit = outcome.result.value?.exitCode;
      const processExited = typeof exit === "number" &&
        outcome.result.reason === (exit === 0 ? undefined : `Command exited with code ${exit}`);
      if (this.executing && this.request.call.name === "Bash" && outcome.name === "Bash" && processExited &&
          typeof command === "string" && testCommand.test(command) && !shellControl.test(command)) {
        this.flash = { animation: exit === 0 ? "passed" : "failed", until: now + 5000 };
      }
      this.request = undefined;
      this.executing = false;
    }
  }

  private matchesApproval(pending: SessionState["pending"]) {
    return pending && this.status === "running" && pending.turn === this.turn &&
      pending.request === this.request?.request && pending.callId === this.request.call.id;
  }

  observeApproval(pending: SessionState["pending"]) {
    if (this.matchesApproval(pending)) this.flash = undefined;
  }

  view(state: SessionState, now: number) {
    if (this.matchesApproval(state.pending)) {
      return { rank: 7, status: { ...idle, label: "待审批", attention: true } };
    }
    if (state.phase === "starting") return { rank: 2, status: { animation: "loading", label: "连接中" } as PetStatus };
    if (state.issue || this.status === "failed") {
      return { rank: 6, status: { animation: "interrupted", label: "异常中断", attention: true, reason: issueReason(state.issue) } as PetStatus };
    }
    if (this.status === "paused") {
      return { rank: 6, status: { animation: "interrupted", label: "待继续", attention: true, reason: "达到回合预算" } as PetStatus };
    }
    if (this.executing) return { rank: 5, status: { animation: "executing", label: "代码执行" } as PetStatus };
    if (this.flash && this.flash.until > now) {
      const { animation, until } = this.flash;
      return { rank: 4, until, status: { animation, label: animation === "passed" ? "样本通过" : "样本失败" } as PetStatus };
    }
    if (this.status === "running") return { rank: 3, status: { animation: "thinking", label: "推理中" } as PetStatus };
    if (this.status === "interrupted") {
      return { rank: 1, status: { animation: "interrupted", label: "已中断", reason: "用户主动中断" } as PetStatus };
    }
    return { rank: 0, status: idle };
  }
}

function issueReason(issue?: Issue) {
  switch (issue?.kind) {
    case "credential": return "模型密钥不可用";
    case "model": return "模型连接或响应失败";
    case "hub": return "TeamHub 连接或请求失败";
    case "session": return "会话运行时异常";
    default: return "回合执行失败";
  }
}

const noActivity = new PetActivity();
export function memberPet(
  sessions: { id: string; state: SessionState; activity?: PetActivity }[], active: string | undefined, now: number,
) {
  let best = { ...noActivity.view({ phase: "idle", events: [] }, now), id: undefined as string | undefined };
  let until: number | undefined;
  for (const { id, state, activity } of sessions) {
    const view = (activity ?? noActivity).view(state, now);
    if (view.rank > best.rank || (view.rank === best.rank && id === active)) best = { ...view, id };
    if (view.until !== undefined) until = Math.min(until ?? Infinity, view.until);
  }
  return { status: best.status, target: best.rank === 7 ? best.id : undefined, until };
}

export function petLayout(count: number, available: number) {
  const rows: number[] = [];
  let width = 0;
  let rowWidth = 0;
  for (let i = 0; i < count; i++) {
    const itemWidth = i === 0 ? 150 : 90;
    if (rowWidth && rowWidth + itemWidth > available) rowWidth = 0;
    if (!rowWidth) rows.push(0);
    rowWidth += itemWidth;
    rows[rows.length - 1]++;
    width = Math.max(width, rowWidth);
  }
  return { rows, width: Math.min(width, available), height: count ? 154 + (rows.length - 1) * 103 : 0 };
}
