#!/bin/sh
set -eu

# vless-agent 安装脚本
# 用法: ./install.sh <server_url> <token> <node_id> [--check-ipv6]

if [ $# -lt 3 ]; then
  echo "用法: $0 <server_url> <token> <node_id> [--check-ipv6]"
  echo "示例: $0 wss://vip.vip.sd/ws/agent my-secret-token 123"
  echo "  加 --check-ipv6 开启 IPv6 连通性检测（SS 节点用）"
  exit 1
fi

SERVER_URL="$1"
TOKEN="$2"
NODE_ID="$3"
CHECK_IPV6=false
if [ "${4:-}" = "--check-ipv6" ]; then
  CHECK_IPV6=true
fi
AGENT_DIR="/opt/vless-agent"
CONFIG_DIR="/etc/vless-agent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== vless-agent 安装 ==="
echo "Server: ${SERVER_URL}"
echo "NodeId: ${NODE_ID}"
echo ""

# 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then apk add --no-cache nodejs openrc; else echo '未找到 Node.js，请先安装 Node.js 18+'; exit 1; fi
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
echo "Node.js 版本: $(node -v)"

# IPv6 节点修复：当 IPv6 forwarding 开启（如 xray 转发场景）时，
# Linux 默认会忽略 RA 默认路由（accept_ra=1 失效），需要 accept_ra=2 才能在
# 转发模式下接受 RA。AWS VPC 的某些子网仅通过 RA 广播默认网关，
# 不修则会出现「IPv6 地址有但 ::/0 路由缺失」导致出站全断。
if [ "$CHECK_IPV6" = "true" ]; then
  mkdir -p /etc/sysctl.d
  cat > /etc/sysctl.d/99-ipv6-accept-ra.conf <<'SYSCTL_EOF'
# 修复 IPv6 转发场景下 RA 默认路由不被接受的问题
net.ipv6.conf.all.accept_ra = 2
net.ipv6.conf.default.accept_ra = 2
SYSCTL_EOF
  sysctl -p /etc/sysctl.d/99-ipv6-accept-ra.conf >/dev/null 2>&1 || true
  # 对当前活跃接口立即生效
  for iface in $(ls /sys/class/net | grep -E '^(eth|ens|enp)'); do
    sysctl -w net.ipv6.conf.${iface}.accept_ra=2 >/dev/null 2>&1 || true
  done
  echo "IPv6 accept_ra 已配置为 2（转发模式下接受 RA 默认路由）"
fi

# 创建配置（使用 node 安全生成 JSON，防止变量注入）
mkdir -p "$CONFIG_DIR"
node -e "
  var cfg = {
    server: process.argv[1],
    token: process.argv[2],
    nodeId: parseInt(process.argv[3], 10),
    checkIPv6: process.argv[4] === 'true'
  };
  require('fs').writeFileSync(process.argv[5], JSON.stringify(cfg, null, 2));
" "$SERVER_URL" "$TOKEN" "$NODE_ID" "$CHECK_IPV6" "${CONFIG_DIR}/config.json"
chmod 600 "${CONFIG_DIR}/config.json"
echo "配置写入 ${CONFIG_DIR}/config.json"

# 复制 agent
mkdir -p "$AGENT_DIR"
cp "${SCRIPT_DIR}/agent.js" "${AGENT_DIR}/agent.js"
chmod 755 "${AGENT_DIR}/agent.js"
echo "agent.js 复制到 ${AGENT_DIR}/"

if command -v rc-service >/dev/null 2>&1 && [ ! -d /run/systemd/system ]; then
  cat > /etc/init.d/vless-agent <<EOF_OPENRC
#!/sbin/openrc-run
name="vless-agent"
command="$(command -v node)"
command_args="/opt/vless-agent/agent.js"
command_directory="/opt/vless-agent"
supervisor="supervise-daemon"
respawn_delay=5
respawn_max=0
output_log="/var/log/vless-agent.log"
error_log="/var/log/vless-agent.log"
export NODE_ENV=production
depend() {
  need net
}
EOF_OPENRC
  chmod 755 /etc/init.d/vless-agent
  rc-update add vless-agent default
  rc-service vless-agent restart
  rc-service vless-agent status
  echo '日志: /var/log/vless-agent.log；状态: rc-service vless-agent status'
else
# 创建 systemd service
cat > /etc/systemd/system/vless-agent.service <<EOF
[Unit]
Description=VLESS Panel Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(which node) ${AGENT_DIR}/agent.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# 安全限制
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/vless-agent /etc/vless-agent /usr/local/etc/xray

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vless-agent

[Install]
WantedBy=multi-user.target
EOF
echo "systemd 服务已创建"

# 启动服务
systemctl daemon-reload
systemctl enable vless-agent
systemctl restart vless-agent
echo "服务已启动并设为开机自启"

echo ""
echo "=== 安装完成 ==="
echo "查看日志: journalctl -u vless-agent -f"
echo "服务状态: systemctl status vless-agent"

fi
