# 青蓝账本

青蓝账本是一款本地优先、可离线、支持跨设备自动同步的中文个人现金流 PWA。账目始终先写入浏览器 IndexedDB；生产站点使用统一账号识别用户，以 Cloudflare D1 保存结构化记录、R2 保存图片凭证。

## 这次同步方案

当前生产方案不再依赖 Firebase CLI、Google OAuth 回调或本机 `localhost` 授权：

- 身份：ChatGPT Sites 统一账号，Worker 只信任平台注入的 `oai-authenticated-user-email`。
- 结构化数据：Cloudflare D1。
- 图片凭证：Cloudflare R2，单张不超过 5 MB。
- 本机缓存：Dexie + IndexedDB，断网时照常记账。
- 自动同步：本机每次新增、修改或删除都会立即触发增量上传；页面可见时每 5 秒增量拉取一次，并在联网、切回页面和窗口聚焦时立即补同步。
- 手动同步：顶部云图标和“设置 → 账号与云同步 → 立即同步”。

生产站点地址：<https://qinglan-ledger.kexiangqi15.chatgpt.site>

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

同步实体包括账户、分类、流水、工资计划、考勤、分期计划/期次、资金预留、预算、设置、主题和附件。工资应收、安全线、周预算、统计和现金流预测从这些事实数据实时派生，因此各设备结果一致。

## 安全

- API 每次请求都在 Worker 内读取平台提供的已认证邮箱；浏览器无法指定别人的用户 ID。
- 所有 D1 查询和 R2 路径都带服务端生成的 `owner_key`。
- `/api/sync`、账号资料和附件响应均使用 `no-store`，Service Worker 明确不缓存 `/api/`。
- 前端没有数据库密钥、服务账号私钥或 OAuth Client Secret。
- 站点访问策略仍由 Sites 控制；当前个人账本应保持仅本人可访问。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

纯本地 Vite 环境没有 Sites 注入的统一账号头和生产 D1/R2 绑定，因此会以 IndexedDB 本地安全模式运行。完整跨设备同步应在 Sites 生产站点验证。

## 测试与构建

```bash
npm run typecheck
npm run test
npm run build
```

测试覆盖财务计算、历史 PS 快照、工资与预算边界、IndexedDB 初始化和备份、同步队列、LWW 冲突，以及“手机默认数据不能覆盖电脑旧修改”的升级场景。

## 部署

`.openai/hosting.json` 已声明：

```json
{
  "project_id": "appgprj_6a58fd61622c8191a5a72d354ac910fd",
  "d1": "DB",
  "r2": "ATTACHMENTS"
}
```

构建会把配置与 `drizzle/` 迁移复制到 `dist/.openai/`。发布新版本时，Sites 为 Worker 绑定 D1/R2 并应用迁移。此同步实现依赖 Sites 的服务端身份头；若改部署到纯静态 GitHub Pages、Netlify 或 Vercel 静态托管，页面仍可离线使用，但必须另行提供兼容的身份代理和 `/api/sync` Worker 才能保留云同步，不能直接把身份头放到客户端伪造。

## 数据备份

- JSON：导出全部业务数据和图片凭证，可合并或覆盖导入。
- CSV：导出交易明细，不嵌入二进制附件。
- 云同步不是永久备份历史的替代品，建议定期导出 JSON。

## 目录

- `app/LedgerApp.tsx`：主要页面与业务交互。
- `app/CloudSyncProvider.tsx`：统一账号、同步状态和手动同步 UI。
- `lib/db.ts`：Dexie 数据库、增量队列与旧数据识别。
- `lib/sync/engine.ts`：D1 增量同步、轮询、离线恢复、迁移和附件下载。
- `lib/sync/core.ts`：LWW 与云数据序列化纯函数。
- `worker/index.ts`：身份隔离、D1 API、R2 附件和冲突历史。
- `db/schema.ts` / `drizzle/`：云数据库模型与迁移。
- `tests/`：财务、IndexedDB 和跨设备同步测试。
