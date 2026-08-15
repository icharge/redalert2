#!/usr/bin/env bash
#
# Remove the RA2Web systemd service (Ubuntu).
#
# Usage:
#   sudo ./uninstall-service.sh          # stop+disable service, keep files
#   sudo ./uninstall-service.sh --purge  # also delete /etc/ra2web and the
#                                       # ra2web user (config is LOST)
#
# Server files are never touched; the service simply points at the directory
# this script runs from, so remove that directory yourself if you want it gone.

set -euo pipefail

APP=ra2web
SVC_USER=ra2web
CONF_DIR=/etc/ra2web
UNIT_FILE=/etc/systemd/system/$APP.service
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
    echo "error: run with sudo: sudo $0 ${1:-}" >&2
    exit 1
fi

systemctl stop "$APP" 2>/dev/null || true
systemctl disable "$APP" 2>/dev/null || true
rm -f "$UNIT_FILE"
systemctl daemon-reload

echo "service $APP stopped, disabled and removed."
echo "server files kept (untouched): $SCRIPT_DIR"

if [[ "${1:-}" == "--purge" ]]; then
    rm -rf "$CONF_DIR"
    userdel "$SVC_USER" 2>/dev/null || true
    echo "purged $CONF_DIR and user $SVC_USER (config lost)."
    echo "data and replays still at $SCRIPT_DIR/data, $SCRIPT_DIR/replays - delete manually if you want them gone."
else
    echo "config kept: $CONF_DIR/ra2web.env"
    echo "to also delete the config and user, re-run with --purge."
fi
