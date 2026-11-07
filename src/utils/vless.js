const { formatBytes } = require('./formatBytes');
const crypto = require('crypto');

// 生成 vless 链接
function buildVlessLink(node, uuid) {
  const params = new URLSearchParams({ type: node.network || 'tcp' });
  if (node.reality_public_key) {
    params.set('security', 'reality');
    params.set('sni', node.sni || 'www.microsoft.com');
    params.set('fp', 'chrome');
    params.set('pbk', node.reality_public_key);
    params.set('sid', node.reality_short_id || '');
    params.set('flow', 'xtls-rprx-vision');
  } else {
    params.set('security', node.security || 'none');
  }
  return `vless://${uuid || node.uuid}@${node.host}:${node.port}?${params}#${encodeURIComponent(node.name)}`;
}

// 生成信息假节点 vless 链接
function buildInfoLink(text) {
  return `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:10000?type=tcp&security=none#${encodeURIComponent(text)}`;
}

// 生成流量信息链接（公共逻辑，避免各协议订阅重复构建）
function buildTrafficInfoLinks(trafficInfo, linkBuilder, brandSuffix = '') {
  if (!trafficInfo) return [];
  const links = [];
  const brand = brandSuffix ? ` ${brandSuffix}` : '';
  links.push(linkBuilder(`Pоrпнub${brand}`));
  const used = trafficInfo.upload + trafficInfo.download;
  if (trafficInfo.total > 0) {
    const remain = Math.max(0, trafficInfo.total - used);
    links.push(linkBuilder(`剩余: ${formatBytes(remain)} | 已用: ${formatBytes(used)}`));
  } else {
    links.push(linkBuilder(`已用: ${formatBytes(used)} | 无限制`));
  }
  return links;
}

// v2ray 订阅（base64 编码的链接列表）
function generateV2raySub(nodes, trafficInfo) {
  const infoLinks = buildTrafficInfoLinks(trafficInfo, buildInfoLink);
  const links = [...infoLinks, ...nodes.map(n => buildVlessLink(n))].join('\n');
  return Buffer.from(links).toString('base64');
}

// ========== 公共订阅模板 ==========

function wrapClashConfig(proxies, proxyNames) {
  return {
    'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'info',
    proxies,
    'proxy-groups': [
      { name: '节点选择', type: 'select', proxies: ['自动选择', ...proxyNames, 'DIRECT'] },
      { name: '自动选择', type: 'url-test', proxies: proxyNames, url: 'http://www.gstatic.com/generate_204', interval: 300 }
    ],
    rules: ['GEOIP,LAN,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,节点选择']
  };
}

function wrapSingboxConfig(outbounds, tags) {
  return {
    log: { level: 'info' },
    outbounds: [
      { tag: '节点选择', type: 'selector', outbounds: ['自动选择', ...tags, 'direct'] },
      { tag: '自动选择', type: 'urltest', outbounds: tags, url: 'http://www.gstatic.com/generate_204', interval: '3m' },
      ...outbounds,
      { tag: 'direct', type: 'direct' },
      { tag: 'block', type: 'block' },
      { tag: 'dns-out', type: 'dns' }
    ],
    route: { auto_detect_interface: true, rules: [{ geoip: ['private', 'cn'], outbound: 'direct' }, { protocol: 'dns', outbound: 'dns-out' }], final: '节点选择' }
  };
}

// Clash Meta (mihomo) 订阅
// ─── 订阅节点对象 builders（提取以消除多处重复）───

function buildVlessClashProxy(n) {
  const p = {
    name: n.name, type: 'vless', server: n.host, port: n.port,
    uuid: n.uuid, network: n.network || 'tcp', udp: true
  };
  if (n.reality_public_key) {
    p.tls = true;
    p.servername = n.sni || 'www.microsoft.com';
    p['reality-opts'] = {
      'public-key': n.reality_public_key,
      'short-id': n.reality_short_id || ''
    };
    p['client-fingerprint'] = 'chrome';
    p.flow = 'xtls-rprx-vision';
  }
  return p;
}

function buildVlessSingboxOutbound(n) {
  const o = {
    tag: n.name, type: 'vless', server: n.host, server_port: n.port,
    uuid: n.uuid, network: n.network || 'tcp'
  };
  if (n.reality_public_key) {
    o.flow = 'xtls-rprx-vision';
    o.tls = {
      enabled: true, server_name: n.sni || 'www.microsoft.com',
      utls: { enabled: true, fingerprint: 'chrome' },
      reality: { enabled: true, public_key: n.reality_public_key, short_id: n.reality_short_id || '' }
    };
  }
  return o;
}

function buildHy2ClashProxy(n) {
  const userId = n._userId || '0';
  const pwd = n.userPassword || n.ss_password || '';
  const p = {
    name: n.name, type: 'hysteria2',
    server: n.host, port: parseInt(n.hy2_port || n.port, 10),
    password: `u-${userId}-h:${pwd}`,
    sni: n.hy2_sni || 'bing.com',
    'skip-cert-verify': true,
  };
  if (n.hy2_obfs) {
    p.obfs = 'salamander';
    p['obfs-password'] = n.hy2_obfs;
  }
  return p;
}

function buildHy2SingboxOutbound(n) {
  const userId = n._userId || '0';
  const pwd = n.userPassword || n.ss_password || '';
  const o = {
    tag: n.name, type: 'hysteria2',
    server: n.host, server_port: parseInt(n.hy2_port || n.port, 10),
    password: `u-${userId}-h:${pwd}`,
    tls: {
      enabled: true,
      server_name: n.hy2_sni || 'bing.com',
      insecure: true,
    },
  };
  if (n.hy2_obfs) {
    o.obfs = { type: 'salamander', password: n.hy2_obfs };
  }
  return o;
}

function generateClashSub(nodes) {
  const proxies = nodes.map(buildVlessClashProxy);
  return clashConfigToYaml(wrapClashConfig(proxies, nodes.map(n => n.name)));
}

// sing-box 订阅
function generateSingboxSub(nodes) {
  const outbounds = nodes.map(buildVlessSingboxOutbound);
  return JSON.stringify(wrapSingboxConfig(outbounds, nodes.map(n => n.name)), null, 2);
}

// 简易 YAML 生成器
function clashConfigToYaml(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  let yaml = '';
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      if (value.length === 0) { yaml += `${pad}${key}: []\n`; }
      else if (typeof value[0] === 'object') {
        yaml += `${pad}${key}:\n`;
        for (const item of value) {
          const entries = Object.entries(item);
          entries.forEach(([k, v], i) => {
            const prefix = i === 0 ? `${pad}  - ` : `${pad}    `;
            if (Array.isArray(v)) {
              yaml += `${prefix}${k}:\n`;
              for (const sv of v) yaml += `${pad}      - ${typeof sv === 'string' ? `"${sv}"` : sv}\n`;
            } else if (typeof v === 'object' && v !== null) {
              yaml += `${prefix}${k}:\n`;
              for (const [sk, sv] of Object.entries(v)) yaml += `${pad}      ${sk}: ${fmtYaml(sv)}\n`;
            } else {
              yaml += `${prefix}${k}: ${fmtYaml(v)}\n`;
            }
          });
        }
      } else {
        yaml += `${pad}${key}:\n`;
        for (const item of value) yaml += `${pad}  - ${typeof item === 'string' ? `"${item}"` : item}\n`;
      }
    } else if (typeof value === 'object' && value !== null) {
      yaml += `${pad}${key}:\n${clashConfigToYaml(value, indent + 2)}`;
    } else {
      yaml += `${pad}${key}: ${fmtYaml(value)}\n`;
    }
  }
  return yaml;
}

function fmtYaml(v) {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

// ========== Hysteria 2 订阅生成 ==========

function buildHy2Link(node, userPassword) {
  const password = userPassword || node.ss_password || '';
  const userId = node._userId || '0';
  const auth = `${encodeURIComponent(`u-${userId}-h`)}:${encodeURIComponent(password)}`;
  const host = node.host.includes(':') ? `[${node.host}]` : node.host;
  const port = node.hy2_port || node.port;
  const params = new URLSearchParams({ insecure: '1', sni: node.hy2_sni || 'bing.com' });
  if (node.hy2_obfs) {
    params.set('obfs', 'salamander');
    params.set('obfs-password', node.hy2_obfs);
  }
  return `hysteria2://${auth}@${host}:${port}?${params}#${encodeURIComponent(node.name)}`;
}

function buildHy2InfoLink(text) {
  return `hysteria2://00000000@127.0.0.1:10000?insecure=1#${encodeURIComponent(text)}`;
}

function generateV2rayHy2Sub(nodes, trafficInfo) {
  const infoLinks = buildTrafficInfoLinks(trafficInfo, buildHy2InfoLink, '[Hy2]');
  const links = [...infoLinks, ...nodes.map(n => buildHy2Link(n, n.userPassword))].join('\n');
  return Buffer.from(links).toString('base64');
}

function generateClashHy2Sub(nodes) {
  const proxies = nodes.map(buildHy2ClashProxy);
  return clashConfigToYaml(wrapClashConfig(proxies, nodes.map(n => n.name)));
}

function generateSingboxHy2Sub(nodes) {
  const outbounds = nodes.map(buildHy2SingboxOutbound);
  return JSON.stringify(wrapSingboxConfig(outbounds, nodes.map(n => n.name)), null, 2);
}

// ========== Shadowsocks 订阅生成 ==========

function buildSsLink(node, userPassword) {
  const method = node.ss_method || 'aes-256-gcm';
  const password = userPassword || node.ss_password || '';
  const userinfo = Buffer.from(`${method}:${password}`).toString('base64');
  // IPv6 地址用方括号包裹
  const host = node.host.includes(':') ? `[${node.host}]` : node.host;
  return `ss://${userinfo}@${host}:${node.port}#${encodeURIComponent(node.name)}`;
}

function buildSsInfoLink(text) {
  const userinfo = Buffer.from('aes-256-gcm:00000000').toString('base64');
  // 用 10000 而非 0，避免某些客户端（如 v2rayN）将 port=0 视为无效节点过滤
  return `ss://${userinfo}@127.0.0.1:10000#${encodeURIComponent(text)}`;
}

function generateV2raySsSub(nodes, trafficInfo) {
  const infoLinks = buildTrafficInfoLinks(trafficInfo, buildSsInfoLink, '[IPv6]');
  const links = [...infoLinks, ...nodes.map(n => buildSsLink(n, n.userPassword))].join('\n');
  return Buffer.from(links).toString('base64');
}

function generateClashSsSub(nodes, trafficInfo) {
  // 生成流量信息伪装节点（无效占位地址，不会真正连接）
  const infoProxies = trafficInfo ? buildTrafficInfoLinks(trafficInfo, (text) => ({
    name: text, type: 'ss',
    server: '127.0.0.1', port: 10000,
    cipher: 'aes-256-gcm', password: '00000000',
    udp: false
  }), '[IPv6]') : [];
  const realProxies = nodes.map(n => ({
    name: n.name, type: 'ss',
    server: n.host, port: n.port,
    cipher: n.ss_method || 'aes-256-gcm',
    password: n.userPassword || n.ss_password || '',
    udp: true
  }));
  const proxies = [...infoProxies, ...realProxies];
  return clashConfigToYaml(wrapClashConfig(proxies, proxies.map(p => p.name)));
}

function generateSingboxSsSub(nodes, trafficInfo) {
  const infoOutbounds = trafficInfo ? buildTrafficInfoLinks(trafficInfo, (text) => ({
    tag: text, type: 'shadowsocks',
    server: '127.0.0.1', server_port: 10000,
    method: 'aes-256-gcm', password: '00000000'
  }), '[IPv6]') : [];
  const realOutbounds = nodes.map(n => ({
    tag: n.name, type: 'shadowsocks',
    server: n.host, server_port: n.port,
    method: n.ss_method || 'aes-256-gcm',
    password: n.userPassword || n.ss_password || ''
  }));
  const outbounds = [...infoOutbounds, ...realOutbounds];
  return JSON.stringify(wrapSingboxConfig(outbounds, outbounds.map(o => o.tag)), null, 2);
}

function detectClient(ua) {
  if (!ua) return 'v2ray';
  ua = ua.toLowerCase();
  if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('stash')) return 'clash';
  if (ua.includes('sing-box') || ua.includes('singbox') || ua.includes('sfi') || ua.includes('sfa')) return 'singbox';
  return 'v2ray';
}

function randomPort(min = 10000, max = 60000) {
  return crypto.randomInt(min, max + 1);
}

// ========== 组合订阅（VLESS + Hy2 混合）==========

function generateV2rayAllSub(vlessNodes, hy2Nodes, trafficInfo) {
  const infoLinks = buildTrafficInfoLinks(trafficInfo, buildInfoLink);
  const links = [...infoLinks, ...vlessNodes.map(n => buildVlessLink(n)), ...hy2Nodes.map(n => buildHy2Link(n, n.userPassword))].join('\n');
  return Buffer.from(links).toString('base64');
}

function generateClashAllSub(vlessNodes, hy2Nodes) {
  const all = [...vlessNodes.map(buildVlessClashProxy), ...hy2Nodes.map(buildHy2ClashProxy)];
  return clashConfigToYaml(wrapClashConfig(all, all.map(n => n.name)));
}

function generateSingboxAllSub(vlessNodes, hy2Nodes) {
  const all = [...vlessNodes.map(buildVlessSingboxOutbound), ...hy2Nodes.map(buildHy2SingboxOutbound)];
  return JSON.stringify(wrapSingboxConfig(all, all.map(n => n.tag)), null, 2);
}

module.exports = {
  buildVlessLink,
  generateV2raySubForUser: generateV2raySub,
  generateClashSubForUser: generateClashSub,
  generateSingboxSubForUser: generateSingboxSub,
  buildSsLink, generateV2raySsSub, generateClashSsSub, generateSingboxSsSub,
  buildHy2Link, generateV2rayHy2Sub, generateClashHy2Sub, generateSingboxHy2Sub,
  generateV2rayAllSub, generateClashAllSub, generateSingboxAllSub,
  detectClient, randomPort
};
