# Codex 全局重置飞书通知器

本项目独立于 Soar。基于 AllenXiao95/codex-reset-signal 的 MIT 代码，基线提交为 `ed339d044d439de6920fb0f983416796edad2d08`（2026-09-12）。保留原许可证，复用原采集、事件时间解析、游标、outbox、锁和 GitHub Actions 状态分支；新增飞书通知适配器与发送记录，不部署 Hermes、VPS 或 Soar。

## Soar 通道审查

已只读核实 `D:\Users\Desktop\SoarInt\.worktrees\soar-v1\soar\feishu.py`：使用自建应用，通过 `auth/v3/tenant_access_token/internal` 取令牌，以 `im/v1/messages` 向既有私聊收件人发送，非 Webhook。配置来自 `D:\Apps\Soar\secrets\feishu.env` 和 `D:\Apps\Soar\config\feishu_recipient.json`。原 `send_digest` 本身不读写数据库，但其配置键、异常和消息封装为 Soar 定制；因此本项目用最小独立适配器调用相同官方接口，不导入 Soar。

没有修改 Soar 的代码、配置、数据库、依赖、定时任务、Prompt 或部署。复用同一身份意味着平台配额、应用可用性及凭据轮换仍然共享；软件运行与状态隔离，不能保证飞书平台故障或应用被禁用时两者独立可用。通知器低频发送，无入站订阅，不更改 Soar 的任何发送策略。

## 本地使用

Node.js 22 或更新版本。`npm ci` 安装本项目依赖；`npm test`、`npm run typecheck` 验证。

复制 `monitor.env.example` 到 `.env`，设置以下四项；不要提交 `.env`：

| Secrets | 含义 |
| --- | --- |
| `FEISHU_APP_ID` | Soar 现有自建应用 App ID |
| `FEISHU_APP_SECRET` | 同一应用 Secret |
| `FEISHU_RECEIVE_ID` | 原有收件人 ID |
| `FEISHU_RECEIVE_ID_TYPE` | 原有 ID 类型，通常为 open_id，以实际配置为准 |

本机也可只设置 `$env:SOAR_FEISHU_READONLY='true'`，显式只读加载上述两个 Soar 文件；不复制密钥到新文件。`npm run monitor` 执行一次，`npm run monitor:loop` 每 300 秒执行一次。不要同时启动多个使用同一 state 路径的进程。本地循环要求电脑开机；GitHub Actions 无此依赖。迁移 VPS 时复用全部 state.json、feishu-deliveries.json 及环境变量，只保留一个执行者。

`node --import tsx scripts/feishu-smoke.ts --live` 会向真实收件人发送一条标有“模拟测试，不是实际公告”的样例并 API 回读，测试状态位于被 Git 忽略的 `outputs/live-smoke/`。重复运行不再发送；不要删除其记录后重复测试。该测试仅证明飞书接口成功和消息可回读，不能证明客户端已经阅读。

## GitHub Actions 部署

使用独立公开仓库，默认分支为 main。公开内容为代码、Tibo 公告、哈希目标标识、消息回执；不包含收件人 ID、应用 Secret、令牌或 Soar 内容。不要复用上游的历史 runtime 状态。

1. 将本项目推到你自己的新仓库 main 分支，保留 MIT 许可证。
2. 初始化全新的状态目录：`node --import tsx scripts/init-notifier-state.ts outputs/runtime-seed`。在此目录单独 `git init -b monitor-state`、提交四个 JSON/XML 文件，并推到新仓库的 monitor-state 分支。该脚本拒绝覆盖已有 state.json。
3. 在仓库 Settings → Secrets and variables → Actions 配置上表四项 Repository Secrets。也可本机只读加载 Soar 后运行 `node --import tsx scripts/configure-feishu-secrets.ts OWNER/REPO`，脚本用 stdin 上传，密钥不写入磁盘或命令行参数。需 `gh` 已登录且有仓库管理 Secrets 的权限。不要把密钥贴到聊天或工作流 YAML。
4. Actions 启用工作流，手动运行 **Monitor X for reset**。首次静默建立基线，不补发历史消息。之后按每小时 2、7、12……57 分检查。`MONITOR_ENABLED=false` 可暂停定时检查，手动触发仍可用。无须 X token 或 Cookie，默认使用公共 FxEmbed；第三方接口故障会失败并保留游标，无自动付费回退。
5. 检查运行日志、GitHub Summary、monitor-state 分支和 outbox。`failed-*` 不代表没有公告。未配置飞书 Secrets 会直接失败，不会仅凭 GitHub Summary 假装飞书通知已启用。

标准 Linux runner 的公开仓库 Actions 免费；私有仓库 GitHub Free 通常只有每月 2,000 分钟。每 5 分钟约 288 次/天、30 天约 8,640 次，若每次计 1 分钟约 8,640 分钟；这只是估算，启动、依赖安装和分页可能增加用时。实际额度以账号账单为准。[GitHub 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、[套餐额度](https://docs.github.com/en/billing/reference/product-usage-included)。

理想发现延迟约 0–5 分钟，加上启动、源站缓存与执行耗时；GitHub 调度高峰可延迟甚至丢弃任务，没有实时 SLA。公开仓库长期无活动可能在 60 天后停用定时任务；不要假设状态分支提交一定避免此限制，需定期检查 Actions 的实际运行。[官方调度限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

## 事件和发送保证

- 预告：Tibo 明确宣布全局/面向所有用户重置时推送，建议暂缓使用 Banked Reset；有承诺但没明确时间仍可推送，显示时间未定。
- 完成：明确完成公告单独推送，注明不等于个人账户已到账。公告发布时间与事件时间分开，原文窗口、时区假设和不确定性沿用上游结果，不伪造精确时间。
- 储备券：明确发放/增加信用及有效期公告及时推送；保留原文条件与链接。
- 普通 reset 提及、请求、猜测、否定、个人/周期恢复不向飞书发送。保守过滤可能漏掉完全没有全局范围表述的模糊公告，需根据新原文添加回归样例。解析器不是官方权威接口。

outbox 与独立 `feishu-deliveries.json` 均在 monitor-state 分支持久化。按来源帖子、事件类型和阶段去重：相同预告的文本编辑不重发，同一帖子由预告变为完成可以另发，有效期变化允许另发。逐条保留飞书成功回执，HTTP 200 还必须同时满足 `code=0` 和非空 message_id。

失败会以同一稳定 UUID 重试，单次最多三次（1、2 秒退避），之后由下次运行继续。传输错误和服务端异常可能已送达；飞书 UUID 只有一小时去重，超过保守的 55 分钟仍不确定的记录停止发送并报 `FEISHU_UNCERTAIN_RECONCILE_BEFORE_RETRY`。先核对飞书记录，确认已送达后补回执，确认未送达才解除 pending；不能盲删记录。

状态写入采用本地原子替换。Actions 收尾即使通知失败也提交 runtime，提交失败会上传恢复 artifact。若出现持久化失败或 runner 被强制终止，应先暂停定时工作流、恢复最新 checkpoint 并核对已发送消息再恢复。不要清空状态重新跑；分布式发送与 Git 提交不能构成原子事务，持久状态丢失时无法保证绝对恰好一次。公开恢复 artifact 只含本通知器公开源数据及哈希/回执，保留 7 天。

日志仅含固定错误类别、HTTP/数字业务码与哈希前缀，不输出飞书原始错误体或底层异常。GitHub Secrets 独立存储；Soar 凭据轮换后需单独更新本项目 Secrets，不修改 Soar 来适应本项目。
