# API 参考

## 约定

- 用户页面：会话认证（`requireAuth`）
- 管理 API (`/admin/api/*`)：管理员会话 + CSRF（`requireAdmin`）
- OPS API (`/ops/api/*`)：`Authorization: Bearer <OPS_API_KEY>`
- 错误格式：`{ "error": "message" }` 或 `{ "ok": false, "error": "message" }`

## 健康检查

```
GET /healthz
→ { "status": "ok", "timestamp": "..." }
```

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/auth/login` | 登录页 |
| POST | `/auth/email-login` | 邮箱密码登录 |
| GET | `/auth/email-register` | 注册页 |
| POST | `/auth/email-register` | 邮箱注册 |
| POST | `/auth/send-email-code` | 发送注册验证码 |
| GET | `/auth/forgot-password` | 找回密码页 |
| POST | `/auth/forgot-send-code` | 找回密码验证码 |
| POST | `/auth/forgot-reset` | 重置密码 |
| GET | `/auth/temp-login` | 临时登录页（一次性 token） |
| POST | `/auth/temp-login` | 临时登录 |
| POST | `/auth/generate-invite-code` | 生成邀请码（需登录） |
| GET | `/auth/logout` | 登出 |

## 用户面板

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 用户面板首页 |
| GET | `/api/panel-summary` | 面板摘要数据（流量、节点、订阅状态） |
| POST | `/api/tg-bind-token` | 生成 TG 绑定 token |
| POST | `/api/tg-unbind` | 解绑 Telegram |
| GET | `/monitor` | 探针页面（所有登录用户可访问） |
| GET | `/api/monitor/overview` | 探针概览数据 |
| GET | `/api/monitor/node/:id` | 单节点性能历史 |

## 订阅

| 路径 | 说明 |
|---|---|
| `GET /sub/:token` | VLESS 订阅 |
| `GET /sub6/:token` | VLESS IPv6 订阅 |
| `GET /subhy2/:token` | Hysteria 2 订阅 |
| `GET /suball/:token` | 全协议订阅 |

按 UA 自动返回对应客户端格式（v2ray base64 / Clash YAML / Sing-box JSON）。  
启用 `SUB_LINK_SIGN_MODE=enforce` 时需附带 `?sig=...`。

## TG WebApp / 游戏

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/rps-game` | 猜拳页面 |
| POST | `/api/rps-profile` | 猜拳档案 |
| POST | `/api/rps-play` | 猜拳出招 |
| GET | `/flip-game` | 翻卡页面 |
| POST | `/api/flip-profile` | 翻卡档案 |
| POST | `/api/flip-draw` | 翻卡抽取 |
| GET | `/lucky-wheel` | 大转盘页面 |
| POST | `/api/lucky-profile` | 大转盘档案 |
| POST | `/api/lucky-spin` | 大转盘抽奖 |

WebApp 通过 Telegram `initData` 验证（含过期检查）。

## OPS API

认证：`Authorization: Bearer <OPS_API_KEY>`

### 查询

| 方法 | 路径 |
|---|---|
| GET | `/ops/api/status` |
| GET | `/ops/api/nodes` |
| GET | `/ops/api/nodes/:id` |
| GET | `/ops/api/users` |
| GET | `/ops/api/audit-log` |
| GET | `/ops/api/health-summary` |
| GET | `/ops/api/agents` |
| GET | `/ops/api/diary` |
| GET | `/ops/api/security/multi-node-overview` |

### 操作

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ops/api/nodes/:id/restart-xray` | 重启服务 |
| POST | `/ops/api/nodes/:id/swap-ip` | 换 IP |
| POST | `/ops/api/nodes/:id/sync-config` | 同步配置 |
| POST | `/ops/api/deploy` | 部署节点 |
| POST | `/ops/api/rotate` | 全量轮换（UUID/Token） |
| POST | `/ops/api/users/:id/freeze` | 冻结用户 |
| POST | `/ops/api/users/:id/unfreeze` | 解冻用户 |
| POST | `/ops/api/backup` | 创建备份 |
| POST | `/ops/api/agents/update-all` | 批量更新 Agent |
| POST | `/ops/api/diary` | 写运营日记（Pоrпнub AI巡检用） |

## 管理 API

前缀 `/admin/api`，需管理员会话 + CSRF。

主要功能：
- 用户 CRUD、批量操作、邀请关系
- 节点 CRUD、部署、重启、AWS 绑定/换 IP
- AWS 账号管理、实例查询、自动绑定
- 备份恢复、SMTP 测试、TG 通知配置
- 流量统计、安全分析、审计日志
- 自动化运维配置、订阅风控配置
- 用户组重置周期、订阅可见性
- Agent 状态查询、批量更新

## 调试

```bash
# 健康检查
curl -i http://127.0.0.1:3000/healthz

# OPS API
source /root/panel/.env
curl -s -H "Authorization: Bearer $OPS_API_KEY" http://127.0.0.1:3000/ops/api/status | jq .

# 查看节点
curl -s -H "Authorization: Bearer $OPS_API_KEY" http://127.0.0.1:3000/ops/api/nodes | jq '.[0]'

# 写日记
curl -s -X POST -H "Authorization: Bearer $OPS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"category":"patrol","mood":"","content":"巡检完成"}' \
  http://127.0.0.1:3000/ops/api/diary
```
