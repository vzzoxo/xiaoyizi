const {restartService}=require('../utils/serviceCommands');
const { NodeSSH } = require('node-ssh');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { randomPort } = require('../utils/vless');
const { BEAUTIFUL_NAMES } = require('../utils/names');
const { getRegionEmoji, getCityCN } = require('../utils/regions');
const { isPrivateOrLoopback } = require('../utils/clientIp');
const { notify } = require('./notify');
const logger = require('./logger');

function getRegionEmojiFromGeo(city, country) {
  return getRegionEmoji(`${city || ''} ${country || ''}`);
}

// AWS 区域代码 → 城市/国家
const AWS_REGION_TO_GEO = {
  'us-east-1':      { city: 'Ashburn',       country: 'United States' },
  'us-east-2':      { city: 'Columbus',      country: 'United States' },
  'us-west-1':      { city: 'San Jose',      country: 'United States' },
  'us-west-2':      { city: 'Portland',      country: 'United States' },
  'ca-central-1':   { city: 'Toronto',       country: 'Canada' },
  'ca-west-1':      { city: 'Calgary',       country: 'Canada' },
  'mx-central-1':   { city: 'Mexico City',   country: 'Mexico' },
  'sa-east-1':      { city: 'São Paulo',     country: 'Brazil' },
  'eu-west-1':      { city: 'Dublin',        country: 'Ireland' },
  'eu-west-2':      { city: 'London',        country: 'United Kingdom' },
  'eu-west-3':      { city: 'Paris',         country: 'France' },
  'eu-central-1':   { city: 'Frankfurt',     country: 'Germany' },
  'eu-central-2':   { city: 'Zurich',        country: 'Switzerland' },
  'eu-north-1':     { city: 'Stockholm',     country: 'Sweden' },
  'eu-south-1':     { city: 'Milan',         country: 'Italy' },
  'eu-south-2':     { city: 'Spain',         country: 'Spain' },
  'ap-east-1':      { city: 'Hong Kong',     country: 'Hong Kong' },
  'ap-east-2':      { city: 'Taipei',        country: 'Taiwan' },
  'ap-northeast-1': { city: 'Tokyo',         country: 'Japan' },
  'ap-northeast-2': { city: 'Seoul',         country: 'Korea' },
  'ap-northeast-3': { city: 'Osaka',         country: 'Japan' },
  'ap-southeast-1': { city: 'Singapore',     country: 'Singapore' },
  'ap-southeast-2': { city: 'Sydney',        country: 'Australia' },
  'ap-southeast-3': { city: 'Jakarta',       country: 'Indonesia' },
  'ap-southeast-4': { city: 'Melbourne',     country: 'Australia' },
  'ap-southeast-5': { city: 'Kuala Lumpur',  country: 'Malaysia' },
  'ap-southeast-7': { city: 'Bangkok',       country: 'Thailand' },
  'ap-south-1':     { city: 'Mumbai',        country: 'India' },
  'ap-south-2':     { city: 'Hyderabad',     country: 'India' },
  'me-south-1':     { city: 'Bahrain',       country: 'Bahrain' },
  'me-central-1':   { city: 'Dubai',         country: 'United Arab Emirates' },
  'il-central-1':   { city: 'Tel Aviv',      country: 'Israel' },
  'af-south-1':     { city: 'Cape Town',     country: 'South Africa' },
};

// 通过 AWS EC2 反向 DNS 推断区域，例如：
// ec2-43-216-223-117.ap-southeast-5.compute.amazonaws.com → ap-southeast-5
async function detectRegionByAwsPtr(ip) {
  try {
    const hostnames = await Promise.race([
      dns.reverse(ip),
      new Promise((_, reject) => setTimeout(() => reject(new Error('PTR timeout')), 3000)),
    ]);
    for (const h of hostnames) {
      const m = h.match(/\.([a-z]{2}-[a-z]+-\d)\.compute\.amazonaws\.com$/);
      if (m && AWS_REGION_TO_GEO[m[1]]) {
        const geo = AWS_REGION_TO_GEO[m[1]];
        return {
          city: geo.city, region: geo.city, country: geo.country,
          cityCN: getCityCN(geo.city),
          emoji: getRegionEmojiFromGeo(geo.city, geo.country),
        };
      }
    }
  } catch (_) { /* 没有 PTR 或不是 AWS */ }
  return null;
}

async function detectRegion(ip) {
  // 防 SSRF：拒绝内网/回环/链路本地 IP（包括云元数据服务 169.254.169.254）
  // 这些地址不应该出现在 detectRegion 的合法输入中（公网节点 IP），
  // 防止恶意输入诱导服务端探测内网或元数据服务。
  if (!ip || typeof ip !== 'string') {
    return { city: 'Unknown', region: '', country: '', cityCN: '未知', emoji: '🌐' };
  }
  try {
    if (isPrivateOrLoopback(ip)) {
      logger.warn({ ip }, '地区检测拒绝：私有/内网/链路本地 IP');
      return { city: 'Unknown', region: '', country: '', cityCN: '未知', emoji: '🌐' };
    }
  } catch (_) { /* 解析失败也视为非法 */ }

  // 优先：AWS PTR 识别（无外网依赖、最准、最快）
  const awsGeo = await detectRegionByAwsPtr(ip);
  if (awsGeo) return awsGeo;

  // 回退：ip-api.com（免费版，加超时避免拖慢部署）
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city&lang=en`, { signal: ctrl.signal });
      const data = await res.json();
      if (data.status === 'success') {
        return {
          city: data.city, region: data.regionName, country: data.country,
          cityCN: getCityCN(data.city),
          emoji: getRegionEmojiFromGeo(data.city, data.country)
        };
      }
    } finally { clearTimeout(timer); }
  } catch (e) {
    logger.warn({ err: e.message, ip }, '地区检测 ip-api 失败，尝试 ipinfo');
  }

  // 二次回退：ipinfo.io（HTTPS，独立 IP，规避 ip-api 的 IP 被屏蔽问题）
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`https://ipinfo.io/${ip}/json`, { signal: ctrl.signal });
      const data = await res.json();
      if (data && data.city) {
        return {
          city: data.city, region: data.region || '', country: data.country || '',
          cityCN: getCityCN(data.city),
          emoji: getRegionEmojiFromGeo(data.city, data.country),
        };
      }
    } finally { clearTimeout(timer); }
  } catch (e) {
    logger.warn({ err: e.message, ip }, '地区检测 ipinfo 失败');
  }

  return { city: 'Unknown', region: '', country: '', cityCN: '未知', emoji: '🌐' };
}

function generateNodeName(geo, existingNodes, hasSocks5 = false) {
  const city = geo.cityCN;
  // 命名规则：普通=小国旗；家宽落地=小国旗+小房子
  const prefix = hasSocks5 ? `${geo.emoji}🏠` : geo.emoji;
  const existingNameSet = new Set(existingNodes.map(n => String(n?.name || '').trim()).filter(Boolean));
  const available = BEAUTIFUL_NAMES.filter(word => !existingNameSet.has(`${prefix} ${city}-${word}`));
  if (available.length > 0) {
    const name = available[Math.floor(Math.random() * available.length)];
    return `${prefix} ${city}-${name}`;
  }

  const fallbackBase = `${prefix} ${city}-${BEAUTIFUL_NAMES[Math.floor(Math.random() * BEAUTIFUL_NAMES.length)]}`;
  let seq = 2;
  while (existingNameSet.has(`${fallbackBase} (${seq})`)) seq += 1;
  return `${fallbackBase} (${seq})`;
}

function isUniqueNodeNameError(err) {
  return String(err?.message || '').includes('UNIQUE constraint failed: nodes.name');
}

function insertNodeWithGeneratedName(db, buildNodeData, geo, hasSocks5 = false) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = generateNodeName(geo, db.getAllNodes(), hasSocks5);
    try {
      const result = db.addNode(buildNodeData(name));
      return { name, result };
    } catch (err) {
      if (!isUniqueNodeNameError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('节点名称生成失败');
}

function insertDualNodesWithGeneratedName(db, buildVlessData, buildSsData, geo, hasSocks5 = false) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const vlessName = generateNodeName(geo, db.getAllNodes(), hasSocks5);
    const ssName = `${vlessName}⁶`;
    try {
      const trx = db.getDb().transaction(() => {
        const vlessResult = db.addNode(buildVlessData(vlessName));
        const ssResult = db.addNode(buildSsData(ssName));
        return { vlessResult, ssResult };
      });
      return { vlessName, ssName, ...trx() };
    } catch (err) {
      if (!isUniqueNodeNameError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('双协议节点名称生成失败');
}

// 统一生成 xray client email（仅用于识别/统计，避免暴露真实信息）
function makeEmail(userId, protocol = '') {
  const safe = String(userId ?? '0').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || '0';
  // 协议后缀用于 Agent 统计按协议拆分：
  // vless -> u-<id>-v@p, ss -> u-<id>-s@p, hy2 -> u-<id>-h@p
  const suffixMap = { vless: '-v', ss: '-s', hy2: '-h' };
  const suffix = suffixMap[protocol] || '';
  return `u-${safe}${suffix}@p`;
}

function formatInstallError(installResult) {
  const code = installResult?.code;
  const stdout = String(installResult?.stdout || '');
  const stderr = String(installResult?.stderr || '');
  const merged = `${stderr}\n${stdout}`.trim().replace(/\s+/g, ' ');
  const detail = merged ? merged.slice(-400) : 'no output';
  return `xray 安装失败(code=${code ?? 'unknown'}): ${detail}`;
}

function assertInstallOk(installResult) {
  const stdout = String(installResult?.stdout || '');
  if (installResult?.code !== 0 || !stdout.includes('INSTALL_OK')) {
    throw new Error(formatInstallError(installResult));
  }
}

function buildOutboundsBySocks(socks5Host, socks5Port, socks5User, socks5Pass) {
  if (socks5Host) {
    const socks5Server = { address: socks5Host, port: parseInt(socks5Port, 10) || 1080 };
    if (socks5User) socks5Server.users = [{ user: socks5User, pass: socks5Pass || '' }];
    return [
      { protocol: 'socks', tag: 'socks5-out', settings: { servers: [socks5Server] } },
      { protocol: 'freedom', tag: 'direct' }
    ];
  }
  return [
    { protocol: 'freedom', tag: 'direct' },
    { protocol: 'blackhole', tag: 'block' }
  ];
}

// ========== 生成 xray 多用户配置 ==========

// 生成完整 xray 配置（多用户 + stats + API + Reality）
function buildXrayConfig(port, clients, outbounds, realityOpts) {
  const streamSettings = { network: 'tcp', security: realityOpts ? 'reality' : 'none' };
  if (realityOpts) {
    // Reality 模式下 clients 需要 flow
    clients = clients.map(c => ({ ...c, flow: 'xtls-rprx-vision' }));
    streamSettings.realitySettings = {
      show: false,
      dest: `${realityOpts.sni}:443`,
      xver: 0,
      serverNames: [realityOpts.sni],
      privateKey: realityOpts.privateKey,
      shortIds: [realityOpts.shortId]
    };
  }
  return {
    log: { loglevel: 'warning' },
    stats: {},
    api: { tag: 'api', services: ['StatsService'] },
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true }
    },
    inbounds: [
      {
        port,
        protocol: 'vless',
        tag: 'vless-in',
        settings: { clients, decryption: 'none' },
        streamSettings
      },
      {
        listen: '127.0.0.1', port: 10085,
        protocol: 'dokodemo-door', tag: 'api-in',
        settings: { address: '127.0.0.1' }
      }
    ],
    outbounds,
    routing: {
      rules: [
        { type: 'field', inboundTag: ['api-in'], outboundTag: 'api' },
        ...(outbounds[0]?.tag === 'socks5-out'
          ? [{ type: 'field', outboundTag: 'socks5-out', network: 'tcp,udp' }]
          : [])
      ]
    }
  };
}

// ========== SFTP 安全写文件 ==========

// 通过 SFTP 写文件，避免 heredoc 注入风险
async function sftpWriteFile(ssh, remotePath, content) {
  const sftp = await ssh.requestSFTP();
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath, { mode: 0o644 });
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.end(Buffer.from(content, 'utf8'));
  });
}

// ========== SSH 推送配置 ==========

// 将配置推送到节点并重启 xray（优先通过 Agent，SSH 后备）
async function pushConfigToNode(node, config) {
  const configJson = typeof config === 'string' ? config : JSON.stringify(config, null, 2);

  // 优先通过 Agent 推送
  const agentWs = require('./agent-ws'); // 延迟加载避免循环依赖
  if (agentWs.isAgentOnline(node.id)) {
    try {
      const result = await agentWs.sendCommand(node.id, {
        type: 'update_config',
        config: config,
      });
      if (result.success) {
        return true;
      }
      logger.warn({ nodeId: node.id, nodeName: node.name, error: result.error }, '推送配置 Agent 失败，回退 SSH');
    } catch (e) {
      logger.warn({ err: e, nodeId: node.id, nodeName: node.name }, '推送配置 Agent 异常，回退 SSH');
    }
  }

  // SSH 后备
  const ssh = new NodeSSH();
  try {
    const connectOpts = buildSshConnectOpts(node);

    await ssh.connect(connectOpts);

    const configPath = node.xray_config_path || '/usr/local/etc/xray/config.json';

    await sftpWriteFile(ssh, configPath, configJson);
    const result = await ssh.execCommand(restartService('xray'));

    const ok = result.stdout.trim() === 'OK';
    return ok;
  } catch (err) {
    logger.error({ err, nodeId: node.id, nodeName: node.name }, '推送配置 SSH 失败');
    return false;
  } finally {
    ssh.dispose();
  }
}

// 将 Hy2 配置推送到节点并重启 hysteria（优先通过 Agent，SSH 后备）
async function pushHy2ConfigToNode(node, configYaml) {
  // 优先通过 Agent 推送
  const agentWs = require('./agent-ws');
  if (agentWs.isAgentOnline(node.id)) {
    try {
      const result = await agentWs.sendCommand(node.id, {
        type: 'update_hy2_config',
        config: configYaml,
      });
      if (result.success) {
        return true;
      }
      logger.warn({ nodeId: node.id, nodeName: node.name, error: result.error }, '推送Hy2配置 Agent 失败，回退 SSH');
    } catch (e) {
      logger.warn({ err: e, nodeId: node.id, nodeName: node.name }, '推送Hy2配置 Agent 异常，回退 SSH');
    }
  }

  // SSH 后备
  const ssh = new NodeSSH();
  try {
    const connectOpts = buildSshConnectOpts(node);

    await ssh.connect(connectOpts);
    await sftpWriteFile(ssh, '/etc/hysteria/config.yaml', configYaml);
    const result = await ssh.execCommand(restartService('hysteria-server'));
    return result.stdout.trim() === 'OK';
  } catch (err) {
    logger.error({ err, nodeId: node.id, nodeName: node.name }, '推送Hy2配置 SSH 失败');
    return false;
  } finally {
    ssh.dispose();
  }
}

// 同步某个节点的配置（用于新用户注册、轮换等场景）
async function syncNodeConfig(node, db) {
  const userUuids = db.getNodeAllUserUuids(node.id);

  // Hy2 节点：使用 Hysteria 2 配置
  if (node.protocol === 'hy2') {
    let statsSecret = node.hy2_stats_secret;
    if (!statsSecret) {
      statsSecret = crypto.randomBytes(16).toString('hex');
      db.updateNode(node.id, { hy2_stats_secret: statsSecret });
    }
    const users = userUuids.map(u => ({
      password: u.uuid, email: makeEmail(u.user_id, 'hy2')
    }));
    const config = buildHy2Config(node.hy2_port || node.port, users, {
      statsSecret,
      obfs: node.hy2_obfs || null,
      socks5Host: node.socks5_host || null,
      socks5Port: node.socks5_port || 1080,
      socks5User: node.socks5_user || null,
      socks5Pass: node.socks5_pass || null,
    });
    return await pushHy2ConfigToNode(node, config);
  }

  // SS 节点：使用 SS 多用户配置
  if (node.protocol === 'ss') {
    const clients = userUuids.map(u => ({
      password: u.uuid, email: makeEmail(u.user_id, 'ss')
    }));
    const ssOutbounds = buildOutboundsBySocks(node.socks5_host, node.socks5_port, node.socks5_user, node.socks5_pass);
    const config = buildSsXrayConfig(node.port, clients, node.ss_method || 'aes-256-gcm', ssOutbounds);

    // 如果有同机 VLESS 伙伴节点，生成双协议配置
    const peerNode = findPeerNode(node, db);
    if (peerNode) {
      const vlessUuids = db.getNodeAllUserUuids(peerNode.id);
      if (vlessUuids.length > 0) {
        const vlessClients = vlessUuids.map(u => ({
          id: u.uuid, level: 0, email: makeEmail(u.user_id, 'vless')
        }));
        const outbounds = buildOutboundsBySocks(peerNode.socks5_host, peerNode.socks5_port, peerNode.socks5_user, peerNode.socks5_pass);
        const realityOpts = peerNode.reality_private_key ? { privateKey: peerNode.reality_private_key, sni: peerNode.sni || 'www.microsoft.com', shortId: peerNode.reality_short_id } : null;
        const dualConfig = buildDualXrayConfig(peerNode.port, node.port, vlessClients, clients, node.ss_method || 'aes-256-gcm', outbounds, realityOpts);
        return await pushConfigToNode(node, dualConfig);
      }
    }
    return await pushConfigToNode(node, config);
  }

  // VLESS 节点
  const clients = userUuids.map(u => ({
    id: u.uuid, level: 0, email: makeEmail(u.user_id, 'vless')
  }));

  let outbounds = buildOutboundsBySocks(node.socks5_host, node.socks5_port, node.socks5_user, node.socks5_pass);

  const realityOpts = node.reality_private_key ? { privateKey: node.reality_private_key, sni: node.sni || 'www.microsoft.com', shortId: node.reality_short_id } : null;

  // 如果有同机 SS 伙伴节点，生成双协议配置
  const peerNode = findPeerNode(node, db);
  if (peerNode) {
    const ssUuids = db.getNodeAllUserUuids(peerNode.id);
    if (ssUuids.length > 0) {
      const ssClients = ssUuids.map(u => ({
        password: u.uuid, email: makeEmail(u.user_id, 'ss')
      }));
      const dualConfig = buildDualXrayConfig(node.port, peerNode.port, clients, ssClients, peerNode.ss_method || 'aes-256-gcm', outbounds, realityOpts);
      return await pushConfigToNode(node, dualConfig);
    }
  }

  const config = buildXrayConfig(node.port, clients, outbounds, realityOpts);
  return await pushConfigToNode(node, config);
}

// 查找同机伙伴节点（仅 VLESS↔SS 双协议配对，hy2 独立运行不参与）
function findPeerNode(node, db) {
  if (node.protocol === 'hy2') return null; // hy2 不参与双协议配对
  const sshHost = node.ssh_host || node.host;
  const allNodes = db.getAllNodes(true);
  const targetProtocol = node.protocol === 'vless' ? 'ss' : 'vless';
  return allNodes.find(n =>
    n.id !== node.id &&
    (n.ssh_host || n.host) === sshHost &&
    n.protocol === targetProtocol
  ) || null;
}

// 同步所有活跃节点的配置
// 去抖版本：短时间多次调用只执行最后一次
let _syncDebounceTimer = null;
let _syncDebounceResolvers = [];

function syncAllNodesConfigDebounced(db) {
  return new Promise((resolve, reject) => {
    _syncDebounceResolvers.push({ resolve, reject });
    if (_syncDebounceTimer) clearTimeout(_syncDebounceTimer);
    _syncDebounceTimer = setTimeout(async () => {
      _syncDebounceTimer = null;
      const resolvers = _syncDebounceResolvers;
      _syncDebounceResolvers = [];
      try {
        const result = await _syncAllNodesConfigImpl(db);
        resolvers.forEach(r => r.resolve(result));
      } catch (err) {
        resolvers.forEach(r => r.reject(err));
      }
    }, 3000);
  });
}

async function _syncAllNodesConfigImpl(db) {
  const nodes = db.getAllNodes(true);
  let success = 0, failed = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < nodes.length; i += CONCURRENCY) {
    const batch = nodes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(n => syncNodeConfig(n, db).catch(() => false)));
    for (const ok of results) { if (ok) success++; else failed++; }
  }
  logger.info({ success, failed }, '配置同步完成');
  if (failed > 0) {
    const db2 = require('./database'); // 延迟加载避免循环依赖
    db2.addAuditLog(null, 'config_sync', `配置同步完成 成功:${success} 失败:${failed}`, 'system');
  }
  return { success, failed };
}

// ========== 启用 BBR ==========

async function enableBBR(ssh) {
  await ssh.execCommand(
    'grep -q "net.core.default_qdisc" /etc/sysctl.conf || echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf; ' +
    'grep -q "net.ipv4.tcp_congestion_control" /etc/sysctl.conf || echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf; ' +
    'sysctl -p'
  );
}

// ========== 公共部署框架 ==========

async function resolveDeployGeo(sshInfo) {
  const geo = await detectRegion(sshInfo.host);
  let displayGeo = geo;
  let isHomeNetwork = false;
  if (sshInfo.socks5_host) {
    isHomeNetwork = true;
    const socks5Geo = await detectRegion(sshInfo.socks5_host);
    if (socks5Geo.city && socks5Geo.city !== 'Unknown' && socks5Geo.cityCN !== '未知') {
      displayGeo = socks5Geo;
    }
  }
  return { displayGeo, isHomeNetwork };
}

function buildSshConnectOpts(sshInfo) {
  // 兼容两种调用形态：
  // 1) sshInfo 来自 node 表（含 ssh_host 字段，需 fallback 到 host）
  // 2) sshInfo 来自部署请求（host 字段直接是 SSH 地址）
  const opts = {
    host: sshInfo.ssh_host || sshInfo.host,
    port: sshInfo.ssh_port || 22,
    username: sshInfo.ssh_user || 'root',
  };
  if (process.env.WORKERS_RUNTIME) opts.algorithms = {cipher:['aes128-gcm@openssh.com','aes256-gcm@openssh.com','aes128-ctr','aes256-ctr']};
  if (sshInfo.ssh_key_path) opts.privateKeyPath = sshInfo.ssh_key_path;
  else if (sshInfo.ssh_password) opts.password = sshInfo.ssh_password;
  return opts;
}

// ========== 部署函数 ==========

async function deployNode(sshInfo, db) {
  const uuid = uuidv4();
  const port = randomPort();

  const { displayGeo, isHomeNetwork } = await resolveDeployGeo(sshInfo);

  const region = `${displayGeo.emoji} ${displayGeo.cityCN}`;
  const { name, result } = insertNodeWithGeneratedName(db, (generatedName) => ({
    name: generatedName, host: sshInfo.host, port, uuid,
    ulzix_order_id: sshInfo.ulzix_order_id || null,
    ssh_host: sshInfo.host,
    ssh_port: sshInfo.ssh_port || 22,
    ssh_user: sshInfo.ssh_user || 'root',
    ssh_password: sshInfo.ssh_password,
    ssh_key_path: sshInfo.ssh_key_path,
    socks5_host: sshInfo.socks5_host || null,
    socks5_port: parseInt(sshInfo.socks5_port, 10) || 1080,
    socks5_user: sshInfo.socks5_user || null,
    socks5_pass: sshInfo.socks5_pass || null,
    region,
    remark: '⏳ 部署中...',
    is_active: 0
  }), displayGeo, isHomeNetwork);
  const nodeId = result.lastInsertRowid;

  // 为所有现有用户在新节点生成 UUID
  db.ensureAllUsersHaveUuid(nodeId);

  const ssh = new NodeSSH();
  try {
    const connectOpts = buildSshConnectOpts(sshInfo);

    logger.info({ nodeName: name, host: sshInfo.host }, '节点部署开始');
    await ssh.connect(connectOpts);
    await enableBBR(ssh);

    // 先安装 xray
    const installScript = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'install-xray.sh'), 'utf8').trim();

    const installResult = await ssh.execCommand(installScript, { execOptions: { timeout: 300000 } });
    assertInstallOk(installResult);

    // 根据设置决定是否启用 Reality
    let realityOpts = null;
    const useReality = db.getSetting('deploy_use_reality') !== '0';
    if (useReality) {
      const keyResult = await ssh.execCommand('xray x25519');
      const output = keyResult.stdout + '\n' + keyResult.stderr;
      const privMatch = output.match(/Private\s*[Kk]ey:\s*(\S+)/);
      const pubMatch = output.match(/Public\s*[Kk]ey:\s*(\S+)/) || output.match(/Password\s*(?:\([^)]*\))?:\s*(\S+)/);
      if (!privMatch || !pubMatch) throw new Error('Reality 密钥生成失败: ' + output.substring(0, 200));
      const realityPrivateKey = privMatch[1];
      const realityPublicKey = pubMatch[1];
      const realityShortId = crypto.randomBytes(4).toString('hex');
      const sni = 'www.microsoft.com';
      db.updateNode(nodeId, { reality_private_key: realityPrivateKey, reality_public_key: realityPublicKey, reality_short_id: realityShortId, sni });
      realityOpts = { privateKey: realityPrivateKey, sni, shortId: realityShortId };
    }

    // 生成多用户配置
    const userUuids = db.getNodeAllUserUuids(nodeId);
    const clients = userUuids.length > 0
      ? userUuids.map(u => ({ id: u.uuid, level: 0, email: makeEmail(u.user_id, 'vless') }))
      : [{ id: uuid, level: 0, email: 'default@panel' }];

    const outbounds = buildOutboundsBySocks(sshInfo.socks5_host, sshInfo.socks5_port, sshInfo.socks5_user, sshInfo.socks5_pass);

    const config = buildXrayConfig(port, clients, outbounds, realityOpts);
    const configJson = JSON.stringify(config, null, 2);
    const configPath = '/usr/local/etc/xray/config.json';

    await ssh.execCommand('mkdir -p /usr/local/etc/xray');
    await sftpWriteFile(ssh, configPath, configJson);
    const startResult = await ssh.execCommand(restartService('xray',{enable:true,delay:2,marker:'DEPLOY_OK'}));

    if (startResult.stdout.includes('DEPLOY_OK')) {
      db.updateNode(nodeId, { is_active: 1, remark: sshInfo.socks5_host ? '🏠 家宽落地' : '' });
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy', `部署成功: ${name} (${sshInfo.host}:${port}) [${clients.length}用户]`, 'system');
      logger.info({ nodeId, nodeName: name, host: sshInfo.host, port, userCount: clients.length }, '节点部署成功');

      // TG 通知
      try { notify.deploy(name, true, `IP: ${sshInfo.host}:${port} | ${clients.length}个用户`); } catch (err) {
        logger.debug({ err, nodeId, name }, '发送部署成功通知失败，已忽略');
      }

      // 自动安装 Agent
      try {
        await installAgentOnNode(ssh, nodeId, db);
      } catch (agentErr) {
        logger.error({ err: agentErr, nodeId, nodeName: name }, 'Agent 安装失败');
      }
    } else {
      const errMsg = (startResult.stderr || startResult.stdout).substring(0, 200);
      db.updateNode(nodeId, { remark: `❌ 部署失败: ${errMsg}` });
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_fail', `部署失败: ${name} - ${errMsg}`, 'system');
      logger.error({ nodeId, nodeName: name, error: errMsg }, '节点部署失败');
      try { notify.deploy(name, false, errMsg); } catch (err) {
        logger.debug({ err, nodeId, name }, '发送部署失败通知失败，已忽略');
      }
    }
  } catch (err) {
    db.updateNode(nodeId, { remark: `❌ ${err.message}` });
    db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_fail', `部署异常: ${name} - ${err.message}`, 'system');
    logger.error({ err, nodeId, nodeName: name }, '节点部署异常');
    try { notify.deploy(name, false, err.message); } catch (notifyErr) {
      logger.debug({ err: notifyErr, nodeId, name }, '发送部署异常通知失败，已忽略');
    }
  } finally {
    ssh.dispose();
  }
}

/**
 * 通过已有 SSH 连接在节点上安装 Agent
 */
async function installAgentOnNode(ssh, nodeId, db) {
  // 获取节点独立 token
  const node = db.getNodeById(nodeId);
  const agentToken = node?.agent_token;
  if (!agentToken) {
    logger.info({ nodeId }, 'Agent 安装跳过：节点无 agent_token');
    return;
  }
  const serverUrl = process.env.AGENT_WS_URL;
  if (!serverUrl) {
    logger.warn({ nodeId }, 'AGENT_WS_URL 未设置，跳过 Agent 安装。请在 .env 中设置 PANEL_DOMAIN 或 AGENT_WS_URL');
    return;
  }

  logger.info({ nodeId, serverUrl }, 'Agent 安装开始');

  // 安装 Node.js（如果没有）
  const nodeCheck = await ssh.execCommand('command -v node && node -v || echo "NO_NODE"', { execOptions: { timeout: 10000 } });
  if (nodeCheck.stdout.includes('NO_NODE')) {
    logger.info({ nodeId }, 'Agent 安装：开始安装 Node.js');
    const installNode = await ssh.execCommand(
      'if command -v apk >/dev/null 2>&1; then apk add --no-cache nodejs; else curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; fi',
      { execOptions: { timeout: 180000 } }
    );
    if (installNode.code !== 0 && installNode.code !== null) {
      throw new Error('Node.js 安装失败: ' + (installNode.stderr || '').substring(0, 200));
    }
  }

  // 读取 agent.js 内容并通过 SSH 写入节点
  const agentJsPath = path.join(__dirname, '..', '..', 'node-agent', 'agent.js');
  const agentCode = fs.readFileSync(agentJsPath, 'utf8');

  // 写入 agent.js
  await ssh.execCommand('mkdir -p /opt/vless-agent');
  await sftpWriteFile(ssh, '/opt/vless-agent/agent.js', agentCode);
  await ssh.execCommand('chmod 755 /opt/vless-agent/agent.js');

  // 写入配置（根据协议决定是否开启 IPv6 检测）
  const needCheckIPv6 = node.protocol === 'ss' || !!findPeerNode(node, db);
  const configJson = JSON.stringify({ server: serverUrl, token: agentToken, nodeId, checkIPv6: needCheckIPv6 }, null, 2);
  await ssh.execCommand('mkdir -p /etc/vless-agent');
  await sftpWriteFile(ssh, '/etc/vless-agent/config.json', configJson);
  await ssh.execCommand('chmod 600 /etc/vless-agent/config.json');

  // IPv6 节点修复：xray 转发场景下 IPv6 forwarding=1，Linux 默认会忽略 RA 默认路由，
  // 需要 accept_ra=2 才能在转发模式下接受 RA。AWS VPC 某些子网仅靠 RA 广播默认网关，
  // 不修则会出现「IPv6 地址有但 ::/0 路由缺失」导致出站全断。
  if (needCheckIPv6) {
    const sysctlConf = [
      '# 修复 IPv6 转发场景下 RA 默认路由不被接受的问题',
      'net.ipv6.conf.all.accept_ra = 2',
      'net.ipv6.conf.default.accept_ra = 2',
    ].join('\n');
    await ssh.execCommand('mkdir -p /etc/sysctl.d');
    await sftpWriteFile(ssh, '/etc/sysctl.d/99-ipv6-accept-ra.conf', sysctlConf);
    await ssh.execCommand('sysctl -p /etc/sysctl.d/99-ipv6-accept-ra.conf >/dev/null 2>&1 || true');
    // 对所有以太网接口立即生效
    await ssh.execCommand("for iface in $(ls /sys/class/net 2>/dev/null | grep -E '^(eth|ens|enp)'); do sysctl -w net.ipv6.conf.${iface}.accept_ra=2 >/dev/null 2>&1 || true; done");
  }

  // Install the service for the host's actual init system.
  const nodeBin = (await ssh.execCommand('command -v node')).stdout.trim() || '/usr/bin/node';
  if(!/^\/[A-Za-z0-9_./-]+$/.test(nodeBin)) throw new Error('Node.js executable path is invalid');
  const initCheck=await ssh.execCommand('if command -v rc-service >/dev/null 2>&1 && [ ! -d /run/systemd/system ]; then echo openrc; else echo systemd; fi');
  const openrc=initCheck.stdout.trim()==='openrc';
  const serviceTemplate = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', openrc ? 'vless-agent.openrc' : 'vless-agent.service'), 'utf8');
  const servicePath=openrc ? '/etc/init.d/vless-agent' : '/etc/systemd/system/vless-agent.service';
  await sftpWriteFile(ssh,servicePath,serviceTemplate.replace('{{NODE_BIN}}',nodeBin).trim());
  const prepare=openrc ? 'chmod 755 /etc/init.d/vless-agent' : 'systemctl daemon-reload';
  const result=await ssh.execCommand(prepare+' && '+restartService('vless-agent',{enable:true,marker:'AGENT_OK'}));
  if(!result.stdout.includes('AGENT_OK')) throw new Error('Agent 服务启动失败');

  logger.info({ nodeId }, 'Agent 安装完成');
}

// ========== IPv6 SS 自动部署 ==========

// 生成 SS 多用户 xray 配置（带 stats）
function buildSsXrayConfig(port, clients, ssMethod, outbounds = null) {
  const finalOutbounds = Array.isArray(outbounds) && outbounds.length > 0
    ? outbounds
    : [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' }
    ];
  return {
    log: { loglevel: 'warning' },
    stats: {},
    api: { tag: 'api', services: ['StatsService'] },
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true }
    },
    inbounds: [
      {
        port, listen: '::', protocol: 'shadowsocks', tag: 'ss-in',
        settings: {
          clients: clients.map(c => ({
            password: c.password, email: c.email, method: ssMethod, level: 0
          })),
          network: 'tcp,udp'
        }
      },
      {
        listen: '127.0.0.1', port: 10085,
        protocol: 'dokodemo-door', tag: 'api-in',
        settings: { address: '127.0.0.1' }
      }
    ],
    outbounds: finalOutbounds,
    routing: {
      rules: [
        { type: 'field', inboundTag: ['api-in'], outboundTag: 'api' },
        ...(finalOutbounds[0]?.tag === 'socks5-out'
          ? [{ type: 'field', outboundTag: 'socks5-out', network: 'tcp,udp' }]
          : [])
      ]
    }
  };
}

// 生成双协议 xray 配置（VLESS IPv4 + SS IPv6）
function buildDualXrayConfig(vlessPort, ssPort, vlessClients, ssClients, ssMethod, outbounds, realityOpts) {
  const vlessStreamSettings = { network: 'tcp', security: realityOpts ? 'reality' : 'none' };
  const vlessClientsWithFlow = realityOpts
    ? vlessClients.map(c => ({ ...c, flow: 'xtls-rprx-vision' }))
    : vlessClients;
  if (realityOpts) {
    vlessStreamSettings.realitySettings = {
      show: false,
      dest: `${realityOpts.sni}:443`,
      xver: 0,
      serverNames: [realityOpts.sni],
      privateKey: realityOpts.privateKey,
      shortIds: [realityOpts.shortId]
    };
  }
  return {
    log: { loglevel: 'warning' },
    stats: {},
    api: { tag: 'api', services: ['StatsService'] },
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true }
    },
    inbounds: [
      {
        port: vlessPort, listen: '0.0.0.0', protocol: 'vless', tag: 'vless-in',
        settings: { clients: vlessClientsWithFlow, decryption: 'none' },
        streamSettings: vlessStreamSettings
      },
      {
        port: ssPort, listen: '::', protocol: 'shadowsocks', tag: 'ss-in',
        settings: {
          clients: ssClients.map(c => ({
            password: c.password, email: c.email, method: ssMethod, level: 0
          })),
          network: 'tcp,udp'
        }
      },
      {
        listen: '127.0.0.1', port: 10085,
        protocol: 'dokodemo-door', tag: 'api-in',
        settings: { address: '127.0.0.1' }
      }
    ],
    outbounds,
    routing: {
      rules: [
        { type: 'field', inboundTag: ['api-in'], outboundTag: 'api' },
        ...(outbounds[0]?.tag === 'socks5-out'
          ? [{ type: 'field', outboundTag: 'socks5-out', network: 'tcp,udp' }]
          : [])
      ]
    }
  };
}

async function deploySsNode(sshInfo, db) {
  // 确保数据库已初始化
  if (typeof db.getDb === 'function') db.getDb();

  const port = randomPort();
  const ssPassword = crypto.randomBytes(16).toString('base64');
  const ssMethod = sshInfo.ss_method || 'aes-256-gcm';

  const { displayGeo, isHomeNetwork: hasSocks5 } = await resolveDeployGeo(sshInfo);
  const region = `${displayGeo.emoji} ${displayGeo.cityCN}`;
  const { name, result } = insertNodeWithGeneratedName(db, (generatedName) => ({
    name: generatedName, host: sshInfo.host, port, uuid: '00000000-0000-0000-0000-000000000000',
    protocol: 'ss', ip_version: 6, ss_method: ssMethod, ss_password: ssPassword,
    ulzix_order_id: sshInfo.ulzix_order_id || null,
    ssh_host: sshInfo.host,
    ssh_port: sshInfo.ssh_port || 22,
    ssh_user: sshInfo.ssh_user || 'root',
    ssh_password: sshInfo.ssh_password,
    ssh_key_path: sshInfo.ssh_key_path,
    socks5_host: sshInfo.socks5_host || null,
    socks5_port: parseInt(sshInfo.socks5_port, 10) || 1080,
    socks5_user: sshInfo.socks5_user || null,
    socks5_pass: sshInfo.socks5_pass || null,
    region, remark: '⏳ 部署中...', is_active: 0
  }), displayGeo, hasSocks5);
  const nodeId = result.lastInsertRowid;

  const ssh = new NodeSSH();
  try {
    const connectOpts = buildSshConnectOpts(sshInfo);

    logger.info({ nodeName: name, host: sshInfo.host }, 'SS 部署开始');
    await ssh.connect(connectOpts);
    await enableBBR(ssh);

    // 检测 IPv6 地址
    const ipv6Result = await ssh.execCommand("ip -6 addr show scope global | grep inet6 | head -1 | awk '{print $2}' | cut -d/ -f1");
    const ipv6Addr = (ipv6Result.stdout || '').trim();
    if (!ipv6Addr) {
      throw new Error('服务器没有 IPv6 地址');
    }
    logger.info({ nodeName: name, host: sshInfo.host, ipv6: ipv6Addr }, 'SS 部署检测到 IPv6');

    // 更新节点 host 为 IPv6 地址
    db.updateNode(nodeId, { host: ipv6Addr });

    // 安装 xray
    const installScript = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'install-xray.sh'), 'utf8').trim();
    const installResult = await ssh.execCommand(installScript, { execOptions: { timeout: 300000 } });
    assertInstallOk(installResult);

    // 为所有现有用户在新节点生成 UUID（用作 SS 密码）
    db.ensureAllUsersHaveUuid(nodeId);

    // 生成多用户 SS 配置（带 stats）
    const userUuids = db.getNodeAllUserUuids(nodeId);
    const clients = userUuids.length > 0
      ? userUuids.map(u => ({ password: u.uuid, email: makeEmail(u.user_id, 'ss') }))
      : [{ password: ssPassword, email: 'default@panel' }];

    const outbounds = buildOutboundsBySocks(sshInfo.socks5_host, sshInfo.socks5_port, sshInfo.socks5_user, sshInfo.socks5_pass);
    const config = buildSsXrayConfig(port, clients, ssMethod, outbounds);
    const configJson = JSON.stringify(config, null, 2);
    await ssh.execCommand('mkdir -p /usr/local/etc/xray');
    await sftpWriteFile(ssh, '/usr/local/etc/xray/config.json', configJson);

    // 开放防火墙端口
    await ssh.execCommand(`
      iptables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport ${port} -j ACCEPT
      iptables -C INPUT -p udp --dport ${port} -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport ${port} -j ACCEPT
      ip6tables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || ip6tables -I INPUT -p tcp --dport ${port} -j ACCEPT
      ip6tables -C INPUT -p udp --dport ${port} -j ACCEPT 2>/dev/null || ip6tables -I INPUT -p udp --dport ${port} -j ACCEPT
      command -v netfilter-persistent &>/dev/null && netfilter-persistent save || true
    `);

    // 启动 xray
    const startResult = await ssh.execCommand(restartService('xray',{enable:true,delay:2,marker:'DEPLOY_OK'}));

    if (startResult.stdout.includes('DEPLOY_OK')) {
      db.updateNode(nodeId, { is_active: 1, remark: sshInfo.socks5_host ? '🏠 家宽落地' : '' });
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_ss', `SS部署成功: ${name} (IPv6: ${ipv6Addr}:${port})`, 'system');
      logger.info({ nodeId, nodeName: name, ipv6: ipv6Addr, port }, 'SS 部署成功');
      try { notify.deploy(name, true, `IPv6 SS | ${ipv6Addr}:${port}`); } catch (err) {
        logger.debug({ err, nodeId, name }, '发送 SS 部署成功通知失败，已忽略');
      }

      // 安装 Agent
      try { await installAgentOnNode(ssh, nodeId, db); } catch (e) {
        logger.error({ err: e, nodeId, nodeName: name }, 'SS 节点 Agent 安装失败');
      }
    } else {
      const errMsg = (startResult.stderr || startResult.stdout).substring(0, 200);
      db.updateNode(nodeId, { remark: `❌ 部署失败: ${errMsg}` });
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_ss_fail', `SS部署失败: ${name} - ${errMsg}`, 'system');
      logger.error({ nodeId, nodeName: name, error: errMsg }, 'SS 部署失败');
      try { notify.deploy(name, false, errMsg); } catch (err) {
        logger.debug({ err, nodeId, name }, '发送 SS 部署失败通知失败，已忽略');
      }
    }
  } catch (err) {
    db.updateNode(nodeId, { remark: `❌ ${err.message}` });
    db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_ss_fail', `SS部署异常: ${name} - ${err.message}`, 'system');
    logger.error({ err, nodeId, nodeName: name }, 'SS 部署异常');
    try { notify.deploy(name, false, err.message); } catch (notifyErr) {
      logger.debug({ err: notifyErr, nodeId, name }, '发送 SS 部署异常通知失败，已忽略');
    }
  } finally {
    ssh.dispose();
  }
}

// ========== 双协议部署（VLESS IPv4 + SS IPv6 同机）==========

async function deployDualNode(sshInfo, db) {
  if (typeof db.getDb === 'function') db.getDb();

  const vlessPort = randomPort();
  const ssPort = randomPort(10000, 60000);
  const uuid = uuidv4();
  const ssPassword = crypto.randomBytes(16).toString('base64');
  const ssMethod = sshInfo.ss_method || 'aes-256-gcm';

  const { displayGeo, isHomeNetwork } = await resolveDeployGeo(sshInfo);

  const region = `${displayGeo.emoji} ${displayGeo.cityCN}`;
  const { vlessName, ssName, vlessResult, ssResult } = insertDualNodesWithGeneratedName(
    db,
    (generatedName) => ({
      name: generatedName, host: sshInfo.host, port: vlessPort, uuid,
      protocol: 'vless', ip_version: 4,
      ulzix_order_id: sshInfo.ulzix_order_id || null,
      ssh_host: sshInfo.host, ssh_port: sshInfo.ssh_port || 22,
      ssh_user: sshInfo.ssh_user || 'root', ssh_password: sshInfo.ssh_password,
      ssh_key_path: sshInfo.ssh_key_path,
      socks5_host: sshInfo.socks5_host || null, socks5_port: parseInt(sshInfo.socks5_port) || 1080,
      socks5_user: sshInfo.socks5_user || null, socks5_pass: sshInfo.socks5_pass || null,
      region, remark: '⏳ 部署中...', is_active: 0
    }),
    (generatedName) => ({
      name: generatedName, host: sshInfo.host, port: ssPort,
      uuid: '00000000-0000-0000-0000-000000000000',
      protocol: 'ss', ip_version: 6, ss_method: ssMethod, ss_password: ssPassword,
      ulzix_order_id: sshInfo.ulzix_order_id || null,
      ssh_host: sshInfo.host, ssh_port: sshInfo.ssh_port || 22,
      ssh_user: sshInfo.ssh_user || 'root', ssh_password: sshInfo.ssh_password,
      ssh_key_path: sshInfo.ssh_key_path,
      socks5_host: sshInfo.socks5_host || null, socks5_port: parseInt(sshInfo.socks5_port, 10) || 1080,
      socks5_user: sshInfo.socks5_user || null, socks5_pass: sshInfo.socks5_pass || null,
      region, remark: '⏳ 部署中...', is_active: 0
    }),
    displayGeo,
    isHomeNetwork
  );
  const vlessNodeId = vlessResult.lastInsertRowid;
  const ssNodeId = ssResult.lastInsertRowid;

  // 为所有用户生成 UUID
  db.ensureAllUsersHaveUuid(vlessNodeId);
  db.ensureAllUsersHaveUuid(ssNodeId);

  const ssh = new NodeSSH();
  try {
    const connectOpts = buildSshConnectOpts(sshInfo);

    logger.info({ vlessName, ssName, host: sshInfo.host }, '双协议部署开始');
    await ssh.connect(connectOpts);
    await enableBBR(ssh);

    // 检测 IPv6 地址
    const ipv6Result = await ssh.execCommand("ip -6 addr show scope global | grep inet6 | head -1 | awk '{print $2}' | cut -d/ -f1");
    const ipv6Addr = (ipv6Result.stdout || '').trim();
    if (!ipv6Addr) {
      throw new Error('服务器没有 IPv6 地址，无法进行双协议部署');
    }
    logger.info({ vlessName, ssName, host: sshInfo.host, ipv6: ipv6Addr }, '双协议部署检测到 IPv6');
    db.updateNode(ssNodeId, { host: ipv6Addr });

    // 安装 xray
    const installScript = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'install-xray.sh'), 'utf8').trim();
    const installResult = await ssh.execCommand(installScript, { execOptions: { timeout: 300000 } });
    assertInstallOk(installResult);

    // 根据设置决定是否启用 Reality
    let realityOpts = null;
    const useReality = db.getSetting('deploy_use_reality') !== '0';
    if (useReality) {
      const keyResult = await ssh.execCommand('xray x25519');
      const output = keyResult.stdout + '\n' + keyResult.stderr;
      const privMatch = output.match(/Private\s*[Kk]ey:\s*(\S+)/);
      const pubMatch = output.match(/Public\s*[Kk]ey:\s*(\S+)/) || output.match(/Password\s*(?:\([^)]*\))?:\s*(\S+)/);
      if (!privMatch || !pubMatch) throw new Error('Reality 密钥生成失败');
      const realityPrivateKey = privMatch[1];
      const realityPublicKey = pubMatch[1];
      const realityShortId = crypto.randomBytes(4).toString('hex');
      const sni = 'www.microsoft.com';
      db.updateNode(vlessNodeId, { reality_private_key: realityPrivateKey, reality_public_key: realityPublicKey, reality_short_id: realityShortId, sni });
      realityOpts = { privateKey: realityPrivateKey, sni, shortId: realityShortId };
    }

    // 构建双协议配置
    const vlessUuids = db.getNodeAllUserUuids(vlessNodeId);
    const vlessClients = vlessUuids.length > 0
      ? vlessUuids.map(u => ({ id: u.uuid, level: 0, email: makeEmail(u.user_id, 'vless') }))
      : [{ id: uuid, level: 0, email: 'default@panel' }];

    const ssUuids = db.getNodeAllUserUuids(ssNodeId);
    const ssClients = ssUuids.length > 0
      ? ssUuids.map(u => ({ password: u.uuid, email: makeEmail(u.user_id, 'ss') }))
      : [{ password: ssPassword, email: 'default@panel' }];

    const outbounds = buildOutboundsBySocks(sshInfo.socks5_host, sshInfo.socks5_port, sshInfo.socks5_user, sshInfo.socks5_pass);

    const config = buildDualXrayConfig(vlessPort, ssPort, vlessClients, ssClients, ssMethod, outbounds, realityOpts);
    const configJson = JSON.stringify(config, null, 2);

    await ssh.execCommand('mkdir -p /usr/local/etc/xray');
    await sftpWriteFile(ssh, '/usr/local/etc/xray/config.json', configJson);

    // 开放两个端口
    await ssh.execCommand(`
      for P in ${vlessPort} ${ssPort}; do
        iptables -C INPUT -p tcp --dport $P -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport $P -j ACCEPT
        iptables -C INPUT -p udp --dport $P -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport $P -j ACCEPT
        ip6tables -C INPUT -p tcp --dport $P -j ACCEPT 2>/dev/null || ip6tables -I INPUT -p tcp --dport $P -j ACCEPT
        ip6tables -C INPUT -p udp --dport $P -j ACCEPT 2>/dev/null || ip6tables -I INPUT -p udp --dport $P -j ACCEPT
      done
      command -v netfilter-persistent &>/dev/null && netfilter-persistent save || true
    `);

    // 启动 xray
    const startResult = await ssh.execCommand(restartService('xray',{enable:true,delay:2,marker:'DEPLOY_OK'}));

    if (startResult.stdout.includes('DEPLOY_OK')) {
      db.updateNode(vlessNodeId, { is_active: 1, remark: sshInfo.socks5_host ? '🏠 家宽落地' : '' });
      db.updateNode(ssNodeId, { is_active: 1, remark: sshInfo.socks5_host ? '🏠 家宽落地' : '' });
      const msg = `双协议部署成功: ${vlessName} (VLESS ${sshInfo.host}:${vlessPort}) + ${ssName} (SS IPv6 ${ipv6Addr}:${ssPort})`;
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_dual', msg, 'system');
      logger.info({ vlessNodeId, ssNodeId, message: msg }, '双协议部署成功');
      try { notify.deploy(vlessName, true, `双协议 | VLESS:${vlessPort} SS-IPv6:${ssPort}`); } catch (err) {
        logger.debug({ err, vlessNodeId, vlessName }, '发送双协议部署成功通知失败，已忽略');
      }

      // 安装 Agent（用 VLESS 节点 ID）
      try { await installAgentOnNode(ssh, vlessNodeId, db); } catch (e) {
        logger.error({ err: e, nodeId: vlessNodeId, nodeName: vlessName }, '双协议节点 Agent 安装失败');
      }
    } else {
      const errMsg = (startResult.stderr || startResult.stdout).substring(0, 200);
      db.updateNode(vlessNodeId, { remark: `❌ 部署失败: ${errMsg}` });
      db.updateNode(ssNodeId, { remark: `❌ 部署失败: ${errMsg}` });
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_dual_fail', `双协议部署失败: ${errMsg}`, 'system');
      logger.error({ vlessNodeId, ssNodeId, error: errMsg }, '双协议部署失败');
      try { notify.deploy(vlessName, false, errMsg); } catch (err) {
        logger.debug({ err, vlessNodeId, vlessName }, '发送双协议部署失败通知失败，已忽略');
      }
    }
  } catch (err) {
    db.updateNode(vlessNodeId, { remark: `❌ ${err.message}` });
    db.updateNode(ssNodeId, { remark: `❌ ${err.message}` });
    db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_dual_fail', `双协议部署异常: ${err.message}`, 'system');
    logger.error({ err, vlessNodeId, ssNodeId }, '双协议部署异常');
    try { notify.deploy(vlessName, false, err.message); } catch (notifyErr) {
      logger.debug({ err: notifyErr, vlessNodeId, vlessName }, '发送双协议部署异常通知失败，已忽略');
    }
  } finally {
    ssh.dispose();
  }
}

// ========== Hysteria 2 部署 ==========

// 生成 Hysteria 2 服务端 YAML 配置（自签证书）
function yamlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildHy2Config(port, users, opts = {}) {
  const statsSecret = opts.statsSecret || crypto.randomBytes(16).toString('hex');
  const lines = [
    `listen: :${port}`,
    '',
    'tls:',
    '  cert: /etc/hysteria/cert.pem',
    '  key: /etc/hysteria/key.pem',
    '',
    'auth:',
    '  type: userpass',
    '  userpass:',
  ];
  for (const u of users) {
    // hy2 userpass 的 key 不能含 @ 号（会破坏客户端 URI 解析）
    const username = u.hy2Username || u.email.replace(/@.*$/, '');
    lines.push(`    "${yamlEscape(username)}": "${yamlEscape(u.password)}"`);
  }
  lines.push('');
  if (opts.obfs) {
    lines.push('obfs:');
    lines.push('  type: salamander');
    lines.push(`  salamander:`);
    lines.push(`    password: "${yamlEscape(opts.obfs)}"`);
    lines.push('');
  }
  // 不设 bandwidth，由客户端自行探测，服务端不限速
  lines.push('masquerade:');
  lines.push('  type: proxy');
  lines.push('  proxy:');
  lines.push('    url: https://www.bing.com');
  lines.push('    rewriteHost: true');
  lines.push('');
  // SOCKS5 落地出口
  if (opts.socks5Host) {
    lines.push('outbounds:');
    lines.push('  - name: socks5-out');
    lines.push('    type: socks5');
    lines.push('    socks5:');
    lines.push(`      addr: "${yamlEscape(opts.socks5Host)}:${opts.socks5Port || 1080}"`);
    if (opts.socks5User) {
      lines.push(`      username: "${yamlEscape(opts.socks5User)}"`);
      lines.push(`      password: "${yamlEscape(opts.socks5Pass || '')}"`);
    }
    lines.push('');
  }

  lines.push('trafficStats:');
  lines.push('  listen: 127.0.0.1:7653');
  lines.push(`  secret: "${statsSecret}"`);
  lines.push('');
  return lines.join('\n');
}

async function deployHy2Node(sshInfo, db) {
  if (typeof db.getDb === 'function') db.getDb();

  const port = randomPort();
  const statsSecret = crypto.randomBytes(16).toString('hex');

  const { displayGeo, isHomeNetwork: hasSocks5 } = await resolveDeployGeo(sshInfo);
  const region = `${displayGeo.emoji} ${displayGeo.cityCN}`;
  const { name, result } = insertNodeWithGeneratedName(db, (generatedName) => ({
    name: generatedName, host: sshInfo.host, port, uuid: '00000000-0000-0000-0000-000000000000',
    protocol: 'hy2', ip_version: 4,
    hy2_port: port,
    hy2_obfs: sshInfo.hy2_obfs || null,
    hy2_sni: 'bing.com',
    hy2_up_mbps: parseInt(sshInfo.hy2_up_mbps) || 100,
    hy2_down_mbps: parseInt(sshInfo.hy2_down_mbps) || 100,
    hy2_stats_secret: statsSecret,
    ulzix_order_id: sshInfo.ulzix_order_id || null,
    ssh_host: sshInfo.host,
    ssh_port: sshInfo.ssh_port || 22,
    ssh_user: sshInfo.ssh_user || 'root',
    ssh_password: sshInfo.ssh_password,
    ssh_key_path: sshInfo.ssh_key_path,
    socks5_host: sshInfo.socks5_host || null,
    socks5_port: parseInt(sshInfo.socks5_port, 10) || 1080,
    socks5_user: sshInfo.socks5_user || null,
    socks5_pass: sshInfo.socks5_pass || null,
    region, remark: '⏳ 部署中...', is_active: 0
  }), displayGeo, hasSocks5);
  const nodeId = result.lastInsertRowid;

  db.ensureAllUsersHaveUuid(nodeId);

  const ssh = new NodeSSH();
  try {
    const connectOpts = buildSshConnectOpts(sshInfo);

    logger.info({ nodeName: name, host: sshInfo.host }, 'Hy2 部署开始');
    await ssh.connect(connectOpts);
    await enableBBR(ssh);

    // 安装 hysteria + 自签证书
    const installScript = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'install-hysteria.sh'), 'utf8').trim();
    const installResult = await ssh.execCommand(installScript, { execOptions: { timeout: 180000 } });
    if (!installResult.stdout.includes('HY2_INSTALL_OK')) {
      const merged = `${installResult.stderr || ''}\n${installResult.stdout || ''}`.trim().replace(/\s+/g, ' ');
      const detail = merged ? merged.slice(-400) : 'no output';
      throw new Error(`hysteria 安装失败(code=${installResult.code ?? 'unknown'}): ${detail}`);
    }

    // 生成多用户配置
    const userUuids = db.getNodeAllUserUuids(nodeId);
    const users = userUuids.length > 0
      ? userUuids.map(u => ({ password: u.uuid, email: makeEmail(u.user_id, 'hy2') }))
      : [{ password: crypto.randomBytes(16).toString('base64'), email: 'default@panel' }];

    const config = buildHy2Config(port, users, {
      statsSecret,
      obfs: sshInfo.hy2_obfs || null,
      upMbps: parseInt(sshInfo.hy2_up_mbps) || 100,
      downMbps: parseInt(sshInfo.hy2_down_mbps) || 100,
      socks5Host: sshInfo.socks5_host || null,
      socks5Port: parseInt(sshInfo.socks5_port) || 1080,
      socks5User: sshInfo.socks5_user || null,
      socks5Pass: sshInfo.socks5_pass || null,
    });

    await ssh.execCommand('mkdir -p /etc/hysteria');
    await sftpWriteFile(ssh, '/etc/hysteria/config.yaml', config);

    // 开放防火墙端口（UDP 是 hy2 的核心）
    await ssh.execCommand(`
      iptables -C INPUT -p udp --dport ${port} -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport ${port} -j ACCEPT
      iptables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport ${port} -j ACCEPT
      ip6tables -C INPUT -p udp --dport ${port} -j ACCEPT 2>/dev/null || ip6tables -I INPUT -p udp --dport ${port} -j ACCEPT
      ip6tables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || ip6tables -I INPUT -p tcp --dport ${port} -j ACCEPT
      command -v netfilter-persistent &>/dev/null && netfilter-persistent save || true
    `);

    // 启动 hysteria
    const startResult = await ssh.execCommand(restartService('hysteria-server',{enable:true,delay:2,marker:'DEPLOY_OK'}));

    if (startResult.stdout.includes('DEPLOY_OK')) {
      db.updateNode(nodeId, { is_active: 1, remark: sshInfo.socks5_host ? '🏠 家宽落地' : '' });
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_hy2', `Hy2部署成功: ${name} (${sshInfo.host}:${port})`, 'system');
      logger.info({ nodeId, nodeName: name, host: sshInfo.host, port }, 'Hy2 部署成功');
      try { notify.deploy(name, true, `Hy2 | ${sshInfo.host}:${port}`); } catch (err) {
        logger.debug({ err, nodeId, name }, '发送 Hy2 部署成功通知失败，已忽略');
      }

      // 安装 Agent
      try { await installAgentOnNode(ssh, nodeId, db); } catch (e) {
        logger.error({ err: e, nodeId, nodeName: name }, 'Hy2 节点 Agent 安装失败');
      }
    } else {
      const errMsg = (startResult.stderr || startResult.stdout).substring(0, 200);
      db.updateNode(nodeId, { remark: `❌ 部署失败: ${errMsg}` });
      db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_hy2_fail', `Hy2部署失败: ${name} - ${errMsg}`, 'system');
      logger.error({ nodeId, nodeName: name, error: errMsg }, 'Hy2 部署失败');
      try { notify.deploy(name, false, errMsg); } catch (err) {
        logger.debug({ err, nodeId, name }, '发送 Hy2 部署失败通知失败，已忽略');
      }
    }
  } catch (err) {
    db.updateNode(nodeId, { remark: `❌ ${err.message}` });
    db.addAuditLog(sshInfo.triggered_by || null, 'node_deploy_hy2_fail', `Hy2部署异常: ${name} - ${err.message}`, 'system');
    logger.error({ err, nodeId, nodeName: name }, 'Hy2 部署异常');
    try { notify.deploy(name, false, err.message); } catch (notifyErr) {
      logger.debug({ err: notifyErr, nodeId, name }, '发送 Hy2 部署异常通知失败，已忽略');
    }
  } finally {
    ssh.dispose();
  }
}

// syncAllNodesConfig 对外暴露去抖版本
const syncAllNodesConfig = syncAllNodesConfigDebounced;
module.exports = { deployNode, deploySsNode, deployDualNode, deployHy2Node, detectRegion, generateNodeName, syncNodeConfig, syncAllNodesConfig, pushConfigToNode, buildHy2Config };

// Workers must retain the request while remote provisioning/configuration runs.
if (process.env.WORKERS_RUNTIME) {
  const { track } = require('../../workers/lifetime');
  for (const [name, fn] of Object.entries(module.exports)) {
    if (typeof fn === 'function' && fn.constructor.name === 'AsyncFunction') {
      module.exports[name] = (...args) => track(fn(...args));
    }
  }
}
