#!/usr/bin/env bash
set -euo pipefail

SYSTEMD_DIR="/etc/systemd/system"

echo "Stopping and disabling services/timers..."

sudo systemctl disable --now savonia-iot-transferrer.service || true
sudo systemctl stop savonia-iot-sensor@*.service 2>/dev/null || true

for timer in $(ls "$SYSTEMD_DIR"/savonia-iot-sensor-*.timer 2>/dev/null | xargs -n1 basename); do
	sudo systemctl disable --now "$timer" || true
done

echo "Removing unit files..."
sudo rm -f "$SYSTEMD_DIR/savonia-iot-transferrer.service"
sudo rm -f "$SYSTEMD_DIR/savonia-iot-sensor@.service"
sudo rm -f "$SYSTEMD_DIR/savonia-iot-sensor-"*.timer

echo "Reloading systemd..."
sudo systemctl daemon-reload

echo "Uninstall complete."