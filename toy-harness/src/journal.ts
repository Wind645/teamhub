import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, truncateSync } from "node:fs";
import { resolve } from "node:path";

export type Event = {
  seq: number; at: string; type: string; turn?: string; data: unknown;
};

export class Journal {
  readonly id: string;
  readonly file: string;
  readonly events: Event[] = [];

  constructor(directory: string, readonly cwd: string, id?: string, createId?: string) {
    this.id = id ?? createId ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(this.id)) throw new Error("Invalid session ID");
    mkdirSync(directory, { recursive: true });
    this.file = resolve(directory, `${this.id}.jsonl`);
    if (id) {
      const bytes = readFileSync(this.file);
      const lastNewline = bytes.lastIndexOf(10);
      const complete = bytes.subarray(0, lastNewline + 1);
      this.events = complete.toString("utf8").trim().split("\n").map(line => JSON.parse(line) as Event);
      if (this.events[0]?.type !== "session" || this.events[0].data !== cwd) {
        throw new Error("Session belongs to a different workspace");
      }
      if (this.events.some((event, index) => event.seq !== index + 1)) {
        throw new Error("Session event sequence is invalid");
      }
      if (complete.length !== bytes.length) truncateSync(this.file, complete.length);
    } else {
      this.add("session", cwd);
    }
  }

  add(type: string, data: unknown, turn?: string): Event {
    const event = { seq: this.events.length + 1, at: new Date().toISOString(), type, turn, data };
    const fd = openSync(this.file, this.events.length ? "a" : "ax", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(event) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.events.push(event);
    return event;
  }

  active(): Event[] {
    let result: Event[] = [];
    for (const event of this.events) {
      if (event.type === "rollback") result = result.filter(item => item.seq <= Number(event.data));
      else result.push(event);
    }
    return result;
  }
}
