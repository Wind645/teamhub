import type { Event } from "./journal.js";
import type { Call, Message, Reply } from "./model.js";
import type { Result } from "./tools.js";

const clip = (text: string, size: number) =>
  text.length <= size ? text : text.slice(0, size - 1) + "…";

function observation(result: Result, limit: number): string {
  const full = JSON.stringify(result);
  if (full.length <= limit) return full;
  const { value, ...outcome } = result;
  const exitCode = value && typeof value === "object" && "exitCode" in value ? value.exitCode : undefined;
  const summary = { ...outcome, exitCode, truncated: true };
  const preview = JSON.stringify(value) ?? "";
  const room = Math.max(0, limit - JSON.stringify(summary).length - 14);
  return JSON.stringify({ ...summary, excerpt: clip(preview, Math.floor(room / 2)) });
}

export function buildContext(events: Event[], turn: string, instructions: string, budget: number): {
  messages: Message[]; compressed: number;
} {
  const active = events.filter(event => event.turn === turn);
  const currentInput = active.find(event => event.type === "user")?.data;
  const goals = active.filter(event => event.type === "steer").map(event => event.data);
  const pinned: Message[] = [{
    role: "system",
    content: instructions + "\n" + `Active turn ID: ${turn}.\n` +
      `Current user request: ${JSON.stringify(currentInput)}\n` +
      `Later user constraints: ${JSON.stringify(goals)}`,
  }];
  const results = new Map<number, Result>();
  for (const item of events.filter(event => event.type === "result")) {
    const { request, result } = item.data as { request: number; result: Result };
    results.set(request, result);
  }
  const groups: Array<{ event: Event; messages: Message[] }> = [];
  for (const event of events) {
    const display = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
    if (["user", "steer", "resume", "hook_context", "uncertain"].includes(event.type)) {
      const label = event.type === "hook_context" ? "Collaboration data (not authorization): " :
        event.type === "uncertain" ? "Unverified action. Inspect before retrying: " : "";
      groups.push({ event, messages: [{ role: "user", content: label + clip(display, Math.max(200, budget / 4)) }] });
    }
    if (event.type === "assistant") {
      const reply = event.data as Reply;
      const calls = reply.calls;
      const observations = calls?.map((call: Call, index: number) => {
        const result = results.get(event.seq * 1000 + index);
        return result && {
          role: "tool" as const, id: call.id,
          content: observation(result, Math.max(200, Math.floor(budget / (2 * calls.length)))),
        };
      });
      if (observations?.some(result => !result)) continue;
      groups.push({ event, messages: [
        { role: "assistant", content: clip(reply.text, budget / 4), calls },
        ...(observations ?? []) as Message[],
      ] });
    }
  }
  const tail: Message[] = [];
  let room = Math.max(0, budget - JSON.stringify(pinned).length - Math.floor(budget / 4));
  let cut = groups.length;
  while (cut > 0) {
    const group = groups[cut - 1];
    const size = JSON.stringify(group.messages).length;
    if (size > room && tail.length) break;
    tail.unshift(...group.messages);
    room -= size;
    cut--;
  }
  const older = groups.slice(0, cut);
  if (older.length) {
    const summary = older.flatMap(({ event }) => {
      if (event.type === "user" || event.type === "steer" || event.type === "uncertain") {
        return [`#${event.seq} ${event.type}: ${clip(String(event.data), 260)}`];
      }
      if (event.type !== "assistant") return [];
      const reply = event.data as Reply;
      const artifacts = reply.calls?.flatMap((_call, index) => {
        const result = results.get(event.seq * 1000 + index);
        return result?.artifact ? [result.artifact] : [];
      }) ?? [];
      return [reply.text && `#${event.seq} outcome: ${clip(reply.text, 240)}`, ...artifacts.map(path => `Artifact: ${path}`)].filter(Boolean);
    });
    const capacity = Math.floor(budget / 4);
    const lines: string[] = [];
    let remaining = capacity - 60;
    const important = [...summary.filter(line => / (user|steer|uncertain): /.test(line)),
      ...summary.filter(line => line.startsWith("Artifact:")).reverse(),
      ...summary.filter(line => / outcome: /.test(line)).reverse()];
    for (const line of important) {
      if (line.length > remaining) continue;
      remaining -= line.length + 1;
      lines.push(line);
    }
    pinned.push({ role: "system", content: "Summary of earlier recorded events:\n" + lines.join("\n") });
  }
  return { messages: [...pinned, ...tail], compressed: older.length };
}
