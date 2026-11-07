# Pоrпнub

> 一个为个人和小团队打造的多协议代理管理面板。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-5-lightgrey.svg)](https://expressjs.com)

基于 Node.js + Express + SQLite，把用户、节点、订阅、流量、运维放进一套系统。覆盖 VLESS Reality / Shadowsocks / Hysteria 2 三种协议，支持 Cloudflare Workers 部署、邮箱注册、Ulzix 订单与节点绑定、Telegram 互动游戏、自动化运维巡检。

## 功能

### 核心
- **多协议**：VLESS Reality / Shadowsocks / Hysteria 2
- **用户系统**：邮箱注册登录、密码找回、邀请码、用户分组、流量限额、到期冻结
- **订阅分发**：UA 自动识别（Clash/Sing-box/v2ray/Shadowrocket 等）、签名防盗链、IP/Token 限流、滥用检测
- **节点部署**：一键部署到任意 VPS，支持 SSH 密码 / Key、SOCKS5 落地
- **流量统计**：用户/节点维度 + 7 天趋势 + 来源分析
- **健康监控**：Agent WebSocket 长连接 + xray/Hysteria 存活检测 + 资源用量

### 自动化
- **Ulzix 集成**：FOSSBilling Client API、Cookie JSON 登录态、订单列表、节点绑定
- **被墙检测**：Agent 连通性检测与通知；Ulzix 换 IP 需在其控制台操作
- **密钥轮换**：UUID/订阅 Token 按用户组配置周期重置
- **不活跃冻结**：TG 30 天未签到自动冻结，签到一次自动解冻

### Telegram Bot
- **签到**：每日签到领流量，连续天数自动升级用户组（7 天家宽 / 15 天 SVIP / 30 天 SSVIP）
- **小游戏**：大转盘（每周）、翻卡（每日）、猜拳（每日）
- **管理**：`/me` 个人面板、`/sub` 拉订阅、`/adminstats` 管理总览
- **通知**：节点离线/恢复/被墙、用户超量、自动轮换、注册新用户、部署成功/失败

### 运维
- **管理后台**：节点 CRUD / 用户 CRUD / 流量统计 / 安全审计 / 备份恢复
- **探针**：实时性能监控（CPU/内存/磁盘/带宽/延迟），仅管理员可见
- **审计日志**：操作可追溯，过期自动清理
- **OPS API**：RESTful 接口，可被 OpenClaw 或外部系统调用做巡检和自愈
- **备份**：每日定时备份 + 手动一键备份 + 一键恢复

## Cloudflare Workers 部署（推荐）

请阅读 [Workers 部署与 Ulzix 配置](./README-WORKERS.md)。包含初始化管理员、Cookie JSON、Agent、备份和 Telegram webhook 配置。

## 快速部署

### 旧版 Node 常驻部署

```bash
bash <(curl -sL https://raw.githubusercontent.com/hekuo5310/PornHub/main/install.sh)
```

脚本会自动完成：系统依赖 → Node.js 22 → PM2 → 拉取代码 → 配置 .env → Nginx + Let's Encrypt SSL → PM2 启动 → 健康检查。

支持系统：Debian 11+ / Ubuntu 20.04+

首个注册的用户自动成为管理员。

### 手动部署

```bash
git clone https://github.com/hekuo5310/PornHub.git
cd PornHub
npm install --omit=dev
cp .env.example .env
# 编辑 .env，至少填 PANEL_DOMAIN 和 SESSION_SECRET
pm2 start ecosystem.config.js
```

## 配置

`.env` 关键变量（完整列表见 [`.env.example`](./.env.example)）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `PANEL_DOMAIN` |  | 面板域名（用于 CSRF Origin 校验、订阅链接生成） |
| `SESSION_SECRET` |  | 会话密钥，建议 64 字符随机字符串 |
| `PORT` | | 监听端口（默认 3000） |
| `TG_BOT_TOKEN` | | Telegram Bot Token（不填则禁用 TG 功能） |
| `OPS_API_KEY` | | OPS API Bearer Token（不填则 OPS API 不可用） |
| `SUB_LINK_SIGN_MODE` | | 订阅签名（`off` / `observe` / `enforce`） |
| `TRUST_PROXY` | | Nginx/Cloudflare 反代信任层数（默认 `1`） |

生成强随机密钥：

```bash
openssl rand -hex 32
```

## 项目结构

```
src/
├── app.js                  # 入口（Express + Session + Helmet + 定时任务）
├── routes/                 # 路由
│   ├── auth.js             # 登录注册
│   ├── panel.js            # 用户面板
│   ├── subscription.js     # 订阅分发
│   ├── opsApi.js           # OPS API
│   ├── monitorApi.js       # 探针
│   ├── flipGame.js / rpsGame.js / luckyWheel.js
│   └── admin/              # 管理后台路由
├── services/               # 业务逻辑
│   ├── database.js         # SQLite + 迁移
│   ├── deploy.js           # 节点部署
│   ├── ulzix.js            # Ulzix FOSSBilling Client API
│   ├── health.js           # 健康检查 + 流量上报
│   ├── tgbot.js            # Telegram Bot
│   ├── agent-ws.js         # Agent WebSocket
│   ├── notify.js           # 通知分发
│   └── repos/              # 数据访问层
├── middleware/             # auth, csrf, rateLimit, errorHandler
└── utils/                  # crypto, password, time, vless, regions...

views/                      # EJS 模板
public/                     # 静态资源（CSS/JS）
test/                       # 单元测试 (node --test)
node-agent/                 # 节点 Agent
templates/                  # 部署脚本模板
openclaw-ops/               # OpenClaw AI 运维 workspace（可选）
```

## 文档

- [管理后台指南](./ADMIN-GUIDE.md) — 各模块功能说明
- [API 参考](./README-API.md) — OPS API / 用户 API / TG WebApp API
- [部署检查清单](./DEPLOY-CHECKLIST.md) — 上线前逐项确认
- [更新日志](./CHANGELOG.md)
- [节点 Agent](./node-agent/README.md)
- [OpenClaw 运维](./openclaw-ops/README.md)（可选）
- [时间显示约定](./TIME-DISPLAY-CONVENTION.md)

## 技术栈

- **运行时**：Node.js 22+
- **框架**：Express 5
- **数据库**：better-sqlite3（同步 API + WAL 模式）
- **进程管理**：PM2
- **模板**：EJS
- **样式**：Tailwind CSS（预编译）
- **Workers**：Durable Object SQLite / Assets / Cron / WebSocket
- **WebSocket**：ws（面板侧）+ 自实现协议（Agent 侧，避免依赖）

## 安全特性

- Helmet + 严格 CSP + 每请求随机 nonce
- CSRF 双重防护（Origin + Token）
- 登录限流 + 验证码次数限制
- 密码使用 scrypt 哈希（参数范围限制防 DoS）
- Ulzix Cookie 仅存服务端 Secret
- 订阅链接 HMAC 签名（可选）
- 多层 Rate Limiting（IP / Token / 行为）
- Timing-safe 比较防时序攻击

## 测试

```bash
npm test
```

## License

[MIT](./LICENSE)

## 致谢

感谢所有使用过本项目并反馈问题的朋友
