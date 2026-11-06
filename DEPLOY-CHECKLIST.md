# 部署检查清单

新装、迁移或升级后逐项确认。

## 1. 进程

```bash
pm2 list                                    # vless-panel online
curl -s http://127.0.0.1:3000/healthz       # status: ok
pm2 logs vless-panel --lines 50 --nostream  # 无连续报错
```

## 2. 域名与 HTTPS

```bash
nginx -t
curl -I https://你的域名
```

确认证书有效、页面正常返回。

## 3. .env 核心项

必填：`PANEL_DOMAIN`、`SESSION_SECRET`

可选：`TG_BOT_TOKEN`、`OPS_API_KEY`、`SUB_LINK_SIGN_MODE`、`TRUST_PROXY`

## 4. 登录与后台

- 首页可打开
- 注册 / 登录正常
- 管理员可进入 `/admin`
- 各 Tab 正常切换

## 5. SMTP

后台 → 设置 → SMTP 保存 → 测试邮件可收到

## 6. 订阅

测试 `/sub/:token`、`/subhy2/:token`、`/suball/:token`，确认格式正确。

## 7. Telegram Bot

`/start`、`/checkin`、`/flip`、`/rps`、`/lucky`、`/me`、`/sub`、`/traffic`、`/nodes` 均正常。绑定流程：先在面板点击导航栏 TG 图标 → 跳转 Bot → `/start bind_<token>` 自动绑定。

## 8. Agent

```bash
journalctl -u vless-agent -f
```

后台确认 Agent 在线，可同步配置、重启服务。

## 9. Ulzix

Cookie JSON 作为服务端 Secret 配置；订单可分页拉取、节点可绑定；过期登录态有明确提示。未核实的 VPS 扩展操作转到 Ulzix 控制台。

## 10. 备份

后台可创建、下载和恢复备份；Workers 为持久化 JSON 快照，Node 版为本地 SQLite 文件。

## 11. OPS API

```bash
source /root/panel/.env
curl -s -H "Authorization: Bearer $OPS_API_KEY" http://127.0.0.1:3000/ops/api/status
```

## 12. 升级后额外检查

```bash
cd /root/panel && npm test
```

确认 TG WebApp 可打开、游戏可结算、后台无 JS 报错。

## 13. 高风险操作前

先备份：数据库恢复、手动轮换、批量更新 Agent。
