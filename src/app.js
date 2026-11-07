if (!process.env.WORKERS_RUNTIME) require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// O9: 启动时 .env 校验（必须在其他模块加载前）
const { validateEnv } = require('./services/env-check');
validateEnv();

const express = require('express');
const session = require('express-session');
const SqliteStore = process.env.WORKERS_RUNTIME ? require('../workers/session-store')(session) : require('better-sqlite3-session-store')(session);
const morgan = require('morgan');
const helmet = require('helmet');
const cron = require('node-cron');
const path = require('path');
const logger = require('./services/logger');
const fs = require('fs');
const { performBackup, BACKUP_DIR } = require('./services/backup');
const { getClientIp } = require('./utils/clientIp');
const { resolveTrustProxyConfig } = require('./utils/trustProxy');
const { requestMetricsMiddleware, scheduleSummaryLogs } = require('./services/requestMetrics');

const { setupAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const panelRoutes = require('./routes/panel');
const adminRoutes = require('./routes/admin');
const adminApiRoutes = require('./routes/adminApi');
const rotateService = require('./services/rotate');
const dbModule = require('./services/database');
const { getDb } = dbModule;
const deployService = require('./services/deploy');
const { configEvents } = require('./services/configEvents');

const app = express();
if (process.env.WORKERS_RUNTIME) {
  app.engine('ejs', require('../workers/views.cjs').renderFile);
  app.set('trust proxy', 1);
}

const PORT = process.env.PORT || 3000;
const DEFAULT_TRAFFIC_RAW_RETENTION_DAYS = Math.max(1, parseInt(process.env.TRAFFIC_RAW_RETENTION_DAYS || '30', 10) || 30); // 最小 1 天
const DEFAULT_TRAFFIC_DAILY_RETENTION_DAYS = Math.max(90, parseInt(process.env.TRAFFIC_DAILY_RETENTION_DAYS || '120', 10) || 120); // 最小 90 天，保证趋势图数据充足

morgan.token('real-ip', (req) => req.clientIp || req.ip || req.socket?.remoteAddress || '-');
const accessLogFormat = ':real-ip - :method :url HTTP/:http-version :status :res[content-length] - :response-time ms';

// 中间件
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// CSP nonce：每个请求生成唯一 nonce
const { cspNonce } = require('./middleware/cspNonce');
app.use(cspNonce);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        (req, res) => `'nonce-${res.locals.nonce}'`,
      ],
      styleSrc: [
        "'self'",
        // TODO(S14-迁移计划): 将内联 style 迁移到外部 CSS 文件后移除 unsafe-inline
        "'unsafe-inline'",
        'https://fonts.googleapis.com',
      ],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // 允许第三方头像/外链图片
      imgSrc: ["'self'", 'data:', 'https:', 'http:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(morgan(process.env.WORKERS_RUNTIME ? (tokens, req, res) => JSON.stringify({method:req.method, path:req.path, status:res.statusCode, durationMs:tokens['response-time'](req,res)}) : accessLogFormat));
app.use(requestMetricsMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 反代信任边界：优先使用 TRUST_PROXY_CIDRS，仅在可信来源下接受 X-Forwarded-For
const trustProxyConfig = resolveTrustProxyConfig(process.env);
app.set('trust proxy', process.env.WORKERS_RUNTIME ? 1 : trustProxyConfig.value);
if (trustProxyConfig.mode === 'cidr') {
  logger.info({ cidrs: trustProxyConfig.cidrs }, 'trust proxy 已启用 CIDR 白名单');
}
app.use((req, res, next) => {
  req.clientIp = getClientIp(req);
  next();
});

// Session（持久化到 SQLite）
app.use(session({
  store: new SqliteStore({ client: getDb(), expired: { clear: true, intervalMs: 3600000 } }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: '__panel_sid',
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 天
  }
}));

// 认证
setupAuth(app);

const { adminLimiter } = require('./middleware/rateLimit');
const { csrfProtection, csrfLocals } = require('./middleware/csrf');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

// CSRF 防护
app.use(csrfLocals);

// 配置同步事件监听
configEvents.on('sync-all', () => {
  deployService.syncAllNodesConfig(dbModule).catch(err => logger.error('[配置同步]', err));
});
configEvents.on('sync-node', (node) => {
  deployService.syncNodeConfig(node, dbModule).catch(err => logger.error('[配置同步]', err));
});

// 路由
app.use('/auth', authRoutes);
app.use('/admin/api', adminLimiter, csrfProtection, adminApiRoutes);
app.use('/admin', csrfProtection, adminRoutes);
app.use('/ops/api', require('./routes/opsApi'));
app.use('/api/agent', require('./routes/agentApi'));

const subscriptionRoutes = require('./routes/subscription');
const statsRoutes = require('./routes/stats');

app.use('/', panelRoutes);
app.use('/', subscriptionRoutes);
app.use('/', statsRoutes);
app.use('/', require('./routes/monitorApi'));
app.use('/', require('./routes/rpsGame'));
app.use('/', require('./routes/flipGame'));
app.use('/', require('./routes/luckyWheel'));


// O2: 健康检查端点
app.get('/healthz', (req, res) => {
  try {
    const d = getDb();
    d.prepare('SELECT 1').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, '健康检查失败');
    res.status(503).json({ status: 'error', error: 'database unreachable' });
  }
});

// 404 + 全局错误处理
app.use(notFoundHandler);
app.use(errorHandler);

// 定时轮换任务（默认每天凌晨 3 点）
cron.schedule('0 3 * * *', async () => {
  logger.info('[CRON] 开始自动轮换...');
  try {
    await rotateService.rotateAll();
    logger.info('[CRON] 轮换完成');
  } catch (err) {
    logger.error({ err }, '[CRON] 轮换失败');
  }
}, { timezone: 'Asia/Shanghai' });

// 每天凌晨 4 点自动冻结不活跃/到期用户（受开关控制）
cron.schedule('0 4 * * *', async () => {
  try {
    let needsSync = false;

    // 自动冻结长期未在 TG 签到的用户（受开关和天数配置控制；未绑定 TG 的用户跳过）
    const noCheckinEnabled = dbModule.getSetting('auto_freeze_no_checkin_enabled') === 'true';
    if (noCheckinEnabled) {
      const rawDays = parseInt(dbModule.getSetting('auto_freeze_no_checkin_days'), 10);
      const days = Number.isFinite(rawDays) && rawDays >= 1 ? rawDays : 30;
      const frozen = dbModule.autoFreezeNoCheckinUsers(days);
      if (frozen.length > 0) {
        logger.info({ count: frozen.length, users: frozen.map(u => u.username) }, '自动冻结长期未签到用户');
        dbModule.addAuditLog(null, 'auto_freeze_no_checkin', `自动冻结 ${frozen.length} 个用户 (${days}天未签到): ${frozen.map(u => u.username).join(', ')}`, 'system');
        needsSync = true;
      }
    }

    // 自动冻结到期用户（到期冻结始终启用，不受开关控制）
    const expired = dbModule.autoFreezeExpiredUsers();
    if (expired.length > 0) {
      logger.info({ count: expired.length, users: expired.map(u => u.username) }, '自动冻结到期用户');
      dbModule.addAuditLog(null, 'auto_freeze_expired', `自动冻结 ${expired.length} 个到期用户: ${expired.map(u => u.username).join(', ')}`, 'system');
      needsSync = true;
    }

    if (needsSync) {
      // 合并执行一次全量同步，避免同一轮 cron 重复推送
      await deployService.syncAllNodesConfig(dbModule);
    }
  } catch (err) { logger.error({ err }, '清理/冻结失败'); }
}, { timezone: 'Asia/Shanghai' });

// 常驻 Node 启动逻辑；Workers 的生命周期由入口与 Cron Trigger 管理。
let server;
if (!process.env.WORKERS_RUNTIME) {
// 启动
server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'VLESS 节点面板已启动');

  // 启动 TG Bot
  try { require('./services/tgbot').init(); } catch (e) { logger.warn({ err: e.message }, 'TG Bot 启动失败'); }

  // 记录面板启动
  dbModule.addAuditLog(null, 'panel_start', `面板启动 端口:${PORT} 环境:${process.env.NODE_ENV || 'development'}`, 'system');

  // O7: 启动时清理过期审计日志
  cleanAuditLogs();

  // O4: 启动时创建备份目录并执行首次备份

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  scheduleSummaryLogs();
});

// 初始化 WebSocket Agent 服务
const agentWs = require('./services/agent-ws');
agentWs.init(server);
}

// O4: 每天凌晨 2 点自动备份数据库
if (!process.env.WORKERS_RUNTIME) cron.schedule('0 2 * * *', async () => {
  const result = await performBackup(getDb());
  if (!result.ok) {
    logger.error({ error: result.error }, '定时备份失败');
  }
}, { timezone: 'Asia/Shanghai' });

// O7: 每天凌晨 4:30 清理过期审计日志和订阅访问日志（保留90天）
function cleanAuditLogs() {
  try {
    const d = getDb();
    const r1 = d.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')").run();
    // sub_access_log 表可能不存在
    let r2 = { changes: 0 };
    try {
      r2 = d.prepare("DELETE FROM sub_access_log WHERE created_at < datetime('now', '-90 days')").run();
    } catch (err) {
      logger.debug({ err }, '跳过清理 sub_access_log（可能表不存在）');
    }
    let r3 = { changes: 0 };
    try {
      r3 = d.prepare("DELETE FROM sub_access_event WHERE created_at < datetime('now', '-90 days')").run();
    } catch (err) {
      logger.debug({ err }, '跳过清理 sub_access_event（可能表不存在）');
    }
    let r4 = { changes: 0 };
    try {
      r4 = d.prepare("DELETE FROM user_multi_node_observe_event WHERE created_at < datetime('now', '-90 days')").run();
    } catch (err) {
      logger.debug({ err }, '跳过清理 user_multi_node_observe_event（可能表不存在）');
    }
    let invites = { deletedExpired: 0 };
    try {
      invites = dbModule.cleanupExpiredInviteCodes();
    } catch (err) {
      logger.debug({ err }, '跳过清理 invite_codes');
    }
    logger.info({
      audit_log: r1.changes,
      sub_access_log: r2.changes,
      sub_access_event: r3.changes,
      user_multi_node_observe_event: r4.changes,
      invite_codes_expired: invites.deletedExpired,
    }, '审计日志清理完成');
  } catch (err) {
    logger.error({ err }, '审计日志清理失败');
  }
}
cron.schedule('30 4 * * *', cleanAuditLogs, { timezone: 'Asia/Shanghai' });

// 每天凌晨 4:40 清理流量历史明细
// 说明：traffic_site_total / traffic_user_total 为累计值，不受清理影响
function cleanTrafficHistory() {
  try {
    const rawSetting = parseInt(dbModule.getSetting('traffic_raw_retention_days') || '', 10);
    const dailySetting = parseInt(dbModule.getSetting('traffic_daily_retention_days') || '', 10);
    const rawDays = Math.max(1, Number.isFinite(rawSetting) ? rawSetting : DEFAULT_TRAFFIC_RAW_RETENTION_DAYS);
    const dailyDays = Math.max(90, Number.isFinite(dailySetting) ? dailySetting : DEFAULT_TRAFFIC_DAILY_RETENTION_DAYS);
    const result = dbModule.cleanupTrafficHistory(rawDays, dailyDays);
    logger.info({ ...result }, '流量历史清理完成');
  } catch (err) {
    logger.error({ err }, '流量历史清理失败');
  }
}
cron.schedule('40 4 * * *', cleanTrafficHistory, { timezone: 'Asia/Shanghai' });

// 每天凌晨 4:50 清理过期监控指标
function cleanNodeMetrics() {
  try {
    const raw = parseInt(dbModule.getSetting('metrics_retention_days') || '', 10);
    const days = Math.max(1, Number.isFinite(raw) ? raw : 7);
    const result = dbModule.cleanupMetrics(days);
    logger.info({ deletedMetrics: result.deletedMetrics }, '监控指标清理完成');
  } catch (err) { logger.error({ err }, '监控指标清理失败'); }
}
cron.schedule('50 4 * * *', cleanNodeMetrics, { timezone: 'Asia/Shanghai' });

// O3: Graceful Shutdown
/** Close the Node server, Agent connections and database before exiting. */
function gracefulShutdown(signal) {
  logger.info({ signal }, '收到关闭信号，开始优雅关闭...');
  server.close(() => {
    logger.info('HTTP 服务器已关闭');
    // 关闭 WebSocket
    try { require('./services/agent-ws').shutdown(); } catch (err) {
      logger.debug({ err }, '关闭 Agent WebSocket 失败，继续关闭流程');
    }
    // 关闭数据库
    try {
      getDb().close();
      logger.info('数据库连接已关闭');
    } catch (err) {
      logger.debug({ err }, '关闭数据库连接失败，继续退出');
    }
    process.exit(0);
  });
  // 5秒超时强制退出
  setTimeout(() => {
    logger.warn('优雅关闭超时，强制退出');
    process.exit(1);
  }, 5000);
}
if (!process.env.WORKERS_RUNTIME) {
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 全局异常兜底：未捕获的异常和 Promise rejection 不再让进程立即崩溃
// 记录详细日志后通过 graceful shutdown 退出（PM2 会自动重启）
process.on('uncaughtException', (err) => {
  try {
    logger.fatal({ err: { message: err.message, stack: err.stack, name: err.name } }, 'uncaughtException — 启动 graceful shutdown');
  } catch (_) {
    console.error('uncaughtException:', err);
  }
  // 给日志一点时间落盘，再触发关闭
  setTimeout(() => gracefulShutdown('uncaughtException'), 200);
});

process.on('unhandledRejection', (reason) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ err: { message: err.message, stack: err.stack } }, 'unhandledRejection — 已捕获，进程继续运行');
  } catch (_) {
    console.error('unhandledRejection:', reason);
  }
  // unhandledRejection 不立即退出（多数为业务侧 Promise 链断裂），仅记录
});

}
module.exports = app;
