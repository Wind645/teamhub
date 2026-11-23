import { isAbsolute } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Args } from "./model.js";
import { runProcess } from "./process.js";
import type { Hook, HookReply } from "./runtime.js";
import type { Tool } from "./tools.js";

export type HookConfig = {
  teamLifecycle?: boolean;
  events: string[];
  matcher?: string;
  command: string;
  args?: string[];
};

export type TeamConfig = { url: string; peer: string; hookPath: string; failClosed?: boolean };

export function teamHooks(config: TeamConfig): HookConfig[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.peer) ||
      new URL(config.url).pathname !== `/mcp/${encodeURIComponent(config.peer)}`) {
    throw new Error("TeamHub URL and hook must use the same peer identity");
  }
  if (!isAbsolute(config.hookPath)) throw new Error("TeamHub hookPath must be absolute");
  const command = process.execPath;
  const args = [config.hookPath, config.peer];
  return [
    { command, args, teamLifecycle: true, events: ["SessionStart", "UserPromptSubmit", "TurnResume", "TurnRelease", "Stop", "Interrupt", "SessionEnd"] },
    { command, args, events: ["PreToolUse", "PostToolUse"], matcher: "^(Bash|apply_patch)$" },
  ];
}

export function createHook(
  hooks: HookConfig[],
  cwd: string,
  timeout: number,
  log: (text: string) => void,
  team?: TeamConfig,
): Hook {
  const handlers = hooks.map(hook => ({
    ...hook, match: hook.matcher === undefined ? undefined : new RegExp(hook.matcher),
  }));
  return async (input: Args): Promise<HookReply> => {
    const merged: HookReply = {};
    for (const hook of handlers) {
      if (!hook.events.includes(String(input.hook_event_name)) ||
          hook.match && !hook.match.test(String(input.tool_name ?? ""))) continue;
      const env = team ? {
        ...process.env, TEAMHUB_MCP_URL: team.url,
        TEAMHUB_HOOK_FAIL_CLOSED: team.failClosed === undefined
          ? process.env.TEAMHUB_HOOK_FAIL_CLOSED : team.failClosed ? "1" : "0",
      } : process.env;
      const event = input.hook_event_name;
      const resume = hook.teamLifecycle && event === "TurnResume";
      const release = hook.teamLifecycle && event === "TurnRelease";
      const payload = resume || release ? { ...input, hook_event_name: resume ? "UserPromptSubmit" : "Stop" } : input;
      const result = await runProcess(hook.command, hook.args ?? [], {
        cwd, timeout, limit: 256_000, input: JSON.stringify(payload), env,
        signal: new AbortController().signal,
      });
      if (result.stderr.trim()) log(result.stderr.trim());
      if (result.failure || result.exitCode !== 0) {
        throw new Error(result.failure ?? `Hook exited with code ${result.exitCode}`);
      }
      const output: unknown = result.stdout.trim() ? JSON.parse(result.stdout) : {};
      if (!output || typeof output !== "object" || Array.isArray(output)) {
        throw new Error("Expected a JSON object from hook stdout");
      }
      const reply = output as HookReply;
      if (team && hook.teamLifecycle && typeof input.turn_id === "string" &&
          !reply.systemMessage && reply.continue !== false &&
          (resume || release || ["Stop", "Interrupt", "SessionEnd"].includes(String(event)))) {
        const client = new Client({ name: "toy-harness-lifecycle", version: "0.1.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(team.url)), { timeout });
          const status = resume ? "received" : event === "Interrupt" ? "interrupted" : event === "SessionEnd" ? "offline" : "idle";
          const updated = await client.callTool({ name: "team_update_state", arguments: {
            turn_id: input.turn_id, status, planned_paths: [],
          } }, { timeout });
          if (updated.isError) throw new Error("TeamHub declined the path release");
          if (resume) {
            const context = reply.hookSpecificOutput?.additionalContext ?? "";
            reply.hookSpecificOutput = { additionalContext: context + "\nThis turn resumed. Register a fresh plan before editing." };
          }
        } catch (error) {
          if (env.TEAMHUB_HOOK_FAIL_CLOSED === "1") throw error;
          reply.systemMessage = `TeamHub coordination check skipped: ${String(error)}`;
        } finally {
          await client.close();
        }
      }
      const context = [
        merged.hookSpecificOutput?.additionalContext, reply.hookSpecificOutput?.additionalContext,
      ].filter(Boolean).join("\n");
      const messages = [merged.systemMessage, reply.systemMessage].filter(Boolean).join("\n");
      Object.assign(merged, reply, { systemMessage: messages, hookSpecificOutput: { additionalContext: context } });
      if (reply.continue === false || reply.decision === "block") break;
    }
    return merged;
  };
}

export async function connectMcp(url: string, timeout: number): Promise<{
  client: Client; tools: Tool[];
}> {
  const client = new Client({ name: "toy-harness", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport, { timeout });
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      cursor = page.nextCursor;
      for (const spec of page.tools) {
        const readOnly = spec.annotations?.readOnlyHint === true;
        tools.push({
          name: spec.name,
          description: spec.description ?? spec.name,
          schema: spec.inputSchema,
          permission: spec.name === "team_begin_turn" ? "deny" : readOnly || spec.name === "team_update_state" ? "allow" : "ask",
          effect: !readOnly,
          async execute(args, signal) {
            const result = await client.callTool({ name: spec.name, arguments: args }, { signal, timeout });
            return { ok: !result.isError, value: result };
          },
        });
      }
    } while (cursor);
    return { client, tools };
  } catch (error) {
    await client.close();
    throw error;
  }
}
