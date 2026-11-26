import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow, Dialog } from "electron";

// Read state at flush time: intermediate stream events are coalesced, but the
// latest pending approval, pause, result and history remain in the snapshot.
export function coalesceUpdates<T>(send: (key: T) => void, delay = 16) {
  const pending = new Set<T>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (key: T) => {
    pending.add(key);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const batch = [...pending];
      pending.clear();
      for (const item of batch) send(item);
    }, delay);
  };
}

export function protectRenderer(window: BrowserWindow, dialog: Dialog, data: string) {
  const log = (entry: Record<string, unknown>) => {
    try {
      appendFileSync(join(data, "renderer-health.jsonl"), JSON.stringify({ at: new Date().toISOString(), window: window.id, ...entry }) + "\n");
    } catch { /* Diagnostics must never take down the UI. */ }
  };
  window.webContents.on("console-message", (_event, level, message) => {
    if (message.startsWith("[TeamHub renderer failure]")) log({ type: "render-error", level, message });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log({ type: "render-process-gone", reason: details.reason, exitCode: details.exitCode });
    if (window.isDestroyed() || details.reason === "clean-exit") return;
    // Only the view reloads. Do not restart workers, resend tasks or drop logs.
    void dialog.showMessageBox(window, {
      type: "error", title: "TeamHub 界面需要恢复", message: "显示进程已退出。",
      detail: "可以重新加载界面并读取已有记录。此操作不会重新提交任务。",
      buttons: ["重新加载界面", "稍后处理"], defaultId: 0, cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !window.isDestroyed()) window.webContents.reload();
    }).catch(() => {});
  });
  window.on("unresponsive", () => log({ type: "unresponsive" }));
}
