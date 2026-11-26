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
    await submit(wzk, "查看收到的消息");
    await settled(wzk);
    await wzk.getByRole("button", { name: "在 wzk project 中新建对话", exact: true }).click();
    await newSession(syh);
    await submit(syh, "运行通过样本");
    await animation("syh", "thinking");
    await submit(wzk, "生成一份桌宠验收报告");
    await expect(approval(wzk)).toBeVisible();
    const approvalSession = (await state(wzk)).active;
    await wzk.locator(".session-button").filter({ hasText: "查看收到的消息" }).click();
    await expect.poll(async () => (await state(wzk)).active).not.toBe(approvalSession);
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

test("composer approval modes are independent per conversation and persist across restarts", { timeout: 85_000 }, async () => {
  const data = await appData();
  const project = join(data, "permissions project");
  await cp(join(repo, "toy-harness/demo/fixtures/code"), project, { recursive: true });
  let running = await launch(data, [project]);
  const picker = page => page.locator(".composer summary");
  const options = page => page.getByRole("group", { name: "工具权限", exact: true });
  const chooseMode = async (page, name) => {
    await picker(page).click();
    await options(page).getByRole("button", { name, exact: true }).click();
    await expect(picker(page)).toHaveText(name);
  };
  const report = page => page.locator(".session-button").filter({ hasText: "生成一份报告" });
  const revision = page => page.locator(".session-button").filter({ hasText: "修订 report.md" });
  try {
    const { app, page } = running;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(680, 520));
    await newSession(page);
    await expect(picker(page)).toHaveText("请求批准");
    await picker(page).click();
    await expect(options(page).getByRole("button", { name: "请求批准", exact: true })).toHaveAttribute("aria-pressed", "true");
    const menu = await options(page).boundingBox();
    const trigger = await picker(page).boundingBox();
    assert.ok(menu.y >= 0 && menu.y + menu.height <= trigger.y && menu.x + menu.width <= 680);
    await page.keyboard.press("Escape");
    await expect(options(page)).toBeHidden();
    await chooseMode(page, "自动审批");
    await submit(page, "生成一份报告");
    await settled(page);
    assert.match(await readFile(join(project, "report.md"), "utf8"), /TeamHub 工作记录/);
    await submit(page, "修复 math.mjs");
    await expect(approval(page)).toBeVisible();
    assert.equal((await current(page)).pending?.name, "Bash");
    await chooseMode(page, "完全访问");
    await expect(approval(page)).toBeVisible();
    await page.getByRole("button", { name: "中断", exact: true }).click();
    await settled(page, "interrupted");

    await submit(page, "修复 math.mjs");
    await settled(page);
    const events = (await current(page)).events;
    const turn = events.findLast(event => event.type === "user").turn;
    assert.equal(events.filter(event => event.turn === turn && event.type === "execute" && event.data.call.name === "Bash").length, 2);
    assert.match(await readFile(join(project, "math.mjs"), "utf8"), /reduce\(\(sum, item\) => sum \+ item, 0\)/);

    const openNavigation = async () => {
      const toggle = page.getByRole("button", { name: "会话导航", exact: true });
      if (await toggle.isVisible()) await toggle.click();
    };
    await openNavigation();
    await page.getByRole("button", { name: "在 permissions project 中新建对话" }).click();
    await expect(picker(page)).toHaveText("请求批准");
    await submit(page, "修订 report.md");
    await expect(approval(page)).toBeVisible();
    assert.equal((await current(page)).pending?.name, "apply_patch");
    await approval(page).click();
    await settled(page);
    await openNavigation();
    await report(page).click();
    await expect(picker(page)).toHaveText("完全访问");
    await openNavigation();
    await revision(page).click();
    await expect(picker(page)).toHaveText("请求批准");

    await running.app.close();
    running = await launch(data, [], { restore: true });
    await expect(picker(running.page)).toHaveText("请求批准");
    await report(running.page).click();
    await expect(picker(running.page)).toHaveText("完全访问");
  } finally { await running.app.close(); }
});

test("workspace drafts enter history only after sending, and the toolbar plus opens the member picker", { timeout: 50_000 }, async () => {
  const data = await appData();
  const first = join(data, "project one");
  const second = join(data, "project two");
  await Promise.all([mkdir(first), mkdir(second)]);
  let running = await launch(data, [first, second]);
  try {
    const { app, page, errors } = running;
    await newSession(page);
    assert.equal((await state(page)).conversations.length, 0);
    await assert.rejects(readdir(join(data, "sessions")), { code: "ENOENT" });
    await submit(page, "工作区一的首条消息");
    await settled(page);
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await newSession(page);
    await expect(page.getByRole("heading", { name: "project two", level: 1 })).toBeVisible();
    await submit(page, "工作区二的首条消息");
    await expect(page.locator(".session-button").filter({ hasText: "工作区二的首条消息" })).toBeVisible();
    await settled(page);
    const before = await state(page);
    const history = await readFile(join(data, "desktop.json"), "utf8");
    const journals = await readdir(join(data, "sessions"));
    const shortcut = page.getByRole("button", { name: "在 project one 中新建对话", exact: true });
    await expect(shortcut.locator("svg.lucide-plus")).toBeVisible();
    await shortcut.click();
    await expect(page.getByRole("heading", { name: "project one", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "选择项目文件夹" })).toHaveCount(0);
    await task(page).fill("未发送的草稿");
    assert.equal((await state(page)).conversations.length, before.conversations.length);
    assert.equal(await readFile(join(data, "desktop.json"), "utf8"), history);
    assert.deepEqual(await readdir(join(data, "sessions")), journals);
    await page.locator(".session-button").filter({ hasText: "工作区二的首条消息" }).click();
    await expect(page.getByRole("button", { name: "检查点" })).toBeVisible();
    await shortcut.click();
    await expect(task(page)).toHaveValue("");
    await submit(page, "从工作区加号发送的消息");
    await expect(page.locator(".session-button").filter({ hasText: "从工作区加号发送的消息" })).toBeVisible();
    await settled(page);
    const after = await state(page);
    assert.equal(after.conversations.length, before.conversations.length + 1);
    assert.equal(after.conversations.find(group => group.members.some(member => member.id === after.active)).members[0].cwd, first);
    assert.ok(before.conversations.every(group => group.members.every(member => member.id !== after.active)));

    const memberPicker = page.getByRole("button", { name: "新建成员窗口", exact: true });
    await expect(memberPicker.locator("svg.lucide-plus")).toBeVisible();
    await expect(page.getByRole("button", { name: "协作状态", exact: true }).locator("svg.lucide-users")).toBeVisible();
    const next = app.waitForEvent("window");
    await memberPicker.click();
    await expect((await next).getByRole("heading", { name: "选择成员" })).toBeVisible();
    assert.deepEqual(errors, []);
    await app.close();
    running = await launch(data, [], { restore: true });
    await expect(running.page.locator(".session-button").filter({ hasText: "从工作区加号发送的消息" })).toBeVisible();
    await expect(running.page.locator(".session-button")).toHaveCount(3);
  } finally { await running.app.close().catch(() => {}); }
});

test("streaming reasoning folds between visible messages and restores collapsed from the journal", { timeout: 70_000 }, async () => {
  const data = await appData();
  const project = join(data, "streaming project");
  await mkdir(project);
  const streams = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.stream !== true || body.reasoning?.summary !== "auto") {
      res.writeHead(400).end();
      return;
    }
    const prompt = JSON.parse(body.input[0].content.match(/^Current user request: (.+)$/m)[1]);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    streams.set(prompt, (type, fields = {}) => {
      res.write(`event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`);
      if (type === "response.completed" || type === "error") res.end();
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const start = async (page, prompt) => {
    await submit(page, prompt);
    await expect.poll(() => streams.has(prompt)).toBe(true);
    return streams.get(prompt);
  };
  const summary = (push, id, delta) => push("response.reasoning_summary_text.delta", { item_id: id, summary_index: 0, delta });
  const body = (push, id, delta) => push("response.output_text.delta", { item_id: id, content_index: 0, delta });
  const summaryItem = (id, text) => ({ id, type: "reasoning", summary: [{ type: "summary_text", text }] });
  const messageItem = (id, text) => ({ id, type: "message", content: [{ type: "output_text", text }] });
  let running;
  try {
    running = await launch(data, [project]);
    const { page, errors } = running;
    await page.evaluate(profile => window.teamhub.saveProfile(profile, "stream-test"), {
      mode: "model", externalHub: "", config: { model: {
        protocol: "responses", endpoint: "http://127.0.0.1:" + server.address().port,
        keyEnv: "TEAMHUB_STREAM_TEST", name: "stream-test",
      } },
    });
    await newSession(page);
    const currentReasoning = page.getByRole("button", { name: "思考中", exact: true });
    const completed = page.getByRole("button", { name: "思考过程", exact: true });
    const activity = page.locator(".timeline > [role=status]:last-child");
    await expect(activity).toHaveCount(0);
    const push = await start(page, "测试分段回复");
    await expect(activity).toHaveText("正在运行");
    push("response.reasoning_text.delta", { item_id: "private", delta: "provider-private field" });
    summary(push, "a", "思考 A");
    await expect(activity).toHaveText("正在思考");
    await expect(currentReasoning).toHaveAttribute("aria-expanded", "true");
    const firstId = await currentReasoning.getAttribute("aria-controls");
    summary(push, "a", " 第一段增量");
    await expect(page.getByText("思考 A 第一段增量", { exact: true })).toBeVisible();
    await expect(currentReasoning).toHaveAttribute("aria-expanded", "true");
    await expect(currentReasoning).toHaveAttribute("aria-controls", firstId);

    const progress = ["中途说明", ...Array.from({ length: 40 }, (_, index) => `进度更新 ${index + 1}`)].join("\n\n");
    body(push, "progress", progress);
    summary(push, "b", "思考 B");
    await expect(completed).toHaveAttribute("aria-expanded", "false");
    await expect(currentReasoning).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("中途说明", { exact: true })).toBeVisible();
    await expect(page.getByText("provider-private field")).toHaveCount(0);
    await completed.press("Space");
    summary(push, "b", " 第二段增量");
    await expect(page.getByText("思考 B 第二段增量", { exact: true })).toBeVisible();
    await expect(completed).toHaveAttribute("aria-expanded", "true");

    const timeline = page.locator(".timeline-scroll");
    await timeline.evaluate(box => { box.scrollTop = 0; box.dispatchEvent(new Event("scroll")); });
    body(push, "final", "最终答复");
    await expect(activity).toHaveText("正在回复");
    await expect(completed).toHaveCount(2);
    await expect(completed.nth(0)).toHaveAttribute("aria-expanded", "true");
    await expect(completed.nth(1)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("最终答复", { exact: true })).toBeVisible();
    body(push, "final", " 已输出");
    await expect(page.getByText("最终答复 已输出", { exact: true })).toBeVisible();
    assert.equal(await timeline.evaluate(box => box.scrollTop), 0);
    assert.deepEqual(await page.locator(".timeline > .reasoning, .timeline > .assistant-message").evaluateAll(rows =>
      rows.map(row => row.querySelector("button, .markdown p, .streaming-text")?.textContent)), ["思考过程", "中途说明", "思考过程", "最终答复 已输出"]);
    assert.equal(await page.getByText("中途说明", { exact: true }).evaluate(node => {
      const selection = getSelection();
      selection.selectAllChildren(node);
      const text = selection.toString();
      selection.removeAllRanges();
      return text;
    }), "中途说明");
    push("response.completed", { response: { output: [
      summaryItem("a", "思考 A 第一段增量"), messageItem("progress", progress),
      summaryItem("b", "思考 B 第二段增量"), messageItem("final", "最终答复 已输出"),
    ] } });
    await settled(page);
    await expect(activity).toBeEmpty();
    await expect(page.getByText("最终答复 已输出", { exact: true })).toHaveCount(1);

    const cancel = await start(page, "测试生成中取消");
    summary(cancel, "cancel", "取消前已收到");
    await expect(currentReasoning).toHaveAttribute("aria-expanded", "true");
    await currentReasoning.press("Enter");
    summary(cancel, "cancel", " 取消前增量");
    // Collapsed reasoning is unmounted; its full text must return on expansion below.
    await expect(page.getByText("取消前已收到 取消前增量", { exact: true })).toHaveCount(0);
    await expect(currentReasoning).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "中断", exact: true }).click();
    await settled(page, "interrupted");
    await expect(activity).toBeEmpty();
    await expect(currentReasoning).toHaveCount(0);
    await expect(completed.nth(2)).toHaveAttribute("aria-expanded", "false");
    await completed.nth(2).click();
    await expect(page.getByText("取消前已收到 取消前增量", { exact: true })).toBeVisible();
    await expect(page.locator(".notice").filter({ hasText: "User interrupted" })).toBeVisible();

    const fail = await start(page, "测试生成中失败");
    summary(fail, "earlier", "独立思考");
    await expect(currentReasoning).toHaveAttribute("aria-expanded", "true");
    summary(fail, "failure", "失败前已收到");
    await expect(completed.nth(3)).toHaveAttribute("aria-expanded", "false");
    await expect(currentReasoning).toHaveAttribute("aria-expanded", "true");
    fail("error", { message: "fixture disconnected" });
    await settled(page, "failed");
    await expect(activity).toBeEmpty();
    await expect(currentReasoning).toHaveCount(0);
    await expect(completed.nth(4)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("alert")).toContainText("模型连接失败");
    await expect(page.getByText("Error: Model stream: fixture disconnected", { exact: true }).first()).toBeVisible();

    await page.reload();
    await expect(completed).toHaveCount(5);
    await expect(currentReasoning).toHaveCount(0);
    for (const button of await completed.all()) await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("中途说明", { exact: true })).toBeVisible();
    await expect(page.getByText("最终答复 已输出", { exact: true })).toBeVisible();
    await completed.nth(4).click();
    await expect(page.getByText("失败前已收到", { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);

    await running.app.close();
    running = await launch(data, [], { restore: true });
    const restored = running.page;
    const restoredReasoning = restored.getByRole("button", { name: "思考过程", exact: true });
    await expect(restoredReasoning).toHaveCount(5);
    for (const button of await restoredReasoning.all()) await expect(button).toHaveAttribute("aria-expanded", "false");
    await restoredReasoning.first().click();
    await expect(restored.getByText("思考 A 第一段增量", { exact: true })).toBeVisible();
    await expect(restored.getByText("最终答复 已输出", { exact: true })).toBeVisible();
  } finally {
    await running?.app.close().catch(() => {});
    server.closeAllConnections();
    server.close();
  }
});

test("DeepSeek reasoning folds at Bash approval and user progress stays visible", { timeout: 70_000 }, async () => {
  const data = await appData();
  const project = join(data, "approval project");
  await mkdir(project);
  await writeFile(join(project, "index.html"), "<!doctype html><title>Approval test</title>");
  const reasoning = [
    `index.html does NOT have fx.css/fx.js tags yet. Earlier event said "index.html only appends 2 tags" — but apparently that wasn't done, or was reverted. Now I need to add them.`,
    "The Bash hook exited code 1 — maybe cwd issue. Let me try again differently.",
    `Let me read fx.js in chunks with read_file? read_file returns truncated excerpt... it truncated at 64KiB? Actually it says truncated true but the excerpt is short — odd. Maybe the file content has escaped quotes and it's small but truncated due to... Hmm the excerpt ends mid-file at "if (reduced) retu...". The output was truncated by the tool response limit perhaps.`,
    "Let me use Bash to split file. Try a simpler command first. index.html has no fx tags yet — needs them. The Bash hook failed; let me retry.",
  ];
  const progress = "我已检查 index.html。接下来会用 Bash 核对两个文件的大小，需要你确认。";
  const command = `node -e "const fs = require('fs'); console.log(fs.readFileSync('fx.js','utf8').length, fs.readFileSync('fx.css','utf8').length)"`;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.stream !== true) { res.writeHead(400).end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    requests.push({
      input: body.input,
      push(type, fields = {}) {
        res.write(`data: ${JSON.stringify({ type, ...fields })}\r\n\r\n`);
        if (type === "response.completed") res.end();
      },
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const request = async index => {
    await expect.poll(() => requests.length).toBe(index + 1);
    return requests[index];
  };
  const call = (id, name, args) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
  const message = (id, text) => ({ type: "message", id, content: [{ type: "output_text", text }] });
  const final = "已处理审批结果。";
  let running;
  try {
    running = await launch(data, [project, project]);
    const { page, errors } = running;
    await page.evaluate(profile => window.teamhub.saveProfile(profile, "approval-test"), {
      mode: "model", externalHub: "", config: { model: {
        protocol: "responses", endpoint: "http://127.0.0.1:" + server.address().port,
        keyEnv: "TEAMHUB_REASONING_APPROVAL_TEST", name: "deepseek-flash",
      } },
    });
    const folded = page.getByRole("button", { name: "思考过程", exact: true });
    const active = page.getByRole("button", { name: "思考中", exact: true });
    const userProgress = page.getByText(progress, { exact: true });
    const approvalCard = page.getByRole("region", { name: "工具审批" });
    const activity = page.locator(".timeline > [role=status]:last-child");
    const reject = approvalCard.getByRole("button", { name: "拒绝", exact: true });
    // Streaming text is a single plain-text block; completed text becomes Markdown.
    const needle = page.locator(".reasoning-body").filter({ hasText: reasoning.at(-1) });
    for (const [index, withProgress] of [false, true].entries()) {
      if (index) await page.getByRole("button", { name: "新建对话", exact: true }).click();
      await newSession(page);
      await submit(page, withProgress ? "读取文件，发进度说明并申请 Bash" : "读取文件并申请 Bash");
      const offset = index * 3;
      const read = await request(offset);
      read.push("response.completed", { response: { output: [call("read-index", "read_file", { path: "index.html" })] } });
      const bash = await request(offset + 1);
      const readResult = bash.input.find(item => item.type === "function_call_output" && item.call_id === "read-index");
      assert.equal(JSON.parse(readResult.output).ok, true);
      await expect(page.locator(".tool").filter({ hasText: "read_file" })).toContainText("成功");

      const id = "reasoning-before-bash";
      const reasoningItem = { id, type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: reasoning.join("\n\n") }] };
      bash.push("response.output_item.added", { item: { id, type: "reasoning", summary: [] } });
      for (const [part, text] of reasoning.entries()) {
        bash.push("response.reasoning_text.delta", { item_id: id, content_index: 0, delta: (part ? "\n\n" : "") + text });
      }
      await expect(active).toHaveAttribute("aria-expanded", "true");
      await expect(needle).toBeVisible();
      const output = [reasoningItem];
      if (withProgress) {
        output.push(message("progress", progress));
        bash.push("response.output_text.delta", { item_id: "progress", content_index: 0, delta: progress });
        await expect(userProgress).toBeVisible();
        await expect(approvalCard).toHaveCount(0);
      }
      bash.push("response.output_item.done", { item: reasoningItem });
      output.push(call("shell", "Bash", { command }));
      bash.push("response.completed", { response: { output } });

      await expect(approvalCard).toBeVisible();
      await expect(activity).toHaveText("等待审批");
      await expect(activity.locator(".timeline-activity-spinner")).toHaveCount(0);
      await expect(folded).toHaveCount(1);
      await expect(folded).toHaveAttribute("aria-expanded", "false");
      await expect(needle).toBeHidden();
      await expect(approvalCard.locator("pre")).toHaveText(command + "\n\n工作目录  " + project);
      await expect(approval(page)).toBeEnabled();
      await expect(reject).toBeEnabled();
      for (const locator of [folded, approvalCard.locator("pre"), approval(page), reject]) {
        await expect(locator).toBeInViewport({ ratio: 1 });
      }
      if (withProgress) await expect(userProgress).toBeInViewport({ ratio: 1 });
      assert.deepEqual(await page.locator(".timeline > .reasoning, .timeline > .assistant-message, .timeline > div:has(> .tool)")
        .evaluateAll(rows => rows.map(row => row.querySelector(".tool-title code, .reasoning button, .markdown p").textContent)),
      withProgress ? ["read_file", "思考过程", progress, "Bash"] : ["read_file", "思考过程", "Bash"]);
      const pendingState = await current(page);
      assert.equal(pendingState.events.filter(e => e.type === "assistant_output" && e.data.kind === "reasoning")
        .map(e => e.data.text).join(""), reasoning.join("\n\n"));
      assert.equal(pendingState.events.find(e => e.type === "assistant" && e.data.calls?.[0]?.name === "Bash").data.text,
        withProgress ? progress : "");

      await folded.click();
      await expect(needle).toBeVisible();
      await folded.click();
      await expect(needle).toBeHidden();
      await reject.click();
      const after = await request(offset + 2);
      await expect(activity).toHaveText("正在运行");
      assert.equal(after.input.some(item => item.content?.includes("Let me use Bash to split file")), false);
      assert.equal(after.input.some(item => item.role === "assistant" && item.content === progress), withProgress);
      after.push("response.completed", { response: { output: [message("final", final)] } });
      await settled(page);
      await expect(approvalCard).toHaveCount(0);
      if (withProgress) await expect(userProgress).toBeVisible();
    }
    assert.deepEqual(errors, []);
    await running.app.close();
    running = await launch(data, [], { restore: true });
    const restored = running.page;
    const restoredReasoning = restored.getByRole("button", { name: "思考过程", exact: true });
    await expect(restoredReasoning).toHaveAttribute("aria-expanded", "false");
    await expect(restored.getByText(progress, { exact: true })).toBeVisible();
    await restoredReasoning.click();
    await expect(restored.getByText(reasoning.at(-1), { exact: true })).toBeVisible();
  } finally {
    await running?.app.close().catch(() => {});
    server.closeAllConnections();
    server.close();
  }
});

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
    assert.equal((await state(page)).conversations.length, 0);
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
    for (const [page, cwd] of [[alice, alicePath], [bob, bobPath], [carol, bobPath]]) {
      await expect(page.locator(".topbar-title code")).toHaveText(cwd);
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
    assert.equal((await state(page)).conversations.length, 0);
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
    await submit(page, "Hub 连通测试消息");
    await expect(page.getByText("Hub 离线")).toBeVisible();
    await expect(task(page)).toHaveValue("Hub 连通测试消息");
    assert.equal((await state(page)).conversations.length, 1);
    await set({ mode: "offline", config: {}, externalHub: hub });
    await submit(page, "Hub 连通测试消息");
    await expect(page.locator(".session-button").filter({ hasText: "Hub 连通测试消息" })).toBeVisible();
    await settled(page);
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
