# Toy Harness

Toy Harness 是独立的 Node.js 22+ 终端助手。它接受工作目录和目标，在同一回合里反复请求模型、执行受控工具并记录结果。普通用法只需要本目录的依赖。TeamHub 接入通过配置启用。

## Windows 安装与演示

### 双实例通信

首次从仓库根目录安装并构建两套 Node.js 包（推荐 Node.js 24 LTS）。

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd --prefix toy-harness ci
npm.cmd --prefix toy-harness run build
.\Start-Alice-Bob.cmd
```

以后双击根目录的 `Start-Alice-Bob.cmd` 即可。启动器打开 Alice 和 Bob 两个窗口，使用独立的临时数据库、工作目录和本机随机端口。学校模型需要校园网和自己的 DeepSeek Key。启动器优先使用环境变量，其次读取当前 Windows 用户已有的加密凭据，否则提示输入一次。两个窗口分别输入 `/exit` 后服务会关闭。

### Linux 双实例通信

以下命令使用 Bash。三个终端都从仓库根目录开始。终端一安装依赖、构建并保持服务运行。

```bash
npm ci && npm run build
npm --prefix toy-harness ci && npm --prefix toy-harness run build
npm start
```

终端二和三分别执行下列代码，提示时输入 `alice` 或 `bob`。两个实例连接同一台机器上的 TeamHub。每个终端使用自己的工作目录，示例按当前检出位置生成 hook 的绝对路径。

```bash
read -rp 'Peer (alice or bob): ' peer
read -rsp 'School DeepSeek key: ' TOY_HARNESS_DEEPSEEK_API_KEY; echo
export TOY_HARNESS_DEEPSEEK_API_KEY
work=$(mktemp -d)
node -e 'const fs=require("node:fs"), path=require("node:path"); const [peer,dir]=process.argv.slice(1); const cfg=require("./toy-harness/examples/sustech.deepseek.json"); cfg.teamhub={peer,url:"http://127.0.0.1:7878/mcp/"+peer,hookPath:path.resolve("dist/hook.js"),failClosed:true}; fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify(cfg));' "$peer" "$work"
node toy-harness/dist/cli.js --config "$work/config.json" --cwd "$work" --sessions "$work/sessions"
```

### 验证消息往返

1. 在 Alice 输入“请通过 TeamHub 给 bob 发送口令蓝桥731”。出现发送审批时输入 `/yes`，等到 `team_send_message ok`。
2. 在 Bob 输入“把 Alice 刚发来的口令原样回复给她”。新回合会读取未读消息。核对并批准发送，等待同样的成功回执。
3. 在 Alice 问“Bob 刚才回复了什么？”。读回原口令即完成双向验证。审批命令带斜杠；普通文字会作为本回合的追加指令。

Toy Harness 在客户端将暂停映射到 Stop、恢复映射到 UserPromptSubmit，并通过 MCP 清空旧的计划路径。恢复沿用原 turn ID，编辑前重新申报路径。可在根项目构建后用 `npm --prefix toy-harness run test:teamhub` 复验。

### Windows 离线演示

从仓库根目录在 PowerShell 执行。

```powershell
Set-Location .\toy-harness
npm.cmd ci
npm.cmd run build
npm.cmd test
npm.cmd run demo -- code
npm.cmd run demo -- report
```

也可用 `npm.cmd run demo` 连续运行两种任务。每次演示复制一份新夹具并通过正常 CLI 提交任务。终端打印会话、产物和验证结果，文件保存在 `.demo-output/run-*/`。两套演示使用同一运行时、工具和入口。

1. **代码修复。** 读取 `math.mjs`，运行 `node check.mjs` 观察失败，修正累加初值，重新运行测试。演示校验代码内容、两次退出码和最终答复。
2. **资料分析。** 读取 `north.txt` 和 `south.txt`，生成 `report.md`，在下一轮补写结论。演示校验共同建议、周一与周五的差异、两个来源文件名、标题及修订结果。

## 真实模型

[示例配置](examples/model.json) 使用 OpenAI Chat Completions。配置使用完整 endpoint URL、模型名和密钥环境变量名。连接支持 Responses 的服务时，将 `protocol` 改为 `responses` 并配置相应 endpoint。两个适配器都要求服务支持函数工具调用。密钥由当前进程环境提供。

```powershell
# PowerShell 7。按所选配置设置相同的密钥环境变量。
$env:OPENAI_API_KEY = Read-Host -MaskInput 'Model API key'
npm.cmd start -- --cwd 'C:\path with spaces\workspace' --config .\examples\model.json
npm.cmd run demo -- --live .\examples\model.json code
npm.cmd run demo -- --live .\examples\model.json report
```

学校网关可使用 [DeepSeek 配置](examples/sustech.deepseek.json)。在学校网络中，从本目录使用 `.env.sustech.local` 提供 `TOY_HARNESS_DEEPSEEK_API_KEY`。Git 会忽略该文件。

```powershell
node --env-file=.env.sustech.local dist/cli.js --cwd 'C:\path with spaces\workspace' --config examples/sustech.deepseek.json
node --env-file=.env.sustech.local demo/run.mjs --live examples/sustech.deepseek.json code report
```

真实模型演示自动批准临时夹具中的补丁，代码夹具只允许精确匹配 `node check.mjs` 的 shell 命令，资料夹具禁用 shell。其他用法默认逐次批准写入和 shell。离线脚本模式用 `--script FILE` 提供模型回复数组，可与 `--config FILE` 同用。回复格式为 `{"text":"","calls":[{"id":"read-1","name":"read_file","args":{"path":"notes.txt"}}]}`，最终答复只含 `text`。可重复传入 `--prompt TEXT` 批量提交。批量模式拒绝需要交互批准的调用。

## 终端和会话

- 输入目标开始普通回合。运行期间输入文字或 `/steer TEXT`，在下一模型请求加入同一回合。工具审批使用 `/yes` 和 `/no`。
- `/interrupt` 或 Ctrl+C 中断活跃回合。状态、模型步骤、工具请求、执行、拒绝原因、结果和产物路径实时显示。
- 用 `--sessions DIR --session ID` 选择会话，工作目录必须与原会话一致。用 `/resume` 接续暂停、中断或失败的回合。工具可能已经产生效果但缺少确认时，恢复标为待核实，运行时不会自动重放。每份会话日志由一个进程写入。
- `/checkpoints` 显示可用检查点，`/rollback SEQ` 恢复检查点的会话历史并保留磁盘审计记录。文件、shell 与远端服务上的副作用保留。退出使用 `/exit`。
- 工作目录中的 `AGENTS.md` 在每次启动时加载。技能查找 `.skills/<name>/SKILL.md`，启动时向模型说明有哪些名称，通过 `load_skill` 把正文交给模型。不会查找父级目录。示例位于资料夹具的 `.skills/source-report/`。
- `delegate_review` 给核查子代理单独的上下文，仅提供同一工作区的 `read_file`。子代理最多请求模型 5 次、读取 8 次，时间上限 30 秒，可随主回合取消。读取设为 `ask` 或 `deny` 时子代理无自动读取权限。

## 工具与上下文

`read_file` 和 `apply_patch` 使用工作区相对路径并检查路径组件，拒绝目录穿越、符号链接、junction 和硬链接。补丁支持单文件新增或按唯一文本上下文更新。它支持 `*** Add File:` 和 `*** Update File:`，适用 TeamHub 的补丁路径识别。工作区应由使用者控制，同时改动目录结构或文件仍可能产生文件系统竞争。

`Bash` 通过平台 shell 启动，Windows 使用 cmd.exe。审批后的命令使用本地账户权限，工作目录只是起点。通过 `permissions` 为工具指定 `allow`、`ask` 或 `deny`，通过 `allowedCommands` 进一步精确限制命令。命令默认 20 秒，合计输出上限 16 KiB。终止会尝试清理子进程树，已经发生的效果仍保留。

模型、运行时、上下文、日志与工具注册分开实现。JSONL 保存有序事件、用户目标、调用、结果、状态和产物位置。回合数无固定上限。上下文按字符预算保留当前目标、项目规则、近期完整调用及结果，并从早期输入、答复和产物记录提取摘要。旧细节以磁盘日志为准。配置项 `steps`、`context`、`turnTimeout`、`commandTimeout`、`outputLimit`、`hookTimeout` 分别控制迭代次数、上下文字符目标和执行限制。默认单回合 16 次模型请求、180 秒。固定指令或单个工具批次过大时，完整配对可超出上下文字符目标。

## TeamHub

在另一个终端进入根项目，执行 `npm.cmd ci`、`npm.cmd run build`、`npm.cmd start`。使用 [TeamHub 示例配置](examples/teamhub.json)，替换模型设置、peer URL 和 `hookPath`，再以 `--config .\examples\teamhub.json` 启动 Toy Harness。要禁用协作，使用没有 `teamhub` 字段的模型配置。

- Streamable HTTP 动态发现 MCP 工具及 schema，保留结构化结果和协议错误。模型可以更新计划、查询状态及 peer、收发消息。`team_begin_turn` 由 `UserPromptSubmit` hook 调用，模型只使用同一 ID 更新状态。`team_read_messages` 会消费未读消息。
- 内置 hook 配置用 Node 直接启动现有 `hook.js`，分开传递脚本路径和 peer 参数。生命周期事件使用 SessionStart、UserPromptSubmit、Stop、Interrupt、SessionEnd。工具事件匹配 `Bash|apply_patch`。额外 `hooks` 配置项接受 `{ "events": ["PreToolUse"], "matcher": "^apply_patch$", "command": "node", "args": ["C:/path with spaces/hook.js"] }`。协议使用 JSON stdin/stdout，stderr 单独显示。
- hook 的额外上下文进入模型请求，阻止原因作为失败结果或停止消息返回。原 hook 的服务离线默认放行。可通过配置 `failClosed: true` 或 `TEAMHUB_HOOK_FAIL_CLOSED=1` 启用停止行为（显式配置优先）。本地工具权限始终有效。TeamHub 当前识别的补丁和 Git 命令是协作提醒与拦截范围，目录和命令仍无隔离。
- 根项目构建后，在本目录运行 `npm.cmd run test:teamhub`。可再用 `node integration/codex.mjs` 验证与已配置模型的 Codex CLI 双向收发。两项联调均使用临时 SQLite 和随机 loopback 端口。

## 需求与实测

| 需求 | 入口或用例 | Windows 实测 |
| --- | --- | --- |
| 基础 · 两类任务 | `npm.cmd run demo` | 两套新会话通过。代码测试退出码从 1 变 0，报告保留标题、两个来源和新增结论。 |
| 基础 · 受控工具 | `npm.cmd test` | 通过。校验调用 ID、顺序、权限拒绝、参数错误、路径越界和 junction、进程超时、输出上限和步数预算。 |
| 基础 · 长期上下文 | `small context` 测试 | 通过。3000 字符预算下 17 轮触发压缩，仍能答出第一轮约束。JSONL 保留全部 17 个用户输入和早期结果。 |
| 基础 · 指令与交付 | CLI 和两套夹具 | 通过。模型回合收到实际结果并给出答复，目录中核对了修改后的代码和资料产物。 |
| 高级 · Skills 与项目指令 | `project instructions` 测试 | 通过。模型在启动时收到当前项目指令，在加载后收到技能正文。切换工作区使用另一份指令。 |
| 高级 · MCP、hook 与协作 | `npm.cmd run test:teamhub` | 2/2 通过。真实服务和 hook 子进程校验缺失计划、重叠补丁与同分支 push 均在执行前拒绝，协调后非冲突文件写入成功。验证消息消费、idle、interrupted、offline、服务离线放行与停止。 |
| 高级 · 进度与 steering | 终端进程和模型请求测试 | 通过。命令挂起时接收输入，下一模型请求保留同一 turn ID，提交 hook 只运行一次。 |
| 高级 · resume 与 rollback | 临时文件与重开日志 | 通过。结果未知的写入被标记，恢复执行前读取核实。回到检查点后文件继续存在。 |
| 高级 · 委派 | `delegate_review` 测试 | 通过。只读子代理核查了星期一及来源，拒绝子代理发出的写入调用，主代理收到审阅结论。 |
| 额外 · Codex 互通 | `node integration/codex.mjs` | 通过。Codex CLI 读取 Toy Harness 发出的测试消息，并经真实 TeamHub 回传确认。 |
| 真实模型 · 代码修复与资料报告 | 学校网关 `deepseek-flash` 与 `--live` | 2/2 通过。代码测试退出码从 1 变 0。报告保留原题、两个来源和周一与周五的差异，第二轮新增一句结论。报告回合还实际加载了技能并调用了只读核查。 |

两类演示和高级本地场景使用脚本模型，HTTP 协议测试使用本地模拟模型服务。TeamHub 联调用现有真实服务和 hook，Codex 互通使用 Codex 自己的模型配置。PDF 给出的 70% 与 30% 为基础和高级两组权重。

