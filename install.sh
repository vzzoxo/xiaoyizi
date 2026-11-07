#!/bin/bash
set -eo pipefail

# ══════════════════════════════════════════════════════════════
# Pоrпнub 一键部署 v4.2
# 支持: Debian 11+ / Ubuntu 20.04+
# 用法: bash <(curl -sL https://raw.githubusercontent.com/hekuo5310/PornHub/main/install.sh)
# ══════════════════════════════════════════════════════════════

INSTALL_DIR="/root/panel"
REPO_URL="https://github.com/hekuo5310/PornHub.git"
NODE_MAJOR=22

R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; C='\033[0;36m'; B='\033[1;37m'; N='\033[0m'
ok()   { echo -e "${G}[✓]${N} $1"; }
warn() { echo -e "${Y}[!]${N} $1"; }
err()  { echo -e "${R}[✗]${N} $1"; exit 1; }
info() { echo -e "${C}[i]${N} $1"; }

# 错误兜底：set -e 触发或脚本异常退出时打印失败步骤
on_error() {
  local rc=$?
  local lineno=$1
  echo ""
  echo -e "${R}══════════════════════════════════════════════${N}"
  echo -e "${R}[✗] 安装中断，退出码 $rc，行号 $lineno${N}"
  echo -e "${R}══════════════════════════════════════════════${N}"
  echo -e "${Y}排查方式：${N}"
  echo -e "  1) 直接看屏幕上方最后一条错误信息"
  echo -e "  2) 检查网络：curl -I https://github.com  （超时 = 网络受限）"
  echo -e "  3) 检查 apt：apt update  （单独跑试试）"
  echo -e "  4) 重新运行同样命令通常是安全的，不会破坏现有数据"
  exit $rc
}
trap 'on_error $LINENO' ERR

banner() {
  echo ""
  echo -e "${C}╔══════════════════════════════════════════════╗${N}"
  echo -e "${C}║${B}             Pоrпнub 一键部署                ${C}║${N}"
  echo -e "${C}║${N}   多协议节点管理 · TG 互动 · AI 运维        ${C}║${N}"
  echo -e "${C}╚══════════════════════════════════════════════╝${N}"
  echo ""
}

# ─── 环境检查 ──────────────────────────────────────────────

preflight() {
  [ "$(id -u)" -ne 0 ] && err "请使用 root 用户运行"
  command -v apt &>/dev/null || err "仅支持 Debian / Ubuntu (apt)"

  local os ver
  os=$(. /etc/os-release && echo "$ID")
  ver=$(. /etc/os-release && echo "$VERSION_ID")
  info "系统: ${os} ${ver} ($(uname -m))"

  local mem_mb; mem_mb=$(free -m | awk '/^Mem:/{print $2}')
  info "内存: ${mem_mb} MB"
  [ "$mem_mb" -lt 256 ] && warn "内存较低，建议 ≥512MB"

  # npm install 较吃内存（≥500MB），低内存机器若无 swap 会 OOM 导致脚本静默失败
  if [ "$mem_mb" -lt 1024 ]; then
    local swap_mb; swap_mb=$(free -m | awk '/^Swap:/{print $2}')
    if [ "${swap_mb:-0}" -lt 512 ]; then
      warn "内存 ${mem_mb}MB + Swap ${swap_mb:-0}MB 偏低，npm install 可能 OOM"
      warn "建议先执行：fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
    fi
  fi
}

# ─── 安装系统依赖 ──────────────────────────────────────────

install_deps() {
  ok "更新包索引..."
  apt update -qq

  local pkgs=(curl git nginx certbot python3-certbot-nginx build-essential)
  local need=()
  for p in "${pkgs[@]}"; do
    dpkg -s "$p" &>/dev/null || need+=("$p")
  done
  if [ ${#need[@]} -gt 0 ]; then
    ok "安装: ${need[*]}"
    DEBIAN_FRONTEND=noninteractive apt install -y -qq "${need[@]}"
  else
    ok "系统依赖已就绪"
  fi
}

install_node() {
  local cur=0
  command -v node &>/dev/null && cur=$(node -v | cut -d. -f1 | tr -d v)
  if [ "$cur" -ge 20 ]; then
    ok "Node.js $(node -v) ✓"
    return
  fi
  ok "安装 Node.js ${NODE_MAJOR}..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt install -y -qq nodejs
  ok "Node.js $(node -v) ✓"
}

install_pm2() {
  if command -v pm2 &>/dev/null; then
    ok "PM2 $(pm2 -v) ✓"
    return
  fi
  ok "安装 PM2..."
  npm install -g pm2 --silent
  ok "PM2 已安装"
}

# ─── 拉取代码 ─────────────────────────────────────────────

deploy_code() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    ok "更新代码..."
    cd "$INSTALL_DIR"
    git fetch origin main --quiet && git reset --hard origin/main --quiet
  else
    ok "克隆项目..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet
    cd "$INSTALL_DIR"
  fi

  ok "安装依赖包..."
  npm install --omit=dev --no-audit --no-fund --silent
  mkdir -p data/logs backups
  chmod 700 backups || true
  ok "代码部署完成"
}

# ─── 配置 .env ────────────────────────────────────────────

configure_env() {
  cd "$INSTALL_DIR"

  ensure_key() {
    local key="$1" value="$2"
    grep -q "^${key}=" .env 2>/dev/null || echo "${key}=${value}" >> .env
  }

  if [ -f .env ]; then
    DOMAIN=$(grep "^PANEL_DOMAIN=" .env 2>/dev/null | cut -d= -f2)
    ok "检测到已有配置 (域名: ${DOMAIN:-未设置})"
    ensure_key "OPS_API_KEY" "$(openssl rand -hex 32)"
    ensure_key "SESSION_SECRET" "$(openssl rand -hex 32)"
    ensure_key "PORT" "3000"
    ensure_key "NODE_ENV" "production"
    ensure_key "TZ" "Asia/Shanghai"
    ensure_key "LOG_LEVEL" "info"
    ensure_key "TRUST_PROXY" "1"
    ensure_key "SUB_LINK_SIGN_MODE" "off"
    return
  fi

  echo ""
  echo -e "${C}━━━ 面板配置 ━━━${N}"
  echo ""

  while true; do
    read -rp "$(echo -e "${C}面板域名${N} (如 panel.example.com): ")" DOMAIN
    [ -n "$DOMAIN" ] && break
    warn "域名不能为空"
  done

  read -rp "$(echo -e "${C}TG Bot Token${N} (可选，回车跳过): ")" TG_TOKEN

  cat > .env << EOF
PANEL_DOMAIN=${DOMAIN}
PORT=3000
NODE_ENV=production
TZ=Asia/Shanghai
LOG_LEVEL=info
SESSION_SECRET=$(openssl rand -hex 32)
TRUST_PROXY=1
OPS_API_KEY=$(openssl rand -hex 32)
SUB_LINK_SIGN_MODE=off
EOF

  [ -n "$TG_TOKEN" ] && echo "TG_BOT_TOKEN=${TG_TOKEN}" >> .env

  ok ".env 已生成"
}

# ─── Nginx + SSL ──────────────────────────────────────────

setup_ssl() {
  if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
    ok "SSL 证书已存在"
    return 0
  fi

  ok "申请 SSL 证书..."
  cat > /etc/nginx/sites-available/vless-panel << EOF
server { listen 80; server_name ${DOMAIN}; location /.well-known/acme-challenge/ { root /var/www/html; } }
EOF
  ln -sf /etc/nginx/sites-available/vless-panel /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t &>/dev/null && systemctl reload nginx

  if certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email 2>/dev/null; then
    ok "SSL 证书申请成功"
    return 0
  fi

  warn "证书申请失败，请确保域名已解析到本机且 80 端口可达"
  read -rp "跳过 SSL 继续? (y/N): " ans
  [[ "$ans" =~ ^[yY]$ ]] || exit 1
  return 1
}

setup_nginx() {
  ok "配置 Nginx..."

  cat > /etc/nginx/sites-available/vless-panel << 'NGINXEOF'
server {
    listen 80;
    server_name DOMAIN_PH;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name DOMAIN_PH;

    ssl_certificate     /etc/letsencrypt/live/DOMAIN_PH/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/DOMAIN_PH/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_stapling on;
    ssl_stapling_verify on;

    add_header X-Frame-Options       "DENY"    always;
    add_header X-Content-Type-Options "nosniff" always;
    client_max_body_size 10m;

    gzip on;
    gzip_types text/plain application/json application/javascript text/css;
    gzip_min_length 1024;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 86400;
    }
}
NGINXEOF

  sed -i "s/DOMAIN_PH/${DOMAIN}/g" /etc/nginx/sites-available/vless-panel
  ln -sf /etc/nginx/sites-available/vless-panel /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t &>/dev/null && systemctl reload nginx
  ok "Nginx 配置完成"
}

# ─── PM2 启动 ─────────────────────────────────────────────

setup_pm2() {
  cd "$INSTALL_DIR"

  if pm2 list 2>/dev/null | grep -q vless-panel; then
    pm2 restart vless-panel --silent
  else
    pm2 start ecosystem.config.js --silent
  fi
  pm2 save --silent 2>/dev/null
  pm2 startup systemd -u root --hp /root 2>/dev/null || true

  sleep 3
  local code; code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/healthz 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    ok "面板启动成功"
  else
    warn "面板可能未完全启动 (HTTP ${code})，请检查: pm2 logs vless-panel"
  fi
}

# ─── OpenClaw（可选）──────────────────────────────────────

setup_openclaw() {
  echo ""
  read -rp "$(echo -e "${C}安装 OpenClaw AI 运维?${N} (y/N): ")" ans
  [[ "$ans" =~ ^[yY]$ ]] || return

  # OpenClaw 是可选辅助工具，失败不应阻塞主流程
  # 临时关闭 -e 让本函数中的非致命错误不触发 trap on_error
  set +e

  if ! command -v openclaw &>/dev/null; then
    ok "安装 OpenClaw..."
    npm install -g openclaw --silent
    if ! command -v openclaw &>/dev/null; then
      warn "OpenClaw 安装失败（非关键，已跳过）"
      set -e
      return 0
    fi
  fi

  if [ -f "$INSTALL_DIR/openclaw-ops/setup.sh" ]; then
    if ! bash "$INSTALL_DIR/openclaw-ops/setup.sh" --force; then
      warn "OpenClaw setup 出错（非关键，已跳过）"
      warn "可稍后手动重试：bash $INSTALL_DIR/openclaw-ops/setup.sh --force"
    fi
  fi

  set -e

  echo ""
  info "后续步骤:"
  info "  1. openclaw gateway start"
  info "  2. openclaw system heartbeat enable"
}

# ─── 完成 ─────────────────────────────────────────────────

show_result() {
  local ver; ver=$(node -e "console.log(require('${INSTALL_DIR}/package.json').version)" 2>/dev/null || echo "?")
  echo ""
  echo -e "${G}╔══════════════════════════════════════════════╗${N}"
  echo -e "${G}║${B}        部署完成 — v${ver}                    ${G}║${N}"
  echo -e "${G}╚══════════════════════════════════════════════╝${N}"
  echo ""
  echo -e "   面板:  ${C}https://${DOMAIN}${N}"
  echo -e "   后台:  ${C}https://${DOMAIN}/admin${N}"
  echo -e "   目录:  ${INSTALL_DIR}"
  echo ""
  echo -e "  ${Y} 首个注册用户自动成为管理员${N}"
  echo -e "  ${Y} 进入后台 → 设置 → 配置 SMTP 后才能注册${N}"
  echo ""
  echo -e "  常用命令:"
  echo -e "    pm2 logs vless-panel       ${C}# 查看日志${N}"
  echo -e "    pm2 restart vless-panel    ${C}# 重启${N}"
  echo -e "    cd ${INSTALL_DIR} && git pull && npm i --omit=dev && pm2 restart vless-panel  ${C}# 更新${N}"
  echo ""
}

# ─── 主流程 ───────────────────────────────────────────────

main() {
  banner
  preflight
  install_deps
  install_node
  install_pm2
  deploy_code
  configure_env
  setup_ssl && setup_nginx
  setup_pm2
  setup_openclaw
  show_result
}

main "$@"
