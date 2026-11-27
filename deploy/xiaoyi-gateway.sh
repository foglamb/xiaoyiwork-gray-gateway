#!/usr/bin/env bash
set -euo pipefail
export HOME="${HOME:-/vol2/@appshare/Harness}"
APP_DIR="$HOME/.local/share/xiaoyiwork-gray-proxy"
DATA_DIR="$HOME/.config/xiaoyiwork-gray-proxy"
PID_FILE="$DATA_DIR/gateway.pid"
LOG_FILE="$DATA_DIR/gateway.log"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CONFIG="$DATA_DIR/config.json"
mkdir -p "$DATA_DIR"
# Report the address the panel is actually reachable on, without hardcoding one host.
panel_url() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
  printf 'http://%s:17356/' "${ip:-127.0.0.1}"
}
is_running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }
start() {
  if is_running; then echo "XiaoyiWork gateway already running (PID $(cat "$PID_FILE"))"; return; fi
  [[ -f "$CONFIG" ]] || { echo "Missing $CONFIG" >&2; exit 1; }
  XIAOYI_PROXY_CONFIG="$CONFIG" nohup "$NODE_BIN" "$APP_DIR/src/cli.mjs" --lan >>"$LOG_FILE" 2>&1 </dev/null &
  echo "$!" > "$PID_FILE"
  chmod 600 "$PID_FILE"
  for _ in {1..30}; do
    if curl -fsS --max-time 1 http://127.0.0.1:17356/healthz >/dev/null 2>&1; then
      echo "XiaoyiWork gateway started: $(panel_url)"
      exit 0
    fi
    if ! is_running; then echo "Gateway exited; see $LOG_FILE" >&2; exit 1; fi
    sleep 0.2
  done
  echo "Gateway is running but health check timed out; see $LOG_FILE" >&2
  exit 1
}
stop() {
  if ! is_running; then rm -f "$PID_FILE"; echo "XiaoyiWork gateway is not running"; return; fi
  kill "$(cat "$PID_FILE")"
  for _ in {1..30}; do is_running || break; sleep 0.2; done
  if is_running; then kill -KILL "$(cat "$PID_FILE")"; fi
  rm -f "$PID_FILE"
  echo "XiaoyiWork gateway stopped"
}
case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status)
    if is_running; then echo "running pid=$(cat "$PID_FILE") url=$(panel_url)"; curl -fsS --max-time 3 http://127.0.0.1:17356/healthz; echo; else echo "stopped"; exit 3; fi ;;
  logs) tail -n 100 "$LOG_FILE" ;;
  credentials) printf 'Credential file: %s/access.txt\n' "$DATA_DIR" ;;
  install-service)
    [[ $EUID -eq 0 ]] || { echo 'Run this command with sudo/root to enable boot persistence.' >&2; exit 1; }
    cp "$APP_DIR/xiaoyiwork-proxy.service" /etc/systemd/system/xiaoyiwork-proxy.service
    systemctl daemon-reload
    systemctl enable --now xiaoyiwork-proxy.service
    systemctl --no-pager --full status xiaoyiwork-proxy.service ;;
  *) echo 'Usage: xiaoyi-gateway {start|stop|restart|status|logs|credentials|install-service}' >&2; exit 2 ;;
esac
