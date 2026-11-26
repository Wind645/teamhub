import type { Event } from "../../toy-harness/src/journal.js";

type Prefix = { length: number; last?: Event };
const extendsPrefix = (events: Event[], old?: Prefix) => Boolean(old && events.length >= old.length &&
  (!old.length || events[old.length - 1] === old.last));
const prefix = (events: Event[]): Prefix => ({ length: events.length, last: events.at(-1) });

const activeExact = new WeakMap<Event[], Event[]>();
const activeLatest = new WeakMap<Event, Prefix & { result: Event[]; rolledBack: boolean }>();
export function activeEvents(events: Event[]): Event[] {
  const exact = activeExact.get(events);
  if (exact) return exact;
  if (!events.length) return events;
  const previous = activeLatest.get(events[0]);
  const old = extendsPrefix(events, previous) ? previous : undefined;
  const start = old?.length ?? 0;
  let rolledBack = old?.rolledBack ?? false;
  let result = rolledBack ? old!.result.slice() : events;
  for (let i = start; i < events.length; i++) {
    const event = events[i];
    if (event.type === "rollback") {
      if (!rolledBack) result = events.slice(0, i);
      result = result.filter(item => item.seq <= Number(event.data));
      rolledBack = true;
    } else if (rolledBack) result.push(event);
  }
  activeLatest.set(events[0], { ...prefix(events), result, rolledBack });
  activeExact.set(events, result);
  return result;
}

type ToolIndex = { results: Map<number, Event>; uncertain: Set<number> };
const indexExact = new WeakMap<Event[], ToolIndex>();
const indexLatest = new WeakMap<Event, Prefix & { result: ToolIndex }>();
export function toolIndex(events: Event[]): ToolIndex {
  const exact = indexExact.get(events);
  if (exact) return exact;
  const previous = events.length ? indexLatest.get(events[0]) : undefined;
  const old = extendsPrefix(events, previous) ? previous : undefined;
  let result = old?.result ?? { results: new Map<number, Event>(), uncertain: new Set<number>() };
  let copied = !old;
  for (let i = old?.length ?? 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== "result" && event.type !== "uncertain") continue;
    if (!copied) { result = { results: new Map(result.results), uncertain: new Set(result.uncertain) }; copied = true; }
    const request = (event.data as { request: number }).request;
    if (event.type === "result" && !result.results.has(request)) result.results.set(request, event);
    if (event.type === "uncertain") result.uncertain.add(request);
  }
  if (events.length) indexLatest.set(events[0], { ...prefix(events), result });
  indexExact.set(events, result);
  return result;
}

type TextRow = { kind: "text" | "reasoning"; seq: number; text: string; active: boolean };
export type TimelineRow = TextRow | { kind: "event"; event: Event };
type Stream = { id?: string; turn?: string; index: number };
type Reply = { seq: number; turn?: string; text: string };
type Timeline = Prefix & { rows: TimelineRow[]; stream?: Stream; reply?: Reply };
const rowsLatest = new WeakMap<Event, Timeline>();
const rowsExact = new WeakMap<Event[], Timeline>();
const stoppedRows = new WeakMap<Timeline, TimelineRow[]>();
const visible = new Set(["user", "steer", "request", "notice", "uncertain", "resume"]);

// Consume new chunks only. Finished rows retain their identities; current text
// is copied on change so previously rendered React snapshots never mutate.
export function timelineRows(events: Event[], running: boolean): TimelineRow[] {
  let state = rowsExact.get(events);
  if (!state) {
    const previous = events.length ? rowsLatest.get(events[0]) : undefined;
    const old = extendsPrefix(events, previous) ? previous : undefined;
    const rows = old ? old.rows.slice() : [];
    let stream = old?.stream, reply = old?.reply;
    const close = () => {
      if (stream) rows[stream.index] = { ...rows[stream.index] as TextRow, active: false };
      stream = undefined;
    };
    for (let i = old?.length ?? 0; i < events.length; i++) {
      const event = events[i];
      if (event.type === "assistant_output") {
        const data = event.data as { type: string; id?: string; kind: "text" | "reasoning"; text?: string };
        if (data.type === "end") {
          if (data.id === undefined || stream?.id === data.id && stream?.turn === event.turn) close();
        } else if (data.text) {
          const row = stream ? rows[stream.index] as TextRow : undefined;
          if (stream && stream.id === data.id && stream.turn === event.turn && row?.kind === data.kind) {
            rows[stream.index] = { ...row, text: row.text + data.text };
          } else {
            close();
            rows.push({ kind: data.kind, seq: event.seq, text: data.text, active: true });
            stream = { id: data.id, turn: event.turn, index: rows.length - 1 };
          }
        }
      } else if (event.type === "assistant") {
        close();
        const data = typeof event.data === "string" ? { text: event.data } : event.data as { text: string; streamedText?: boolean; calls?: unknown[] };
        if (data.text && !data.streamedText) rows.push({ kind: "text", seq: event.seq, text: data.text, active: false });
        reply = data.calls?.length ? undefined : { seq: event.seq, turn: event.turn, text: data.text };
      } else if (event.type === "final") {
        close();
        const text = String(event.data);
        if (text && (reply?.seq !== event.seq - 1 || reply.turn !== event.turn || reply.text !== text)) {
          rows.push({ kind: "text", seq: event.seq, text, active: false });
        }
      } else if (visible.has(event.type)) { close(); rows.push({ kind: "event", event }); }
      else if (event.type === "model" || event.type === "status") close();
    }
    state = { ...prefix(events), rows, stream, reply };
    if (events.length) rowsLatest.set(events[0], state);
    rowsExact.set(events, state);
  }
  if (running || !state.stream) return state.rows;
  let result = stoppedRows.get(state);
  if (!result) {
    result = state.rows.slice();
    result[state.stream.index] = { ...result[state.stream.index] as TextRow, active: false };
    stoppedRows.set(state, result);
  }
  return result;
}
