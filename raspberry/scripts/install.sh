#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# Configurable defaults
# -----------------------------
# Try to auto-detect repo root using git; fall back to script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if git_root=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null); then
	REPO_ROOT_DEFAULT="$git_root"
else
	# scripts/ -> raspberry/ -> repo root
	REPO_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

CONFIG_DEFAULT="$REPO_ROOT_DEFAULT/raspberry/config/config.json"
SYSTEMD_DIR="/etc/systemd/system"
ENV_FILE="/var/lib/savonia-iot/.env"

# -----------------------------
# Args
# -----------------------------
REPO_ROOT="${1:-$REPO_ROOT_DEFAULT}"
CONFIG_PATH="${2:-$CONFIG_DEFAULT}"

if [[ ! -d "$REPO_ROOT" ]]; then
	echo "ERROR: Repo root not found: $REPO_ROOT"
	exit 1
fi

if [[ ! -x "/usr/bin/node" ]]; then
	echo "ERROR: /usr/bin/node not found. Install Node.js system-wide (NodeSource recommended) so systemd can run services." >&2
	echo "Try: sudo apt install -y nodejs" >&2
	exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
	echo "ERROR: Config not found: $CONFIG_PATH"
	exit 1
fi

# -----------------------------
# IoT Hub connection string (.env for systemd services)
# -----------------------------
if [[ -z "${IOT_HUB_CONNECTION_STRING:-}" ]]; then
	echo "IOT_HUB_CONNECTION_STRING is not set in the environment."
	read -r -s -p "Enter IOT_HUB_CONNECTION_STRING (input hidden): " IOT_HUB_CONNECTION_STRING
	echo ""
	if [[ -z "$IOT_HUB_CONNECTION_STRING" ]]; then
		echo "ERROR: IOT_HUB_CONNECTION_STRING cannot be empty"
		exit 1
	fi
fi

echo "Writing env file: $ENV_FILE"
sudo mkdir -p "$(dirname "$ENV_FILE")"
echo "IOT_HUB_CONNECTION_STRING=$IOT_HUB_CONNECTION_STRING" | sudo tee "$ENV_FILE" >/dev/null
sudo chmod 600 "$ENV_FILE"
sudo chown pi:pi "$ENV_FILE"

echo "Repo root : $REPO_ROOT"
echo "Config    : $CONFIG_PATH"

# -----------------------------
# Build (assumes node/npm already installed)
# -----------------------------
echo "Installing dependencies and building..."
cd "$REPO_ROOT"
npm ci
npm run -w raspberry build

# -----------------------------
# Create runtime directories (best effort)
# -----------------------------
echo "Creating runtime directories..."
sudo mkdir -p /var/lib/savonia-iot /var/log/savonia-iot
sudo chown -R pi:pi /var/lib/savonia-iot /var/log/savonia-iot

# -----------------------------
# Install base unit files
# -----------------------------
echo "Installing systemd unit templates..."
sudo cp "$REPO_ROOT/raspberry/scripts/systemd/savonia-iot-transferrer.service" "$SYSTEMD_DIR/"
sudo cp "$REPO_ROOT/raspberry/scripts/systemd/savonia-iot-sensor@.service" "$SYSTEMD_DIR/"

# Patch WorkingDirectory and config path inside the two base units
# - WorkingDirectory must match the actual clone location (REPO_ROOT)
# - --config path must match CONFIG_PATH
sudo sed -i "s|^WorkingDirectory=.*$|WorkingDirectory=$REPO_ROOT|" "$SYSTEMD_DIR/savonia-iot-transferrer.service"
sudo sed -i "s|^WorkingDirectory=.*$|WorkingDirectory=$REPO_ROOT|" "$SYSTEMD_DIR/savonia-iot-sensor@.service"

sudo sed -i "s|--config .*config.json|--config $CONFIG_PATH|g" "$SYSTEMD_DIR/savonia-iot-transferrer.service"
sudo sed -i "s|--config .*config.json|--config $CONFIG_PATH|g" "$SYSTEMD_DIR/savonia-iot-sensor@.service"

# Ensure services load environment variables from the shared env file
for unit in "$SYSTEMD_DIR/savonia-iot-transferrer.service" "$SYSTEMD_DIR/savonia-iot-sensor@.service"; do
	if ! sudo grep -q "^EnvironmentFile=$ENV_FILE$" "$unit"; then
		# Insert right after [Service]
		sudo sed -i "/^\[Service\]/a EnvironmentFile=$ENV_FILE" "$unit"
	fi
done

# -----------------------------
# Generate transferrer timer (start on boot)
# -----------------------------
echo "Generating transferrer timer..."
cat <<EOF | sudo tee "$SYSTEMD_DIR/savonia-iot-transferrer.timer" >/dev/null
[Unit]
Description=Savonia IoT - Start Measurement Transferrer on boot

[Timer]
OnBootSec=15s
AccuracySec=1s
Unit=savonia-iot-transferrer.service

[Install]
WantedBy=timers.target
EOF

# -----------------------------
# Generate per-sensor timers from config.json
# -----------------------------
echo "Generating per-sensor timers from config..."

SENSOR_LIST_JSON="$(node -e "
const fs=require('fs');
const cfg=JSON.parse(fs.readFileSync('$CONFIG_PATH','utf8'));
if(!cfg.sensors || !Array.isArray(cfg.sensors)) { process.exit(2); }
const out = cfg.sensors.map(s => ({ sensorId: s.sensorId, intervalMs: s.intervalMs }));
process.stdout.write(JSON.stringify(out));
")"

# Validate we got something sensible
if [[ -z "$SENSOR_LIST_JSON" ]]; then
	echo "ERROR: Failed to read sensors from config"
	exit 1
fi

# Remove old generated timers
echo "Removing old generated sensor timer units..."
sudo rm -f "$SYSTEMD_DIR/savonia-iot-sensor-"*.timer

# Create a timer for each sensorId
node -e "
const sensors = JSON.parse(process.argv[1]);
for (const s of sensors) {
	if (!s.sensorId) throw new Error('sensorId missing');
	if (!s.intervalMs || s.intervalMs <= 0) throw new Error('intervalMs missing/invalid for ' + s.sensorId);

	const unitName = 'savonia-iot-sensor-' + s.sensorId + '.timer';
	const serviceInstance = 'savonia-iot-sensor@' + s.sensorId + '.service';

	// systemd supports ms suffix (e.g. 60000ms)
	const timer = [
		'[Unit]',
		'Description=Savonia IoT - Run sensor ' + s.sensorId,
		'',
		'[Timer]',
		'OnBootSec=15s',
		'OnUnitActiveSec=' + s.intervalMs + 'ms',
		'AccuracySec=1s',
		'Unit=' + serviceInstance,
		'',
		'[Install]',
		'WantedBy=timers.target',
		''
	].join('\\n');

	console.log('@@UNIT ' + unitName);
	process.stdout.write(timer + '\\n');
	console.log('@@END');
}
" "$SENSOR_LIST_JSON" | while IFS= read -r line; do
	if [[ "$line" == @@UNIT* ]]; then
		UNIT_NAME="${line#@@UNIT }"
		UNIT_PATH="$SYSTEMD_DIR/$UNIT_NAME"
		CONTENT=""
		continue
	fi

	if [[ "$line" == "@@END" ]]; then
		if [[ -z "${UNIT_NAME:-}" ]]; then
			echo "ERROR: encountered @@END without @@UNIT" >&2
			exit 1
		fi
		echo "Writing $UNIT_PATH"
		echo "$CONTENT" | sudo tee "$UNIT_PATH" >/dev/null
		unset UNIT_NAME
		unset UNIT_PATH
		CONTENT=""
		continue
	fi

	# Accumulate content lines
	if [[ -n "${UNIT_NAME:-}" ]]; then
		CONTENT+="$line"$'\n'
	fi
done

# Cleanup accidental broken unit files from older buggy installer (best effort)
sudo rm -f "$SYSTEMD_DIR/[Unit]" "$SYSTEMD_DIR/[Timer]" "$SYSTEMD_DIR/[Install]" 2>/dev/null || true

# -----------------------------
# Reload systemd and enable services
# -----------------------------
echo "Reloading systemd..."
sudo systemctl daemon-reload

echo "Enabling and starting transferrer timer..."
sudo systemctl enable --now savonia-iot-transferrer.timer

echo "Enabling and starting sensor timers..."
for timer in $(ls "$SYSTEMD_DIR"/savonia-iot-sensor-*.timer 2>/dev/null | xargs -n1 basename); do
	sudo systemctl enable --now "$timer"
done

echo ""
echo "Install complete."
echo "Check status:"
echo "  systemctl status savonia-iot-transferrer.service"
echo "  systemctl status savonia-iot-transferrer.timer"
echo "  systemctl list-timers | grep savonia"
echo "Logs:"
echo "  journalctl -u savonia-iot-transferrer.service -f"