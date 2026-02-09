#!/usr/bin/env bash
set -euo pipefail

SYSTEMD_DIR="/etc/systemd/system"
ENV_FILE="/etc/savonia-iot/env"

echo "Stopping and disabling services/timers..."

# Stop/disable timers first (they may re-trigger services)
sudo systemctl disable --now savonia-iot-transferrer.timer 2>/dev/null || true

# Stop/disable services (including any instantiated sensor services)
sudo systemctl disable --now savonia-iot-transferrer.service 2>/dev/null || true
sudo systemctl stop savonia-iot-sensor@*.service 2>/dev/null || true

# Stop/disable per-sensor timers generated from config
for timer in $(ls "$SYSTEMD_DIR"/savonia-iot-sensor-*.timer 2>/dev/null | xargs -n1 basename); do
	sudo systemctl disable --now "$timer" 2>/dev/null || true
done

echo "Removing unit files..."
# Base units
sudo rm -f "$SYSTEMD_DIR/savonia-iot-transferrer.service"
sudo rm -f "$SYSTEMD_DIR/savonia-iot-transferrer.timer"
sudo rm -f "$SYSTEMD_DIR/savonia-iot-sensor@.service"

# Generated per-sensor timers
sudo rm -f "$SYSTEMD_DIR/savonia-iot-sensor-"*.timer

echo "Reloading systemd..."
sudo systemctl daemon-reload

# Remove env directory if empty
if sudo test -d "$(dirname "$ENV_FILE")"; then
	if [ -z "$(sudo ls -A "$(dirname "$ENV_FILE")")" ]; then
		sudo rmdir "$(dirname "$ENV_FILE")"
	fi
fi

# Remove shared env file (contains secrets)
if sudo test -f "$ENV_FILE"; then
	echo "Removing env file: $ENV_FILE"
	sudo rm -f "$ENV_FILE"
fi

# Optional: remove runtime directories if empty (best effort)
for d in /var/lib/savonia-iot /var/log/savonia-iot; do
	if sudo test -d "$d" && [ -z "$(sudo ls -A "$d")" ]; then
		sudo rmdir "$d" || true
	fi
done

echo "Uninstall complete."