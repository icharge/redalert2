#!/usr/bin/env bash
#
# Remove the RA2Web systemd service (Ubuntu).
#
# Usage:
#   sudo ./scripts/uninstall-server.sh          # stop+disable service, keep files
#   sudo ./scripts/uninstall-server.sh --purge  # also delete /opt/ra2web,
#                                               # /etc/ra2web and the ra2web user
#                                               # (data + replays are LOST)

set -euo pipefail

APP=ra2web
SVC_USER=ra2web
INSTALL_DIR=${1:-/opt/ra2web}
CONF_DIR=/etc/ra2web
UNIT_FILE=/etc/systemd/system/$APP.service

if [[ $EUID -ne 0 ]]; then
    echo "error: run with sudo: sudo $0 ${1:-}" >&2
    exit 1
fi

systemctl stop "$APP" 2>/dev/null || true
systemctl disable "$APP" 2>/dev/null || true
rm -f "$UNIT_FILE"
systemctl daemon-reload

echo "service $APP stopped, disabled and removed."

if [[ "${1:-}" == "--purge" ]]; then
    rm -rf "$INSTALL_DIR" "$CONF_DIR"
    userdel -r "$SVC_USER" 2>/dev/null || true
    echo "purged $INSTALL_DIR, $CONF_DIR and user $SVC_USER (data and replays deleted)."
else
    echo "files kept: $INSTALL_DIR (data: $INSTALL_DIR/server/data, replays: $INSTALL_DIR/server/replays)"
    echo "config kept: $CONF_DIR/ra2web.env"
    echo "to also delete them, re-run with --purge."
fi
