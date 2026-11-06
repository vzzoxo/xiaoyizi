# 小姨子：Cloudflare Workers 部署

项目名称、原有界面和协议保持不变。管理面板运行于 Workers；SQLite、会话、验证码、备份持久化在一个 SQLite Durable Object 中；静态文件使用 Workers Assets。VLESS / Shadowsocks / Hysteria 服务及 Agent 仍运行在你的 VPS 上，Workers 负责管理与订阅分发。

## 部署

需要 Node.js 22+、Cloudflare 账号。新实例首次启动需要初始化管理员。

```bash
npm ci
npx wrangler login
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ULZIX_COOKIES_JSON
npm run deploy
```

- `SESSION_SECRET`：至少 32 字符强随机值，可使用 `openssl rand -hex 32` 生成。它也用于加密敏感数据库字段，部署后应保持稳定。
- `ADMIN_EMAIL`、`ADMIN_PASSWORD`：首次初始化管理员的邮箱和密码，密码至少 12 字符；已有用户时不会重置账号。初始化后可移除这两个 Secret。
- `ULZIX_COOKIES_JSON`：Ulzix 客户区已登录会话导出的 Cookie JSON，直接粘贴完整 JSON 到 Wrangler 的输入提示中。Cookie 不进入网页、不写入仓库或日志。
- 在 `wrangler.jsonc` 的 `vars` 中设置 `PANEL_DOMAIN` 为面板域名（不含 `https://`），用于派生 Agent 地址与 Telegram 链接。生产环境绑定自己的域名后再安装 Agent。
- `wrangler.jsonc` 保留 Worker 名称 `xiaoyizi`。Durable Object 单例名称 `xiaoyizi` 与绑定 `PANEL` 是数据身份，不应随意改动，否则会创建另一套数据库。
- 不需要单独创建 D1/KV/R2 数据资源。SQL 仓库继续使用同步事务，避免机械改成异步数据库后破坏判分、流量与邀请码事务。

首次打开网站后，使用初始化管理员的邮箱和密码登录。进入后台设置 SMTP、注册规则和节点。

## 本地开发与检查

复制 `.dev.vars.example` 为 `.dev.vars`，填入本地测试值，然后：

```bash
npm run dev
npm test
npm run test:worker
npm run check:worker
```

`test:worker` 使用实际 workerd / Miniflare，验证登录、模板、CSRF、订阅、Agent WebSocket 上报与指令、Cron 去重、快照恢复，以及关闭并重新创建运行时后的数据和会话持久化。测试不访问真实 Ulzix 账号，也不部署生产资源。

开发时使用 `https://` 访问或保留生产环境的代理协议转发适配；会话 Cookie 始终设置 Secure / HttpOnly。修改模板后需要重新构建，Worker 中不进行运行时模板编译。Node 常驻部署仍可以使用 `npm start`，其部署数据与 Worker 数据各自独立。

## Ulzix 集成

固定连接 `https://idc-new.ulzix.com`，使用标准 FOSSBilling Client API：

- `POST /api/client/order/get_list`：分页查询自己的订单。
- `POST /api/client/order/get`：绑定前验证订单归当前登录客户所有。

会话 Cookie 支持以下格式：

```json
[
  {"name":"PHPSESSID","value":"YOUR_SESSION","domain":"idc-new.ulzix.com","path":"/"}
]
```

也支持 `{"cookies":[...]}` 和 `{"COOKIE_NAME":"COOKIE_VALUE"}`。完整导出通常优于只选一个 Cookie；会自动过滤其他域名与已过期 Cookie。若存在 `fossbilling_csrf`，将其同步发送到请求头和请求体；否则使用相同会话读取首页 `meta[name="csrf-token"]`，与 Ulzix 现有 API.js 的方式保持一致。上游跳转不会自动跟随，避免 Cookie 被转发到其他站点。

管理后台「Ulzix」中可查看订单状态、到期时间、服务类型，并将节点绑定到订单。Cookie 过期后更新 `ULZIX_COOKIES_JSON`。

**功能边界：** 标准 FOSSBilling 的订单 API 不等于 VPS 控制接口。目前没有核实 Ulzix 自定义 VPS 模块的开机、关机、重装、换 IP、创建实例接口，因此保留控制台入口，不猜测这些接口，也不会把旧 AWS 实例 ID 当作订单 ID。旧 AWS SDK、账号管理页面、自动换 IP 调用均已移除；旧数据库中的 AWS 列仅用于升级兼容，不再执行操作。OPS 换 IP 端点明确返回 501。

## 节点与 Agent

Agent 协议与地址保持 `/ws/agent`，要求节点独立 Token。连接认证、速率限制、断线清理、心跳、命令超时及指令结果的节点归属校验均在服务端执行。普通 WebSocket 连接用于复用现有协议，当前不使用 hibernation；长连接有相应 Durable Object 运行费用。

后台保留 SSH 密码部署与在线 Agent 配置同步。Workers 构建适配 ssh2 为 AES-GCM / AES-CTR，移除运行时编译的 Poly1305 模块；不支持在 Workers 中引用你电脑或旧服务器上的 SSH Key 文件路径。远程部署请求会等待后台任务完成后再返回，避免响应结束后安装被取消。真实 SSH / SMTP 连通性取决于目标主机、网络和账号，需使用你的 VPS / 邮件服务进行验收，不能用本地模拟替代。

## 定时任务与备份

一个每分钟 Cron Trigger 转发到持有数据的 Durable Object；按上海时间执行原有轮换、冻结和清理任务。每日 02:00 创建 JSON 快照，同一日同一任务完成后重试不会重复执行。每分钟检查过期 Agent、清理失效会话和验证码。

Worker 备份为后台可下载、恢复的 `.json` 快照，持久化在 Durable Object SQL 中；不写入临时文件系统。保留最多 14 份且清理 7 天以前的快照，每份最多 8 MiB。恢复前自动保存安全快照，并清除登录会话。快照包含账号与节点敏感信息，应妥善保管。更大的数据库请结合 Cloudflare 原生 Time Travel；本地 Node 版的 SQLite `.db` 文件不能直接当作 Worker JSON 快照恢复。当前未提供旧服务器数据库的自动导入工具。

## Telegram

Workers 使用 webhook，不运行长期 polling。设置 Secret `TG_BOT_TOKEN`、`TG_WEBHOOK_SECRET`（随机且符合 Telegram 的 secret_token 要求），在 Telegram Bot API 的 `setWebhook` 中指定：

```json
{"url":"https://YOUR_PANEL_DOMAIN/telegram/webhook","secret_token":"SAME_TG_WEBHOOK_SECRET"}
```

收到更新时校验 `X-Telegram-Bot-Api-Secret-Token`，处理完成后记录 update_id，防止已完成更新被重复执行。发送通知和异步配置任务保留在请求生命周期内。Bot 菜单可通过 BotFather 配置；后台 Telegram 通知配置仍独立保留。

## 当前验证

113 项 Node 测试通过，Workers 运行时测试与 Wrangler dry-run 通过。真实 Ulzix 登录态、VPS SSH、SMTP 和 Telegram webhook 需要对应凭据才能进行线上联调；未在这些外部服务创建或变更资源。
