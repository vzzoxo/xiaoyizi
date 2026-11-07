# Changelog

## v4.2.0 (2026-05)

### 新功能

- **TG 解绑**：用户可在面板自助解绑 Telegram（点击导航栏蓝色 TG 图标）
- **TG 未签到自动冻结**：30 天未在 TG 签到的绑定用户自动冻结，签到一次自动解冻（替代旧的"未登录冻结"和"一键禁用不活跃用户"）
- **探针开放**：探针监控页面（`/monitor`）从仅管理员可见调整为所有登录用户可见

### Bug 修复

- **修复 AWS 换 IP 误报失败**：`notify.ops()` 在通知开关关闭时返回 `undefined` 导致 `.catch()` 报 TypeError，HTTP 返回 500，但实际 IP 已成功更换。现 `notify` 所有方法统一返回 Promise
- **修复 traffic 外键崩溃**：删除节点/用户后 Agent 仍上报旧数据触发外键约束，导致进程崩溃。现 `recordTraffic` 失败时记录 debug 日志而非抛出
- **修复 scrypt DoS 风险**：`verifyPassword` 限制 N/r/p 参数范围（N ≤ 2^20, r ≤ 16, p ≤ 4），防止篡改数据库哈希导致 CPU/内存 DoS

### AWS 区域

- 新增亚太区域：`ap-southeast-3` 雅加达、`ap-southeast-4` 墨尔本、**`ap-southeast-5` 吉隆坡**、`ap-southeast-7` 曼谷、`ap-south-2` 海得拉巴
- 新增美洲：`ca-west-1` 加拿大西部、`mx-central-1` 墨西哥
- 新增欧洲：`eu-central-2` 苏黎世、`eu-south-1` 米兰、`eu-south-2` 西班牙
- 新增中东非洲：`me-central-1` 阿联酋、`il-central-1` 以色列、`af-south-1` 开普敦
- 前端区域下拉框按地理位置分组显示

### UI

- 已绑定 TG 的图标从勾号改为蓝色 TG 图标（避免歧义）
- 修复弹窗使用 Tailwind JIT 任意值 class 在预编译 CSS 中不生效的问题（`z-[999]` / `bg-[#1a1520]` 改为 inline style）

### 其他

- 删除"一键禁用不活跃用户"功能（被 TG 未签到策略替代）
- 删除"未登录自动冻结"配置项（被 TG 未签到策略替代）

---

## v4.1.1 (2026-03-17)

### Bug 修复

- 修复登录密码 `.trim()` 与注册不一致导致含空格密码无法登录
- 修复 `emitSyncNode` 传更新前旧对象
- 修复封禁不活跃用户漏掉从未登录的用户
- 修复编辑 AWS 账号时 socks5 配置被意外清空
- 修复 SS 节点部署缺少 `ssh_key_path` 导致 SSH Key 部署后无法回连

### 代码清理

- 新建 `src/utils/regions.js` 统一地区映射
- 新建 `src/utils/tgGame.js` 统一游戏公共函数
- 新建 `src/services/migrations.js` 拆分数据库迁移代码
- 删除 20+ 处未使用的 import 和死代码
- `forgotCodes` 加入定时清理防内存泄漏

### 运维

- 补全 `openclaw-ops/` 目录
- 更新Pоrпнub AI人设

## v4.1.0 (2026-03-13)

### Telegram

- 重构机器人菜单：签到 / 大转盘 / 翻卡 / 猜拳 / 我的 / 订阅
- 增加 `my` 二级菜单和管理员总览
- 增加 `/adminstats`
- 修复 callback 场景下误判未绑定账号

### TG WebApp

- 猜拳持久化每日限制
- 增加 initData 过期校验
- 新增每日翻卡 WebApp
- 每周抽奖升级为大转盘 WebApp

### 其他

- 签到 / 抽奖流程事务化
- 每周抽奖统一按 Asia/Shanghai 周一边界

## v4.0.0 (2026-03-10)

- 邮箱注册、找回密码、订阅签名、TG 绑定完成整合

## v3.x

- 订阅风控后台配置化
- 端口轮换周期支持配置
- 从旧登录路径收口到邮箱注册 / 登录
