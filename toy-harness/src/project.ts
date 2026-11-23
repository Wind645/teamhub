import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Message, Model } from "./model.js";
import { objectSchema, Registry, workspacePath, type Tool } from "./tools.js";

const name = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" };
const shortText = { type: "string", minLength: 1, maxLength: 4000 };

async function optional<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

async function text(cwd: string, file: string): Promise<string> {
  const content = await readFile(await workspacePath(cwd, file), "utf8");
  if (content.length > 6000) throw new Error(`${file} exceeds the 6000-character instruction limit`);
  return content;
}

export async function projectSetup(cwd: string): Promise<{ instructions: string; tools: Tool[] }> {
  const instructions = await optional(() => text(cwd, "AGENTS.md")) ?? "";
  const entries = await optional(() => readdir(join(cwd, ".skills"), { withFileTypes: true })) ?? [];
  const names = entries.filter(entry => entry.isDirectory() && new RegExp(name.pattern).test(entry.name))
    .map(entry => entry.name).sort();
  const available: string[] = [];
  const skills = new Map<string, string>();
  for (const skill of names) {
    const content = await optional(() => text(cwd, `.skills/${skill}/SKILL.md`));
    if (content !== undefined) {
      available.push(skill);
      skills.set(skill, content);
    }
  }
  return {
    instructions: (instructions ? "\nProject instructions (AGENTS.md):\n" + instructions : "") +
      (available.length ? "\nAvailable skills: " + available.join(", ") + ". Use load_skill when relevant." : ""),
    tools: available.length ? [{
      name: "load_skill", description: "Load project skill instructions by name.",
      schema: objectSchema({ name: { ...name, enum: available } }),
      permission: "allow", effect: false,
      async execute({ name }) { return { ok: true, value: skills.get(String(name)) }; },
    }] : [],
  };
}

export function delegateTool(model: Model, read: Tool, instructions: string): Tool {
  const registry = new Registry();
  registry.add(read);
  return {
    name: "delegate_review",
    description: "Ask a separate read-only reviewer to verify claims against workspace source files. Provide a scoped task.",
    schema: objectSchema({ task: shortText }),
    permission: "allow", effect: false,
    async execute({ task }, signal) {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const messages: Message[] = [{
        role: "system",
        content: "You are a read-only source reviewer. Check files with read_file, cite the filenames that support each conclusion, and report uncertainty." + instructions,
      }, { role: "user", content: String(task) }];
      let reads = 0;
      for (let step = 0; step < 5; step++) {
        bounded.throwIfAborted();
        const reply = await model.next(messages, registry.specs(), bounded);
        const calls = reply.calls ?? [];
        if (!calls.length) return { ok: true, value: { review: reply.text.slice(0, 6000) } };
        reads += calls.length;
        if (reads > 8) break;
        messages.push({ role: "assistant", content: reply.text, calls });
        for (const call of calls) {
          bounded.throwIfAborted();
          try {
            const { tool, args } = registry.check(call);
            if (tool.permission !== "allow") throw new Error("Read permission required for delegated access");
            const result = await tool.execute(args, bounded);
            messages.push({ role: "tool", id: call.id, content: JSON.stringify(result).slice(0, 6000) });
          } catch (error) {
            messages.push({ role: "tool", id: call.id, content: String(error) });
          }
        }
      }
      return { ok: false, reason: "Review budget exhausted" };
    },
  };
}
