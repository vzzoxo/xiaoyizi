#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const crypto = require('crypto');

// ─── 配置 ───
const CONFIG_PATH = '/etc/vless-agent/config.json';
const XRAY_CONFIG_PATH = '/usr/local/etc/xray/config.json';
const AGENT_PATH = '/opt/vless-agent/agent.js';
const AGENT_VERSION = process.env.AGENT_VERSION || '1.3.0';

const CHINA_PROBE_TARGETS = [
  { host: '220.202.155.242', port: 80 },
  { host: '114.114.114.114', port: 53 },
  { host: '223.5.5.5', port: 53 },
];

// IPv6 连通性探测（ping Google DNS，检测 IPv6 网络是否正常）
const IPV6_PROBE_TARGET = { host: '2001:4860:4860::8888', port: 53 };

let config = loadConfig();
const REPORT_INTERVAL = config.reportInterval || 2_000;
const HEARTBEAT_INTERVAL = 30_000;
const SELF_HEAL_INTERVAL = config.selfHealInterval || 60_000;

// ─── TLS 配置 ───
const INSECURE_TLS = config.insecureTls === true;
if (INSECURE_TLS) {
  log('WARN', 'TLS 证书校验已禁用 (config.insecureTls=true)，存在中间人攻击风险，仅限调试使用！请在调试完成后立即关闭！');
}

// ─── exec 指令白名单 ───
// 精确匹配：完整命令必须严格等于白名单条目
const EXEC_WHITELIST_EXACT = new Set([
  'systemctl restart xray',
  'rc-service xray restart',
  'systemctl stop xray',
  'rc-service xray stop',
  'systemctl start xray',
  'rc-service xray start',
  'systemctl status xray',
  'rc-service xray status',
  'systemctl is-active xray',
  'systemctl restart hysteria-server',
  'rc-service hysteria-server restart',
  'systemctl stop hysteria-server',
  'rc-service hysteria-server stop',
  'systemctl start hysteria-server',
  'rc-service hysteria-server start',
  'systemctl status hysteria-server',
  'rc-service hysteria-server status',
  'systemctl is-active hysteria-server',
  'uptime',
  'top -bn1',
  'ip addr',
  'ip -6 addr',
  'ip route',
  'cat /usr/local/etc/xray/config.json',
  'cat /etc/hysteria/config.yaml',
  'free -m',
  'free -h',
]);
// 受控前缀匹配：仅限安全的只读诊断命令
const EXEC_WHITELIST_PREFIX = [
  'xray api statsquery ',
  'xray api stats ',
  'df -h',
  'df -B1',
  'df -B1 ',
  'df -h ',
  'ping -c ',
  'ps aux',
];
const EXEC_WHITELIST_ENABLED = config.execWhitelistEnabled !== false;
const AGENT_CAPABILITIES = {
  tlsStrict: !INSECURE_TLS,
  execWhitelist: EXEC_WHITELIST_ENABLED,
  selfHeal: true,
  selfUpdate: true,
};
const PANEL_HOST = (() => {
  try { return new URL(config.server).hostname.toLowerCase(); } catch { return null; }
})();
const SAFE_DOWNLOAD_HOSTS = new Set([PANEL_HOST, 'vip.vip.sd'].filter(Boolean));
const DANGEROUS_SHELL_PATTERN = /[|;&`<>]|\$\(|\r|\n/;

function extractCommandUrls(cmd) {
  return (cmd.match(/https?:\/\/[^\s"']+/g) || []);
}
const reconnectMetrics = {
  disconnectCount: 0,
  lastDisconnectAt: null,
  lastReconnectAt: null,
  consecutiveReconnects: 0,
};

let ws = null;
let reconnectDelay = 1000;
let heartbeatTimer = null;
let reportTimer = null;
let selfHealTimer = null;

// ─── 配置加载 ───
function loadConfig() {
  // 环境变量优先
  if (process.env.AGENT_SERVER && process.env.AGENT_TOKEN && process.env.AGENT_NODE_ID) {
    return {
      server: process.env.AGENT_SERVER,
      token: process.env.AGENT_TOKEN,
      nodeId: parseInt(process.env.AGENT_NODE_ID),
    };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    log('ERROR', `无法读取 ${CONFIG_PATH}: ${e.message}`, { error: e.message, configPath: CONFIG_PATH });
    process.exit(1);
  }
}

// ─── 工具函数 ───
function log(tag, msg, meta = null) {
  const payload = { time: new Date().toISOString(), tag, msg };
  if (meta && typeof meta === 'object') payload.meta = meta;
  const line = JSON.stringify(payload);
  if (tag === 'ERROR') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function run(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: err?.code });
    });
  });
}

function sendMsg(data) {
  if (ws?.readyState === 1) {
    try {
      ws.send(JSON.stringify({ ...data, nodeId: config.nodeId }));
    } catch (e) {
      log('WS', `发送失败: ${e.message}`);
    }
  }
}

// ─── TCP 探测中国可达性 ───
function tcpProbe(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; socket.destroy(); resolve(ok); } };
    socket.setTimeout(timeout);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function checkChinaReachable() {
  try {
    const results = await Promise.all(
      CHINA_PROBE_TARGETS.map(t => tcpProbe(t.host, t.port))
    );
    const passCount = results.filter(Boolean).length;
    return passCount >= 2;
  } catch {
    return null;
  }
}

// 检测本机是否有全局 IPv6 地址
function hasGlobalIPv6() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv6' && !iface.internal && !iface.address.startsWith('fe80')) {
        return true;
      }
    }
  }
  return false;
}

// IPv6 连通性检测（仅配置开启 checkIPv6 且有全局 IPv6 地址时才检测）
async function checkIPv6Reachable() {
  if (!config.checkIPv6 || !hasGlobalIPv6()) return null;
  try {
    return await tcpProbe(IPV6_PROBE_TARGET.host, IPV6_PROBE_TARGET.port, 5000);
  } catch {
    return false;
  }
}

// ─── CPU 使用率采集（/proc/stat delta） ───
let _prevCpuTimes = null;

function getCpuUsage() {
  try {
    const raw = fs.readFileSync('/proc/stat', 'utf8');
    const line = raw.split('\n').find(l => l.startsWith('cpu '));
    if (!line) return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    // user, nice, system, idle, iowait, irq, softirq, steal
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    if (!_prevCpuTimes) {
      _prevCpuTimes = { idle, total };
      return null;
    }
    const dIdle = idle - _prevCpuTimes.idle;
    const dTotal = total - _prevCpuTimes.total;
    _prevCpuTimes = { idle, total };
    if (dTotal <= 0) return null;
    return +((1 - dIdle / dTotal) * 100).toFixed(1);
  } catch {
    return null;
  }
}

// ─── 网络带宽采集（/proc/net/dev delta） ───
let _prevNetStats = null;
let _prevNetTs = null;

function getNetworkBandwidth() {
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = raw.split('\n').slice(2); // skip header
    let rxBytes = 0, txBytes = 0;
    for (const line of lines) {
      const parts = line.trim().split(/[:\s]+/);
      if (parts.length < 10) continue;
      const iface = parts[0];
      if (iface === 'lo') continue; // skip loopback
      rxBytes += parseInt(parts[1], 10) || 0;
      txBytes += parseInt(parts[9], 10) || 0;
    }
    const now = Date.now();
    if (!_prevNetStats) {
      _prevNetStats = { rxBytes, txBytes };
      _prevNetTs = now;
      return { rxRate: 0, txRate: 0 };
    }
    const dt = (now - _prevNetTs) / 1000;
    if (dt <= 0) return { rxRate: 0, txRate: 0 };
    const rxRate = Math.max(0, Math.round((rxBytes - _prevNetStats.rxBytes) / dt));
    const txRate = Math.max(0, Math.round((txBytes - _prevNetStats.txBytes) / dt));
    _prevNetStats = { rxBytes, txBytes };
    _prevNetTs = now;
    return { rxRate, txRate, rxBytes, txBytes };
  } catch {
    return { rxRate: 0, txRate: 0 };
  }
}

// ─── 系统信息采集 ───
function getSystemInfo() {
  const loadavg = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    loadavg,
    memory: {
      total: totalMem,
      free: freeMem,
      used: totalMem - freeMem,
      usagePercent: +((1 - freeMem / totalMem) * 100).toFixed(1),
    },
    uptime: os.uptime(),
  };
}

async function getDiskUsage() {
  const { ok, stdout } = await run("df -B1 / | tail -1 | awk '{print $2,$3,$4,$5}'");
  if (!ok || !stdout) return null;
  const [total, used, avail, percent] = stdout.split(/\s+/);
  return { total: +total, used: +used, avail: +avail, usagePercent: parseFloat(percent) };
}

/** Select a fixed service command for OpenRC or systemd without accepting shell fragments. */
function serviceCommand(service,action) {
  if(!['xray','hysteria-server'].includes(service) || !['start','stop','restart','status'].includes(action)) throw new Error('Invalid service operation');
  if(fs.existsSync('/sbin/rc-service') && !fs.existsSync('/run/systemd/system')) return 'rc-service '+service+' '+action;
  return 'systemctl '+(action==='status' ? 'is-active' : action)+' '+service;
}
async function getXrayStatus() {
  const { ok } = await run(serviceCommand('xray','status'));
  return ok;
}

async function getHysteriaStatus() {
  const { ok } = await run(serviceCommand('hysteria-server','status'));
  return ok;
}

// Hysteria 2 流量统计（通过 HTTP API）
async function getHysteriaTraffic() {
  try {
    const configRaw = fs.readFileSync('/etc/hysteria/config.yaml', 'utf8');
    const secretMatch = configRaw.match(/secret:\s*"?([^"\n]+)"?/);
    if (!secretMatch) return [];
    const secret = secretMatch[1].trim();

    return new Promise((resolve) => {
      const reqOpts = {
        hostname: '127.0.0.1',
        port: 7653,
        path: '/traffic?clear=1',
        method: 'GET',
        headers: { 'Authorization': secret },
        timeout: 5000,
      };
      const req = http.request(reqOpts, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const records = [];
            for (const [email, stats] of Object.entries(data)) {
              // 用户名格式: u-<userId>-h (新) 或 u-<userId>-h@p (旧兼容)
              const m = email.match(/^u-(\d+)-h(?:@p)?$/);
              if (!m) continue;
              const userId = parseInt(m[1], 10);
              const tx = stats.tx || 0; // server→client = 用户下载
              const rx = stats.rx || 0; // client→server = 用户上传
              if (rx > 0) records.push({ userId, direction: 'uplink', value: rx, proto: 'hy2' });
              if (tx > 0) records.push({ userId, direction: 'downlink', value: tx, proto: 'hy2' });
            }
            resolve(records);
          } catch {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.end();
    });
  } catch {
    return [];
  }
}

async function getXrayTraffic() {
  const { ok, stdout } = await run(
    'xray api statsquery --server=127.0.0.1:10085 -pattern "user>>>" -reset 2>/dev/null'
  );
  if (!ok || !stdout) return [];

  function pushRecordByName(records, name, rawValue) {
    let userId = null;
    let direction = null;
    let proto = null;

    // 新协议区分格式：
    // VLESS: u-<id>-v@p
    // SS:    u-<id>-s@p
    let m = String(name || '').match(/^user>>>u-(\d+)-(v|s)@p>>>traffic>>>(uplink|downlink)$/);
    if (m) {
      userId = parseInt(m[1], 10);
      proto = m[2] === 's' ? 'ss' : 'vless';
      direction = m[3];
    } else {
      // 兼容更多历史格式：
      // 旧: user-<id>@panel
      // 新(无协议后缀): u-<id>@p
      // 部分版本: u-<id>-v / u-<id>-s（无 @p）
      m = String(name || '').match(/^user>>>(?:user-|u-)(\d+)(?:-(v|s))?(?:@panel|@p)?>>>traffic>>>(uplink|downlink)$/);
      if (m) {
        userId = parseInt(m[1], 10);
        proto = m[2] === 's' ? 'ss' : (m[2] === 'v' ? 'vless' : null);
        direction = m[3];
      }
    }

    if (!userId || !direction) return;
    const value = parseInt(rawValue, 10) || 0;
    if (value <= 0) return;
    records.push({ userId, direction, value, proto });
  }

  try {
    const data = JSON.parse(stdout);
    if (!data.stat || !Array.isArray(data.stat)) return [];
    const records = [];
    for (const stat of data.stat) {
      pushRecordByName(records, stat?.name || '', stat?.value || 0);
    }
    return records;
  } catch {
    // 兼容部分 Xray 版本：statsquery 输出 protobuf 文本而不是 JSON
    // 示例：name: "user>>>u-1-v@p>>>traffic>>>uplink" value: 123
    const records = [];
    const re = /name:\s*"([^"]+)"\s*value:\s*(\d+)/g;
    let m;
    while ((m = re.exec(stdout)) !== null) {
      pushRecordByName(records, m[1], m[2]);
    }
    return records;
  }
}

// ─── 定时上报 ───
async function report() {
  try {
    const cpuUsage = getCpuUsage();
    const netBandwidth = getNetworkBandwidth();
    const [xrayActive, traffic, hy2Active, hy2Traffic, cnReachable, ipv6Reachable, disk] = await Promise.all([
      getXrayStatus(),
      getXrayTraffic(),
      getHysteriaStatus(),
      getHysteriaTraffic(),
      checkChinaReachable(),
      checkIPv6Reachable(),
      getDiskUsage(),
    ]);
    const sys = getSystemInfo();
    const allTraffic = [...traffic, ...hy2Traffic];
    sendMsg({
      type: 'report',
      ts: Date.now(),
      version: AGENT_VERSION,
      capabilities: AGENT_CAPABILITIES,
      reconnectMetrics,
      xrayAlive: xrayActive,
      hysteriaAlive: hy2Active,
      trafficRecords: allTraffic,
      cnReachable,
      ipv6Reachable,
      loadAvg: sys.loadavg,
      memUsage: sys.memory,
      diskUsage: disk,
      cpuUsage,
      netBandwidth,
      uptime: sys.uptime,
    });
  } catch (e) {
    log('上报', `失败: ${e.message}`);
  }
}

// ─── 自愈：xray/hysteria 挂了自动重启 ───
async function selfHeal() {
  const active = await getXrayStatus();
  if (!active) {
    log('自愈', 'xray 未运行，尝试重启...');
    const { ok, stderr } = await run(serviceCommand('xray','restart'));
    log('自愈', ok ? 'xray 重启成功' : `xray 重启失败: ${stderr}`);
  }
  // Hysteria 自愈：仅当 config 存在时才检测
  try {
    if (fs.existsSync('/etc/hysteria/config.yaml')) {
      const hy2Active = await getHysteriaStatus();
      if (!hy2Active) {
        log('自愈', 'hysteria-server 未运行，尝试重启...');
        const { ok, stderr } = await run(serviceCommand('hysteria-server','restart'));
        log('自愈', ok ? 'hysteria-server 重启成功' : `hysteria-server 重启失败: ${stderr}`);
      }
    }
  } catch (e) {
    log('自愈', `hysteria 检测异常: ${e.message}`);
  }
}

// ─── 指令处理 ───
async function handleCommand(msg) {
  const { type, id } = msg;
  const reply = (data) => sendMsg({ type: 'cmd_result', id, cmdType: type, ...data });

  switch (type) {
    case 'ping':
      sendMsg({ type: 'pong', ts: Date.now() });
      break;

    case 'restart_xray': {
      const { ok, stderr } = await run(serviceCommand('xray','restart'));
      reply({ success: ok, error: ok ? undefined : stderr });
      break;
    }

    case 'restart_hysteria': {
      const { ok, stderr } = await run(serviceCommand('hysteria-server','restart'));
      reply({ success: ok, error: ok ? undefined : stderr });
      break;
    }

    case 'update_hy2_config': {
      try {
        if (!msg.config) throw new Error('缺少 config 字段');
        const configStr = typeof msg.config === 'string' ? msg.config : String(msg.config);
        if (!configStr.includes('listen:')) {
          throw new Error('config 不像有效的 hysteria 配置');
        }
        // 备份当前配置
        const hy2ConfigPath = '/etc/hysteria/config.yaml';
        try {
          if (fs.existsSync(hy2ConfigPath)) {
            fs.copyFileSync(hy2ConfigPath, hy2ConfigPath + '.bak');
          }
        } catch (backupErr) {
          log('WARN', `备份 hy2 配置失败: ${backupErr.message}`);
        }
        fs.mkdirSync('/etc/hysteria', { recursive: true });
        fs.writeFileSync(hy2ConfigPath, configStr, 'utf8');
        const { ok, stderr } = await run(serviceCommand('hysteria-server','restart'));
        reply({ success: ok, error: ok ? undefined : stderr });
      } catch (e) {
        reply({ success: false, error: e.message });
      }
      break;
    }

    case 'update_config': {
      try {
        if (!msg.config) throw new Error('缺少 config 字段');
        // 解析并验证 JSON 结构
        const parsed = typeof msg.config === 'string' ? JSON.parse(msg.config) : msg.config;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('config 必须是 JSON 对象');
        }
        // 基本结构校验：xray 配置至少需要 inbounds 或 outbounds
        if (!parsed.inbounds && !parsed.outbounds) {
          throw new Error('config 缺少 inbounds/outbounds，不像有效的 xray 配置');
        }
        const configStr = JSON.stringify(parsed, null, 2);
        // 先备份当前配置
        try {
          if (fs.existsSync(XRAY_CONFIG_PATH)) {
            fs.copyFileSync(XRAY_CONFIG_PATH, XRAY_CONFIG_PATH + '.bak');
          }
        } catch (backupErr) {
          log('WARN', `备份当前配置失败: ${backupErr.message}`);
        }
        fs.writeFileSync(XRAY_CONFIG_PATH, configStr, 'utf8');
        const { ok, stderr } = await run(serviceCommand('xray','restart'));
        reply({ success: ok, error: ok ? undefined : stderr });
      } catch (e) {
        reply({ success: false, error: e.message });
      }
      break;
    }

    case 'exec': {
      if (!msg.command) { reply({ success: false, error: '缺少 command 字段' }); break; }
      const cmd = msg.command.trim();

      // 基础防护：拒绝危险 shell 元字符（防止管道、命令拼接、命令替换）
      if (DANGEROUS_SHELL_PATTERN.test(cmd)) {
        log('WARN', `exec 指令含危险字符，已拒绝: ${cmd}`);
        reply({ success: false, error: '指令包含危险字符（|;&`<>,$(),换行）' });
        break;
      }

      // 白名单校验（精确匹配 + 受控前缀匹配）
      if (EXEC_WHITELIST_ENABLED) {
        const exactMatch = EXEC_WHITELIST_EXACT.has(cmd);
        const prefixMatch = !exactMatch && EXEC_WHITELIST_PREFIX.some(prefix => cmd.startsWith(prefix));
        if (!exactMatch && !prefixMatch) {
          log('WARN', `exec 指令被白名单拒绝: ${cmd}`);
          reply({ success: false, error: `指令不在白名单中: ${cmd.slice(0, 80)}` });
          break;
        }
      }

      // curl/wget 仅允许下载面板域名，避免执行任意远程脚本
      if (cmd.startsWith('curl ') || cmd.startsWith('wget ')) {
        const urls = extractCommandUrls(cmd);
        if (urls.length > 0) {
          const forbidden = urls.find((u) => {
            try {
              const h = new URL(u).hostname.toLowerCase();
              return !SAFE_DOWNLOAD_HOSTS.has(h);
            } catch {
              return true;
            }
          });
          if (forbidden) {
            log('WARN', `exec 下载域名不在白名单，已拒绝: ${forbidden}`);
            reply({ success: false, error: `下载域名不在白名单: ${forbidden}` });
            break;
          }
        }
      }

      const timeout = Math.min(msg.timeout || 30000, 120000);
      const result = await run(cmd, timeout);
      reply({ success: result.ok, stdout: result.stdout, stderr: result.stderr, code: result.code });
      break;
    }

    case 'self_update': {
      try {
        // 安全修复：不再接受外部 URL，仅从面板服务器下载
        const baseUrl = config.server.replace(/\/ws\/agent$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        const updateUrl = `${baseUrl}/api/agent/download`;
        log('更新', `从 ${updateUrl} 下载新版 agent...`);
        const code = await httpGet(updateUrl);
        // SHA-256 完整性校验：如果面板下发了 sha256 字段，则验证下载内容
        if (msg.sha256) {
          const actualHash = crypto.createHash('sha256').update(code).digest('hex');
          if (actualHash !== msg.sha256) {
            throw new Error(`SHA-256 校验失败: 期望=${msg.sha256.slice(0, 16)}... 实际=${actualHash.slice(0, 16)}...`);
          }
          log('更新', 'SHA-256 校验通过');
        } else {
          log('WARN', '面板未提供 sha256，跳过完整性校验');
        }
        const tmpPath = AGENT_PATH + '.tmp';
        fs.writeFileSync(tmpPath, code, 'utf8');
        fs.renameSync(tmpPath, AGENT_PATH);
        fs.chmodSync(AGENT_PATH, 0o755);
        reply({ success: true, message: '更新完成，即将重启' });
        // 延迟退出，让 systemd 自动重启
        setTimeout(() => process.exit(0), 500);
      } catch (e) {
        reply({ success: false, error: e.message });
      }
      break;
    }

    default:
      log('指令', `未知指令: ${type}`);
      reply({ success: false, error: `未知指令: ${type}` });
  }
}

// ─── HTTP GET（用于 self_update） ───
function httpGet(urlStr, _redirectCount = 0) {
  if (_redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: { Authorization: `Bearer ${config.token}` }, timeout: 30000, rejectUnauthorized: !INSECURE_TLS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, _redirectCount + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
  });
}

// ─── WebSocket 连接 ───
function connect() {
  const wsUrl = config.server;
  log('WS', `连接 ${config.server} ...`);

  ws = createRawWs(wsUrl);
  if (!ws) {
    log('WS', '无法创建 WebSocket 连接');
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    log('WS', '已连接，发送认证...');
    reconnectDelay = 1000;
    lastActivity = Date.now();
    if (reconnectMetrics.consecutiveReconnects > 0) {
      reconnectMetrics.lastReconnectAt = new Date().toISOString();
      reconnectMetrics.consecutiveReconnects = 0;
    }
    // 发送认证消息
    sendMsg({ type: 'auth', token: config.token, nodeId: config.nodeId, version: AGENT_VERSION, capabilities: AGENT_CAPABILITIES });
    // 立即上报一次
    setTimeout(report, 1000);
    // 心跳
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws?.readyState === 1) {
        if (typeof ws.ping === 'function') ws.ping();
        else sendMsg({ type: 'heartbeat' });
      }
    }, HEARTBEAT_INTERVAL);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      if (msg.type === 'auth_ok') {
        log('WS', '认证成功');
        return;
      }
      handleCommand(msg).catch(e => log('指令', `处理异常: ${e.message}`));
    } catch (e) {
      log('WS', `消息解析失败: ${e.message}`);
    }
  });

  ws.on('close', (code, reason) => {
    log('WS', `断开 code=${code} reason=${reason || ''}`);
    reconnectMetrics.disconnectCount += 1;
    reconnectMetrics.consecutiveReconnects += 1;
    reconnectMetrics.lastDisconnectAt = new Date().toISOString();
    cleanup();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log('WS', `错误: ${err.message}`);
  });
}

// 手动实现简易 WebSocket（用于没有内置 WebSocket 的 Node 版本）
function createRawWs(urlStr) {
  const EventEmitter = require('events');
  const url = new URL(urlStr);
  const isSecure = url.protocol === 'wss:';
  const mod = isSecure ? require('tls') : net;
  const port = url.port || (isSecure ? 443 : 80);
  const key = crypto.randomBytes(16).toString('base64');
  const pathStr = url.pathname + url.search;

  const emitter = new EventEmitter();
  emitter.readyState = 0; // CONNECTING

  const socket = mod.connect({ host: url.hostname, port, servername: url.hostname, rejectUnauthorized: !INSECURE_TLS }, () => {
    const headers = [
      `GET ${pathStr} HTTP/1.1`,
      `Host: ${url.hostname}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: 13`,
      '', ''
    ].join('\r\n');
    socket.write(headers);
  });

  let upgraded = false;
  let buffer = Buffer.alloc(0);
  let fragmented = null; // { opcode, chunks: Buffer[] }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (!upgraded) {
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const headerStr = buffer.slice(0, idx).toString();
      if (!headerStr.includes('101')) {
        emitter.readyState = 3;
        emitter.emit('error', new Error('WebSocket 握手失败'));
        socket.destroy();
        return;
      }
      upgraded = true;
      emitter.readyState = 1;
      buffer = buffer.slice(idx + 4);
      emitter.emit('open');
    }

    // 解析 WebSocket 帧
    while (buffer.length >= 2) {
      const frame = parseWsFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.totalLen);

      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (frame.fin) {
          emitter.emit('message', frame.payload);
        } else {
          fragmented = { opcode: frame.opcode, chunks: [frame.payload] };
        }
      } else if (frame.opcode === 0x0) {
        if (!fragmented) continue;
        fragmented.chunks.push(frame.payload);
        if (frame.fin) {
          emitter.emit('message', Buffer.concat(fragmented.chunks));
          fragmented = null;
        }
      } else if (frame.opcode === 0x8) {
        emitter.readyState = 3;
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
        emitter.emit('close', code, '');
        socket.destroy();
        return;
      } else if (frame.opcode === 0x9) {
        // PING → PONG
        sendWsFrame(socket, 0xA, frame.payload);
      }
    }
  });

  socket.on('error', (err) => {
    emitter.emit('error', err);
    // 不在这里设 readyState=3，留给 close 事件处理
    // socket error 后一定会触发 close
  });

  socket.on('close', () => {
    if (emitter.readyState !== 3) {
      emitter.readyState = 3;
      emitter.emit('close', 1006, '');
    }
  });

  // 兜底：如果 socket 被销毁但没触发 close（极端情况）
  socket.on('end', () => {
    if (emitter.readyState !== 3) {
      emitter.readyState = 3;
      emitter.emit('close', 1006, '');
    }
  });

  emitter.send = (data) => {
    if (emitter.readyState !== 1) return;
    const buf = Buffer.from(data, 'utf8');
    sendWsFrame(socket, 0x1, buf);
  };

  emitter.ping = () => {
    if (emitter.readyState !== 1) return;
    sendWsFrame(socket, 0x9, Buffer.alloc(0));
  };

  emitter.close = () => {
    if (emitter.readyState === 1) {
      sendWsFrame(socket, 0x8, Buffer.alloc(0));
    }
    socket.destroy();
    emitter.readyState = 3;
  };

  return emitter;
}

function parseWsFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0F;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7F;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) offset += 4;
  if (buf.length < offset + payloadLen) return null;

  let payload = Buffer.from(buf.slice(offset, offset + payloadLen));
  if (masked) {
    const mask = buf.slice(offset - 4, offset);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }

  return { fin, opcode, payload, totalLen: offset + payloadLen };
}

function sendWsFrame(socket, opcode, payload) {
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 10);
  }

  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];

  try { socket.write(Buffer.concat([header, masked])); } catch {}
}

function cleanup() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  ws = null;
}

function scheduleReconnect() {
  const delay = reconnectDelay + Math.random() * 1000;
  log('WS', `${(delay / 1000).toFixed(1)}s 后重连`);
  setTimeout(connect, delay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
}

// Watchdog: 如果长时间没有活跃连接，强制重连
let lastActivity = Date.now();
function watchdog() {
  if (ws?.readyState === 1) {
    lastActivity = Date.now();
    return;
  }
  const elapsed = Date.now() - lastActivity;
  if (elapsed > 120_000) {
    log('Watchdog', `${(elapsed / 1000).toFixed(0)}s 无活跃连接，强制重连`);
    lastActivity = Date.now();
    try { ws?.close?.(); } catch {}
    cleanup();
    reconnectDelay = 1000;
    connect();
  }
}

// ─── 启动 ───
function start() {
  log('启动', `nodeId=${config.nodeId} server=${config.server}`);
  connect();

  reportTimer = setInterval(report, REPORT_INTERVAL);
  selfHealTimer = setInterval(selfHeal, SELF_HEAL_INTERVAL);
  setInterval(watchdog, 30_000);

  // 优雅退出
  const shutdown = (sig) => {
    log('退出', `收到 ${sig}`);
    clearInterval(reportTimer);
    clearInterval(selfHealTimer);
    clearInterval(heartbeatTimer);
    ws?.close?.();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 未捕获异常不崩溃
  process.on('uncaughtException', (e) => log('异常', e.stack || e.message));
  process.on('unhandledRejection', (e) => log('异常', `Promise: ${e?.stack || e}`));
}

start();
