# TeamHub Windows 桌面端

完整解压 `release/TeamHub-Windows-x64.zip`，双击其中的 `TeamHub.exe`。便携包包含 Node 和 TeamHub 运行时，日常使用无需终端。

## 打开成员窗口

1. 在成员选择器点击已有配置，或输入新的成员 ID。ID 统一为小写，可使用英文字母、数字、点、短横线和下划线。
2. 选择项目文件夹并点击「进入对话」。默认离线体验。输入「生成一份报告」，核对补丁后点击「允许一次」，即可在所选目录看到 `report.md`。
3. 通过 Windows 菜单「窗口 → 新建成员窗口」或再次启动 `TeamHub.exe` 打开选择器。选中已打开的成员会聚焦其窗口。
4. 在各窗口的「模型设置」配置成员自己的模型和密钥。「共享 Hub 地址」对所有成员生效，留空时由应用启动本机 Hub。

每个成员都可以发起任务。同一成员一次运行一个回合，多个成员可并行。成员可以选择同一目录或分别选择目录。关闭一个成员窗口后，其他已打开的成员仍可工作。再次选择该成员会恢复其历史。

在对话输入框左下角选择工具权限，每个对话单独保存。默认「请求批准」逐次确认待审批工具。「自动审批」直接批准工作区补丁，Shell 命令和需审批的协作操作仍需确认。「完全访问」跳过所有工具的手动确认，Shell 命令以当前系统用户的权限运行。各模式均遵守已导入的工具拒绝规则和命令白名单。运行中切换权限，下一次发送或继续回合时生效。

## 多人状态桌宠

1. 打开 `wzk` 和 `syh` 两个成员窗口，在任一窗口的设置中勾选「显示桌宠」。这是全局开关，默认关闭。
2. 在 `wzk` 的空目录发起「生成一份报告」，暂留在写入审批。在 `syh` 发起另一项任务。最小化两个窗口后，桌宠仍分别显示成员的状态。
3. 点击 `wzk` 的桌宠回到待审批会话，再选择是否允许。拖动任一桌宠可移动整组，位置和开关会在重启后恢复。

最近获得焦点的成员显示为大宠。状态取自各成员的所有会话，依次优先显示待审批、异常或待继续、工具执行、短时测试结果、推理、连接、主动中断和空闲。测试动画目前仅识别直接执行的 `node --test` 或 `node.exe --test`，以实际进程退出码为准，显示约 5 秒。

## 三人离线演示

打开 `alice`、`bob`、`carol` 三个成员窗口，并各自进入对话。在 Alice 输入「请给 Bob 发送口令『蓝桥731』」时，可使用下列原样指令触发离线脚本。

1. Alice：`请给 Bob 发送口令「蓝桥731」`，批准发送，然后关闭 Alice 窗口。
2. Bob：`把 Alice 发来的口令转发给 Carol`，批准发送。
3. Carol：`回复 Alice，原样转述 Bob 发来的口令`，批准发送。
4. 从选择器重新打开 Alice，输入 `查看收到的消息`。

## 旧数据

新版首次打开旧索引时，会将旧双助手会话分别归入已有 peer ID 的成员，旧单助手会话归入 `local`。原 JSONL 的路径、会话 ID 和工作目录继续使用。原索引备份为用户数据目录中的 `desktop-v1.json`。同一 Windows 用户下升级时保留用户数据目录即可。

## 构建

从仓库根目录执行。

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd --prefix toy-harness ci
npm.cmd --prefix desktop ci
npm.cmd --prefix desktop run typecheck
npm.cmd --prefix desktop run package:win
```

便携包和可直接运行的解包目录位于 `desktop/release`。

## 2026-11-25：白屏防护修复版

最初的白屏防护包保留在 `release/win-unpacked-ui-fixed-20261125-final/TeamHub.exe`。
当前推荐使用下文的性能优化版，启动器已更新指向该版本。
学校接口用户先正常退出原有 TeamHub，再运行仓库根目录的
`Start-TeamHub-School.cmd`。它继续读取已有的本地密钥文件，无须重新填写密钥。
启动入口已统一为这个文件，并指向最新修复包；切换前请正常退出正在运行的旧版本。

本次改动：

- 后台连续事件按 100 毫秒合并界面通知，发送时读取最新状态。日志仍逐条保存；审批、状态变化和设置即时通知。
- 已显示且内容未变的 Markdown 不重复解析。现有安装包中折叠的思考内容不再隐藏着渲染。
- 未捕获的前端错误显示恢复面板；重新加载当前本地页面不重新提交任务。
- 显示进程退出时记录原因，并提供重新加载选项；不重启或重新派发后台任务。
- 诊断记录位于 `%APPDATA%/teamhub-desktop/renderer-health.jsonl`，测试使用独立目录。

### 验证与边界

专项测试覆盖连续输出、暂停、待审批、完成显示、React 渲染异常、显示进程强制崩溃及恢复。
合并通知测试模拟三个成员共 30,000 次通知，检查最终暂停、待审批、完成状态均保留。
本机 Alice/Bob/Carol 的 CALC-01 历史在三个浏览器页面同时回放，未出现渲染异常。
这些测试使用本地数据或模拟输入，不调用付费模型。

此前用户遇到的白屏没有在原版历史回放中稳定复现，因此不能宣称已经证明唯一根因，
也不能把“完全访问”或 hook 判定为原因。本次处理了重复渲染负担和无错误恢复机制，仍需要实际任务复测。

原有“三成员窗口”自动测试在“第二次启动程序应打开选择器”处超时；
对照未修改的主进程也出现相同超时。这项未通过，不能据此声称完整测试套件全部通过。

### 给维护者

仓库当前源码早于本机分发包，直接用仓库全量打包会缺少分发包已有的权限模式和流式显示。
`scripts/build-ui-hotfix.mjs` 因此只修补已核对版本的显示相关部分，保留原有 runtime。
脚本验证原 `app.asar` 的 SHA-256，版本不符即停止；输出目录存在也停止，避免覆盖正在使用的版本。
此脚本属于当前分发包的临时修补；取得对应新版源码后，应将同样的修复合入源码并正常构建。

```powershell
# 从仓库根目录；依赖安装步骤见上文
node desktop/scripts/build-ui-hotfix.mjs
node --test desktop/test/ui-health.test.mjs desktop/test/renderer-recovery.test.mjs
```

测试已生成的修复包时，可在当前 PowerShell 临时设置
`TEAMHUB_TEST_EXE` 为修复包 `TeamHub.exe` 的绝对路径，再运行 `renderer-recovery.test.mjs`。
原始分发目录仍保留，但不再提供单独的旧版启动器；不要删除会话目录或数据库。

## 运行中卡顿：性能优化版

此前性能版启动器指向
`release/win-unpacked-ui-performance-20261125-final/TeamHub.exe`。
正常结束或中断当前任务并退出旧程序后，再使用启动器打开，新代码才会生效。

这轮改动专门减少渲染工作：

- 默认挂载最近 80 条可见记录；点击“查看更早的消息”每次增加 80 条，并保留浏览位置。完整历史和检查点不删除。
- 工具卡片展开时才创建详情和序列化输出。待审批操作的内容和批准按钮仍直接显示；较早的待审批记录也不会被分页隐藏。
- 工具结果索引每份事件数组只建立一次，避免每个工具卡片重复扫描整个日志。
- 复用未变化的有效历史和状态计算，减少输入文字时的额外处理。
- 分发包的流式回复先显示纯文本，结束后再显示 Markdown 排版；不改变模型请求、工具权限或后台步骤数。

本地合成测试使用同样的 300 条工具调用及长输出，比对上一版白屏防护包：

- 原版挂载 300 张工具卡片及 300 份工具详情；新版初始挂载 72 张卡片（另有 8 条进度记录），折叠工具详情为 0。
- 一次对比的首次更新绘制耗时约 148 ms → 62 ms；后续 7 次更新中位数约 45 ms → 33 ms。
- 这是本机合成场景的测量，不代表所有项目都按相同比例提速；模型响应、磁盘和剩余全量历史传输耗时未由本次改动消除。
- 已验证加载更早消息、展开工具详情、较早记录的审批、短历史替换，以及流式纯文本切换到完成后的 Markdown。
- 实际打包程序的暂停、审批、完成、渲染错误恢复及显示进程崩溃恢复测试通过。

复现性能与功能测试（从仓库根目录执行，默认使用已安装的 Edge 无界面模式，不访问真实会话或模型）：

```powershell
node desktop/scripts/benchmark-ui.mjs desktop/release/win-unpacked-ui-fixed-20261125-final desktop/release/win-unpacked-ui-performance-20261125-final
```

`build-ui-hotfix.mjs` 保留这些性能优化，要求输出目录不存在，并校验原始分发包版本。

## 可选的自动暂停（2026-11-26）

此轮自动暂停功能最初发布于
`release/win-unpacked-auto-pause-20261126/TeamHub.exe`。正常结束或停止任务并退出旧程序后，从此启动器重新打开。

在每个成员窗口的齿轮设置中，可以切换 **达到运行上限后自动暂停**，然后点击 **保存设置**。

- 默认开启：沿用原有步数与单轮时间预算，达到上限后需要手动继续。默认值是 16 次模型调用和 180 秒，导入配置可以改变上限。
- 关闭：取消这两种预算导致的暂停，直到任务完成、用户停止、工具/hook 拦截或请求失败。工具审批、工具超时、网络错误处理保持原样，不自动重试错误，也不自动唤醒空闲成员。
- 设置按成员保存，Alice、Bob、Carol 分别设置。它不是权限开关。
- 运行中的任务不能保存这项设置；先等待结束或手动停止，再保存，下次任务或“继续此回合”使用新值。已暂停的任务不会因关闭开关自行启动。
- 配置字段为 `config.autoPause`（布尔值）；未设置视为开启。CLI 配置的同名字段位于顶层。

源码中的 runtime/session、桌面设置与配置保存均已接入。分发包比仓库源码更新，因此构建脚本在原包上精确修改预算判断和设置传递，保留原包的流式输出与审批模式，没有用旧版 worker 整体替换。

验证：toy-harness 的 18 项测试通过；新桌面设置/worker 的 2 项测试通过。覆盖默认暂停、恢复、关闭后超过 16 步和时间预算、手动中断、模型错误、审批拒绝、设置保存/重启、成员隔离。桌面 worker 使用本地模拟模型，不消耗 API 额度。

复现（仓库根目录 PowerShell）：

```powershell
npm.cmd --prefix toy-harness run build
node --test toy-harness/test/*.test.mjs
$env:TEAMHUB_TEST_EXE = Join-Path (Get-Location) 'desktop/release/win-unpacked-auto-pause-20261126/TeamHub.exe'
node --test desktop/test/auto-pause.test.mjs
```

重新生成分发包：`node desktop/scripts/build-ui-hotfix.mjs <新的输出目录名>`，不会覆盖已有目录。

## 实时状态传输优化（2026-11-26）

此轮增量传输版本为
`release/win-unpacked-live-state-20261126-v2/TeamHub.exe`。它保留自动暂停开关、原有审批模式、流式回复、历史记录和界面恢复功能。先正常退出旧版，再从此启动器打开；无需重新填写密钥。

发现的问题：每次进度更新都重新发送成员所有会话的完整历史，导致重复 IPC 传输、跨上下文复制、重新处理不相关的旧会话。后台变化快于界面处理时，还会积压过时的快照。

本轮修改：

- 首次打开或重新加载发送完整基线，后续只发送新增日志和变化的会话状态。接收端保留不变会话的对象引用，减轻侧栏重绘。
- 每个窗口最多只有一个更新等待确认；等待时保留最新状态的读取入口，不排队保存过时快照。全部事件仍保留，下一次更新会补齐尚未发送的日志。
- 普通连续输出合并窗口由 100ms 缩短至 16ms；状态、审批和错误仍直接触发发布。若已有更新在途，随接收确认发送最新状态。
- 在界面端重建增量数据，避免 preload 再把完整历史跨隔离边界复制一次。
- 窗口不再因切到后台而启用 Chromium 的后台计时器节流；确认机制使用帧回调及 50ms 计时器回退。
- 防止较慢的初始 state 请求覆盖更新后的状态；重新加载会重建基线，旧页面的确认不会释放新页面的数据。

真实 Electron IPC 与 DOM 的合成对比测试：三个窗口各带 300 条工具调用及长输出，持续接收进度。在本机这次运行中，旧版中位显示延迟约 89ms、P95 128ms、最大 154ms；新版分别为 7ms、28ms、57ms。传输量（含首次完整基线）约 318.6MB → 7.5MB。测试观察了实际界面文字变化，也确认三个窗口均显示完成、输入文字未丢失、最小化后恢复可见审批按钮。

这些数字仅代表本机合成场景，并不保证任何机器或真实任务都零延迟。首次加载极长历史、模型网络等待、磁盘和 UI 本身过重仍可能耗时。此修改不伪造完成状态，不自动重试请求，也不隐藏审批。

验证项目：增量历史与回滚、审批添加/清除、重启替换日志、删除会话、旧确认、窗口隔离、慢界面不积压；自动暂停开关/实际 worker；渲染错误与崩溃恢复。

复现（仓库根目录）：

```powershell
node --test desktop/test/state-stream.test.mjs
$env:TEAMHUB_TEST_EXE = Join-Path (Get-Location) 'desktop/release/win-unpacked-live-state-20261126-v2/TeamHub.exe'
node --test desktop/test/auto-pause.test.mjs desktop/test/renderer-recovery.test.mjs
node desktop/scripts/benchmark-state-stream.mjs desktop/release/win-unpacked-auto-pause-20261126 desktop/release/win-unpacked-live-state-20261126-v2
```

构建脚本默认输出 `win-unpacked-live-state-20261126-v2`；输出目录必须不存在。原分发包比源码更新，因此同步修改源码和可复现分发补丁，而不使用旧源码整体覆盖新版应用。增量通信实现位于 `src/state-stream.ts`、`ui/live-state.ts`。

## 长流式回复的增量整理（2026-11-26）

此轮长回复优化最初发布于
`release/win-unpacked-timeline-20261126/TeamHub.exe`，构建脚本默认输出也更新为此目录。正常退出旧程序后重新打开启动器即可。

此前虽然只传新增事件，界面收到更新后仍会从头整理有效日志、重新拼接全部流式文字并重建工具结果索引。现在 `ui/timeline-model.ts` 利用增量传输保留下来的事件对象，只处理新增事件；没有回滚时直接复用有效日志，已有回复行和未变化的工具索引继续复用。更新中的文字行按需复制，避免修改已交给 React 的旧快照。回滚、重开和新日志基线会按实际前缀重新计算。

将原分发包的实际整理函数作为对照，逐个事件前缀校验了思考/正文切换、流式结束、重复 final 去重、状态切换、回滚与恢复；结果一致。模拟 50,000 个历史文字片段、连续 100 次更新时，整理函数累计耗时约 306ms → 7ms。这是纯整理逻辑耗时，并非整个界面的帧延迟，也不代表模型生成速度变快。

验证通过：3 项整理逻辑测试、打包版自动暂停/worker/渲染恢复测试，以及加载更多历史、展开工具、旧记录审批、短历史替换和流式转 Markdown 的界面检查。

复现：

```powershell
node --test desktop/test/timeline-model.test.mjs
$env:TEAMHUB_TEST_EXE = Join-Path (Get-Location) 'desktop/release/win-unpacked-timeline-20261126/TeamHub.exe'
node --test desktop/test/auto-pause.test.mjs desktop/test/renderer-recovery.test.mjs
node desktop/scripts/benchmark-ui.mjs desktop/release/win-unpacked-live-state-20261126-v2 desktop/release/win-unpacked-timeline-20261126
```

仍保留完整日志、按需加载历史、增量 IPC、自动暂停开关与审批行为。本轮没有改变模型配置或后台任务执行速度。

## 修复页面随内容变长（2026-11-26）

**当前启动器** `Start-TeamHub-School.cmd` 指向
`release/win-unpacked-layout-20261126/TeamHub.exe`。正常退出旧版后重新打开启动器。
如果该修复包不存在，启动器使用 `release/win-unpacked/TeamHub.exe`，并检查分发文件是否完整。GitHub 只保存源码与构建脚本；新克隆的仓库需要先按上文打包，再启动。

旧版可复现的问题：在 1280×720 窗口中加入 80 个历史会话后，页面滚动高度达到约 5496px。Grid 隐式行及嵌套 Flex 容器的自动最小高度让内容撑开外层，内部滚动区域失去高度约束。

`ui/public/viewport-layout.css` 现将外层网格行约束为 `minmax(0, 1fr)`，为侧栏和会话容器补充 `min-height: 0`，限制外层溢出。历史会话列表和聊天时间线仍各自滚动，输入区不会被历史内容挤出窗口。不是通过删除或截断消息来控制高度。成员选择页、设置弹窗仍保留各自滚动区域。

验证：打包版在 1280×720、900×620、680×500 下，分别显示 1/50/180 条长回复、加载更多记录、连续输出 500 行文字，外层高度均受窗口约束，输入框可见可输入。侧栏可滚到底部，设置保存按钮可以访问；源代码构建通过。

```powershell
node --test desktop/test/layout.test.mjs
```

该测试默认检查 `win-unpacked-layout-20261126`。也可通过 `TEAMHUB_LAYOUT_DIR` 指定其他分发目录，旧版 `win-unpacked-timeline-20261126` 会复现页面撑高断言失败。构建脚本默认输出目录现为 `win-unpacked-layout-20261126`，不会覆盖已有目录。
