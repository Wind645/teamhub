// Runs before the application module, including when that module fails to load.
(() => {
  let shown = false;
  function recover(error) {
    if (shown) return;
    shown = true;
    console.error("[TeamHub renderer failure]", error instanceof Error ? error.name + ": " + error.message : "Application module failed");
    const panel = document.createElement("section");
    panel.className = "renderer-recovery";
    panel.setAttribute("role", "alert");
    const title = document.createElement("h1");
    title.textContent = "界面显示遇到错误";
    const text = document.createElement("p");
    text.textContent = "可以重新加载界面，读取已有会话记录。这不会重新提交任务；尚未发送的输入请先复制保存。";
    const button = document.createElement("button");
    button.textContent = "重新加载界面";
    button.onclick = () => location.reload();
    panel.append(title, text, button);
    (document.body || document.documentElement).append(panel);
  }
  window.addEventListener("error", event => {
    if (event instanceof ErrorEvent) recover(event.error);
    else if (event.target instanceof HTMLScriptElement) recover();
  }, true);
  // React 19 reports uncaught rendering exceptions through window.reportError.
  // Do not treat ordinary rejected API calls as a crashed renderer.
})();
