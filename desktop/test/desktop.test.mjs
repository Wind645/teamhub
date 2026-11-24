import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "@playwright/test";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const repo = resolve(root, "..");
const executablePath = process.env.TEAMHUB_TEST_EXE;
const state = page => page.evaluate(() => window.teamhub.state());
const current = async page => { const snap = await state(page); return snap.sessions[snap.active]; };
const task = page => page.getByRole("textbox", { name: "任务" });
const approval = page => page.getByRole("button", { name: "允许一次", exact: true });
const appData = async () => mkdtemp(join(tmpdir(), "TeamHub 桌面 验收 "));
const nativePointerEnabled = process.platform === "win32" && process.env.TEAMHUB_TEST_NATIVE_POINTER === "1";

async function nativePointer(app, pet, animal, drag) {
  const box = await animal.locator(".caption").boundingBox();
  const viewport = await pet.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const x = (box.x + box.width / 2) / viewport.width;
  const y = (box.y + box.height / 2) / viewport.height;
  const handle = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith("/pet.html"));
    return win.getNativeWindowHandle().readBigUInt64LE().toString();
  });
  const script = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PetTest {
  [StructLayout(LayoutKind.Sequential)]
  public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int x, int y, uint data, UIntPtr extra);
}
"@
[void][PetTest]::SetProcessDPIAware()
$rect = New-Object PetTest+Rect
if (![PetTest]::GetWindowRect([IntPtr]${handle}, [ref]$rect)) { throw "Pet window bounds unavailable" }
$x = [int]($rect.Left + ($rect.Right - $rect.Left) * ${x})
$y = [int]($rect.Top + ($rect.Bottom - $rect.Top) * ${y})
$old = New-Object PetTest+Point
[void][PetTest]::GetCursorPos([ref]$old)
try {
  if (![PetTest]::SetCursorPos($x, $y)) { throw "Could not move the native cursor" }
  $point = New-Object PetTest+Point
  [void][PetTest]::GetCursorPos([ref]$point)
  $window = [PetTest]::GetAncestor([PetTest]::WindowFromPoint($point), 2)
  if ($window.ToInt64() -ne ${handle}) { throw "Cursor ($($point.X), $($point.Y)) hit $window instead of ${handle}" }
  [PetTest]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  try {
    Start-Sleep -Milliseconds 130
    ${drag ? `[void][PetTest]::SetCursorPos(($x - 85), ($y - 65)); Start-Sleep -Milliseconds 180` : ""}
  } finally { [PetTest]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 130
} finally { [void][PetTest]::SetCursorPos($old.X, $old.Y) }
`;
  try {
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 8000 });
  } catch (error) {
    throw new Error(error.stderr?.match(/<S S="Error">([^<]*)/)?.[1] ?? "Native pointer automation failed");
  }
}

test("desktop pets keep updating in minimized wzk and syh windows and return to the background approval", { timeout: 110_000 }, async () => {
  const data = await appData();
  const wzkProject = join(data, "wzk project");
  const syhProject = join(data, "syh project");
  await Promise.all([mkdir(wzkProject), mkdir(syhProject)]);
  await writeFile(join(syhProject, "pass.test.mjs"),
    'import test from "node:test"; test("passes", async () => new Promise(done => setTimeout(done, 2600)));');
  await writeFile(join(syhProject, "fail.test.mjs"),
    'import test from "node:test"; test("fails", () => { throw new Error("expected failure"); });');
  const held = new Map();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.headers.authorization !== "Bearer pet-test") { res.writeHead(401).end(); return; }
    const { messages } = JSON.parse(body);
    const prompt = JSON.parse(messages[0].content.match(/^Current user request: (.+)$/m)[1]);
    const index = messages.findLastIndex(message => message.role === "user" && message.content === prompt);
    const replied = messages.slice(index + 1).some(message => message.role === "tool");
    const reply = message => res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ choices: [{ message }] }));
    if (prompt === "模型连接故障") { res.writeHead(503).end(); return; }
    if (replied) { reply({ content: "完成" }); return; }
    if (prompt === "等候中断") { held.set(prompt, res); return; }
    const command = prompt === "运行失败样本" ? "node --test fail.test.mjs"
      : prompt === "运行通过样本" ? "node --test pass.test.mjs" : "node -v";
    const tool = () => reply({ content: null, tool_calls: [{
      id: "pet-test-call", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command }) },
    }] });
    if (prompt === "运行通过样本") held.set(prompt, tool);
    else tool();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  let running;
  try {
    running = await launch(data, [wzkProject, syhProject], { picker: true, scaled: true });
    const { app, page: picker, errors } = running;
    const wzk = await createMember(app, picker, "wzk");
    const syh = await createMember(app, await menuPicker(app), "syh");
    assert.equal((await state(wzk)).petsEnabled, false);
    await syh.getByRole("button", { name: "模型设置", exact: true }).click();
    const toggle = syh.getByRole("checkbox", { name: "显示桌宠" });
    await expect(toggle).not.toBeChecked();
    const nextPet = app.waitForEvent("window");
    await toggle.check();
    let pet = await nextPet;
    await expect(toggle).toBeChecked();
    await syh.getByRole("button", { name: "关闭", exact: true }).click();
    const lead = () => pet.locator(".lead");
    const animal = peer => pet.locator(`[data-peer="${peer}"]`);
    const animation = (peer, kind) => expect(animal(peer)).toHaveAttribute("data-animation", kind);
    const label = (peer, name) => expect(animal(peer)).toHaveAccessibleName(`${peer} · ${name}`);
    const wzkWindow = await app.browserWindow(wzk);
    const syhWindow = await app.browserWindow(syh);
    const petWindow = await app.browserWindow(pet);
    await expect(lead()).toHaveAttribute("data-peer", "syh");
    assert.equal(await pet.evaluate(() => devicePixelRatio), 1.25);
    assert.deepEqual(await petWindow.evaluate(win => [win.isVisible(), win.isAlwaysOnTop(), win.isFocusable(), win.isFocused()]),
      [true, true, false, false]);
    const assets = await pet.evaluate(async () => {
      const names = ["空闲", "加载中", "推理中", "代码执行", "样本通过", "样本失败", "异常中断"];
      return Promise.all(names.map(async name => {
        const image = new Image();
        image.src = `./桌宠/${name}.gif`;
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }));
    });
    assert.deepEqual(assets, [[300, 300], [168, 300], [320, 320], [168, 300], [168, 300], [300, 278], [300, 300]]);
    await wzkWindow.evaluate(win => win.focus());
    await expect(lead()).toHaveAttribute("data-peer", "wzk");
    const third = await createMember(app, await menuPicker(app), "third");
    await expect(lead()).toHaveAttribute("data-peer", "third");
    await expect(pet.locator(".pet")).toHaveCount(3);
    await (await app.browserWindow(third)).evaluate(win => win.close());
    await expect(pet.locator(".pet")).toHaveCount(2);

    const profile = { mode: "model", externalHub: "", config: { permissions: { Bash: "allow" },
      model: { endpoint: "http://127.0.0.1:" + server.address().port, keyEnv: "TEAMHUB_PET_TEST", name: "pet-test" } } };
    const configure = config => syh.evaluate(profile => window.teamhub.saveProfile(profile, "pet-test"), config);
    await configure(profile);
    await newSession(wzk);
    await newSession(syh);
    await submit(syh, "运行通过样本");
    await animation("syh", "thinking");
    await submit(wzk, "生成一份桌宠验收报告");
    await expect(approval(wzk)).toBeVisible();
    const approvalSession = (await state(wzk)).active;
    await wzk.evaluate(project => window.teamhub.create(project), wzkProject);
    assert.notEqual((await state(wzk)).active, approvalSession);
    await label("wzk", "待审批");
    await wzkWindow.evaluate(win => win.minimize());
    await syhWindow.evaluate(win => win.minimize());
    assert.equal(await wzkWindow.evaluate(win => win.isMinimized()), true);
    assert.equal(await syhWindow.evaluate(win => win.isMinimized()), true);
    await expect.poll(() => held.has("运行通过样本")).toBe(true);
    held.get("运行通过样本")();
    await animation("syh", "executing");
    await label("wzk", "待审批");
    await animation("syh", "passed");
    await label("wzk", "待审批");
    assert.equal(await wzkWindow.evaluate(win => win.isMinimized()), true);
    assert.equal(await syhWindow.evaluate(win => win.isMinimized()), true);
    await expect(animal("syh")).toHaveAttribute("data-animation", "idle", { timeout: 8000 });
    const position = win => win.getPosition();
    let dragged;
    if (nativePointerEnabled) await nativePointer(app, pet, animal("wzk"), false);
    else await animal("wzk").click();
    await expect.poll(async () => (await state(wzk)).active).toBe(approvalSession);
    assert.equal(await wzkWindow.evaluate(win => win.isMinimized()), false);
    if (nativePointerEnabled) await expect.poll(() => wzkWindow.evaluate(win => win.isFocused())).toBe(true);
    assert.equal(await syhWindow.evaluate(win => win.isMinimized()), true);
    await expect(approval(wzk)).toBeVisible();
    await approval(wzk).click();
    await settled(wzk);
    assert.match(await readFile(join(wzkProject, "report.md"), "utf8"), /桌宠验收报告/);
    await animation("wzk", "idle");
    await wzkWindow.evaluate(win => win.minimize());
    await expect.poll(() => wzkWindow.evaluate(win => win.isMinimized())).toBe(true);
    const original = await petWindow.evaluate(position);
    if (nativePointerEnabled) {
      await nativePointer(app, pet, animal("wzk"), true);
    } else {
      const box = await animal("wzk").locator(".caption").boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await pet.mouse.move(x, y);
      await app.evaluate(({ screen }, [x, y]) => {
        const original = screen.getCursorScreenPoint;
        let samples = 0;
        screen.getCursorScreenPoint = () => {
          if (++samples === 1) return { x: x + 50, y: y + 100 };
          return { x, y };
        };
        setTimeout(() => { screen.getCursorScreenPoint = original; }, 1500).unref();
      }, original);
      await pet.mouse.down();
      await pet.mouse.move(x - 12, y - 12);
      await pet.mouse.up();
    }
    await expect.poll(async () => (await petWindow.evaluate(position))[0]).toBeLessThan(original[0]);
    dragged = await petWindow.evaluate(position);
    assert.ok(dragged[1] < original[1]);
    await expect.poll(() => wzkWindow.evaluate(win => win.isMinimized())).toBe(true);
    assert.equal(await syhWindow.evaluate(win => win.isMinimized()), true);

    await animal("syh").click();
    await expect(lead()).toHaveAttribute("data-peer", "syh");
    await submit(syh, "运行失败样本");
    await animation("syh", "failed");
    await settled(syh);
    assert.equal((await current(syh)).events.findLast(event => event.type === "result").data.result.value.exitCode, 1);
    await submit(syh, "等候中断");
    await animation("syh", "thinking");
    await syh.getByRole("button", { name: "中断", exact: true }).click();
    await label("syh", "已中断");
    await submit(syh, "模型连接故障");
    await label("syh", "异常中断");
    await configure({ ...profile, config: { ...profile.config, steps: 1 } });
    await submit(syh, "耗尽一步预算");
    await label("syh", "待继续");
    await syh.getByRole("button", { name: "继续此回合", exact: true }).click();
    await settled(syh);
    await animation("syh", "idle");

    for (let i = 0; i < 2; i++) {
      await wzk.evaluate(() => window.teamhub.setPetsEnabled(false));
      await expect.poll(() => pet.isClosed()).toBe(true);
      const reopenedPet = app.waitForEvent("window");
      await wzk.evaluate(() => window.teamhub.setPetsEnabled(true));
      pet = await reopenedPet;
      await expect(pet.locator(".pet")).toHaveCount(2);
    }
    await syhWindow.evaluate(win => win.close());
    await expect(lead()).toHaveAttribute("data-peer", "wzk");
    await expect(pet.locator(".pet")).toHaveCount(1);
    assert.deepEqual(errors, []);
    await app.close();
    running = await launch(data, [], { picker: true, scaled: true });
    const restored = await createMember(running.app, running.page, "wzk", true);
    assert.equal((await state(restored)).petsEnabled, true);
    const petPage = () => running.app.windows().find(page => page.url().endsWith("/pet.html"));
    await expect.poll(() => Boolean(petPage())).toBe(true);
    const reloadedPet = petPage();
    await expect(reloadedPet.locator(".lead")).toHaveAttribute("data-peer", "wzk");
    assert.deepEqual(await (await running.app.browserWindow(reloadedPet)).evaluate(position), dragged);
    assert.deepEqual(running.errors, []);
  } finally {
    await running?.app.close().catch(() => {});
    server.closeAllConnections();
    server.close();
  }
});

async function launch(data, paths = [], options = {}) {
  const env = { ...process.env, TEAMHUB_DESKTOP_DATA: data };
  delete env.NODE_TEST_CONTEXT;
  if (executablePath && process.platform === "win32") {
    const pathKey = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = join(env.SystemRoot ?? "C:\\Windows", "System32");
  }
  const app = await _electron.launch({
    executablePath, args: [...(executablePath ? [] : [root]), ...(options.scaled ? ["--force-device-scale-factor=1.25"] : [])],
    env,
    timeout: 20_000,
  });
  try {
    // Exercise the real renderer and main-process routes with repeatable native dialog decisions.
    await app.evaluate(({ dialog }, choices) => {
      dialog.showOpenDialog = async () => ({ canceled: !choices.length, filePaths: [choices.shift()] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, paths);
    const errors = [];
    app.on("window", page => {
      page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message));
    });
    const picker = await app.firstWindow();
    const page = options.picker ? picker : await createMember(app, picker, "tester", Boolean(options.restore));
    return { app, page, errors, env };
  } catch (error) { await app.close(); throw error; }
}

async function createMember(app, picker, peer, existing = false) {
  const next = app.waitForEvent("window");
  if (existing) await picker.getByRole("button", { name: new RegExp("^" + peer + "(?:\\s|$)") }).click();
  else {
    await picker.getByRole("textbox", { name: "成员 ID" }).fill(peer);
    await picker.getByRole("button", { name: "打开成员窗口" }).click();
  }
  const page = await next;
  await expect(page.locator(".topbar-title strong")).toHaveText(peer.toLowerCase());
  await expect.poll(() => picker.isClosed()).toBe(true);
  return page;
}
async function newSession(page) {
  await page.getByRole("button", { name: "选择项目文件夹" }).click();
  await page.getByRole("button", { name: "进入对话" }).click();
  await expect(task(page)).toBeVisible();
}
async function submit(page, text) {
  await task(page).fill(text);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled({ timeout: 20_000 });
  await task(page).press("Enter");
}
async function settled(page, status = "completed") {
  await expect.poll(async () => (await current(page))?.events.findLast(e => e.type === "status")?.data, { timeout: 15_000 }).toBe(status);
}
async function menuPicker(app) {
  const next = app.waitForEvent("window");
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu().items.find(item => item.label === "窗口").submenu;
    const item = menu.items.find(item => item.label === "新建成员窗口");
    if (!item) throw new Error("Missing native menu entry");
    item.click();
  });
  return next;
}

test("Windows renderer approves one real report, revises it, restores history, and rolls back without touching files", { timeout: 85_000 }, async () => {
  const data = await appData();
  const project = join(data, "测试 资料");
  await cp(join(repo, "toy-harness/demo/fixtures/report"), project, { recursive: true });
  const file = join(project, "report.md");
  let running = await launch(data, [project], { scaled: true });
  try {
    const { app, page, errors } = running;
    assert.equal(await page.evaluate(() => devicePixelRatio), 1.25);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(680, 520));
    await newSession(page);
    await task(page).fill("读取 north.txt 和 south.txt，生成资料报告");
    await task(page).evaluate(node => {
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    assert.equal((await current(page)).events.some(e => e.type === "user"), false);
    await submit(page, "读取 north.txt 和 south.txt，生成资料报告");
    await expect(approval(page)).toBeVisible();
    await assert.rejects(readFile(file), { code: "ENOENT" });
    const duplicate = (await current(page)).pending;
    await approval(page).click();
    assert.equal(await page.evaluate(async key => {
      const snap = await window.teamhub.state();
      return window.teamhub.command(snap.active, { type: "approve", key, allow: true });
    }, duplicate), false);
    await settled(page);
    await expect(page.getByText("已生成", { exact: false })).toBeVisible();
    assert.match(await readFile(file, "utf8"), /# Pilot findings[\s\S]*Monday[\s\S]*Friday[\s\S]*north.txt, south.txt/);
    assert.equal((await current(page)).events.filter(e => e.type === "execute" && e.data.call.name === "apply_patch").length, 1);
    assert.deepEqual(errors, []);
    await submit(page, "修订 report.md，补写结论");
    await page.getByRole("button", { name: "拒绝", exact: true }).click();
    await settled(page);
    assert.doesNotMatch(await readFile(file, "utf8"), /结论/);
    await submit(page, "修订 report.md，补写结论");
    await approval(page).click();
    await settled(page);
    assert.match(await readFile(file, "utf8"), /结论/);
    await app.close();
    running = await launch(data, [], { restore: true });
    await expect(running.page.getByText("已将结论写入", { exact: false })).toBeVisible();
    await expect(running.page.getByRole("button", { name: "在文件夹中定位" })).toHaveCount(2);
    await running.page.getByRole("button", { name: "检查点" }).click();
    await running.page.getByRole("button", { name: /会话开始/ }).click();
    await expect(running.page.getByText("已将结论写入", { exact: false })).toHaveCount(0);
    assert.match(await readFile(file, "utf8"), /结论/);
    assert.deepEqual(running.errors, []);
  } finally { await running.app.close().catch(() => {}); }
});

test("code fixture, interrupt on close, resume, and uncertain replay safety", { timeout: 85_000 }, async () => {
  const data = await appData();
  const project = join(data, "代码 空格");
  await cp(join(repo, "toy-harness/demo/fixtures/code"), project, { recursive: true });
  let running = await launch(data, [project]);
  try {
    const { page } = running;
    await newSession(page);
    await submit(page, "修复 math.mjs，运行 node check.mjs");
    await approval(page).click();
    await approval(page).click();
    const turn = (await current(page)).events.find(e => e.type === "user").turn;
    await page.getByRole("button", { name: "中断", exact: true }).click();
    await settled(page, "interrupted");
    await running.app.close();
    running = await launch(data, [], { restore: true });
    await running.page.getByRole("button", { name: "继续此回合", exact: true }).click();
    await expect(running.page.getByRole("region", { name: "工具审批" })).toContainText("Update File: math.mjs");
    await approval(running.page).click();
    await expect(running.page.getByRole("region", { name: "工具审批" })).toContainText("node check.mjs");
    await approval(running.page).click();
    await settled(running.page);
    const events = (await current(running.page)).events;
    assert.equal(events.find(e => e.type === "resume").turn, turn);
    assert.deepEqual(events.filter(e => e.type === "result" && e.data.name === "Bash" && e.data.result.value).map(e => e.data.result.value.exitCode), [1, 0]);
    assert.match(await readFile(join(project, "math.mjs"), "utf8"), /item, 0/);
    await submit(running.page, "生成一份报告");
    await expect(approval(running.page)).toBeVisible();
    await running.app.close();
    const dir = join(data, "sessions");
    const file = join(dir, (await readdir(dir)).find(name => name.endsWith(".jsonl")));
    const original = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(original.findLast(e => e.type === "status").data, "interrupted");
    const request = original.findLast(e => e.type === "request");
    const simulated = original.filter(e => e.seq <= request.seq);
    simulated.push({ ...request, seq: request.seq + 1, type: "execute", data: { ...request.data, effect: true } });
    await writeFile(file, simulated.map(e => JSON.stringify(e)).join("\n") + "\n");
    await writeFile(join(project, "report.md"), "已经写入，回执遗失\n");
    running = await launch(data, [], { restore: true });
    await expect(running.page.getByText("待核实 · 先前调用可能已产生副作用")).toBeVisible();
    await running.page.getByRole("button", { name: "继续此回合", exact: true }).click();
    await settled(running.page);
    assert.equal(await readFile(join(project, "report.md"), "utf8"), "已经写入，回执遗失\n");
    assert.equal((await current(running.page)).events.filter(e => e.type === "execute" && e.turn === request.turn && e.data.call.name === "apply_patch").length, 1);
    assert.deepEqual(running.errors, []);
  } finally { await running.app.close().catch(() => {}); }
});

test("three member windows share one Hub, have independent turns, and survive closing the first window", { timeout: 110_000 }, async () => {
  const data = await appData();
  const alicePath = join(data, "Alice 工作区");
  const bobPath = join(data, "Bob Carol 工作区");
  await Promise.all([mkdir(alicePath), cp(join(repo, "toy-harness/demo/fixtures/code"), bobPath, { recursive: true })]);
  const { app, page: picker, errors, env } = await launch(data, [alicePath, bobPath, bobPath], { picker: true });
  try {
    const alice = await createMember(app, picker, "Alice");
    await newSession(alice);
    const bob = await createMember(app, await menuPicker(app), "Bob");
    await newSession(bob);

    const next = app.waitForEvent("window");
    const duplicate = spawn(executablePath ?? app.process().spawnfile, executablePath ? [] : [root], {
      env, cwd: root, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    duplicate.stderr.on("data", chunk => { stderr += chunk; });
    const duplicateExit = once(duplicate, "exit");
    const secondPicker = await next.catch(async error => {
      const outcome = duplicate.exitCode ?? "running";
      if (outcome === "running") duplicate.kill();
      throw new Error(`${String(error)}; second launch: ${outcome}; ${stderr}`);
    });
    const carol = await createMember(app, secondPicker, "Carol");
    assert.deepEqual(await duplicateExit, [0, null], stderr);
    await newSession(carol);
    assert.equal(app.windows().length, 3);
    for (const [page, peer, cwd] of [[alice, "alice", alicePath], [bob, "bob", bobPath], [carol, "carol", bobPath]]) {
      const window = await app.browserWindow(page);
      assert.equal(await window.evaluate(win => win.getTitle()), "TeamHub · " + peer + " · " + cwd);
    }

    const existing = await menuPicker(app);
    await existing.getByRole("button", { name: /^bob .*已打开/ }).click();
    await expect.poll(() => existing.isClosed()).toBe(true);
    assert.equal(app.windows().length, 3);
    assert.equal(await (await app.browserWindow(bob)).evaluate(win => win.isFocused()), true);

    await submit(alice, "生成一份报告");
    await expect(approval(alice)).toBeVisible();
    const a = await state(alice);
    const pending = a.sessions[a.active].pending;
    await submit(bob, "修复 math.mjs，运行 node check.mjs");
    await expect(approval(bob)).toBeVisible();
    assert.equal(await bob.evaluate(async ({ id, key }) => {
      const snap = await window.teamhub.state();
      if (snap.sessions[id]) return "leaked";
      try { await window.teamhub.command(id, { type: "approve", key, allow: true }); return "accepted"; }
      catch { return "rejected"; }
    }, { id: a.active, key: pending }), "rejected");
    const tools = bob.getByRole("region", { name: "工具审批" });
    await expect(tools).toContainText("node check.mjs");
    await approval(bob).click();
    await expect(tools).toContainText("Update File: math.mjs");
    await approval(bob).click();
    await expect(tools).toContainText("node check.mjs");
    await approval(bob).click();
    await settled(bob);
    await assert.rejects(readFile(join(alicePath, "report.md")), { code: "ENOENT" });
    assert.match(await readFile(join(bobPath, "math.mjs"), "utf8"), /item, 0/);
    await expect(approval(alice)).toBeVisible();
    await task(alice).fill("请加上进度记录");
    await alice.getByRole("button", { name: "追加指令" }).click();
    await expect(alice.getByText("追加指令 · 已排队")).toBeVisible();
    await expect.poll(async () => (await current(alice)).pending?.request).not.toBe(pending.request);
    await approval(alice).click();
    await settled(alice);
    assert.equal((await current(alice)).events.find(e => e.type === "steer").turn, pending.turn);
    assert.match(await readFile(join(alicePath, "report.md"), "utf8"), /进度记录/);

    const send = async (page, prompt, recipient) => {
      await submit(page, prompt);
      await expect(page.getByRole("region", { name: "工具审批" })).toContainText(recipient);
      await approval(page).click();
      await settled(page);
      const result = (await current(page)).events.findLast(e => e.type === "result" && e.data.name === "team_send_message");
      assert.equal(result.data.result.ok, true);
      assert.deepEqual(result.data.result.value.structuredContent.recipients, [recipient]);
    };
    await send(alice, "请给 Bob 发送口令「蓝桥731」", "bob");
    const aliceWindow = await app.browserWindow(alice);
    await aliceWindow.evaluate(win => win.close());
    await expect.poll(() => alice.isClosed()).toBe(true);
    await bob.getByRole("button", { name: "协作状态", exact: true }).click();
    await expect(bob.getByText("Hub 已连接")).toBeVisible();
    await send(bob, "把 Alice 发来的口令转发给 Carol", "carol");
    await send(carol, "回复 Alice，原样转述 Bob 发来的口令", "alice");

    const reopened = await createMember(app, await menuPicker(app), "alice", true);
    await expect(reopened.getByText("已向 bob 发送", { exact: false })).toBeVisible();
    await submit(reopened, "查看收到的消息");
    await settled(reopened);
    await expect(reopened.getByText("收到来自 carol 的消息「蓝桥731」。", { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});

test("missing credentials, connection errors, and external Hub ownership", { timeout: 85_000 }, async () => {
  const data = await appData();
  const project = join(data, "测试项目");
  await mkdir(project);
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer in-memory-key") { res.writeHead(401).end(); return; }
      if (req.url === "/fail") { res.writeHead(503).end(); return; }
      const input = JSON.parse(body);
      assert.equal(input.model, "local-test");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "模型连接成功" } }] }));
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = "http://127.0.0.1:" + server.address().port;
  const external = spawn(process.execPath, [join(repo, "dist", "server.js")], {
    env: { ...process.env, TEAMHUB_PORT: "0", TEAMHUB_DB: join(data, "external.sqlite") },
    windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const [bound] = await once(external, "message");
  const hub = "http://127.0.0.1:" + bound.port;
  let running;
  const model = { endpoint: endpoint + "/fail", keyEnv: "TEAMHUB_TEST_MISSING_KEY", name: "local-test", protocol: "chat" };
  const profile = { mode: "model", config: { model }, externalHub: "" };
  try {
    running = await launch(data, [project, project]);
    const { app, page, errors } = running;
    const set = (profile, key) => page.evaluate(({ profile, key }) => window.teamhub.saveProfile(profile, key), { profile, key });
    await set(profile);
    await newSession(page);
    await submit(page, "模型测试");
    await expect(page.getByText("缺少模型密钥")).toBeVisible();
    await expect(task(page)).toHaveValue("模型测试");
    await set(profile, "in-memory-key");
    await submit(page, "模型失败测试");
    await settled(page, "failed");
    await expect(page.getByText("模型连接失败")).toBeVisible();
    await set({ ...profile, config: { model: { ...model, endpoint: endpoint + "/chat" } } }, "in-memory-key");
    await submit(page, "模型响应测试");
    await settled(page);
    await expect(page.getByText("模型连接成功")).toBeVisible();
    assert.doesNotMatch(await readFile(join(data, "desktop.json"), "utf8"), /in-memory-key/);
    await set({ mode: "offline", config: {}, externalHub: endpoint });
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await newSession(page);
    await expect(page.getByText("Hub 离线")).toBeVisible();
    await set({ mode: "offline", config: {}, externalHub: hub });
    await expect.poll(async () => (await current(page)).phase).toBe("ready");
    await app.close();
    assert.equal((await fetch(hub + "/health")).status, 200);
    assert.deepEqual(errors, []);
  } finally {
    await running?.app.close().catch(() => {});
    server.close();
    if (external.connected) external.disconnect();
    if (external.exitCode === null) await once(external, "exit");
  }
});

test("legacy histories retain their journals, and member model settings stay independent", { timeout: 60_000 }, async () => {
  const data = await appData();
  const cwd = join(data, "旧版 项目");
  const directory = join(data, "sessions");
  await Promise.all([mkdir(cwd), mkdir(directory)]);
  const profile = { mode: "offline", config: {}, externalHub: "" };
  const legacy = JSON.stringify({ profile, active: "legacy-b", conversations: [
    { id: "old-pair", created: 1, members: [
      { id: "legacy-a", cwd, peer: "alice" },
      { id: "legacy-b", cwd, peer: "bob" },
    ] },
    { id: "old-solo", created: 0, members: [{ id: "legacy-solo", cwd }] },
  ] });
  await writeFile(join(data, "desktop.json"), legacy);
  const logs = new Map();
  for (const id of ["legacy-a", "legacy-b", "legacy-solo"]) {
    const events = [
      { seq: 1, type: "session", data: cwd },
      { seq: 2, type: "user", turn: id, data: "旧任务 " + id },
      { seq: 3, type: "final", turn: id, data: "旧答复 " + id },
      { seq: 4, type: "status", turn: id, data: "completed" },
    ].map(event => JSON.stringify({ at: new Date(0).toISOString(), ...event })).join("\n") + "\n";
    const file = join(directory, id + ".jsonl");
    await writeFile(file, events);
    logs.set(file, events);
  }
  const { app, page: picker, errors } = await launch(data, [], { picker: true });
  try {
    await expect(picker.getByRole("button", { name: /^local/ })).toBeVisible();
    const alice = await createMember(app, picker, "alice", true);
    const bob = await createMember(app, await menuPicker(app), "bob", true);
    await expect(alice.getByText("旧答复 legacy-a")).toBeVisible();
    await expect(bob.getByText("旧答复 legacy-b")).toBeVisible();
    const local = await createMember(app, await menuPicker(app), "local", true);
    await expect(local.getByText("旧答复 legacy-solo")).toBeVisible();
    for (const [file, prefix] of logs) assert.ok((await readFile(file, "utf8")).startsWith(prefix));
    assert.equal(await readFile(join(data, "desktop-v1.json"), "utf8"), legacy);
    const model = { name: "alice-test", endpoint: "http://127.0.0.1:1/chat", keyEnv: "TEAMHUB_TEST_ALICE_KEY" };
    await expect.poll(async () => (await current(alice)).phase).toBe("ready");
    await alice.evaluate(model => window.teamhub.saveProfile({ mode: "model", config: { model }, externalHub: "" }, "temporary-alice-key"), model);
    assert.equal((await state(alice)).profile.config.model.name, "alice-test");
    assert.equal((await state(alice)).hasKey, true);
    assert.equal((await state(bob)).profile.mode, "offline");
    assert.equal((await state(bob)).hasKey, false);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
