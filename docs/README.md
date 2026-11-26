# Team Hub 案例与检查文档

这里集中保存本次协作中由助手生成的演示文档和检查记录。仓库原有的 README、设计提示词和技能文档保持原位。

## 四个案例怎么选

### case0：宿舍公共物品借还小站——不作为 pre 展示

- 文档：[DORM_BORROW_DEMO_GUIDE.md](case0/DORM_BORROW_DEMO_GUIDE.md)。
- 内容：三个助手分别代表借用同学、物品提供者、生活委员，开发借还、记录与损坏管理功能。
- 规模：网页、后端、SQLite、公共接口协商和两轮需求变更，工作量较大。
- **由于项目太大，不作为本次 pre 的展示项目。**保留流程作为后续参考；文档中的展示章节是当时的方案，不代表当前选择。
- 此文件夹只收录流程，不代表整个项目已开发完成或验收通过。

### case1：宿舍门口留言牌——可以展示，优先用于直观演示

- 文档：[SIGN_DEMO_GUIDE.md](case1/SIGN_DEMO_GUIDE.md)。
- Alice 提出安静时段，Bob 提出快递放置要求，Carol 检查隐私；由 Bob 生成唯一的 `index.html`。
- 不需要后端、数据库、依赖或额外资源，生成后双击 HTML 即可展示。
- pre 展示：**两条需求消息、一条隐私检查反馈、最终网页**。
- 证明基础的多用户需求汇合与通信，不承担复杂项目开发的展示目标。
- 当前这里只保存操作流程，未在整理文档时生成或验收网页。排练时在新的空项目目录执行任务。

### case2：加减乘协作——可以展示，用于代码交接演示

- 文档：[CALC_DEMO_RECORD.md](case2/CALC_DEMO_RECORD.md)，包含此前执行记录、三份任务和复演步骤。
- 本目录只保留文档，代码保留在原算术项目目录中。
- Alice 实现加法，Bob 实现减法，Carol 实现乘法；三人通过消息交换调用说明，再使用另一人的函数完成组合计算。
- pre 展示：三个函数、实际通信记录，以及组合计算结果 **7、7、20**。
- 重新展示“从零开发”时，要新建空目录，不能把已有项目代码当作现场生成结果。

### case3：宿舍一周值日表——可以展示，用于时间约束协商

- 文档：[DUTY_DEMO_GUIDE.md](case3/DUTY_DEMO_GUIDE.md)，包含三份可复制任务、消息推进步骤和验收方法。
- 三位室友分别提出扫地、倒垃圾、擦桌子的时间要求，由三个 Agent 实际通信并确认共同安排。
- 最终只有一个 HTML 和三份 JS 数据文件，双击网页即可展示，不做后端、数据库或依赖安装。
- pre 展示：**三方独立要求、真实协商记录、完整值日表**。参考安排只供操作者验收，不提前发给 Agent。
- 此目录只保存文档，尚未在本次整理中生成或验收项目。

## 文件夹编号与原项目路径

这里的 `case0`、`case1`、`case2`、`case3` 是**文档分类编号**。原算术项目位于 `F:\System\Desktop\学习\OOAD\case1`，其文档归档到 `docs/case2`，并不表示原目录改名。原项目、会话和日志路径均保留。

```text
docs/
├─ README.md
├─ HOOKS_CHECK_REPORT.md
├─ case0/
│  └─ DORM_BORROW_DEMO_GUIDE.md
├─ case1/
│  └─ SIGN_DEMO_GUIDE.md
├─ case2/
│  └─ CALC_DEMO_RECORD.md
└─ case3/
   └─ DUTY_DEMO_GUIDE.md
```

## 其他记录与整理范围

- [HOOKS_CHECK_REPORT.md](HOOKS_CHECK_REPORT.md)：保留历史检查结果。报告针对其中注明的日期和提交，不应直接当作当前版本的验收结论。
- 已移除根目录中旧的候选文档：`COLLABORATION_DEMO_CASES.md`、`PRE_DEMO_CASES.md`、`DUTY_DEMO_GUIDE.md`。新的值日表流程保存在 `case3/DUTY_DEMO_GUIDE.md`，以本目录的案例说明为准。
- 仓库原有的 `README.md`、`desktop/README.md`、`toy-harness/README.md`、`DESKTOP-UI-PROMPT.md`、`DESKTOP-PET-PROMPT.md` 及原有技能文档不移动、不删除。此前对原 README 的更新也保留在原位置。

## pre 准备顺序

1. 先排练 case1，确认消息确实发出并收到，网页符合三条验收要求。
2. 准备 case2 的代码、通信记录和实际命令输出，作为技术演示或备用。
3. 若要展示时间条件如何协商，排练 case3；只把各自任务发给对应助手，不提前提供参考安排。
4. 留存真实截图或录像。若依靠人工输入“继续”推动协作，展示时如实说明。
5. 不现场启动 case0 的完整开发流程。
