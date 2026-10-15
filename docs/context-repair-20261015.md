# 近期真实公告修复验收（2026-10-15）

此前保守的单帖规则只在最近 11 个公告节点中命中 2 个。调研确认，Tibo 使用了 Day N/ Reset 主帖、时间回复、引用完成帖的结构。两类遗漏同时存在：上游未识别 processed/Loading 等表达，以及规范化丢弃了实际回复与引用关系。飞书正则单独放宽无法补齐。

本次仅修改独立通知器。未操作 Soar 的代码、配置、数据库、依赖、定时任务或进程。原有 59 个源码/文档/飞书配置文件 SHA-256 核对变化数为 0。

## 真实样本及结果

所有样本原文、发布时间和关系于 2026-10-15 通过 FxEmbed 镜像核验（直接 X 网页访问 403）。社区汇总仅用于发现原帖，完成声明不当成个人到账。公开固定样本在 `fixtures/tibo-october-2026.ts`，不包含个人数据或凭据。

| 轮次 | 原文来源 | 回放期望 |
| --- | --- | --- |
| Day 2 | [重置已处理](https://x.com/thsottiaux/status/2107676072871600470) | 1 次完成，识别 processed |
| Day 3 | [正在加载 banked reset](https://x.com/thsottiaux/status/2107913674593644711) | 1 次储备券发放公告，不假设到账 |
| Day 6 | [根帖](https://x.com/thsottiaux/status/2109045220411351517) → [时间回复](https://x.com/thsottiaux/status/2109045392684032299) → [引用完成帖](https://x.com/thsottiaux/status/2109132167112782291) | 共 1 次预告、1 次完成 |
| Day 8 | [根帖](https://x.com/thsottiaux/status/2109812216212099456) → [时间回复](https://x.com/thsottiaux/status/2109812360596865224) → [引用完成帖](https://x.com/thsottiaux/status/2109873287853707513) | 共 1 次预告、1 次完成，问句不遮蔽完成陈述 |
| Day 10 | [根帖](https://x.com/thsottiaux/status/2110595484180214059) → [时间回复](https://x.com/thsottiaux/status/2110595554036400151) → [引用完成帖](https://x.com/thsottiaux/status/2110618732666257557) | 共 1 次预告、1 次完成，两小时窗口锚定时间回复 |

Day 10 预计窗口为北京时间 12:56:07–14:56:07，完成公告发布时间为 14:28:13。此为公告链验证，不代表账号到账验证。

## 验证

- 138 项测试、类型检查和 git diff --check 通过。包括 27 项新增真实样本、结构关系、跨运行、迁移和发送回归测试。同一公告同时包含自动重置和发券时两类均保留；引用旧重置的发券帖不会被误当作旧重置完成。
- 同一批真实样本经过 monitor、独立持久化状态、FeishuNotifier 和 mock HTTP 全链路回放，按阶段共 8 条：3 预告、4 完成、1 发券；第二次运行无重发。这里的 8 条均为测试替身，未发送真实飞书。
- 主帖、时间、完成分别三个运行到达，仍只发预告与完成；完成-only 首次基线后，晚到时间帖不回退成预告。
- Day 9 功能更新、活动总纲、将来重置的设想、断链 Done/Landing、第三方根帖、否定和猜测不作为正式通知。真实 API 与 FxEmbed 两种来源都保留关系并验证祖先作者。
- 跨游标祖先可按 ID 回查；失败不推进游标。旧 outbox、游标与已发送回执不被清空，解析升级不补发历史。
- `scripts/verify-context-migration.ts` 从 origin/monitor-state 读取生产公开状态，在 outputs/context-release 副本中执行真实采集和 mock 通知；演练结果游标 `2110624335463584028` 原样保留，上下文 19 条，历史入队 0，真实发送 0。原回执另存副本用于上线比对。
- 发布前扫描 86 个可发布文件，未发现本机飞书配置原值进入代码或样本。

## 运行边界

只按已验证的回复/引用关系关联，不使用任意时间邻近或自动把别人的引用文本当官方声明。当前规则仍无法保证覆盖所有未来自然语言；新表达需以真实样本回归。原飞书业务成功、回执、UUID 窗口和不确定发送处理保持有效。

GitHub 定时工作流仍可能延迟。上线验收分别记录云端迁移、普通执行与实际 schedule 触发，不能把手动触发当成调度证据。本次不补发部署前旧公告。

## 云端上线验收

- 上线代码：`8b7e5f1ea590459b6139a935fe620c2f8f1e72ea`。
- [最终 CI](https://github.com/StephenChen1108/codex-reset-notifier/actions/runs/38701472031)：成功，138 项测试及类型检查、构建验证通过。
- [云端迁移运行](https://github.com/StephenChen1108/codex-reset-notifier/actions/runs/38701474038)：成功，北京时间 15:50:47 完成采集，日志明确记录上下文基线建立及游标保留；parserVersion=6、contextVersion=1、上下文 19 条、checked-0-posts、待发送 0，状态分支提交成功。
- 生产游标仍为 `2110624335463584028`；`feishu-deliveries.json` 的 SHA-256 与迁移前归档一致。真实飞书历史模拟消息 API 回读成功，POST 数 0，未新增模拟消息或补发旧公告。
- 工作流 API 状态为 active；目前验收证据为手动触发，尚未观察到 schedule 事件，不将其描述为已验证严格五分钟调度。
- 本地副本收尾时已位于 `D:\Users\Desktop\SoarInt\CodexResetNotifier`；核对独立 Git 根目录、HEAD 和 origin 均正确，工作区干净。该路径变更不是本次修复命令所执行的移动；Soar 运行工作树未参与开发或部署。
