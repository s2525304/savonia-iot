#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"

# Load base env
source "$SCRIPT_DIR/../azure.env"

# Load generated env (from previous scripts)
GENERATED_ENV="$SCRIPT_DIR/.generated.env"
if [[ -f "$GENERATED_ENV" ]]; then
	source "$GENERATED_ENV"
fi

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------

require_var() {
	local name="$1"
	if [[ -z "${!name:-}" ]]; then
		echo "ERROR: Required env var '$name' is not set" >&2
		exit 1
	fi
}

require_cmd() {
	local name="$1"
	command -v "$name" >/dev/null 2>&1 || {
		echo "ERROR: Required command '$name' not found in PATH" >&2
		exit 1
	}
}

ensure_extension() {
	local ext="$1"
	if ! az extension show --name "$ext" >/dev/null 2>&1; then
		echo "Installing Azure CLI extension: $ext"
		az extension add --name "$ext" --output none
	fi
}

# ------------------------------------------------------------------------------
# Preconditions
# ------------------------------------------------------------------------------

require_cmd az
require_cmd swa

require_var AZURE_SUBSCRIPTION_ID
require_var AZURE_RESOURCE_GROUP
require_var AZURE_LOCATION

require_var STATICWEBAPP_NAME
require_var STATICWEBAPP_SKU

# UI needs to call the backend. For your UI, same-origin /api is expected.
# Keep these explicit so you can change later without touching code.
API_BASE_PATH="${API_BASE_PATH:-/api}"

# Optional: set if your UI uses it (safe, non-secret)
APP_TITLE="${APP_TITLE:-Savonia IoT}"

# ------------------------------------------------------------------------------
# Azure context
# ------------------------------------------------------------------------------

echo "Using subscription: $AZURE_SUBSCRIPTION_ID"
az account set --subscription "$AZURE_SUBSCRIPTION_ID"

# Static Web Apps extension
ensure_extension staticwebapp

# ------------------------------------------------------------------------------
# Ensure Static Web App
# ------------------------------------------------------------------------------

if az staticwebapp show --name "$STATICWEBAPP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "Static Web App '$STATICWEBAPP_NAME' already exists."
else
	echo "WARNING: A new Azure Static Web App will be created."
	echo "  Name     : $STATICWEBAPP_NAME"
	echo "  Location : $AZURE_LOCATION"
	echo "  SKU      : $STATICWEBAPP_SKU"
	echo
	echo "Press Ctrl+C within the next 10 seconds to cancel."
	sleep 10

	echo "Creating Static Web App '$STATICWEBAPP_NAME'..."
	# Note: This creates the SWA resource. Source control integration can be added later.
	az staticwebapp create \
		--name "$STATICWEBAPP_NAME" \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--location "$AZURE_LOCATION" \
		--sku "$STATICWEBAPP_SKU" \
		--output none
	echo "Static Web App created."
fi

# ------------------------------------------------------------------------------
# App settings (environment variables)
# ------------------------------------------------------------------------------

managed_keys=(
	"API_BASE_PATH"
	"APP_TITLE"
)

settings_args=(
	"API_BASE_PATH=$API_BASE_PATH"
	"APP_TITLE=$APP_TITLE"
)

# NOTE: This overwrites values for these keys but does not delete other keys.
echo "Setting Static Web App environment variables (${#settings_args[@]})..."
# Azure CLI prints a noisy "App settings have been redacted..." message; capture and hide it.
if ! az staticwebapp appsettings set \
	--name "$STATICWEBAPP_NAME" \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--setting-names "${settings_args[@]}" \
	--output none >/dev/null 2>&1; then
	echo "ERROR: Failed to set Static Web App environment variables" >&2
	exit 1
fi

echo "Static Web App environment variables updated."

# ------------------------------------------------------------------------------
# Deploy UI (SWA CLI)
# ------------------------------------------------------------------------------

 # Resolve UI source directory relative to the script directory.
 # If STATICWEBAPP_SOURCE_DIR is a relative path (e.g. "webui"), treat it as relative to SCRIPT_DIR.
if [[ -n "${STATICWEBAPP_SOURCE_DIR:-}" ]]; then
	if [[ "$STATICWEBAPP_SOURCE_DIR" = /* ]]; then
		WEB_SRC_DIR="$STATICWEBAPP_SOURCE_DIR"
	else
		WEB_SRC_DIR="$SCRIPT_DIR/../$STATICWEBAPP_SOURCE_DIR"
	fi
else
	WEB_SRC_DIR="$SCRIPT_DIR/../webui"
fi
if [[ ! -d "$WEB_SRC_DIR" ]]; then
	echo "ERROR: UI source directory not found: $WEB_SRC_DIR" >&2
	echo "Set STATICWEBAPP_SOURCE_DIR to the correct folder and re-run." >&2
	exit 1
fi

# Get deployment token (apiKey)
DEPLOY_TOKEN="$(az staticwebapp secrets list \
	--name "$STATICWEBAPP_NAME" \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--query "properties.apiKey" \
	--output tsv)"

if [[ -z "$DEPLOY_TOKEN" ]]; then
	echo "ERROR: Failed to retrieve SWA deployment token." >&2
	exit 1
fi

# Deploy the static content. Your app is plain HTML/CSS/JS (no build step).
# We deploy the folder as-is.
echo "Deploying Static Web App content..."

SWA_CLI_DEPLOYMENT_TOKEN="$DEPLOY_TOKEN" \
	swa deploy "$WEB_SRC_DIR" \
		--api-location "$WEB_SRC_DIR/api" \
		--env production \
		--deployment-token "$DEPLOY_TOKEN" \
		--api-language node \
		--api-version 18 \
		--verbose

echo "UI deploy complete."

# ------------------------------------------------------------------------------
# List settings that exist in Azure but are not managed by this script
# ------------------------------------------------------------------------------

echo

echo "------------------------------------------------------------"
echo "Static Web App environment variables not managed by this script"
echo "(present in Azure, but not in managed_keys)"
echo "------------------------------------------------------------"

current_keys="$(az staticwebapp appsettings list \
	--name "$STATICWEBAPP_NAME" \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--query "[].name" \
	--output tsv | sort)"

managed_keys_sorted="$(printf "%s\n" "${managed_keys[@]}" | sort)"

extra_keys="$(comm -23 <(printf "%s\n" "$current_keys") <(printf "%s\n" "$managed_keys_sorted") || true)"

if [[ -z "${extra_keys// }" ]]; then
	echo "(none)"
else
	echo "$extra_keys"
fi

echo

echo "Static Web App setup complete."

# Print the SWA URL as the last line
SWA_HOSTNAME="$(az staticwebapp show \
	--name "$STATICWEBAPP_NAME" \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--query "defaultHostname" \
	--output tsv)"

if [[ -n "$SWA_HOSTNAME" ]]; then
	echo "UI URL: https://$SWA_HOSTNAME"
fi
