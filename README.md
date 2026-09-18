# 青蓝账本

青蓝账本是一款本地优先、可离线、支持跨设备自动同步的中文个人现金流 PWA。账目始终先写入浏览器 IndexedDB；生产站点使用统一账号识别用户，以 Cloudflare D1 保存结构化记录、R2 保存图片凭证。

## 当前财务管理能力

- 手机适配：320px 起的小屏布局，手机/平板底部导航与全部功能菜单；表单至少 16px，主要触控按钮至少 44px，支持 iPhone 安全区与横屏菜单滚动。预测表在手机上按日期卡片排列，保留所有预测金额。响应式样式集中在 `app/mobile.css`，不修改财务数据或同步规则。

- 灵活考勤：任意日期可设为出勤、休息、请假、待确认或未在职，工资实时重算。
- 最后工作日：最后工作日之后自动停止计薪；延长日期时新增日期默认待确认。
- 工资结算联动：修改已结算考勤会按差额调整工资到账流水和账户余额，并保存调整审计。
- 动态现金流日历：自动使用当前月份，可前后翻月，展示工资、分期和周期账单预测。
- 财务计划：周期收支、储蓄目标、应收借款和报销均支持本地优先跨设备同步。
- 账户对账：输入真实余额后保存对账快照，差额通过可审计的调整流水修正。
- 月度报告：支持月份选择、环比、储蓄率、刚性支出比例、分类趋势和月度结账快照。
- AI 财务分析：在统计页分析现金安全、预算、工资应收、分期压力和储蓄目标，并把报告跨设备同步。
- 数据安全中心：显示当前设备、同步队列、近期设备和冲突历史。

## 这次同步方案

当前生产方案不再依赖 Firebase CLI、Google OAuth 回调或本机 `localhost` 授权：

- 身份：ChatGPT Sites 统一账号，Worker 只信任平台注入的 `oai-authenticated-user-email`。
- 结构化数据：Cloudflare D1。
- 图片凭证：Cloudflare R2，单张不超过 5 MB。
- 本机缓存：Dexie + IndexedDB，断网时照常记账。
- 自动同步：本机每次新增、修改或删除都会立即触发增量上传；页面可见时每 5 秒增量拉取一次，并在联网、切回页面和窗口聚焦时立即补同步。
- 手动同步：顶部云图标和“设置 → 账号与云同步 → 立即同步”。

生产站点地址：<https://qinglan-ledger.kexiangqi15.chatgpt.site>

### GitHub Pages 访问与同步

单月流水导出：进入“设置 → 按月导出流水”，选择月份后下载 `青蓝流水-YYYY-MM.csv`，可直接用于花销分析。只包含所选月份的流水，保留交易类型与状态（退款、转账和撤销不会冒充正常支出），不含附件及同步凭证；完整 CSV/JSON 导出仍保留。

仓库包含 GitHub Actions 发布流程，Pages 地址为 `https://kexiangqi15-glitch.github.io/financial-management/`。Pages 只托管公开前端代码；账本、附件、D1 数据库和任何密钥都不提交到 GitHub。

Pages 与原生产站点使用同一份 D1/R2 数据。首次使用前，请在原站点打开“设置 → 账号与云同步 → GitHub Pages 同步码 → 生成 48 位同步码”，点击“复制同步码”，再在 Pages 首屏输入。输入后自动连接，无需刷新；原站点刷新后仍可查看本机保存的码。同步码是高熵账本密码，只保存在各设备浏览器本地，切勿分享。“生成另一同步码”不会使已连接设备上的旧码失效。

原站点 API 必须使用 `credentials: same-origin` 保持统一账号登录；Pages 使用 `credentials: omit` 与 `x-qinglan-sync-code`，不依赖第三方 Cookie。若旧站反复回到登录页，先强制刷新（Windows：Ctrl+Shift+R），不要清除站点数据或 IndexedDB。服务器只保存同步码的哈希，并将其映射到原账户，不另建或搬空账本。Pages 前端可离线记账，但在线同步仍依赖原 Worker 域名的可达性，不能保证所有国内网络均能访问。

## 同步与冲突规则

每条数据独立保存 `entityType + recordId + clock + deviceId`：

1. 业务操作先落 IndexedDB，并写入可重试的 `syncQueue`。
2. 联网后仅上传队列中的变化，不全量覆盖云端。
3. 客户端使用 D1 `serverVersion` 游标，仅拉取上次同步后的变化。
4. 手机和电脑同时修改同一记录时，按 `clock` 执行 Last Write Wins；同一毫秒再用 `deviceId` 稳定打破平局。
5. 被覆盖版本和冲突失败版本写入 `sync_history`；删除保存为墓碑，避免另一台设备把旧数据“复活”。
6. 所有金额仍使用整数分，统计结果由本地纯函数从事实数据重新计算，不单独同步重复统计值。

### 首次升级迁移

升级后的第一次成功联网会自动检查旧 IndexedDB：

- 云端为空：把本机全部数据排入上传队列。
- 另一台设备已先创建云账本：先拉取云端，再把本机相对示例数据的真实修改重新排入队列。
- 同 ID 的旧余额修改也会被识别。例如电脑把默认 ¥1,358.55 改成 ¥1,353.05，即使手机先上传了默认值，电脑的真实修改仍会进入云端竞争并同步回手机。
- 迁移完成后不删除 IndexedDB，本机缓存和 JSON 备份能力保持不变。

## D1 数据结构

迁移文件位于 `drizzle/0000_d1_cloud_sync.sql`，核心表如下：

| 表 | 用途 |
| --- | --- |
| `sync_users` | 统一账号资料与最后访问时间 |
| `sync_devices` | 设备 ID、客户端信息和最后在线时间 |
| `sync_sequence` | 分配单调递增的云端版本号 |
| `sync_records` | 当前版本、墓碑和增量游标 |
| `sync_history` | 被覆盖版本与冲突历史 |

`sync_records` 以 `(owner_key, entity_type, record_id)` 为主键，并为 `(owner_key, server_version)` 建索引。`owner_key` 是服务端根据规范化邮箱计算的 SHA-256，不由浏览器提交。未来扩展家庭账本时可把所有权层替换为独立 `ledger_id` 和成员表。

同步实体包括账户、分类、流水、工资计划、考勤、工资结算与调整、分期计划/期次、资金预留、周期账单、储蓄目标、应收往来、对账快照、预算、设置、主题和附件。工资应收、安全线、预算、统计和现金流预测从这些事实数据实时派生，因此各设备结果一致。

## 安全

- API 每次请求都在 Worker 内读取平台提供的已认证邮箱；浏览器无法指定别人的用户 ID。
- 所有 D1 查询和 R2 路径都带服务端生成的 `owner_key`。
- `/api/sync`、账号资料和附件响应均使用 `no-store`，Service Worker 明确不缓存 `/api/`。
- OpenAI API Key 只保存在 Worker 的服务端环境变量中，不会进入浏览器代码、IndexedDB、备份或同步数据。
- AI 分析只发送金额汇总、分类名称和日期，不发送商户、流水备注、附件、账号邮箱或完整交易明细；API 请求设置为不存储。
- 前端没有数据库密钥、服务账号私钥或 OAuth Client Secret。
- 应用页面可以公开访问，但业务 API 必须取得 Sites 统一账号身份；未登录访客不能读取任何账本数据。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
pnpm install
pnpm run dev
```

纯本地 Vite 环境没有 Sites 注入的统一账号头、生产 D1/R2 绑定和服务端 AI 密钥，因此会以 IndexedDB 本地安全模式运行。完整跨设备同步和 AI 分析应在 Sites 生产站点验证。

## 测试与构建

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

测试覆盖财务计算、历史 PS 快照、灵活考勤、离职日期、已到账工资联动、预算边界、IndexedDB v3 初始化和备份、同步队列、LWW 冲突，以及“手机默认数据不能覆盖电脑旧修改”的升级场景。

## 部署

`.openai/hosting.json` 已声明：

```json
{
  "project_id": "appgprj_6a58fd61622c8191a5a72d354ac910fd",
  "d1": "DB",
  "r2": "ATTACHMENTS"
}
```

构建会把配置与 `drizzle/` 迁移复制到 `dist/.openai/`。发布新版本时，Sites 为 Worker 绑定 D1/R2、注入服务端 `OPENAI_API_KEY` 并应用迁移。GitHub Pages 发布版本通过跨域同步码连接该 Worker，身份头和 OpenAI 密钥仍完全留在服务端。若改部署到其他静态托管，必须在 Worker 的 CORS 白名单中显式加入该站点来源，不能把身份头或 OpenAI 密钥放到客户端。

## 数据备份

- JSON v2：导出全部业务数据、财务计划、月度结账、同步设置和图片凭证；仍兼容导入旧版 v1 备份。
- CSV：导出交易明细，不嵌入二进制附件。
- 云同步不是永久备份历史的替代品，建议定期导出 JSON。

## 目录

- `app/LedgerApp.tsx`：主要页面与业务交互。
- `app/CloudSyncProvider.tsx`：统一账号、同步状态和手动同步 UI。
- `lib/db.ts`：Dexie 数据库、增量队列与旧数据识别。
- `lib/sync/engine.ts`：D1 增量同步、轮询、离线恢复、迁移和附件下载。
- `lib/sync/core.ts`：LWW 与云数据序列化纯函数。
- `lib/ai-analysis.ts`：隐私化财务汇总、AI 请求和结果校验。
- `worker/index.ts`：身份隔离、D1 API、R2 附件、冲突历史和服务端 AI 分析。
- `db/schema.ts` / `drizzle/`：云数据库模型与迁移。
- `tests/`：财务、IndexedDB 和跨设备同步测试。
