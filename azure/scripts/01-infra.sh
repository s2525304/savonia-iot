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

echo "============================================================"
echo "Azure infrastructure bootstrap"
echo
echo "Subscription : $AZURE_SUBSCRIPTION_ID"
echo "Location     : $AZURE_LOCATION"
echo "Resource grp : $AZURE_RESOURCE_GROUP"
echo "============================================================"
echo

# Ensure Azure CLI is logged in
if ! az account show >/dev/null 2>&1; then
	echo "Not logged in to Azure CLI."
	echo "Run: az login"
	exit 1
fi


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
echo "Container    : $BLOB_CONTAINER"
echo "Queues       : $QUEUE_BLOB_BATCH , $QUEUE_ALERTS"
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

# Blob container (idempotent)
az storage container create \
	--name "$BLOB_CONTAINER" \
	--connection-string "$STORAGE_CONNECTION_STRING" >/dev/null

# Queues (idempotent)
az storage queue create --name "$QUEUE_BLOB_BATCH" --connection-string "$STORAGE_CONNECTION_STRING" >/dev/null
az storage queue create --name "$QUEUE_ALERTS" --connection-string "$STORAGE_CONNECTION_STRING" >/dev/null

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
	"EVENTHUB_CONNECTION_STRING=$EVENTHUB_CONNECTION_STRING" \
	"EVENTHUB_NAME=$EVENTHUB_NAME" \
	"EVENTHUB_CONSUMERGROUP=$EVENTHUB_CONSUMERGROUP_INGEST" \
	"QUEUE_BLOB_BATCH=$QUEUE_BLOB_BATCH" \
	"QUEUE_ALERTS=$QUEUE_ALERTS" \
	"BLOB_CONTAINER=$BLOB_CONTAINER" \
	"TIMESCALE_CONNECTION_STRING=$TIMESCALE_CONNECTION_STRING" \
	"TIMESCALE_RETENTION_DAYS=$TIMESCALE_RETENTION_DAYS" \
	>/dev/null

echo "Function App configuration applied."

echo
echo "Infra step 01 completed."