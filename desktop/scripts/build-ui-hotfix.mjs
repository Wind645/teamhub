// The distributed app is newer than this checkout. Patch only its UI delivery
// and recovery, retaining its approval controls and streaming. The runtime patch
// below only adds the opt-out for turn budgets; it does not replace the worker.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { build, transform } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const original = resolve(root, "release/win-unpacked");
const archive = join(original, "resources/app.asar");
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
if (digest !== "fb7a7d2712b668c51e754a5ce7a9d352f7a47e4b255cce41924340ad52a3024d") {
  throw new Error("The installed app has changed. Review its source before applying this version-specific UI hotfix.");
}
await mkdir(join(root, "build"), { recursive: true });
const stage = await mkdtemp(join(root, "build/ui-hotfix-"));
asar.extractAll(archive, stage);
function replaceOnce(text, before, after) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error("Unexpected bundle layout: " + before.slice(0, 65));
  return text.replace(before, after);
}
const mainFile = join(stage, "build/main.cjs");
let main = await readFile(mainFile, "utf8");
main = 'const uiHealth = require("./ui-health.cjs");\n' + main;
main = 'const { StatePublisher } = require("./state-stream.cjs");\nconst statePublisher = new StatePublisher();\n' + main;
main = replaceOnce(main, 'window.webContents.send("teamhub:state", snapshot(record))',
  'statePublisher.publish(window.webContents, () => snapshot(record))');
main = replaceOnce(main, 'function registerApi() {', `function registerApi() {
  for (const channel of ["watch-state", "ack-state"]) import_electron2.ipcMain.on("teamhub:" + channel, (event, revision) => {
    if (event.senderFrame !== event.sender.mainFrame) return;
    const owner = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!owner || owner.closing || quitting) return;
    if (channel === "watch-state") statePublisher.watch(event.sender, () => snapshot(owner.record));
    else if (Number.isSafeInteger(revision)) statePublisher.ack(event.sender, revision);
  });`);
main = replaceOnce(main, 'webPreferences: { preload: (0, import_node_path2.join)(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true }',
  'webPreferences: { preload: (0, import_node_path2.join)(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }');
main = replaceOnce(main, "function publish(peer) {", "const publishWorker = uiHealth.coalesceUpdates(peer => publish(peer));\nfunction publish(peer) {");
const workerStart = main.indexOf('proc.on("message", (message2) => {');
const workerEnd = main.indexOf("const message = {", workerStart);
if (workerStart < 0 || workerEnd < 0) throw new Error("Missing worker event handler");
main = main.slice(0, workerStart) + replaceOnce(main.slice(workerStart, workerEnd),
  "publish(this.peer);", 'if (message2.type === "event" && message2.event.type !== "status") publishWorker(this.peer); else publish(this.peer);') + main.slice(workerEnd);
const createWindowStart = main.indexOf("function createWindow(title, chooser = false) {");
if (createWindowStart < 0) throw new Error("Missing member window factory");
main = main.slice(0, createWindowStart) + replaceOnce(main.slice(createWindowStart),
  'window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));',
  'uiHealth.protectRenderer(window, import_electron2.dialog, data);\n  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));');
// Keep external navigation blocked while allowing the recovery button to reload
// the current local page. The previous blanket guard also blocked that reload.
main = main.slice(0, createWindowStart) + replaceOnce(main.slice(createWindowStart), 'window.webContents.on("will-navigate", (event) => event.preventDefault());',
  'window.webContents.on("will-navigate", (event) => { if (event.url !== window.webContents.getURL()) event.preventDefault(); });');
main = replaceOnce(main, 'outputLimit, turnTimeout } = value.config;', 'outputLimit, turnTimeout, autoPause } = value.config;\n  if (autoPause !== undefined && typeof autoPause !== "boolean") throw new Error("自动暂停设置必须为开或关");');
main = replaceOnce(main, '      outputLimit,\n      turnTimeout\n', '      outputLimit,\n      turnTimeout,\n      autoPause\n');
await transform(main, { loader: "js" }); // Fail before packaging malformed bundle patches.
await writeFile(mainFile, main);
await build({ entryPoints: [join(root, "src/ui-health.ts")], outfile: join(stage, "build/ui-health.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"] });
await build({ entryPoints: [join(root, "src/state-stream.ts")], outfile: join(stage, "build/state-stream.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node24" });
const preloadFile = join(stage, "build/preload.cjs");
let preload = await readFile(preloadFile, "utf8");
preload = replaceOnce(preload, '  state: () => invoke("state"),', `  state: () => invoke("state"),
  watchState: () => import_electron.ipcRenderer.send("teamhub:watch-state"),
  ackState: revision => import_electron.ipcRenderer.send("teamhub:ack-state", revision),`);
preload = replaceOnce(preload, 'return () => import_electron.ipcRenderer.off("teamhub:state", handler);',
  'import_electron.ipcRenderer.on("teamhub:live-state", handler);\n    return () => { import_electron.ipcRenderer.off("teamhub:state", handler); import_electron.ipcRenderer.off("teamhub:live-state", handler); };');
await writeFile(preloadFile, preload);
const uiFile = join(stage, "build/ui/assets/index-3zCRhiFA.js");
let ui = (await transform(await readFile(uiFile, "utf8"), { format: "esm" })).code;
ui = 'import { subscribeLiveState } from "./live-state.js";\n' + ui;
ui = replaceOnce(ui, 'const E = te.subscribe(t);\n    return te.state().then(t).catch((M) => f({ "": String(M) })), E;',
  'return subscribeLiveState(te, t, M => f({ "": String(M) }));');
await build({ entryPoints: [join(root, "ui/live-state.ts")], outfile: join(stage, "build/ui/assets/live-state.js"),
  bundle: true, format: "esm", target: "chrome130" });
const settingsStart = ui.indexOf('function bh({');
const settingsEnd = ui.indexOf('function al({', settingsStart);
if (settingsStart < 0 || settingsEnd < 0) throw new Error("Missing settings form");
ui = ui.slice(0, settingsStart) + replaceOnce(ui.slice(settingsStart, settingsEnd),
  '}, children: [d.jsxs("label", { className: "checkbox",',
  `}, children: [d.jsxs("label", { className: "checkbox", children: [d.jsx("input", { type: "checkbox", role: "switch", checked: r.config.autoPause !== false, onChange: event => i({ ...r, config: { ...r.config, autoPause: event.target.checked } }) }), "达到运行上限后自动暂停"] }),
  d.jsx("p", { className: "muted", children: "开启：达到步数或单轮时间上限后，需要手动继续。关闭：不因这两项上限暂停，仍可手动停止，审批和错误处理保持不变。仅影响当前成员；任务结束或停止后保存，下次运行或继续此回合时生效。" }),
  d.jsxs("label", { className: "checkbox",`) + ui.slice(settingsEnd);
ui = replaceOnce(ui, "function gh({", "ol = _.memo(ol);\nfunction gh({");
ui = replaceOnce(ui, 'className: "reasoning-body", children: d.jsx(ol, { text: t })',
  'className: "reasoning-body", children: o && d.jsx(ol, { text: t, active: n })');
ui = 'import { HistoryWindow, toolIndex } from "./history-performance.js";\n' + ui;
ui = 'import { activeEvents, timelineRows } from "./timeline-model.js";\n' + ui;
const activeStart = ui.indexOf('function Cn(e) {'), activeEnd = ui.indexOf('function il(', activeStart);
const rowsStart = ui.indexOf('function ph(e, t) {'), rowsEnd = ui.indexOf('const te = window.teamhub', rowsStart);
if (activeStart < 0 || activeEnd < 0 || rowsStart < 0 || rowsEnd < 0) throw new Error("Missing timeline reducers");
ui = ui.slice(0, activeStart) + 'const Cn = activeEvents;\n' + ui.slice(activeEnd);
ui = ui.slice(0, rowsStart) + 'const ph = timelineRows;\n' + ui.slice(rowsEnd);
await build({ entryPoints: [join(root, "ui/timeline-model.ts")], outfile: join(stage, "build/ui/assets/timeline-model.js"),
  bundle: true, format: "esm", target: "chrome130" });
ui = replaceOnce(ui, 'function ol({ text: e }) {', 'Or = _.memo(Or);\nfunction ol({ text: e }) {');
ui = replaceOnce(ui, 'x = ph(ne, g && !$?.issue),', 'x = _.useMemo(() => ph(ne, g && !$?.issue), [ne, g, $?.issue]),');
ui = replaceOnce(ui, "function ol({ text: e }) {", `function ol({ text: e, active }) {
  if (active) return d.jsx("div", { className: "markdown live-text", children: e });`);
ui = replaceOnce(ui, 'd.jsx(ol, { text: E.text })', 'd.jsx(ol, { text: E.text, active: E.active })');
const toolsStart = ui.indexOf("function xh({");
const toolsEnd = ui.indexOf("function yh({", toolsStart);
if (toolsStart < 0 || toolsEnd < 0) throw new Error("Missing tool renderer");
let tool = ui.slice(toolsStart, toolsEnd);
tool = replaceOnce(tool, 't.find((b) => b.type === "result" && b.data.request === l)', 'toolIndex(t).results.get(l)');
tool = replaceOnce(tool, 't.some((b) => b.type === "uncertain" && b.data.request === l)', 'toolIndex(t).uncertain.has(l)');
tool = replaceOnce(tool, '[p, h] = _.useState(false),', '[p, h] = _.useState(false), [expanded, setExpanded] = _.useState(false),');
tool = replaceOnce(tool, 'z = y ?? (', 'z = expanded || f ? y ?? (');
tool = replaceOnce(tool, ': Qe(m)), N =', ': Qe(m)) : "", N =');
tool = replaceOnce(tool, 'd.jsxs("details", { children:', 'd.jsxs("details", { onToggle: event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }, children:');
tool = replaceOnce(tool, 'd.jsxs("div", { className: "tool-body",', 'expanded && d.jsxs("div", { className: "tool-body",');
ui = ui.slice(0, toolsStart) + tool + ui.slice(toolsEnd);
ui = replaceOnce(ui, 'W && x.map((E) => {', `W && d.jsx(HistoryWindow, { items: x,
  pendingSeq: $?.pending ? ne.find(item => item.type === "request" && item.data.request === $.pending.request && item.turn === $.pending.turn)?.seq : undefined,
  children: (E) => {`);
ui = replaceOnce(ui, '}), De && d.jsx(vn,', '}}, P), De && d.jsx(vn,');
await build({ entryPoints: [join(root, "ui/history-performance.tsx")], outfile: join(stage, "build/ui/assets/history-performance.js"),
  bundle: true, format: "esm", target: "chrome130", jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
  tsconfigRaw: { compilerOptions: { jsx: "react" } }, define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "reuse-packaged-react", setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "packaged-react" }));
    builder.onLoad({ filter: /.*/, namespace: "packaged-react" }, () => ({ contents: 'export { r as default } from "./client-BaUToD7D.js";' }));
    builder.onResolve({ filter: /client-BaUToD7D\.js$/ }, () => ({ path: "./client-BaUToD7D.js", external: true }));
  } }] });
await transform(ui, { loader: "js" });
await writeFile(uiFile, ui);
const htmlFile = join(stage, "build/ui/index.html");
await writeFile(htmlFile, replaceOnce(await readFile(htmlFile, "utf8"), "<head>",
  '<head>\n<link rel="stylesheet" href="./renderer-recovery.css">\n<link rel="stylesheet" href="./history-performance.css">\n<script src="./renderer-recovery.js"></script>'));
await writeFile(htmlFile, replaceOnce(await readFile(htmlFile, "utf8"), "</head>",
  '<link rel="stylesheet" href="./viewport-layout.css">\n</head>'));
for (const file of ["renderer-recovery.js", "renderer-recovery.css", "history-performance.css", "viewport-layout.css"]) {
  await cp(join(root, "ui/public", file), join(stage, "build/ui", file));
}
// Keep the newer distributed worker's streaming/approval implementation intact.
let worker = await readFile(join(original, "resources/runtime/worker.cjs"), "utf8");
worker = replaceOnce(worker,
  'const timer = setTimeout(() => controller.abort(new Error("Turn time budget reached")), this.options.turnTimeout);',
  'const timer = this.options.autoPause === false ? undefined : setTimeout(() => controller.abort(new Error("Turn time budget reached")), this.options.turnTimeout);');
worker = replaceOnce(worker, 'step < this.options.steps; step++', 'this.options.autoPause === false || step < this.options.steps; step++');
worker = replaceOnce(worker, 'turnTimeout: positive(config2.turnTimeout, 18e4)', 'autoPause: config2.autoPause !== false,\n      turnTimeout: positive(config2.turnTimeout, 18e4)');
const output = resolve(root, "release", process.argv[2] ?? "win-unpacked-layout-20261126");
await mkdir(output); // Never overwrite a running or previously generated build.
for (const entry of await readdir(original)) {
  await cp(join(original, entry), join(output, entry), { recursive: true, force: false, errorOnExist: true });
}
await asar.createPackage(stage, join(output, "resources/app.asar"));
await writeFile(join(output, "resources/runtime/worker.cjs"), worker);
await writeFile(join(output, "UI-FIX.txt"), "UI hotfix: incremental state delivery with one update in flight, 16ms stream coalescing, background updates, memoized Markdown and renderer recovery. Per-member autoPause setting (default true). Original runtime retained with a targeted budget patch.\n");
console.log("Fixed app: " + join(output, "TeamHub.exe"));
console.log("Test UI: " + join(stage, "build/ui"));
