import type { Snapshot, SessionState } from "./protocol.js";

export type StatePacket = {
  revision: number; reset: boolean;
  head: Omit<Snapshot, "sessions">;
  ids: string[];
  changes: Record<string, { from: number; state: Omit<SessionState, "events">; events: SessionState["events"] }>;
};

// Journal events are append-only. A replaced event array (worker restart/import)
// gets a fresh baseline; rollbacks are themselves events and remain in the log.
export class StateEncoder {
  private cursors = new Map<string, { events: SessionState["events"]; length: number; last: unknown; meta: string }>();
  encode(snapshot: Snapshot, revision: number, reset = false): StatePacket {
    if (reset) this.cursors.clear();
    const { sessions, ...head } = snapshot;
    const changes: StatePacket["changes"] = {};
    const ids = Object.keys(sessions);
    for (const id of this.cursors.keys()) if (!(id in sessions)) this.cursors.delete(id);
    for (const [id, session] of Object.entries(sessions)) {
      if (!session) continue;
      const { events, ...state } = session;
      const old = this.cursors.get(id);
      const from = old && old.events === events && old.length <= events.length &&
        (!old.length || events[old.length - 1] === old.last) ? old.length : 0;
      const meta = JSON.stringify(state);
      if (!old || from !== events.length || old.meta !== meta || old.events !== events) {
        changes[id] = { from, state, events: events.slice(from) };
      }
      this.cursors.set(id, { events, length: events.length, last: events.at(-1), meta });
    }
    return { revision, reset, head, ids, changes };
  }
}

export class StateDecoder {
  current?: Snapshot;
  revision = 0;
  apply(packet: StatePacket): Snapshot {
    if (packet.revision <= this.revision && this.current) return this.current;
    if (!packet.reset && !this.current) throw new Error("Missing state baseline");
    const sessions: Snapshot["sessions"] = {};
    for (const id of packet.ids) {
      const change = packet.changes[id];
      const old = packet.reset ? undefined : this.current?.sessions[id];
      if (!change) {
        if (old) sessions[id] = old;
        continue;
      }
      if (change.from && (!old || old.events.length !== change.from)) throw new Error("State history gap");
      sessions[id] = { ...change.state, events: change.from
        ? change.events.length ? old!.events.concat(change.events) : old!.events
        : change.events };
    }
    this.revision = packet.revision;
    return this.current = { ...packet.head, sessions };
  }
}

// Only one update is in flight. While the view is busy, retain a getter for
// current state instead of queuing obsolete, increasingly large snapshots.
type Endpoint = { send: (channel: string, packet: StatePacket) => void; once: (event: "destroyed", callback: () => void) => unknown };
export class StatePublisher {
  private streams = new WeakMap<Endpoint, { encoder: StateEncoder; get: () => Snapshot; flight: number; dirty: boolean }>();
  private revision = 0;
  watch(endpoint: Endpoint, get: () => Snapshot) {
    const stream = { encoder: new StateEncoder(), get, flight: 0, dirty: false };
    if (!this.streams.has(endpoint)) endpoint.once("destroyed", () => this.streams.delete(endpoint));
    this.streams.set(endpoint, stream);
    this.send(endpoint, stream, true);
  }
  publish(endpoint: Endpoint, get: () => Snapshot) {
    const stream = this.streams.get(endpoint);
    if (!stream) return;
    stream.get = get;
    stream.dirty = true;
    if (!stream.flight) this.send(endpoint, stream);
  }
  ack(endpoint: Endpoint, revision: number) {
    const stream = this.streams.get(endpoint);
    if (!stream || stream.flight !== revision) return;
    stream.flight = 0;
    if (stream.dirty) this.send(endpoint, stream);
  }
  private send(endpoint: Endpoint, stream: { encoder: StateEncoder; get: () => Snapshot; flight: number; dirty: boolean }, reset = false) {
    stream.flight = ++this.revision;
    stream.dirty = false;
    endpoint.send("teamhub:live-state", stream.encoder.encode(stream.get(), stream.flight, reset));
  }
}
