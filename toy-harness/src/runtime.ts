import { randomUUID } from "node:crypto";
import type { Event, Journal } from "./journal.js";
import { buildContext } from "./context.js";
import type { Args, Call, Model, Reply } from "./model.js";
import type { Registry, Result, Tool } from "./tools.js";

export type HookReply = {
  decision?: string; reason?: string; continue?: boolean; stopReason?: string;
  systemMessage?: string; hookSpecificOutput?: { additionalContext?: string };
};
export type Hook = (input: Args) => Promise<HookReply>;
export type Approval = (tool: Tool, args: Args, signal: AbortSignal, identity: {
  turn: string; request: number; callId: string;
}) => Promise<boolean>;
export type RuntimeOptions = {
  journal: Journal; model: Model; registry: Registry; instructions: string;
  approve: Approval; hook?: Hook; emit?: (event: Event) => void;
  steps: number; context: number; turnTimeout: number;
  autoPause?: boolean;
};

const superseded = new Error("Tool call skipped because a newer user instruction arrived");

export class Runtime {
  private active?: { id: string; controller: AbortController; step?: AbortController };
  private stopped = false;

  constructor(private readonly options: RuntimeOptions) {}

  get journal() { return this.options.journal; }
  get busy() { return Boolean(this.active); }

  private add(type: string, data: unknown, turn?: string) {
    const event = this.journal.add(type, data, turn);
    this.options.emit?.(event);
    return event;
  }

  private async hook(name: string, turn?: string, extra: Args = {}): Promise<HookReply> {
    const result = await this.options.hook?.({
      hook_event_name: name, session_id: this.journal.id, turn_id: turn,
      cwd: this.journal.cwd, ...extra,
    }) ?? {};
    if (this.options.hook) this.add("hook", { name, ...result }, turn);
    if (result.systemMessage) this.add("notice", result.systemMessage, turn);
    if (result.hookSpecificOutput?.additionalContext) {
      this.add("hook_context", result.hookSpecificOutput.additionalContext, turn);
    }
    return result;
  }

  private enforce(result: HookReply): void {
    if (result.continue === false || result.decision === "block") {
      throw new Error(result.stopReason ?? result.reason ?? "Stopped by lifecycle hook");
    }
  }

  private async release(event: "TurnRelease" | "Interrupt", turn: string): Promise<void> {
    try {
      this.enforce(await this.hook(event, turn));
    } catch (error) {
      this.add("notice", String(error), turn);
    }
  }

  async start(): Promise<void> {
    const events = this.journal.active();
    const outcomes = new Set(events.filter(event => event.type === "result")
      .map(event => (event.data as { request: number }).request));
    const uncertain = new Set(events.filter(event => event.type === "uncertain")
      .map(event => (event.data as { request: number }).request));
    for (const event of events.filter(event => event.type === "execute")) {
      const data = event.data as { request: number; call: Call; effect: boolean };
      if (!data.effect || outcomes.has(data.request) || uncertain.has(data.request)) continue;
      this.add("uncertain", data, event.turn);
    }
    const resumed = this.latestTurn();
    if (resumed && this.status(resumed) === "running") {
      await this.release("TurnRelease", resumed);
      this.add("status", "paused", resumed);
    }
    if (resumed) this.add("notice", `Turn ${resumed} restored with status ${String(this.status(resumed))}`, resumed);
    this.enforce(await this.hook("SessionStart", resumed));
  }

  private latestTurn(): string | undefined {
    return this.journal.active().findLast(event => event.type === "user")?.turn;
  }

  private status(turn: string): unknown {
    return this.journal.active().findLast(event => event.type === "status" && event.turn === turn)?.data;
  }

  steer(text: string): void {
    if (!this.active) throw new Error("There is no active turn");
    this.add("steer", text, this.active.id);
    this.active.step?.abort(superseded);
  }

  interrupt(): void { this.active?.controller.abort(new Error("User interrupted")); }

  async end(): Promise<void> {
    if (this.busy) throw new Error("Wait for the active turn to settle");
    if (this.stopped) return;
    this.stopped = true;
    const lastSubmitted = this.journal.events.findLast(event => event.type === "user");
    await this.hook("SessionEnd", lastSubmitted?.turn);
  }

  rollback(seq: number): void {
    if (this.busy) throw new Error("Interrupt the current turn before rollback");
    const checkpoint = this.journal.active().find(event => event.seq === seq);
    if (!checkpoint || !["session", "status"].includes(checkpoint.type) || checkpoint.data === "running") {
      throw new Error("Choose the session start or a settled status checkpoint");
    }
    this.add("rollback", seq);
  }

  async submit(prompt: string): Promise<string> {
    if (this.busy || this.stopped) throw new Error("Session is unavailable for submission");
    const turn = randomUUID();
    this.add("user", prompt, turn);
    return this.run(turn, prompt);
  }

  async resume(): Promise<string> {
    if (this.busy || this.stopped) throw new Error("Session is unavailable for resume");
    const turn = this.latestTurn();
    if (!turn || !["paused", "interrupted", "failed"].includes(String(this.status(turn)))) {
      throw new Error("There is no paused, interrupted or failed turn to resume");
    }
    this.add("resume", "Continue the current request. Check any uncertain side effects before retrying.", turn);
    return this.run(turn);
  }

  private async run(turn: string, prompt?: string): Promise<string> {
    const controller = new AbortController();
    const { signal } = controller;
    const active: NonNullable<Runtime["active"]> = { id: turn, controller };
    this.active = active;
    const timer = this.options.autoPause === false ? undefined :
      setTimeout(() => controller.abort(new Error("Turn time budget reached")), this.options.turnTimeout);
    this.add("status", "running", turn);
    try {
      const originalPrompt = prompt ?? this.journal.active().find(event => event.type === "user" && event.turn === turn)?.data;
      const register = (event: "UserPromptSubmit" | "TurnResume") =>
        this.hook(event, turn, { prompt: originalPrompt }).then(result => this.enforce(result));
      await register(prompt === undefined ? "TurnResume" : "UserPromptSubmit");
      for (let step = 0; this.options.autoPause === false || step < this.options.steps; step++) {
        signal.throwIfAborted();
        const decision = new AbortController();
        active.step = decision;
        const context = buildContext(this.journal.active(), turn, this.options.instructions, this.options.context);
        this.add("model", { step: step + 1, compressed: context.compressed }, turn);
        let reply: Reply;
        let receivedOutput = false;
        let streamedText = false;
        try {
          reply = await this.options.model.next(context.messages, this.options.registry.specs(), signal, update => {
            if (signal.aborted) return;
            if (update.type === "delta") {
              receivedOutput = true;
              if (update.kind === "text") streamedText = true;
            }
            if (receivedOutput) this.add("assistant_output", update, turn);
          });
        } finally {
          if (receivedOutput) this.add("assistant_output", { type: "end" }, turn);
        }
        signal.throwIfAborted();
        if ((reply.calls?.length ?? 0) > 50 ||
            new Set(reply.calls?.map(call => call.id)).size !== (reply.calls?.length ?? 0) ||
            reply.calls?.some(call => typeof call.id !== "string" || !call.id || typeof call.name !== "string")) {
          throw new Error("Model returned an invalid tool-call batch");
        }
        const recorded = streamedText ? { ...reply, streamedText: true } : reply;
        if (reply.calls?.length) {
          const message = this.add("assistant", recorded, turn);
          for (const [index, call] of reply.calls.entries()) {
            signal.throwIfAborted();
            await this.dispatch(turn, message.seq * 1000 + index, call, signal, decision.signal);
          }
          continue;
        }
        if (decision.signal.aborted) continue;
        this.enforce(await this.hook("Stop", turn));
        signal.throwIfAborted();
        if (decision.signal.aborted) {
          await register("TurnResume");
          continue;
        }
        this.add("assistant", recorded, turn);
        this.add("final", reply.text, turn);
        this.add("status", "completed", turn);
        return reply.text;
      }
      signal.throwIfAborted();
      this.add("notice", "Model step budget reached. Use /resume to continue.", turn);
      await this.release("TurnRelease", turn);
      this.add("status", "paused", turn);
      return "";
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      const interrupted = signal.aborted && (reason as Error)?.message === "User interrupted";
      this.add("notice", String(reason), turn);
      await this.release(interrupted ? "Interrupt" : "TurnRelease", turn);
      this.add("status", interrupted ? "interrupted" : signal.aborted ? "paused" : "failed", turn);
      return "";
    } finally {
      clearTimeout(timer);
      this.active = undefined;
    }
  }

  private async dispatch(turn: string, request: number, call: Call, signal: AbortSignal, decision: AbortSignal): Promise<void> {
    this.add("request", { request, call }, turn);
    let result: Result;
    let stopReason: string | undefined;
    let post: Args | undefined;
    let effect = false;
    try {
      decision.throwIfAborted();
      const { tool, args } = this.options.registry.check(call);
      const approved = tool.permission === "ask"
        ? await this.options.approve(tool, args, AbortSignal.any([signal, decision]), { turn, request, callId: call.id })
        : tool.permission === "allow";
      decision.throwIfAborted();
      signal.throwIfAborted();
      if (!approved) {
        throw new Error("Denied by local tool policy");
      }
      this.add("permission", { name: tool.name, decision: "approved" }, turn);
      signal.throwIfAborted();
      const fields = { tool_name: tool.name, tool_input: args };
      const pre = await this.hook("PreToolUse", turn, fields);
      if (pre.continue === false) stopReason = pre.stopReason ?? "Stopped by PreToolUse";
      this.enforce(pre);
      signal.throwIfAborted();
      decision.throwIfAborted();
      effect = tool.effect;
      this.add("execute", { request, call, effect }, turn);
      post = fields;
      result = await tool.execute(args, signal);
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (signal.aborted && post && effect && !result.ok) {
      this.add("uncertain", { request, call, effect: true }, turn);
    }
    this.add("result", { request, name: call.name, id: call.id, result }, turn);
    if (post && !signal.aborted) {
      const after = await this.hook("PostToolUse", turn, { ...post, tool_response: result });
      this.enforce(after);
    }
    if (stopReason) throw new Error(stopReason);
  }
}
