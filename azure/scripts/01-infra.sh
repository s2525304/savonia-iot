#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------------------
# Azure infrastructure bootstrap
# Step 1: Ensure Resource Group exists
# ------------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../azure.env"


require_var() {
	local name="$1"
	if [[ -z "${!name:-}" ]]; then
		echo "ERROR: Required environment variable '$name' is not set."
		echo "Please set it in azure.env (copy from azure.env.example)."
		exit 1
	fi
}

# ------------------------------------------------------------------------------
# Tooling preflight (fail fast)
# ------------------------------------------------------------------------------

require_cmd() {
	local cmd="$1"
	local install_hint="$2"
	if ! command -v "$cmd" >/dev/null 2>&1; then
		echo "ERROR: Required tool '$cmd' is not installed or not on PATH."
		echo "$install_hint"
		exit 1
	fi
}

# Azure CLI
require_cmd "az" "Install Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli"


# Python 3 (used to update local.settings.json)
require_cmd "python3" "Install Python 3: https://www.python.org/downloads/ (or via Homebrew: brew install python)"

# zip (used to deploy Function App code via zipdeploy)
require_cmd "zip" "Install zip (macOS: brew install zip; Ubuntu/Debian: sudo apt-get install zip)"

# Required by the Postgres firewall rule helper below
# (we use curl primarily; dig is accepted as a fallback)
if ! command -v curl >/dev/null 2>&1 && ! command -v dig >/dev/null 2>&1; then
	echo "ERROR: Either 'curl' or 'dig' is required to detect your current public IP (for Postgres firewall rule)."
	echo "Install curl (recommended): https://curl.se/download.html"
	echo "Or install dig via dnsutils/bind-tools (e.g. on macOS: brew install bind)"
	exit 1
fi

# Sanity-check Azure CLI can actually run
if ! az version >/dev/null 2>&1; then
	echo "ERROR: Azure CLI is installed but failed to run 'az version'."
	echo "Try reinstalling Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli"
	exit 1
fi

# Optional but helpful: fail fast if not logged in
if ! az account show >/dev/null 2>&1; then
	echo "ERROR: Not logged in to Azure CLI."
	echo "Run: az login"
	exit 1
fi

# Optional but helpful: ensure the expected subscription is at least visible
# (This avoids failing later after provisioning work.)
if ! az account list --query "[?id=='${AZURE_SUBSCRIPTION_ID}'].id" -o tsv 2>/dev/null | grep -q "${AZURE_SUBSCRIPTION_ID}"; then
	echo "ERROR: AZURE_SUBSCRIPTION_ID '${AZURE_SUBSCRIPTION_ID}' was not found in 'az account list'."
	echo "Verify you are logged in to the correct tenant/subscription, then re-run: az login"
	exit 1
fi

# ------------------------------------------------------------------------------
# Validate all required env vars early (fail fast)
# ------------------------------------------------------------------------------

# Azure / general
require_var AZURE_SUBSCRIPTION_ID
require_var AZURE_LOCATION
require_var AZURE_RESOURCE_GROUP

# IoT Hub
require_var IOTHUB_NAME
require_var IOTHUB_SKU
require_var IOTHUB_UNITS

# Event Hub
require_var EVENTHUB_NAMESPACE
require_var EVENTHUB_NAME
require_var EVENTHUB_SKU
require_var EVENTHUB_PARTITIONS
require_var EVENTHUB_CONSUMERGROUP_INGEST
require_var EVENTHUB_CONSUMERGROUP_EXTRA

# Storage / Function App
require_var FUNCTIONAPP_STORAGE_ACCOUNT
require_var FUNCTIONAPP_NAME
require_var FUNCTIONAPP_NODE_VERSION
require_var FUNCTIONAPP_FUNCTIONS_VERSION
# Cold storage (Blob)
require_var COLD_CONTAINER
# Optional cold storage settings
COLD_PREFIX="${COLD_PREFIX:-telemetry}"
COLD_GZIP="${COLD_GZIP:-false}"

# Queues
require_var QUEUE_BLOB_BATCH
require_var QUEUE_ALERTS
require_var QUEUE_DB_WRITE

# Timescale / PostgreSQL
require_var POSTGRES_TIER
require_var POSTGRES_HOST
require_var POSTGRES_PORT
require_var POSTGRES_DATABASE
require_var POSTGRES_USER
require_var POSTGRES_PASSWORD
require_var POSTGRES_SSLMODE
require_var POSTGRES_LOCATION
require_var POSTGRES_VERSION
require_var TIMESCALE_RETENTION_DAYS

# HTTP API
require_var HTTP_API_KEY

# Optional: comma-separated list of allowed authenticated users (e.g. GitHub usernames)
HTTP_ALLOWED_USERS="${HTTP_ALLOWED_USERS:-}"

# Optional: SWA-linked JWT auth for HTTP APIs (Option A)
# If SWA_NAME is provided, we can derive issuer/audience/jwksUri automatically.
SWA_NAME="${SWA_NAME:-}"
HTTP_JWT_ISSUER="${HTTP_JWT_ISSUER:-}"
HTTP_JWT_AUDIENCE="${HTTP_JWT_AUDIENCE:-}"
HTTP_JWKS_URI="${HTTP_JWKS_URI:-}"

# Derive JWT settings from SWA if possible (only when not explicitly set)
# - issuer  : https://<swa-host>/.auth
# - jwksUri : https://<swa-host>/.auth/keys
# - audience: https://<functionapp>.azurewebsites.net
if [[ -n "$SWA_NAME" ]]; then
	SWA_DEFAULT_HOSTNAME="$(az staticwebapp show -g "$AZURE_RESOURCE_GROUP" -n "$SWA_NAME" --query defaultHostname -o tsv 2>/dev/null || echo "")"
	if [[ -n "$SWA_DEFAULT_HOSTNAME" ]]; then
		if [[ -z "$HTTP_JWT_ISSUER" ]]; then
			HTTP_JWT_ISSUER="https://${SWA_DEFAULT_HOSTNAME}/.auth"
		fi
		if [[ -z "$HTTP_JWKS_URI" ]]; then
			HTTP_JWKS_URI="https://${SWA_DEFAULT_HOSTNAME}/.auth/keys"
		fi
		if [[ -z "$HTTP_JWT_AUDIENCE" ]]; then
			HTTP_JWT_AUDIENCE="https://${FUNCTIONAPP_NAME}.azurewebsites.net"
		fi
	else
		echo "WARNING: Could not resolve SWA defaultHostname for SWA_NAME='$SWA_NAME'. JWT auth env vars will not be derived."
	fi
fi

# Extra safety: prevent accidentally deploying with placeholder password
if [[ "$POSTGRES_PASSWORD" == "CHANGE_ME" ]]; then
	echo "ERROR: POSTGRES_PASSWORD is set to 'CHANGE_ME'."
	echo "Please set a real password in azure.env before running this script."
	exit 1
fi

# Extra safety: prevent accidentally deploying with placeholder HTTP API key
if [[ "$HTTP_API_KEY" == "CHANGE_ME" ]]; then
	echo "ERROR: HTTP_API_KEY is set to 'CHANGE_ME'."
	echo "Please set a real key in azure.env before running this script."
	exit 1
fi

# If any JWT settings are configured, require all 3.
# (They are typically derived from SWA_NAME, but can be set manually.)
if [[ -n "${HTTP_JWT_ISSUER}" || -n "${HTTP_JWT_AUDIENCE}" || -n "${HTTP_JWKS_URI}" ]]; then
	if [[ -z "${HTTP_JWT_ISSUER}" || -z "${HTTP_JWT_AUDIENCE}" || -z "${HTTP_JWKS_URI}" ]]; then
		echo "ERROR: Partial JWT config. If using SWA JWT auth, set all of: HTTP_JWT_ISSUER, HTTP_JWT_AUDIENCE, HTTP_JWKS_URI (or set SWA_NAME so they are derived)."
		exit 1
	fi
fi

echo "============================================================"
echo "Azure infrastructure bootstrap"
echo
echo "Subscription : $AZURE_SUBSCRIPTION_ID"
echo "Location     : $AZURE_LOCATION"
echo "Resource grp : $AZURE_RESOURCE_GROUP"
echo "============================================================"
echo



# Select subscription
az account set --subscription "$AZURE_SUBSCRIPTION_ID"

# Ensure required Azure CLI extensions are installed (non-interactive)
# This avoids the script pausing for confirmation prompts.
ensure_extension() {
	local ext="$1"
	if az extension show --name "$ext" >/dev/null 2>&1; then
		return 0
	fi
	echo "Installing Azure CLI extension: $ext"
	az extension add --name "$ext" --only-show-errors >/dev/null
}

# Needed for: az postgres flexible-server execute/connect (SQL file execution)
ensure_extension "rdbms-connect"

# Needed for: az iot hub ... (IoT Hub commands)
ensure_extension "azure-iot"

# Create resource group if missing
if az group show --name "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "Resource group already exists: $AZURE_RESOURCE_GROUP"
else
	echo "The script will CREATE the resource group if it does not exist."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Creating resource group: $AZURE_RESOURCE_GROUP"
	az group create \
		--name "$AZURE_RESOURCE_GROUP" \
		--location "$AZURE_LOCATION"
	echo "Resource group created."
fi

echo

echo "------------------------------------------------------------"
echo "IoT Hub"
echo "Name        : $IOTHUB_NAME"
echo "SKU / Units : $IOTHUB_SKU / $IOTHUB_UNITS"
echo "------------------------------------------------------------"

if az iot hub show --name "$IOTHUB_NAME" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "IoT Hub already exists: $IOTHUB_NAME"
else
	echo "The script will CREATE the IoT Hub listed above."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	# Ensure IoT Hub resource provider is registered (one-time per subscription)
	state="$(az provider show --namespace Microsoft.Devices --query registrationState -o tsv 2>/dev/null || echo "")"
	if [[ "$state" != "Registered" ]]; then
		echo "Registering Azure resource provider: Microsoft.Devices (current state: ${state:-unknown})"
		az provider register --namespace Microsoft.Devices >/dev/null

		for i in $(seq 1 24); do
			state="$(az provider show --namespace Microsoft.Devices --query registrationState -o tsv 2>/dev/null || echo "")"
			if [[ "$state" == "Registered" ]]; then
				echo "Microsoft.Devices provider registered."
				break
			fi
			echo "Waiting for Microsoft.Devices registration... ($i/24)"
			sleep 5
		done

		if [[ "$state" != "Registered" ]]; then
			echo "ERROR: Microsoft.Devices provider is not Registered (state: ${state:-unknown})."
			echo "Try again later or register manually: az provider register --namespace Microsoft.Devices"
			exit 1
		fi
	fi

	echo "Creating IoT Hub: $IOTHUB_NAME"
	az iot hub create \
		--name "$IOTHUB_NAME" \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--location "$AZURE_LOCATION" \
		--sku "$IOTHUB_SKU" \
		--unit "$IOTHUB_UNITS"

	echo "IoT Hub created."
fi

echo

echo "------------------------------------------------------------"
echo "Event Hub"
echo "Namespace   : $EVENTHUB_NAMESPACE"
echo "Event Hub   : $EVENTHUB_NAME"
echo "SKU         : $EVENTHUB_SKU"
echo "Partitions  : $EVENTHUB_PARTITIONS"
echo "CG (ingest) : $EVENTHUB_CONSUMERGROUP_INGEST"
echo "CG (extra)  : $EVENTHUB_CONSUMERGROUP_EXTRA"
echo "------------------------------------------------------------"

# Ensure Event Hubs resource provider is registered (one-time per subscription)
eh_state="$(az provider show --namespace Microsoft.EventHub --query registrationState -o tsv 2>/dev/null || echo "")"
if [[ "$eh_state" != "Registered" ]]; then
	echo "The script will REGISTER Azure resource provider: Microsoft.EventHub (required for Event Hubs)."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Registering Azure resource provider: Microsoft.EventHub (current state: ${eh_state:-unknown})"
	az provider register --namespace Microsoft.EventHub >/dev/null

	for i in $(seq 1 24); do
		eh_state="$(az provider show --namespace Microsoft.EventHub --query registrationState -o tsv 2>/dev/null || echo "")"
		if [[ "$eh_state" == "Registered" ]]; then
			echo "Microsoft.EventHub provider registered."
			break
		fi
		echo "Waiting for Microsoft.EventHub registration... ($i/24)"
		sleep 5
	done

	if [[ "$eh_state" != "Registered" ]]; then
		echo "ERROR: Microsoft.EventHub provider is not Registered (state: ${eh_state:-unknown})."
		echo "Try again later or register manually: az provider register --namespace Microsoft.EventHub"
		exit 1
	fi
fi

# Event Hubs namespace
if az eventhubs namespace show --name "$EVENTHUB_NAMESPACE" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "Event Hubs namespace already exists: $EVENTHUB_NAMESPACE"
else
	echo "The script will CREATE the Event Hubs namespace listed above."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Creating Event Hubs namespace: $EVENTHUB_NAMESPACE"
	az eventhubs namespace create \
		--name "$EVENTHUB_NAMESPACE" \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--location "$AZURE_LOCATION" \
		--sku "$EVENTHUB_SKU" >/dev/null
	echo "Event Hubs namespace created."
fi

# Event Hub
if az eventhubs eventhub show --name "$EVENTHUB_NAME" --namespace-name "$EVENTHUB_NAMESPACE" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "Event Hub already exists: $EVENTHUB_NAME"
else
	echo "The script will CREATE the Event Hub listed above."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Creating Event Hub: $EVENTHUB_NAME"
	az eventhubs eventhub create \
		--name "$EVENTHUB_NAME" \
		--namespace-name "$EVENTHUB_NAMESPACE" \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--partition-count "$EVENTHUB_PARTITIONS" >/dev/null
	echo "Event Hub created."
fi

# Consumer groups (non-destructive; create if missing)
if ! az eventhubs eventhub consumer-group show \
		--name "$EVENTHUB_CONSUMERGROUP_INGEST" \
		--eventhub-name "$EVENTHUB_NAME" \
		--namespace-name "$EVENTHUB_NAMESPACE" \
		--resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "Creating consumer group: $EVENTHUB_CONSUMERGROUP_INGEST"
	az eventhubs eventhub consumer-group create \
		--name "$EVENTHUB_CONSUMERGROUP_INGEST" \
		--eventhub-name "$EVENTHUB_NAME" \
		--namespace-name "$EVENTHUB_NAMESPACE" \
		--resource-group "$AZURE_RESOURCE_GROUP" >/dev/null
fi

if ! az eventhubs eventhub consumer-group show \
		--name "$EVENTHUB_CONSUMERGROUP_EXTRA" \
		--eventhub-name "$EVENTHUB_NAME" \
		--namespace-name "$EVENTHUB_NAMESPACE" \
		--resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "Creating consumer group: $EVENTHUB_CONSUMERGROUP_EXTRA"
	az eventhubs eventhub consumer-group create \
		--name "$EVENTHUB_CONSUMERGROUP_EXTRA" \
		--eventhub-name "$EVENTHUB_NAME" \
		--namespace-name "$EVENTHUB_NAMESPACE" \
		--resource-group "$AZURE_RESOURCE_GROUP" >/dev/null
fi

# ------------------------------------------------------------
# IoT Hub routing: send all DeviceMessages to Event Hub
# ------------------------------------------------------------
ROUTING_ENDPOINT_NAME="telemetryEventHub"
ROUTE_NAME="telemetryToEventHub"

# Build a connection string that includes the EntityPath (required by IoT Hub endpoint)
EVENTHUB_CONNECTION_STRING="$(az eventhubs namespace authorization-rule keys list \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--namespace-name "$EVENTHUB_NAMESPACE" \
	--name RootManageSharedAccessKey \
	--query primaryConnectionString -o tsv)"

# IoT Hub routing endpoint requires EntityPath for the target Event Hub
if [[ "$EVENTHUB_CONNECTION_STRING" != *"EntityPath="* ]]; then
	EH_CONN="${EVENTHUB_CONNECTION_STRING};EntityPath=${EVENTHUB_NAME}"
else
	EH_CONN="$EVENTHUB_CONNECTION_STRING"
fi

# Create routing endpoint if missing.
# Some Azure CLI versions can fail to "show" an endpoint even when a name is already taken.
# So we also check for name collisions across all endpoint types.
endpoint_type_found=""

# Fast path: eventhub endpoint exists
if az iot hub routing-endpoint show \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--hub-name "$IOTHUB_NAME" \
		--endpoint-name "$ROUTING_ENDPOINT_NAME" \
		--endpoint-type eventhub >/dev/null 2>&1; then
	endpoint_type_found="eventhub"
else
	# Fallback: look for an endpoint with the same name in any endpoint type
	for t in eventhub servicebusqueue servicebustopic azurestoragecontainer; do
		count="$(az iot hub routing-endpoint list \
			--resource-group "$AZURE_RESOURCE_GROUP" \
			--hub-name "$IOTHUB_NAME" \
			--endpoint-type "$t" \
			--query "length([?name=='${ROUTING_ENDPOINT_NAME}'])" -o tsv 2>/dev/null || echo "0")"
		if [[ "$count" != "0" ]]; then
			endpoint_type_found="$t"
			break
		fi
	done
fi

if [[ -n "$endpoint_type_found" ]]; then
	if [[ "$endpoint_type_found" == "eventhub" ]]; then
		echo "IoT Hub routing endpoint already exists: $ROUTING_ENDPOINT_NAME"
	else
		echo "ERROR: IoT Hub routing endpoint name '$ROUTING_ENDPOINT_NAME' is already in use for endpoint type '$endpoint_type_found'."
		echo "Please delete/rename that endpoint or change ROUTING_ENDPOINT_NAME in the script."
		exit 1
	fi
else
	echo "The script will CONFIGURE IoT Hub routing endpoint '$ROUTING_ENDPOINT_NAME' to Event Hub '$EVENTHUB_NAME'."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Creating IoT Hub routing endpoint: $ROUTING_ENDPOINT_NAME"
	az iot hub routing-endpoint create \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--hub-name "$IOTHUB_NAME" \
		--endpoint-name "$ROUTING_ENDPOINT_NAME" \
		--endpoint-type eventhub \
		--endpoint-resource-group "$AZURE_RESOURCE_GROUP" \
		--endpoint-subscription-id "$AZURE_SUBSCRIPTION_ID" \
		--connection-string "$EH_CONN" >/dev/null
	echo "IoT Hub routing endpoint created."
fi

# Create route if missing
if az iot hub route show \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--hub-name "$IOTHUB_NAME" \
		--name "$ROUTE_NAME" >/dev/null 2>&1; then
	echo "IoT Hub route already exists: $ROUTE_NAME"
else
	echo "The script will CREATE IoT Hub route '$ROUTE_NAME' to send all device messages to '$ROUTING_ENDPOINT_NAME'."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Creating IoT Hub route: $ROUTE_NAME"
	az iot hub route create \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--hub-name "$IOTHUB_NAME" \
		--name "$ROUTE_NAME" \
		--source-type DeviceMessages \
		--endpoint-name "$ROUTING_ENDPOINT_NAME" \
		--enabled true \
		--condition "true" >/dev/null
	echo "IoT Hub route created."
fi

echo

# ----------------- TimescaleDB / PostgreSQL (Azure Flexible Server) -----------------

echo

echo "------------------------------------------------------------"
echo "TimescaleDB / PostgreSQL (Azure Flexible Server)"
echo "Host        : $POSTGRES_HOST"
echo "Database    : $POSTGRES_DATABASE"
echo "User        : $POSTGRES_USER"
echo "Location    : $POSTGRES_LOCATION"
echo "Version     : $POSTGRES_VERSION"
echo "Tier        : $POSTGRES_TIER"
echo "Retention   : ${TIMESCALE_RETENTION_DAYS} days"
echo "------------------------------------------------------------"

# Ensure PostgreSQL resource provider is registered (one-time per subscription)
pgprov_state="$(az provider show --namespace Microsoft.DBforPostgreSQL --query registrationState -o tsv 2>/dev/null || echo "")"
if [[ "$pgprov_state" != "Registered" ]]; then
	echo "The script will REGISTER Azure resource provider: Microsoft.DBforPostgreSQL (required for PostgreSQL Flexible Server)."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Registering Azure resource provider: Microsoft.DBforPostgreSQL (current state: ${pgprov_state:-unknown})"
	az provider register --namespace Microsoft.DBforPostgreSQL >/dev/null

	for i in $(seq 1 24); do
		pgprov_state="$(az provider show --namespace Microsoft.DBforPostgreSQL --query registrationState -o tsv 2>/dev/null || echo "")"
		if [[ "$pgprov_state" == "Registered" ]]; then
			echo "Microsoft.DBforPostgreSQL provider registered."
			break
		fi
		echo "Waiting for Microsoft.DBforPostgreSQL registration... ($i/24)"
		sleep 5
	done

	if [[ "$pgprov_state" != "Registered" ]]; then
		echo "ERROR: Microsoft.DBforPostgreSQL provider is not Registered (state: ${pgprov_state:-unknown})."
		echo "Try again later or register manually: az provider register --namespace Microsoft.DBforPostgreSQL"
		exit 1
	fi
fi

# Derive server name from POSTGRES_HOST (first label)
POSTGRES_SERVER_NAME="${POSTGRES_HOST%%.*}"

# Azure Flexible Server admin username cannot contain '@'
POSTGRES_ADMIN_USER="${POSTGRES_USER%@*}"

# Map POSTGRES_TIER -> Azure tier/SKU defaults
PG_TIER=""
PG_SKU=""
PG_STORAGE_GB=""
PG_BACKUP_DAYS="7"

case "$POSTGRES_TIER" in
	dev)
		# Cheapest option: Burstable tier
		PG_TIER="Burstable"
		PG_SKU="Standard_B1ms"
		PG_STORAGE_GB="32"
		;;
	prod)
		# Production default: GeneralPurpose tier
		PG_TIER="GeneralPurpose"
		# Use a known-valid SKU for GeneralPurpose
		PG_SKU="standard_d2s_v3"
		PG_STORAGE_GB="128"
		;;
	*)
		echo "ERROR: Invalid POSTGRES_TIER '$POSTGRES_TIER'. Allowed: dev, prod"
		exit 1
		;;
esac

# Create PostgreSQL Flexible Server if missing
if az postgres flexible-server show --name "$POSTGRES_SERVER_NAME" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "PostgreSQL Flexible Server already exists: $POSTGRES_SERVER_NAME"
else
	echo "The script will CREATE the PostgreSQL Flexible Server listed above."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Creating PostgreSQL Flexible Server: $POSTGRES_SERVER_NAME"
	# NOTE: We enable public access for simplicity; tighten later if needed.
	az postgres flexible-server create \
		--name "$POSTGRES_SERVER_NAME" \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--location "$POSTGRES_LOCATION" \
		--admin-user "$POSTGRES_ADMIN_USER" \
		--admin-password "$POSTGRES_PASSWORD" \
		--tier "$PG_TIER" \
		--sku-name "$PG_SKU" \
		--storage-size "$PG_STORAGE_GB" \
		--backup-retention "$PG_BACKUP_DAYS" \
		--version "$POSTGRES_VERSION" \
		--public-access 0.0.0.0 >/dev/null
	echo "PostgreSQL Flexible Server created."
fi


# Allow the current public IP to reach Postgres (helps local development and schema install)
CURRENT_IP=""
if command -v curl >/dev/null 2>&1; then
	CURRENT_IP="$(curl -s https://api.ipify.org || true)"
elif command -v dig >/dev/null 2>&1; then
	CURRENT_IP="$(dig +short myip.opendns.com @resolver1.opendns.com 2>/dev/null | tail -n 1)"
fi

if [[ "$CURRENT_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "Configuring Postgres firewall rule for current IP: $CURRENT_IP"
	az postgres flexible-server firewall-rule create \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--name "$POSTGRES_SERVER_NAME" \
		--rule-name "allow-current-ip" \
		--start-ip-address "$CURRENT_IP" \
		--end-ip-address "$CURRENT_IP" >/dev/null
else
	echo "WARNING: Could not determine current public IP (curl/dig missing or lookup failed)."
	echo "You may need to add a firewall rule manually:"
	echo "  az postgres flexible-server firewall-rule create -g $AZURE_RESOURCE_GROUP -n $POSTGRES_SERVER_NAME --rule-name allow-current-ip --start-ip-address <IP> --end-ip-address <IP>"
fi

# Ensure database exists
if az postgres flexible-server db show \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--server-name "$POSTGRES_SERVER_NAME" \
		--database-name "$POSTGRES_DATABASE" >/dev/null 2>&1; then
	echo "Database already exists: $POSTGRES_DATABASE"
else
	echo "Creating database: $POSTGRES_DATABASE"
	az postgres flexible-server db create \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--server-name "$POSTGRES_SERVER_NAME" \
		--database-name "$POSTGRES_DATABASE" >/dev/null
fi


# Ensure TimescaleDB is allowlisted and preloaded (required on Azure Flexible Server)
needs_restart=false

current_azure_ext="$(az postgres flexible-server parameter show \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--server-name "$POSTGRES_SERVER_NAME" \
	--name azure.extensions \
	--query value -o tsv 2>/dev/null || echo "")"

if [[ ",${current_azure_ext}," != *",timescaledb,"* ]]; then
	new_azure_ext="$current_azure_ext"
	new_azure_ext="${new_azure_ext#,}"
	new_azure_ext="${new_azure_ext%,}"
	if [[ -n "$new_azure_ext" ]]; then
		new_azure_ext="${new_azure_ext},timescaledb"
	else
		new_azure_ext="timescaledb"
	fi
	echo "Allowlisting TimescaleDB extension via azure.extensions"
	az postgres flexible-server parameter set \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--server-name "$POSTGRES_SERVER_NAME" \
		--name azure.extensions \
		--value "$new_azure_ext" >/dev/null
	needs_restart=true
fi

current_preload="$(az postgres flexible-server parameter show \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--server-name "$POSTGRES_SERVER_NAME" \
	--name shared_preload_libraries \
	--query value -o tsv 2>/dev/null || echo "")"

if [[ ",${current_preload}," != *",timescaledb,"* ]]; then
	new_preload="$current_preload"
	new_preload="${new_preload#,}"
	new_preload="${new_preload%,}"
	if [[ -n "$new_preload" ]]; then
		new_preload="${new_preload},timescaledb"
	else
		new_preload="timescaledb"
	fi
	echo "Adding timescaledb to shared_preload_libraries"
	az postgres flexible-server parameter set \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--server-name "$POSTGRES_SERVER_NAME" \
		--name shared_preload_libraries \
		--value "$new_preload" >/dev/null
	needs_restart=true
fi

if [[ "$needs_restart" == true ]]; then
	echo "Restarting PostgreSQL Flexible Server to apply Timescale settings..."
	az postgres flexible-server restart \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--name "$POSTGRES_SERVER_NAME" >/dev/null
	# Give the server a moment to come back
	sleep 20
fi

# Install schema from SQL files (idempotent)
TIMESCALE_DIR="$SCRIPT_DIR/../timescale"
if [[ ! -d "$TIMESCALE_DIR" ]]; then
	echo "ERROR: Timescale SQL directory not found: $TIMESCALE_DIR"
	echo "Expected to find *.sql files under azure/timescale/"
	exit 1
fi

sql_files=(
	"01_init_extensions.sql"
	"02_init_schema.sql"
	"03_init_indexes.sql"
	"04_init_aggregates.sql"
	"05_init_alerts.sql"
)

for f in "${sql_files[@]}"; do
	path="$TIMESCALE_DIR/$f"
	if [[ ! -f "$path" ]]; then
		echo "ERROR: Missing SQL file: $path"
		exit 1
	fi
	echo "Applying schema: $f"
	az postgres flexible-server execute \
		-n "$POSTGRES_SERVER_NAME" \
		-u "$POSTGRES_ADMIN_USER" \
		-p "$POSTGRES_PASSWORD" \
		-d "$POSTGRES_DATABASE" \
		-f "$path" >/dev/null

done

echo "Schema applied."

# Build a libpq-style connection string for the Function App (less fragile than URL encoding)
TIMESCALE_CONNECTION_STRING="host=$POSTGRES_HOST port=$POSTGRES_PORT dbname=$POSTGRES_DATABASE user=$POSTGRES_USER password=$POSTGRES_PASSWORD sslmode=$POSTGRES_SSLMODE"

echo

echo "------------------------------------------------------------"
echo "Function App"
echo "Storage acct : $FUNCTIONAPP_STORAGE_ACCOUNT"
echo "Function App : $FUNCTIONAPP_NAME"
echo "Node         : $FUNCTIONAPP_NODE_VERSION"
echo "Functions    : v$FUNCTIONAPP_FUNCTIONS_VERSION"
echo "SWA name     : ${SWA_NAME:-<none>}"
echo "JWT issuer   : ${HTTP_JWT_ISSUER:-<none>}"
echo "JWT audience : ${HTTP_JWT_AUDIENCE:-<none>}"
echo "JWKS URI     : ${HTTP_JWKS_URI:-<none>}"
echo "Cold container: $COLD_CONTAINER"
echo "Queues       : $QUEUE_BLOB_BATCH , $QUEUE_ALERTS , $QUEUE_DB_WRITE"
echo "------------------------------------------------------------"

# Ensure Storage resource provider is registered (one-time per subscription)
st_state="$(az provider show --namespace Microsoft.Storage --query registrationState -o tsv 2>/dev/null || echo "")"
if [[ "$st_state" != "Registered" ]]; then
	echo "The script will REGISTER Azure resource provider: Microsoft.Storage (required for Storage Accounts)."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Registering Azure resource provider: Microsoft.Storage (current state: ${st_state:-unknown})"
	az provider register --namespace Microsoft.Storage >/dev/null

	for i in $(seq 1 24); do
		st_state="$(az provider show --namespace Microsoft.Storage --query registrationState -o tsv 2>/dev/null || echo "")"
		if [[ "$st_state" == "Registered" ]]; then
			echo "Microsoft.Storage provider registered."
			break
		fi
		echo "Waiting for Microsoft.Storage registration... ($i/24)"
		sleep 5
	done

	if [[ "$st_state" != "Registered" ]]; then
		echo "ERROR: Microsoft.Storage provider is not Registered (state: ${st_state:-unknown})."
		echo "Try again later or register manually: az provider register --namespace Microsoft.Storage"
		exit 1
	fi
fi

# Ensure Web/Functions resource provider is registered (one-time per subscription)
web_state="$(az provider show --namespace Microsoft.Web --query registrationState -o tsv 2>/dev/null || echo "")"
if [[ "$web_state" != "Registered" ]]; then
	echo "The script will REGISTER Azure resource provider: Microsoft.Web (required for Function Apps)."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Registering Azure resource provider: Microsoft.Web (current state: ${web_state:-unknown})"
	az provider register --namespace Microsoft.Web >/dev/null

	for i in $(seq 1 24); do
		web_state="$(az provider show --namespace Microsoft.Web --query registrationState -o tsv 2>/dev/null || echo "")"
		if [[ "$web_state" == "Registered" ]]; then
			echo "Microsoft.Web provider registered."
			break
		fi
		echo "Waiting for Microsoft.Web registration... ($i/24)"
		sleep 5
	done

	if [[ "$web_state" != "Registered" ]]; then
		echo "ERROR: Microsoft.Web provider is not Registered (state: ${web_state:-unknown})."
		echo "Try again later or register manually: az provider register --namespace Microsoft.Web"
		exit 1
	fi
fi

# Storage account for Function App
if az storage account show --name "$FUNCTIONAPP_STORAGE_ACCOUNT" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "Storage account already exists: $FUNCTIONAPP_STORAGE_ACCOUNT"
else
	echo "The script will CREATE the Storage Account listed above (required for the Function App)."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Creating Storage account: $FUNCTIONAPP_STORAGE_ACCOUNT"
	az storage account create \
		--name "$FUNCTIONAPP_STORAGE_ACCOUNT" \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--location "$AZURE_LOCATION" \
		--sku Standard_LRS \
		--kind StorageV2 >/dev/null
	echo "Storage account created."
fi

STORAGE_CONNECTION_STRING="$(az storage account show-connection-string \
	--name "$FUNCTIONAPP_STORAGE_ACCOUNT" \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--query connectionString -o tsv)"

# Cold storage container (idempotent)
az storage container create \
	--name "$COLD_CONTAINER" \
	--connection-string "$STORAGE_CONNECTION_STRING" >/dev/null

# Queues (idempotent)
az storage queue create --name "$QUEUE_BLOB_BATCH" --connection-string "$STORAGE_CONNECTION_STRING" >/dev/null
az storage queue create --name "$QUEUE_ALERTS" --connection-string "$STORAGE_CONNECTION_STRING" >/dev/null
az storage queue create --name "$QUEUE_DB_WRITE" --connection-string "$STORAGE_CONNECTION_STRING" >/dev/null

# Function App
if az functionapp show --name "$FUNCTIONAPP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
	echo "Function App already exists: $FUNCTIONAPP_NAME"
else
	echo "The script will CREATE the Function App listed above."
	echo "Press Ctrl+C within the next 10 seconds to abort."
	echo
	sleep 10

	echo "Creating Function App: $FUNCTIONAPP_NAME"
	az functionapp create \
		--name "$FUNCTIONAPP_NAME" \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--storage-account "$FUNCTIONAPP_STORAGE_ACCOUNT" \
		--consumption-plan-location "$AZURE_LOCATION" \
		--functions-version "$FUNCTIONAPP_FUNCTIONS_VERSION" \
		--runtime node \
		--runtime-version "$FUNCTIONAPP_NODE_VERSION" >/dev/null
	echo "Function App created."
fi

# Configure Function App settings (safe to re-run)
# Note: EVENTHUB_CONNECTION_STRING is fetched earlier in this script.
az functionapp config appsettings set \
	--name "$FUNCTIONAPP_NAME" \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--settings \
	"AzureWebJobsStorage=$STORAGE_CONNECTION_STRING" \
	"HTTP_API_KEY=$HTTP_API_KEY" \
	"HTTP_ALLOWED_USERS=$HTTP_ALLOWED_USERS" \
	"HTTP_JWT_ISSUER=$HTTP_JWT_ISSUER" \
	"HTTP_JWT_AUDIENCE=$HTTP_JWT_AUDIENCE" \
	"HTTP_JWKS_URI=$HTTP_JWKS_URI" \
	"SWA_NAME=$SWA_NAME" \
	"EVENTHUB_CONNECTION_STRING=$EVENTHUB_CONNECTION_STRING" \
	"EVENTHUB_NAME=$EVENTHUB_NAME" \
	"EVENTHUB_CONSUMERGROUP=$EVENTHUB_CONSUMERGROUP_INGEST" \
	"QUEUE_BLOB_BATCH=$QUEUE_BLOB_BATCH" \
	"QUEUE_ALERTS=$QUEUE_ALERTS" \
	"QUEUE_DB_WRITE=$QUEUE_DB_WRITE" \
	"COLD_STORAGE_CONNECTION_STRING=$STORAGE_CONNECTION_STRING" \
	"COLD_CONTAINER=$COLD_CONTAINER" \
	"COLD_PREFIX=$COLD_PREFIX" \
	"COLD_GZIP=$COLD_GZIP" \
	"POSTGRES_HOST=$POSTGRES_HOST" \
	"POSTGRES_PORT=$POSTGRES_PORT" \
	"POSTGRES_DATABASE=$POSTGRES_DATABASE" \
	"POSTGRES_USER=$POSTGRES_USER" \
	"POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
	"POSTGRES_SSLMODE=$POSTGRES_SSLMODE" \
	"TIMESCALE_RETENTION_DAYS=$TIMESCALE_RETENTION_DAYS" \
	>/dev/null


echo "Function App configuration applied."

echo

echo "------------------------------------------------------------"
echo "Deploy Function App code"
echo "Source dir   : $SCRIPT_DIR/../functions"
echo "Remote build : enabled (Oryx)"
echo "------------------------------------------------------------"

FUNCTIONS_CODE_DIR="$SCRIPT_DIR/../functions"

if [[ ! -d "$FUNCTIONS_CODE_DIR" ]]; then
	echo "ERROR: Function App code directory not found: $FUNCTIONS_CODE_DIR"
	echo "Expected the Function App source under ../functions relative to this script."
	exit 1
fi

if [[ ! -f "$FUNCTIONS_CODE_DIR/host.json" ]]; then
	echo "ERROR: host.json not found under: $FUNCTIONS_CODE_DIR"
	echo "This does not look like an Azure Functions app root."
	exit 1
fi

# Enable remote build (Oryx) on deployment
# NOTE: These settings are required for zipdeploy remote builds on Linux Function Apps.
az functionapp config appsettings set \
	--name "$FUNCTIONAPP_NAME" \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--settings \
	"SCM_DO_BUILD_DURING_DEPLOYMENT=1" \
	"ENABLE_ORYX_BUILD=1" \
	>/dev/null

# Create a deployment zip (exclude local-only and heavy folders)
DEPLOY_ZIP="${SCRIPT_DIR}/.functionapp-deploy.zip"
rm -f "$DEPLOY_ZIP"

(
	cd "$FUNCTIONS_CODE_DIR"
	# Exclusions:
	# - node_modules (remote build restores)
	# - local.settings.json (local dev)
	# - git metadata and OS cruft
	zip -r "$DEPLOY_ZIP" . \
		-x "node_modules/*" \
		-x ".git/*" \
		-x "local.settings.json" \
		-x "**/*.log" \
		-x "**/.DS_Store" \
		>/dev/null
)

# Deploy with zipdeploy. Prefer --build-remote if supported by this az version.
# If not supported, the SCM_DO_BUILD_DURING_DEPLOYMENT/ENABLE_ORYX_BUILD settings above will still trigger remote build.
set +e
az functionapp deployment source config-zip \
	--name "$FUNCTIONAPP_NAME" \
	--resource-group "$AZURE_RESOURCE_GROUP" \
	--src "$DEPLOY_ZIP" \
	--build-remote true \
	>/dev/null
zipdeploy_rc=$?
set -e

if [[ $zipdeploy_rc -ne 0 ]]; then
	echo "NOTE: 'az functionapp deployment source config-zip --build-remote' failed (older az?). Retrying without --build-remote..."
	az functionapp deployment source config-zip \
		--name "$FUNCTIONAPP_NAME" \
		--resource-group "$AZURE_RESOURCE_GROUP" \
		--src "$DEPLOY_ZIP" \
		>/dev/null
fi

rm -f "$DEPLOY_ZIP"

echo "Function App deployment triggered."

#
# ------------------------------------------------------------------------------
# Local development: write/merge required settings into ../functions/local.settings.json
# ------------------------------------------------------------------------------
LOCAL_SETTINGS_DIR="$SCRIPT_DIR/../functions"
LOCAL_SETTINGS_FILE="$LOCAL_SETTINGS_DIR/local.settings.json"

mkdir -p "$LOCAL_SETTINGS_DIR"

COLD_STORAGE_CONNECTION_STRING="$STORAGE_CONNECTION_STRING"
export LOCAL_SETTINGS_FILE HTTP_API_KEY HTTP_ALLOWED_USERS HTTP_JWT_ISSUER HTTP_JWT_AUDIENCE HTTP_JWKS_URI SWA_NAME STORAGE_CONNECTION_STRING EVENTHUB_CONNECTION_STRING EVENTHUB_NAME EVENTHUB_CONSUMERGROUP_INGEST \
	QUEUE_BLOB_BATCH QUEUE_ALERTS QUEUE_DB_WRITE \
	COLD_STORAGE_CONNECTION_STRING COLD_CONTAINER COLD_PREFIX COLD_GZIP \
	POSTGRES_HOST POSTGRES_PORT POSTGRES_DATABASE POSTGRES_USER POSTGRES_PASSWORD POSTGRES_SSLMODE TIMESCALE_RETENTION_DAYS
python3 - <<'PY'
import json
import os

path = os.environ["LOCAL_SETTINGS_FILE"]

# Keys managed by this script (only these are updated/overwritten)
managed = {
	"AzureWebJobsStorage": os.environ.get("STORAGE_CONNECTION_STRING", ""),
	"HTTP_API_KEY": os.environ.get("HTTP_API_KEY", ""),
	"HTTP_ALLOWED_USERS": os.environ.get("HTTP_ALLOWED_USERS", ""),
	"HTTP_JWT_ISSUER": os.environ.get("HTTP_JWT_ISSUER", ""),
	"HTTP_JWT_AUDIENCE": os.environ.get("HTTP_JWT_AUDIENCE", ""),
	"HTTP_JWKS_URI": os.environ.get("HTTP_JWKS_URI", ""),
	"SWA_NAME": os.environ.get("SWA_NAME", ""),
	"EVENTHUB_CONNECTION_STRING": os.environ.get("EVENTHUB_CONNECTION_STRING", ""),
	"EVENTHUB_NAME": os.environ.get("EVENTHUB_NAME", ""),
	"EVENTHUB_CONSUMERGROUP": os.environ.get("EVENTHUB_CONSUMERGROUP_INGEST", ""),
	"QUEUE_BLOB_BATCH": os.environ.get("QUEUE_BLOB_BATCH", ""),
	"QUEUE_ALERTS": os.environ.get("QUEUE_ALERTS", ""),
	"QUEUE_DB_WRITE": os.environ.get("QUEUE_DB_WRITE", ""),
	"COLD_STORAGE_CONNECTION_STRING": os.environ.get("COLD_STORAGE_CONNECTION_STRING", ""),
	"COLD_CONTAINER": os.environ.get("COLD_CONTAINER", ""),
	"COLD_PREFIX": os.environ.get("COLD_PREFIX", ""),
	"COLD_GZIP": os.environ.get("COLD_GZIP", ""),
	"POSTGRES_HOST": os.environ.get("POSTGRES_HOST", ""),
	"POSTGRES_PORT": os.environ.get("POSTGRES_PORT", ""),
	"POSTGRES_DATABASE": os.environ.get("POSTGRES_DATABASE", ""),
	"POSTGRES_USER": os.environ.get("POSTGRES_USER", ""),
	"POSTGRES_PASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),
	"POSTGRES_SSLMODE": os.environ.get("POSTGRES_SSLMODE", ""),
	"TIMESCALE_RETENTION_DAYS": os.environ.get("TIMESCALE_RETENTION_DAYS", ""),
}

# Basic sanity: don't accidentally write empty required values
required = [
	"AzureWebJobsStorage",
	"HTTP_API_KEY",
	"EVENTHUB_CONNECTION_STRING",
	"EVENTHUB_NAME",
	"QUEUE_BLOB_BATCH",
	"QUEUE_ALERTS",
	"QUEUE_DB_WRITE",
]
missing = [k for k in required if not managed.get(k)]
if missing:
	raise SystemExit(f"ERROR: Cannot write local.settings.json; missing values for: {', '.join(missing)}")

# Load existing JSON if present
if os.path.exists(path):
	with open(path, "r", encoding="utf-8") as f:
		try:
			data = json.load(f)
		except json.JSONDecodeError:
			# If file exists but is invalid, start fresh rather than silently corrupting
			raise SystemExit(f"ERROR: {path} exists but is not valid JSON")
else:
	data = {}

# Preserve other top-level keys
if "IsEncrypted" not in data:
	data["IsEncrypted"] = False

values = data.get("Values")
if not isinstance(values, dict):
	values = {}

# Merge managed keys
for k, v in managed.items():
	values[k] = v

data["Values"] = values

with open(path, "w", encoding="utf-8") as f:
	json.dump(data, f, indent=2, ensure_ascii=False)
	f.write("\n")

print(f"Updated local settings: {path}")
PY

echo
echo "Infra step 01 completed."