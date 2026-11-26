import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "teamhub-stream-"));
const file = join(dir, "stream.cjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/state-stream.ts", import.meta.url))], outfile: file,
  platform: "node", format: "cjs", bundle: true });
const { StateEncoder, StateDecoder, StatePublisher } = createRequire(import.meta.url)(file);
const event = (seq, type = "notice", data = `event-${seq}`) => ({ seq, type, data, turn: "t" });
const fixture = () => ({ peer: "alice", profile: { mode: "offline", config: {} }, conversations: [], active: "a",
  sessions: { a: { phase: "ready", events: [event(1, "status", "running")] }, b: { phase: "idle", events: [event(1)] } } });

test("delta transport preserves statuses, pending approvals, histories, deletion and replaced arrays", () => {
  const s = fixture(), encode = new StateEncoder(), decode = new StateDecoder();
  let rev = 0;
  const update = reset => decode.apply(structuredClone(encode.encode(s, ++rev, reset)));
  const first = update(true), stable = first.sessions.b;
  s.sessions.a.events.push(event(2));
  s.sessions.a.pending = { request: 1, turn: "t", callId: "c", name: "Bash", args: {} };
  let next = update();
  assert.deepEqual(next, s);
  assert.equal(next.sessions.b, stable);
  assert.equal(first.sessions.a.events.length, 1, "previous immutable UI snapshot stays unchanged");
  delete s.sessions.a.pending;
  s.sessions.a.events.push(event(3, "status", "completed"), event(4, "rollback", 1));
  assert.deepEqual(update(), s);
  s.sessions.a.events = [event(1, "status", "paused")];
  assert.deepEqual(update(), s);
  delete s.sessions.b;
  assert.deepEqual(update(), s);
  assert.deepEqual(update(true), s, "reload sends a complete baseline");
});

test("slow renderer holds only one packet, catches up to latest status, isolates windows and rejects stale ACK", () => {
  const s = fixture(), publisher = new StatePublisher(), packets = [];
  const endpoint = Object.assign(new EventEmitter(), { send: (_channel, packet) => packets.push(structuredClone(packet)) });
  publisher.watch(endpoint, () => s);
  for (let i = 2; i <= 10002; i++) {
    s.sessions.a.events.push(event(i));
    publisher.publish(endpoint, () => s);
  }
  s.sessions.a.events.push(event(10003, "status", "completed"));
  publisher.publish(endpoint, () => s);
  assert.equal(packets.length, 1);
  publisher.ack(endpoint, -1);
  assert.equal(packets.length, 1);
  publisher.ack(endpoint, packets[0].revision);
  assert.equal(packets.length, 2, "one current update, not thousands of obsolete snapshots");
  const decode = new StateDecoder();
  packets.forEach(packet => decode.apply(packet));
  assert.deepEqual(decode.current, s);
  const other = Object.assign(new EventEmitter(), { send: (_channel, p) => assert.equal(p.head.peer, "bob") });
  publisher.watch(other, () => ({ ...fixture(), peer: "bob" }));
  const previous = packets.at(-1).revision;
  publisher.watch(endpoint, () => s);
  publisher.publish(endpoint, () => s);
  publisher.ack(endpoint, previous);
  assert.equal(packets.length, 3, "old page ACK cannot release new page's packet");
});

test("large history updates send only appended events (measured payload)", () => {
  const s = fixture(), encoder = new StateEncoder();
  s.sessions.b.events = Array.from({ length: 1000 }, (_, i) => event(i + 1, "result", "x".repeat(8000)));
  const baselineBytes = Buffer.byteLength(JSON.stringify(encoder.encode(s, 1, true)));
  s.sessions.a.events.push(event(2, "status", "completed"));
  const delta = encoder.encode(s, 2);
  const deltaBytes = Buffer.byteLength(JSON.stringify(delta));
  assert.equal(delta.changes.b, undefined);
  assert.equal(delta.changes.a.events.length, 1);
  assert.ok(deltaBytes < baselineBytes / 1000);
  console.log(JSON.stringify({ baselineBytes, deltaBytes, reduction: `${(100 * (1 - deltaBytes / baselineBytes)).toFixed(3)}%` }));
});
