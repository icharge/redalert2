#!/usr/bin/env bash
#
# Install the RA2Web WOL/gserv server as a systemd service (Ubuntu).
#
# Usage:
#   sudo ./install-service.sh
#
# Run from the server directory (the directory containing this script and
# src/). The service runs the server in place - nothing is copied, and the
# working directory stays where you launched it from. Remove the service
# again with ./uninstall-service.sh.
#
# What it does:
#   - installs bun if not already present (system-wide)
#   - creates a system user "ra2web" (no login)
#   - creates .env from .env.example (edit this file to configure; real
#     environment variables beat .env files; .env.local layers on top)
#   - installs /etc/systemd/system/ra2web.service with:
#       systemctl start/stop/status/restart ra2web
#       systemctl reload ra2web   -> hot reload, keeps connections/games
#   - enables the service so it starts at boot
#
# After editing .env:  sudo systemctl reload ra2web
# Settings that need a restart (port, external URL, storage, payload caps)
# are logged on reload and require:    sudo systemctl restart ra2web
#
# The service user "ra2web" only gets write access to data/, replays/ and
# logs/; the rest of the directory stays owned by you.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=ra2web
SVC_USER=ra2web
ENV_FILE=$SCRIPT_DIR/.env
UNIT_FILE=/etc/systemd/system/$APP.service

if [[ $EUID -ne 0 ]]; then
    echo "error: run with sudo: sudo $0" >&2
    exit 1
fi

if [[ ! -f "$SCRIPT_DIR/src/index.ts" ]]; then
    echo "error: $SCRIPT_DIR does not look like the server directory (src/index.ts missing)" >&2
    echo "run this script from the directory containing src/" >&2
    exit 1
fi

if [[ "$SCRIPT_DIR" == /home/* ]]; then
    echo "warning: server lives under /home; the unit uses ProtectHome=true and would fail to read it."
    echo "         move the directory out of /home (e.g. /opt/ra2web) or remove ProtectHome from $UNIT_FILE."
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

# --- system user -------------------------------------------------------------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    echo "creating system user $SVC_USER"
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC_USER"
fi

# The service user only gets write access to data/, replays/ and logs/.
mkdir -p "$SCRIPT_DIR/data" "$SCRIPT_DIR/replays" "$SCRIPT_DIR/logs"
chown -R "$SVC_USER:$SVC_USER" "$SCRIPT_DIR/data" "$SCRIPT_DIR/replays" "$SCRIPT_DIR/logs"

# --- environment file --------------------------------------------------------
# The server reads .env (then .env.local) from its own directory at startup
# and on reload, so no EnvironmentFile= is needed in the unit. The service
# user must be able to read it; only data/, replays/ and logs/ are writable.
if [[ ! -f "$ENV_FILE" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
    echo "created $ENV_FILE - EDIT IT NOW (at minimum EXTERNAL_URL and GLOBAL_CHANNEL_PASS)"
fi
chown root:root "$ENV_FILE"
chmod 644 "$ENV_FILE"

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
WorkingDirectory=$SCRIPT_DIR
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
ReadWritePaths=$SCRIPT_DIR/data $SCRIPT_DIR/replays $SCRIPT_DIR/logs
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
echo "server files (not copied): $SCRIPT_DIR"
echo "data:     $SCRIPT_DIR/data (ra2web.sqlite)"
echo "replays:  $SCRIPT_DIR/replays"
echo "config:   $ENV_FILE"
echo "logs:     $SCRIPT_DIR/logs/server.log (rotating) and journalctl -u $APP -f"
echo "reload:   sudo systemctl reload $APP   (keeps all connections and game sessions)"
echo "restart:  sudo systemctl restart $APP (needed for port/URL/storage changes)"
echo "uninstall: sudo $SCRIPT_DIR/uninstall-service.sh [--purge]"
echo
systemctl --no-pager --lines 8 status "$APP" || true
