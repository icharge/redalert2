#!/usr/bin/env bash
#
# Install the RA2Web WOL/gserv server as a systemd service (Ubuntu).
#
# Usage:
#   sudo ./install-server.sh [install-dir]
#
# Run from the uploaded server/ directory on the server (the directory
# containing this script and src/). By default the server is installed to
# /opt/ra2web and the service is named "ra2web". Running from /opt/ra2web
# itself skips the copy.
#
# What it does:
#   - copies server/ to <install-dir>/server (rsync --delete if available)
#   - creates a system user "ra2web" (no login)
#   - creates /etc/ra2web/ra2web.env from server/.env.example (edit this file
#     to configure; environment variables beat .env files)
#   - installs /etc/systemd/system/ra2web.service with:
#       systemctl start/stop/status/restart ra2web
#       systemctl reload ra2web   -> hot reload, keeps connections/games
#   - enables the service so it starts at boot
#
# After editing /etc/ra2web/ra2web.env:  sudo systemctl reload ra2web
# Settings that need a restart (port, external URL, storage, payload caps)
# are logged on reload and require:    sudo systemctl restart ra2web

set -euo pipefail

APP=ra2web
SVC_USER=ra2web
INSTALL_DIR=${1:-/opt/ra2web}
CONF_DIR=/etc/ra2web
ENV_FILE=$CONF_DIR/ra2web.env
UNIT_FILE=/etc/systemd/system/$APP.service
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
    echo "error: run with sudo: sudo $0 ${1:-}" >&2
    exit 1
fi

# --- bun runtime -------------------------------------------------------------
BUN_BIN=${BUN_BIN:-$(command -v bun || true)}
if [[ -z "$BUN_BIN" ]]; then
    echo "bun not found; installing to /usr/local/bin (system-wide) ..."
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
    BUN_BIN=/usr/local/bin/bun
fi
BUN_BIN="$(readlink -f "$BUN_BIN")"
echo "using bun: $BUN_BIN ($($BUN_BIN --version))"

# --- copy the server ----------------------------------------------------------
SRC_DIR="$SCRIPT_DIR"
if [[ "$(readlink -f "$SRC_DIR")" == "$(readlink -f "$INSTALL_DIR/server")" ]]; then
    echo "server already at $INSTALL_DIR/server (running from the install location); skipping copy"
else
    echo "installing server files -> $INSTALL_DIR/server"
    mkdir -p "$INSTALL_DIR"
    if command -v rsync >/dev/null 2>&1; then
        rsync -a --delete --exclude node_modules --exclude data --exclude replays \
            "$SRC_DIR/" "$INSTALL_DIR/server/"
    else
        cp -a "$SRC_DIR" "$INSTALL_DIR/"
        echo "note: rsync not found; used cp (stale files are not removed on reinstall)"
    fi
fi

# --- system user -------------------------------------------------------------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    echo "creating system user $SVC_USER"
    useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi
mkdir -p "$INSTALL_DIR/server/data" "$INSTALL_DIR/server/replays"
chown -R "$SVC_USER:$SVC_USER" "$INSTALL_DIR"

# --- environment file --------------------------------------------------------
mkdir -p "$CONF_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
    echo "created $ENV_FILE - EDIT IT NOW (at minimum EXTERNAL_URL and GLOBAL_CHANNEL_PASS)"
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

# --- systemd unit -------------------------------------------------------------
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=RA2Web WOL lobby and gserv server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$INSTALL_DIR/server
EnvironmentFile=$ENV_FILE
ExecStart=$BUN_BIN run src/index.ts
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR/server/data $INSTALL_DIR/server/replays
RestrictSUIDSGID=true
RestrictRealtime=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$APP" >/dev/null
systemctl restart "$APP"

echo
echo "installed and running: systemctl status $APP"
echo "logs:   journalctl -u $APP -f"
echo "reload: sudo systemctl reload $APP   (keeps all connections and game sessions)"
echo "restart: sudo systemctl restart $APP (needed for port/URL/storage changes)"
echo
systemctl --no-pager --lines 8 status "$APP" || true
