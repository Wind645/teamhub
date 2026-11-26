import React from "react";
export { toolIndex } from "./timeline-model.js";

type Row = { seq?: number; event?: { seq: number } };
const seq = (row: Row) => row.seq ?? row.event!.seq;
const batchSize = 80;

// Key by session in the caller. Only mounted history is limited, never the log.
export function HistoryWindow<T extends Row>({ items, pendingSeq, children }: {
  items: T[]; pendingSeq?: number; children: (item: T) => React.ReactNode;
}) {
  const [anchor, setAnchor] = React.useState<number>();
  const button = React.useRef<HTMLButtonElement>(null);
  const restore = React.useRef<{ box: HTMLElement; top: number; height: number } | null>(null);
  let start = anchor === undefined ? Math.max(0, items.length - batchSize) : items.findIndex(item => seq(item) >= anchor);
  if (start < 0) start = Math.max(0, items.length - batchSize);
  const pending = pendingSeq === undefined ? -1 : items.findIndex(item => seq(item) === pendingSeq);
  if (pending >= 0) start = Math.min(start, pending);
  React.useLayoutEffect(() => {
    const saved = restore.current;
    if (saved) {
      saved.box.scrollTop = saved.top + saved.box.scrollHeight - saved.height;
      restore.current = null;
    }
  }, [anchor]);
  const earlier = () => {
    const box = button.current?.closest<HTMLElement>(".timeline-scroll");
    if (box) restore.current = { box, top: box.scrollTop, height: box.scrollHeight };
    setAnchor(seq(items[Math.max(0, start - batchSize)]));
  };
  return <>
    {start > 0 && <button ref={button} className="history-earlier" onClick={earlier}>查看更早的消息（还有 {start} 条）</button>}
    {items.slice(start).map(children)}
  </>;
}
