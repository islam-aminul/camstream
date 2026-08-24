#!/usr/bin/env bash
# Removes the service. Keeps configuration and device identity unless --purge.
set -euo pipefail
SERVICE=camstream-agent
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

systemctl disable --now "$SERVICE" 2>/dev/null || true
rm -f "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
rm -rf /opt/camstream

if [ "${1:-}" = "--purge" ]; then
  # This destroys the device's credential key. Camera credentials cannot be
  # recovered afterwards — they must be re-entered in the admin UI.
  rm -rf /etc/camstream /var/lib/camstream
  userdel camstream 2>/dev/null || true
  echo "Purged. Camera credentials will need to be re-entered."
else
  echo "Removed. Configuration and device identity kept; use --purge to delete them."
fi
