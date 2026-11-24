import type { ApprovalKey, Pending } from "./protocol.js";

export class ApprovalGate {
  private waiting?: { pending: Pending; settle: (allow: boolean) => void };

  constructor(private readonly publish: (pending?: Pending) => void) {}

  wait(pending: Pending, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const abort = () => settle(false);
      const settle = (allow: boolean) => {
        this.waiting = undefined;
        signal.removeEventListener("abort", abort);
        this.publish();
        resolve(allow);
      };
      this.waiting = { pending, settle };
      signal.addEventListener("abort", abort, { once: true });
      this.publish(pending);
    });
  }

  answer(key: ApprovalKey, allow: boolean): boolean {
    const waiting = this.waiting;
    if (!waiting || !key || typeof allow !== "boolean") return false;
    const { pending } = waiting;
    if (key.turn !== pending.turn || key.request !== pending.request || key.callId !== pending.callId) return false;
    waiting.settle(allow);
    return true;
  }
}
