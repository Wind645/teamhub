import { StateDecoder, type StatePacket } from "../src/state-stream.js";
import type { Snapshot } from "../src/protocol.js";

type LiveApi = {
  subscribe(callback: (value: Snapshot | StatePacket) => void): () => void;
  state(): Promise<Snapshot>;
  watchState?(): void;
  ackState?(revision: number): void;
};

export function subscribeLiveState(api: LiveApi, update: (state: Snapshot) => void, fail: (error: unknown) => void) {
  const decoder = new StateDecoder();
  let disposed = false, received = false;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remove = api.subscribe(value => {
    if (disposed) return;
    received = true;
    if (!("revision" in value)) { update(value); return; } // diagnostics and older hosts
    try { update(decoder.apply(value)); }
    catch (error) { api.watchState?.(); fail(error); return; }
    // Give React a rendering opportunity before requesting the latest state.
    // A timer fallback also keeps minimized windows current (rAF may be paused).
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearTimeout(timer);
    const ack = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = undefined;
      if (!disposed) api.ackState?.(value.revision);
    };
    frame = requestAnimationFrame(ack);
    timer = setTimeout(ack, 50);
  });
  api.watchState?.();
  // Never let a slower initial RPC overwrite a more recent streamed state.
  void api.state().then(value => { if (!disposed && !received) update(value); }).catch(error => { if (!disposed) fail(error); });
  return () => { disposed = true; remove(); if (frame !== undefined) cancelAnimationFrame(frame); clearTimeout(timer); };
}
