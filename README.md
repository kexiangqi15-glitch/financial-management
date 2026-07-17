# 青蓝账本

青蓝账本是一个本地优先、可离线、支持 Google 登录与 Firestore 跨设备实时同步的中文个人现金流 PWA。Windows、Android、iPhone、Mac 和 iPad 登录同一 Google 账号后，共享同一份账本；IndexedDB 始终保留为本地缓存和离线数据库。

## 技术选择

本项目采用 Firebase Authentication + Cloud Firestore：

| 方案 | 实时/离线 | Google 登录 | 运维 | 免费额度与结论 |
| --- | --- | --- | --- | --- |
| Firebase | 原生实时监听、Web 离线缓存 | 原生 | 最低 | 个人账本首选；免费层足够日常增量同步 |
| Supabase | 实时能力良好，离线需自建 | 可用 | 较低 | SQL/共享账本很强，但本地冲突层工作更多 |
| Appwrite | 可用 | 可用 | 云版或自托管 | 维护与生态成本更高 |
| Cloudflare D1 | 无原生客户端实时监听 | 需另配认证 | 低 | 很适合 API/统计，不适合本需求的实时离线同步 |
| PocketBase | 实时可用 | 需配置 | 必须维护单机服务 | 不符合“零服务器维护”目标 |

注意：Firebase 在中国大陆网络下的连通性可能受运营商和网络环境影响。应用会继续写入 IndexedDB 并显示“离线/待同步”，恢复可访问网络后自动补传，不会因云端暂时不可用阻塞记账。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm install
copy .env.example .env.local
npm run dev
```

未配置 Firebase 时应用会进入“本地安全模式”，原有账本可继续使用，但不会宣称已云同步。

## Firebase 配置

1. 在 [Firebase Console](https://console.firebase.google.com/) 创建项目，不启用 Analytics 也可以。
2. 添加一个 Web 应用，复制 Web 配置到 `.env.local` 对应的 `VITE_FIREBASE_*` 字段。
3. Authentication → Sign-in method → 启用 Google。
4. Authentication → Settings → Authorized domains，加入所有实际部署域名，例如：
   - `qinglan-ledger.kexiangqi15.chatgpt.site`
   - Vercel / Netlify / GitHub Pages 的正式域名
5. Firestore Database → Create database，选择离主要使用地点较近的区域。
6. 安装并登录 Firebase CLI 后部署安全规则与索引：

```bash
npx firebase-tools login
npx firebase-tools use YOUR_PROJECT_ID
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

也可以在不重新构建的情况下替换部署产物中的 `firebase-config.js`：

```js
window.__QINGLAN_FIREBASE_CONFIG__ = {
  apiKey: "...",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "...",
  appId: "..."
};
```

Firebase Web API Key 是项目标识，不是管理员密钥；真正的数据隔离由 `firestore.rules` 中的 `request.auth.uid` 强制执行。不要在前端放置服务账号私钥。

## 同步行为

- 启动：先拉取云端记录，再合并本机待同步变更。
- 新增、修改、删除：业务写入先落 IndexedDB，再写入逐记录增量队列。
- 离线：完整保留本地写入；`online` 事件触发后自动重试。
- 多设备：Firestore `onSnapshot` 实时监听远端变化。
- 冲突：按 `clock + deviceId` 做确定性的 Last Write Wins。
- 历史：覆盖前的版本写入当前记录的 `history` 子集合；删除采用墓碑记录，不做无审计的硬删除。
- 图片：Blob 仍保存在 IndexedDB；云端以约 600 KB 的 Firestore 分块保存，5 MB 凭证不会超过单文档大小限制。
- 手动同步：顶部云图标和“设置 → 账号与云同步 → 立即同步”。

首次升级会识别旧 IndexedDB 数据。即使另一台设备先创建了云账本，本机与示例值不同的账户余额、考勤、预算、交易和附件也会作为旧设备自定义数据重新进入队列，避免同 ID 数据被默认样例覆盖。迁移成功后本地缓存不会删除。

## Firestore 结构

```text
users/{uid}                               用户资料与 schemaVersion
users/{uid}/devices/{deviceId}            设备最近在线信息
users/{uid}/records/{entity--encodedId}   统一增量记录/墓碑
  └─ history/{clock-deviceId}             冲突和覆盖前版本
users/{uid}/attachmentChunks/{chunkId}    版本化附件分块
```

`records` 文档包含 `entityType`、`recordId`、`data`、`deleted`、`clock`、`deviceId`、`schemaVersion` 和服务端 `updatedAt`。统一记录流只需一个实时监听，未来可平滑扩展到 `ledgers/{ledgerId}/records` 与成员权限，实现家庭/共享账本。`firestore.indexes.json` 已包含实体时间和交易日期查询索引。

同步实体包括账户、分类、流水、工资计划、考勤、分期计划/期次、资金预留、预算、设置、主题和附件。统计、应收工资、安全线、未来余额与现金流预测是纯函数派生结果；同步底层事实数据后，每台设备会得到完全相同的派生结果，避免保存重复统计造成漂移。

## 安全规则

`firestore.rules` 只允许已登录且 `request.auth.uid == userId` 的用户读写 `users/{userId}` 及其所有子集合。任何用户都无法查询或修改其他 UID 下的数据。规则必须部署到实际 Firebase 项目后才生效。

## 部署

```bash
npm run typecheck
npm run test
npm run build
```

- Firebase Hosting：`firebase.json` 已指向 `dist/client` 并配置 SPA rewrite。
- Vercel / Netlify / GitHub Pages：构建目录使用 `dist/client`，并将所有路由回退到 `index.html`。
- ChatGPT Sites：保留 `.openai/hosting.json` 与 Cloudflare Worker 静态入口；Firebase 仅作为客户端认证/数据服务。

部署后若手机仍显示旧页面，完全关闭旧 PWA/Safari 标签再重新打开；Service Worker v2 会删除旧缓存。顶部必须出现云同步状态或未配置提示，不能再显示“数据仅存本机”。

## 数据与备份

Dexie v2 表包括全部业务表，以及：

- `syncQueue`：逐记录待发送变更、重试次数和错误。
- `syncMeta`：设备迁移标记、每条记录的 LWW 版本戳和最后同步时间。

JSON 备份仍包含所有业务数据和附件；CSV 只导出流水字段。云同步不是备份历史的替代品，建议继续定期导出 JSON。

## 目录

- `app/CloudSyncProvider.tsx`：登录门、账号状态和同步 UI。
- `lib/sync/engine.ts`：Firestore 实时、增量、离线恢复、迁移、附件和历史版本。
- `lib/sync/core.ts`：LWW、文档 ID、数据清洗和分块纯函数。
- `lib/db.ts`：Dexie v2、本地队列和旧数据识别。
- `firestore.rules` / `firestore.indexes.json`：生产安全与索引。
- `tests/`：财务算法、IndexedDB、迁移队列和冲突测试。
