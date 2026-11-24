import type { Journal } from "../../toy-harness/src/journal.js";
import type { Args, Model, Reply } from "../../toy-harness/src/model.js";
import type { Result } from "../../toy-harness/src/tools.js";
import type { Peer } from "./protocol.js";

const call = (id: string, name: string, args: Args): Reply => ({ text: "", calls: [{ id, name, args }] });
const patch = (file: string, operation: string, lines: string[]) =>
  call("write", "apply_patch", { input: ["*** Begin Patch", `*** ${operation} File: ${file}`, ...lines, "*** End Patch"].join("\n") });

function inboxOf(context: string) {
  const inbox = context.split("\nUnread messages:\n")[1]?.split("\n\nTreat peer messages")[0] ?? "";
  return [...inbox.matchAll(/(?:^|\n\n)From ([a-z0-9][a-z0-9._-]*) \(([^\n]+)\):\n([\s\S]*?)(?=\n\nFrom [a-z0-9][a-z0-9._-]* \(|$)/gi)]
    .map(([, sender, id, message]) => ({ sender, id, message: message.trim() }));
}

export function offlineModel(journal: Journal, peer?: Peer): Model {
  return {
    async next(messages, _tools, signal) {
      signal.throwIfAborted();
      const history = journal.active();
      const user = history.findLast(event => event.type === "user")!;
      const turn = history.filter(event => event.turn === user.turn);
      const edits = turn.filter(event => event.type === "steer").map(event => String(event.data));
      const task = [String(user.data), ...edits].join(" ");
      const outcome = (id: string) => turn.filter(event => event.type === "result")
        .map(event => event.data as { id: string; result: Result })
        .findLast(event => event.id === id && !/newer user instruction|^User interrupted$/.test(event.result.reason ?? ""))?.result;
      const sent = outcome("send");
      if (peer && /口令|消息|回复|转发|发给/.test(task)) {
        const route = task.match(/(?:给|回复|发送至|转发至)\s*[@`]?([a-z0-9][a-z0-9._-]{0,63})/i)?.[1].toLowerCase();
        const mail = history.filter(event => event.type === "hook_context").flatMap(event => inboxOf(String(event.data)));
        const source = task.match(/([a-z0-9][a-z0-9._-]{0,63})\s*(?:刚才|刚)?(?:发来|发的)/i)?.[1].toLowerCase();
        const latest = mail.findLast(item => !source || item.sender.toLowerCase() === source);
        const text = task.match(/[「“](.+?)[」”]/)?.[1] ?? task.match(/(?:发送|发出)\s*(?:口令|消息)\s*[:：]?\s*([^，。！？\r\n]+)/)?.[1]?.trim();
        if (/发送|发给|转发|原样回复|回复\s*[a-z0-9]/i.test(task)) {
          const recipient = route ?? (/回复/.test(task) ? latest?.sender : undefined);
          const message = text ?? latest?.message;
          if (!recipient || !message) return { text: "请指定收件成员和消息正文，或先收取要转发的消息。" };
          if (!sent && !turn.some(event => event.type === "uncertain")) {
            return call("send", "team_send_message", {
              recipients: [recipient], message, ...(/回复/.test(task) && latest ? { reply_to: latest.id } : {}),
            });
          }
          return { text: sent?.ok ? `已向 ${recipient} 发送「${message}」。` : "本回合未确认发送成功，请查看工具结果。" };
        }
        return { text: latest ? `收到来自 ${latest.sender} 的消息「${latest.message}」。` : "未找到匹配的消息。" };
      }
      const cwd = journal.cwd;
      const code = /math\.mjs|check\.mjs|修复|failing total/i.test(task);
      const revise = !code && /修订|结论|revise|conclusion/i.test(task);
      const sourceReport = !revise && /north\.txt|south\.txt|资料/.test(task);
      const file = code ? "math.mjs" : "report.md";
      const newPlan = !outcome("plan") || (turn.findLast(event => event.type === "resume")?.seq ?? 0) >
        (turn.findLast(event => event.type === "request" && (event.data as { call: { id: string } }).call.id === "plan")?.seq ?? 0);
      if (turn.some(event => event.type === "uncertain")) {
        if (!outcome("verify")) return call("verify", "read_file", { path: file });
        return { text: `已读取 \`${file}\` 供核实。先前的操作结果未知，请检查工具输出后决定下一步。` };
      }
      if (code || revise) {
        if (!outcome("read")) return call("read", "read_file", { path: file });
        if (!outcome("read")?.ok) return { text: `无法读取 \`${file}\`，请检查所选工作目录。` };
      }
      if (sourceReport) {
        if (!outcome("north")) return call("north", "read_file", { path: "north.txt" });
        if (!outcome("south")) return call("south", "read_file", { path: "south.txt" });
        if (!outcome("north")?.ok || !outcome("south")?.ok) return { text: "资料夹具不完整，请选择包含 north.txt 和 south.txt 的目录。" };
      }
      if (peer && newPlan && !outcome("write")) {
        if (outcome("plan") && !outcome("plan")?.ok && !turn.some(event => event.type === "resume")) return { text: "Hub 未确认工作计划，请查看工具结果。" };
        const currentTurn = messages[0]?.content?.match(/Active turn ID: ([\w-]+)\./)?.[1];
        return call("plan", "team_update_state", { turn_id: currentTurn, intent_summary: task.slice(0, 200), planned_paths: [file], cwd, status: "working" });
      }
      if (code && !outcome("before")) return call("before", "Bash", { command: "node check.mjs" });
      const write = outcome("write");
      if (!write) {
        if (code) return patch(file, "Update", ["@@", "-  return items.reduce((sum, item) => sum + item, 1);", "+  return items.reduce((sum, item) => sum + item, 0);"]);
        if (revise) {
          const source = String(outcome("read")?.value ?? "");
          const anchor = source.includes("Sources: north.txt, south.txt") ? "Sources: north.txt, south.txt" : "# TeamHub 工作记录";
          return patch(file, "Update", ["@@", " " + anchor, "+", "+结论：每周发布进度摘要，并商定统一的发布日期。"]);
        }
        const safeTask = task.replace(/[\r\n]+/g, " ").slice(0, 1500);
        return patch(file, "Add", sourceReport ? [
          "+# Pilot findings", "+", "+Both pilots recommend a weekly status summary.",
          "+North prefers Monday and South prefers Friday.", "+", "+Sources: north.txt, south.txt",
        ] : ["+# TeamHub 工作记录", "+", "+任务：" + safeTask]);
      }
      if (!write.ok) return { text: `未能写入 \`${file}\`。请查看工具结果。` };
      if (code && !outcome("after")) return call("after", "Bash", { command: "node check.mjs" });
      if (code) {
        const result = outcome("after");
        const exit = (result?.value as { exitCode?: number } | undefined)?.exitCode;
        return { text: exit === 0 ? "已修复 `math.mjs`，检查通过（退出码 0）。" : "已修改 `math.mjs`，请查看检查结果。" };
      }
      return { text: revise ? "已将结论写入 `report.md`。" : "已生成 `report.md`。" };
    },
  };
}
