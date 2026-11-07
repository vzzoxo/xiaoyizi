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
  retry 3 apk add --no-cache curl unzip jq ca-certificates openrc iproute2 iptables openssh-sftp-server
  mkdir -p /usr/local/bin /usr/local/etc/xray /usr/local/share/xray
  if ! command -v xray >/dev/null 2>&1; then
    case "$(uname -m)" in
      x86_64) asset=Xray-linux-64.zip; digest=e4bd9119f50ae7c41658b1abd0679ae06f98bd864a2907ff33f2f2cf7081b214 ;;
      aarch64) asset=Xray-linux-arm64-v8a.zip; digest=1811c8f1da0c3b6dc707ebaf1c8390e987ba39859a8f0a7aadd8526157f2ec8d ;;
      *) echo "Unsupported Alpine architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    archive=$(mktemp)
    trap 'rm -f "$archive"' EXIT HUP INT TERM
    curl -fL --retry 3 --retry-delay 2 "https://github.com/XTLS/Xray-core/releases/download/v26.10.31/$asset" -o "$archive"
    printf '%s  %s\n' "$digest" "$archive" | sha256sum -c -
    unzip -p "$archive" xray > /usr/local/bin/xray
    chmod 755 /usr/local/bin/xray
    # The generated panel configs do not use geodata; avoid installing unused databases on small NAT disks.
  fi
  xray_bin=$(command -v xray)
  cat > /etc/init.d/xray <<SERVICEEOF
#!/sbin/openrc-run
name="xray"
command="$xray_bin"
command_args="run -config /usr/local/etc/xray/config.json"
supervisor="supervise-daemon"
respawn_delay=5
respawn_max=0
output_log="/var/log/xray.log"
error_log="/var/log/xray.log"
depend() {
  need net
}
SERVICEEOF
  chmod 755 /etc/init.d/xray
  echo "INSTALL_OK"
  exit 0
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "install-xray: unsupported OS (requires apt-get or apk)" >&2
  exit 1
fi

# 某些云主机会遇到 apt 临时锁或镜像瞬断，这里做轻量重试并保留错误输出。
retry 3 apt-get update -y
retry 3 apt-get install -y curl unzip jq ca-certificates

if ! command -v xray >/dev/null 2>&1; then
  install_script="$(mktemp)"
  curl -fsSL --retry 3 --retry-delay 2 \
    https://github.com/XTLS/Xray-install/raw/e741a4f56d368afbb9e5be3361b40c4552d3710d/install-release.sh \
    -o "$install_script"
  bash "$install_script" install
  rm -f "$install_script"
fi

command -v xray >/dev/null 2>&1 || { echo "install-xray: xray binary missing after install" >&2; exit 1; }
echo "INSTALL_OK"
