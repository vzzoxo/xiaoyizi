#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive

retry() {
  local max="$1"
  shift
  local i=1
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$i" -ge "$max" ]; then
      return 1
    fi
    i=$((i + 1))
    sleep 2
  done
}

if command -v apk >/dev/null 2>&1; then
  retry 3 apk add --no-cache curl openssl ca-certificates openrc iproute2 iptables openssh-sftp-server
  mkdir -p /usr/local/bin
  if ! command -v hysteria >/dev/null 2>&1; then
    case "$(uname -m)" in
      x86_64) asset=hysteria-linux-amd64; digest=907ba8c9693edb104b20582681fb7dc15639d5b64a9cbb616a7b539190a86691 ;;
      aarch64) asset=hysteria-linux-arm64; digest=a68a61a84452ca250ce0368202521965ca9cc9d801a404f1dc9008ac6cf677a7 ;;
      *) echo "Unsupported Alpine architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    binary=$(mktemp)
    trap 'rm -f "$binary"' EXIT HUP INT TERM
    curl -fL --retry 3 --retry-delay 2 "https://github.com/apernet/hysteria/releases/download/app/v2.13.0/$asset" -o "$binary"
    printf '%s  %s\n' "$digest" "$binary" | sha256sum -c -
    cp "$binary" /usr/local/bin/hysteria
    chmod 755 /usr/local/bin/hysteria
  fi
else
  retry 3 apt-get update -y
  retry 3 apt-get install -y curl openssl
  if ! command -v hysteria >/dev/null 2>&1; then
    install_script="$(mktemp)"
    curl -fsSL --retry 3 --retry-delay 2 https://get.hy2.sh/ -o "$install_script"
    bash "$install_script"
    rm -f "$install_script"
  fi
fi
command -v hysteria >/dev/null 2>&1 || { echo "install-hysteria: hysteria binary missing after install" >&2; exit 1; }

# 生成自签证书（10年有效期）
mkdir -p /etc/hysteria
if [ ! -f /etc/hysteria/cert.pem ]; then
  openssl ecparam -genkey -name prime256v1 -out /etc/hysteria/key.pem 2>/dev/null
  openssl req -new -x509 -days 3650 -key /etc/hysteria/key.pem -out /etc/hysteria/cert.pem -subj "/CN=bing.com" 2>/dev/null
fi
# 确保 hysteria 用户可读证书（官方安装器以 hysteria 用户运行）
chown root:root /etc/hysteria/key.pem /etc/hysteria/cert.pem
chmod 644 /etc/hysteria/cert.pem
chmod 600 /etc/hysteria/key.pem

if command -v apk >/dev/null 2>&1; then
  hysteria_bin=$(command -v hysteria)
  cat > /etc/init.d/hysteria-server <<SERVICEEOF
#!/sbin/openrc-run
name="hysteria-server"
command="$hysteria_bin"
command_args="server -c /etc/hysteria/config.yaml"
supervisor="supervise-daemon"
respawn_delay=5
respawn_max=0
output_log="/var/log/hysteria-server.log"
error_log="/var/log/hysteria-server.log"
depend() {
  need net
}
SERVICEEOF
  chmod 755 /etc/init.d/hysteria-server
else
# 覆盖 systemd service（官方安装器自带的以 hysteria 用户运行，我们统一用 root）
cat > /etc/systemd/system/hysteria-server.service << 'SERVICEEOF'
[Unit]
Description=Hysteria 2 Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria server -c /etc/hysteria/config.yaml
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
SERVICEEOF
systemctl daemon-reload
fi

echo "HY2_INSTALL_OK"
