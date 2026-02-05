#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"

usage() {
	cat <<'EOF'
Usage:
	./azure.sh              Run full infra: 10,20,30,40,50,60
	./azure.sh func         Run only Function App deploy (50)
	./azure.sh swa          Run only Static Web App deploy (60)
	./azure.sh func swa     Run Function App (50) then Static Web App (60)
	./azure.sh swa func     Same as above

Notes:
	- Scripts are run from this directory.
	- This wrapper fails fast if any step fails.
EOF
}

run_step() {
	local script="$1"
	if [[ ! -f "$SCRIPT_DIR/$script" ]]; then
		echo "ERROR: Missing script: $SCRIPT_DIR/$script" >&2
		exit 1
	fi

	echo
	echo "============================================================"
	echo "Running: $script"
	echo "============================================================"
	bash "$SCRIPT_DIR/$script"
	echo "Done: $script"
}

main() {
	local run_full=true
	local want_func=false
	local want_swa=false

	if [[ $# -gt 0 ]]; then
		run_full=false
		for arg in "$@"; do
			case "$arg" in
				func)
					want_func=true
					;;
				swa)
					want_swa=true
					;;
				-h|--help|help)
					usage
					exit 0
					;;
				*)
					echo "ERROR: Unknown argument: $arg" >&2
					usage >&2
					exit 2
					;;
			esac
		done

		if [[ "$want_func" != true && "$want_swa" != true ]]; then
			echo "ERROR: No valid targets specified." >&2
			usage >&2
			exit 2
		fi
	fi

	if [[ "$run_full" == true ]]; then
		run_step "10-resourcegroup.sh"
		run_step "20-iothub.sh"
		run_step "30-storageaccount.sh"
		run_step "40-postgres.sh"
		run_step "50-functionapp.sh"
		run_step "60-staticwebapp.sh"
	else
		if [[ "$want_func" == true ]]; then
			run_step "50-functionapp.sh"
		fi
		if [[ "$want_swa" == true ]]; then
			run_step "60-staticwebapp.sh"
		fi
	fi

	echo
	echo "All requested steps completed successfully."
}

main "$@"