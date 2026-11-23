import { randomUUID } from "node:crypto";
import { lstat, link, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Args, Call, ToolSpec } from "./model.js";
import { runProcess } from "./process.js";

export type Permission = "allow" | "ask" | "deny";
export type Result = { ok: boolean; value?: unknown; reason?: string; artifact?: string };
export type Tool = ToolSpec & {
  permission: Permission;
  effect: boolean;
  execute(args: Args, signal: AbortSignal): Promise<Result>;
};

export const objectSchema = (properties: Args, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string", minLength: 1 };

export class Registry {
  private readonly tools = new Map<string, { tool: Tool; validate: ValidateFunction }>();
  private readonly validator = new Ajv({ strict: false });
  private readonly validator2020 = new Ajv2020({ strict: false });

  add(tool: Tool): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || this.tools.has(tool.name)) {
      throw new Error(`Invalid or duplicate tool name: ${tool.name}`);
    }
    const validator = tool.schema.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? this.validator2020 : this.validator;
    this.tools.set(tool.name, { tool, validate: validator.compile(tool.schema) });
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map(({ tool: { name, description, schema } }) => ({ name, description, schema }));
  }

  check(call: Call): { tool: Tool; args: Args } {
    const entry = this.tools.get(call.name);
    if (!entry) throw new Error(`Unknown tool: ${call.name}`);
    if (!entry.validate(call.args)) {
      throw new Error(`Invalid arguments: ${this.validator.errorsText(entry.validate.errors)}`);
    }
    return { tool: entry.tool, args: call.args as Args };
  }
}

export async function workspacePath(cwd: string, path: string, allowMissing = false): Promise<string> {
  const parts = path.split(/[\\/]/);
  if (isAbsolute(path) || path !== path.trim() || parts.some(part => !part || part === "." || part === ".." ||
      /^\.git$/i.test(part) || /[:\r\n\0]/.test(part) || /[. ]$/.test(part))) {
    throw new Error("Use a workspace-relative file path without traversal or special components");
  }
  let current = cwd;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && allowMissing && index === parts.length - 1) return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error("Workspace tools reject symbolic links and junctions");
    if (info?.isFile() && info.nlink !== 1) throw new Error("Workspace tools reject hard-linked files");
    if (info && index === parts.length - 1 && !info.isFile()) throw new Error("Expected a regular file");
  }
  const parent = await realpath(dirname(current));
  const back = relative(cwd, parent);
  if (back === ".." || back.startsWith("../") || back.startsWith("..\\") || isAbsolute(back)) {
    throw new Error("Path resolves outside workspace");
  }
  return current;
}

async function readSmall(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(65_537);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === buffer.length) throw new Error("File exceeds the 64 KiB tool limit");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } finally {
    await handle.close();
  }
}

type Patch = { path: string; create: boolean; lines: string[] };

export function parsePatch(input: string): Patch {
  const lines = input.replaceAll("\r\n", "\n").trimEnd().split("\n");
  const header = /^\*\*\* (Add|Update) File: (.+)$/.exec(lines[1] ?? "");
  if (lines[0] !== "*** Begin Patch" || !header || lines.at(-1) !== "*** End Patch") {
    throw new Error("Expected a single Add File or Update File patch");
  }
  const body = lines.slice(2, -1);
  const create = header[1] === "Add";
  if (!body.length || body.some(line => !/^[ +\-]/.test(line) && (create || line !== "@@")) ||
      (create && body.some(line => !line.startsWith("+"))) ||
      (!create && body[0] !== "@@")) {
    throw new Error("Invalid patch body. Use @@ with exact context for updates and + lines for additions");
  }
  return { path: header[2], create, lines: body };
}

async function applyPatch(cwd: string, patch: Patch, signal: AbortSignal): Promise<Result> {
  const file = await workspacePath(cwd, patch.path, patch.create);
  const original = patch.create ? "" : await readSmall(file);
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  let contents = patch.lines.map(line => line.slice(1)).join(newline) + newline;
  if (!patch.create) {
    const source = original.replaceAll("\r\n", "\n").split("\n");
    let cursor = 0;
    const hunks: string[][] = [];
    for (const line of patch.lines) {
      if (line === "@@") hunks.push([]);
      else hunks.at(-1)!.push(line);
    }
    for (const hunk of hunks) {
      const before = hunk.filter(line => !line.startsWith("+")).map(line => line.slice(1));
      const after = hunk.filter(line => !line.startsWith("-")).map(line => line.slice(1));
      const matches = source.flatMap((_line, index) =>
        index >= cursor && before.length && before.every((line, offset) => line === source[index + offset])
          ? [index] : []);
      if (matches.length !== 1) throw new Error("Patch context must match exactly once after the previous hunk");
      const start = matches[0];
      source.splice(start, before.length, ...after);
      cursor = start + after.length;
    }
    contents = source.join(newline);
  }
  const temp = resolve(dirname(file), `.toy-patch-${randomUUID()}`);
  const mode = patch.create ? 0o666 : (await lstat(file)).mode & 0o777;
  await writeFile(temp, contents, { flag: "wx", mode });
  try {
    await workspacePath(cwd, patch.path, patch.create);
    if (!patch.create && await readSmall(file) !== original) throw new Error("File changed during patch");
    signal.throwIfAborted();
    if (patch.create) await link(temp, file);
    else await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
  return { ok: true, value: { path: patch.path, operation: patch.create ? "added" : "updated" }, artifact: file };
}

export function localTools(cwd: string, timeout: number, limit: number): Tool[] {
  return [
    {
      name: "read_file", description: "Read a workspace-relative UTF-8 file up to 64 KiB.",
      schema: objectSchema({ path: string }), permission: "allow", effect: false,
      async execute({ path }) {
        return { ok: true, value: await readSmall(await workspacePath(cwd, String(path))) };
      },
    },
    {
      name: "apply_patch",
      description: "Apply one text-file patch. Use *** Begin Patch, *** Add File: path with + lines, or *** Update File: path with @@ hunks (space context, - old, + new), then *** End Patch.",
      schema: objectSchema({ input: { ...string, maxLength: 65_536 } }), permission: "ask", effect: true,
      async execute({ input }, signal) { return applyPatch(cwd, parsePatch(String(input)), signal); },
    },
    {
      name: "Bash", description: "Run a user-approved command in the platform's shell with workspace cwd (cmd.exe on Windows).",
      schema: objectSchema({ command: { ...string, maxLength: 4096 } }), permission: "ask", effect: true,
      async execute({ command }, signal) {
        const result = await runProcess(String(command), [], { cwd, signal, timeout, limit, shell: true });
        const reason = result.failure ?? (result.exitCode !== 0 ? `Command exited with code ${result.exitCode}` : undefined);
        return { ok: !reason, value: result, reason };
      },
    },
  ];
}
