import type { Event } from "../../toy-harness/src/journal";
import type { OutputUpdate, Reply } from "../../toy-harness/src/model";

type OutputRow = { kind: "text" | "reasoning"; seq: number; text: string; active: boolean };
type Row = OutputRow | { kind: "event"; event: Event };

export function timelineRows(events: Event[], running: boolean): Row[] {
  const rows: Row[] = [];
  let part: { id: string; turn?: string; row: OutputRow } | undefined;
  let assistant: { seq: number; turn?: string; text: string } | undefined;
  const endPart = () => {
    if (part) part.row.active = false;
    part = undefined;
  };
  for (const event of events) {
    if (event.type === "assistant_output") {
      const update = event.data as OutputUpdate;
      if (update.type === "end") {
        if (update.id === undefined || (part?.id === update.id && part.turn === event.turn)) endPart();
      } else if (update.text) {
        if (part?.id === update.id && part.turn === event.turn && part.row.kind === update.kind) {
          part.row.text += update.text;
        } else {
          endPart();
          const row = { kind: update.kind, seq: event.seq, text: update.text, active: true };
          rows.push(row);
          part = { id: update.id, turn: event.turn, row };
        }
      }
    } else if (event.type === "assistant") {
      endPart();
      const reply: Reply & { streamedText?: boolean } =
        typeof event.data === "string" ? { text: event.data } : event.data as Reply;
      if (reply.text && !reply.streamedText) {
        rows.push({ kind: "text", seq: event.seq, text: reply.text, active: false });
      }
      assistant = reply.calls?.length ? undefined : { seq: event.seq, turn: event.turn, text: reply.text };
    } else if (event.type === "final") {
      endPart();
      const text = String(event.data);
      if (text && (assistant?.seq !== event.seq - 1 || assistant.turn !== event.turn || assistant.text !== text)) {
        rows.push({ kind: "text", seq: event.seq, text, active: false });
      }
    } else if (["user", "steer", "request", "notice", "uncertain", "resume"].includes(event.type)) {
      endPart();
      rows.push({ kind: "event", event });
    } else if (event.type === "model" || event.type === "status") {
      endPart();
    }
  }
  if (!running) endPart();
  return rows;
}
