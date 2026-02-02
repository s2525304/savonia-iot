(async () => {
	// Allow-list for this demo. For GitHub, SWA does not provide your school email by default.
	const allowedGithubUser = "s2525304";
	const allowedEmail = "s2525304@edu.savonia.fi";

	const x_api_key = "TokkoKoriKalaSukka878"

	const res = await fetch("/.auth/me");
	const data = await res.json();
	const principal = data?.clientPrincipal;

	if (!principal) {
		// Not logged in (or auth not configured)
		document.body.innerHTML = "<h2>Not authenticated</h2>";
		return;
	}

	const provider = principal.identityProvider;
	const claims = principal.claims ?? [];

	// For Entra ID, preferred_username is usually the email / UPN.
	const email =
		claims.find(c => c.typ === "preferred_username")?.val ||
		claims.find(c => c.typ === "emails")?.val ||
		"";

	// For GitHub, `userDetails` is typically the GitHub username.
	const githubUser = principal.userDetails || "";

	const allowed = provider === "github"
		? githubUser === allowedGithubUser
		: email === allowedEmail;

	if (!allowed) {
		document.body.innerHTML = "<h2>Access denied</h2>";
		return;
	}

	document.getElementById("auth-status").textContent =
		provider === "github" ? `Logged in as ${githubUser}` : `Logged in as ${email}`;
	document.getElementById("app").hidden = false;

	const deviceSelect = document.getElementById("device-select");
	const sensorSelect = document.getElementById("sensor-select");

	async function loadDevices() {
		const res = await fetch("/api/devices", {
			headers: {
				"x-api-key": x_api_key
			}
		});
		if (!res.ok) {
			console.error("Failed to load devices");
			return;
		}
		const data = await res.json();
		const devices = data.devices ?? [];

		deviceSelect.innerHTML = "<option value=''>Select device</option>";
		for (const d of devices) {
			const opt = document.createElement("option");
			opt.value = d.deviceId;
			opt.textContent = d.deviceId;
			deviceSelect.appendChild(opt);
		}
	}

	async function loadSensors(deviceId) {
		sensorSelect.disabled = true;
		sensorSelect.innerHTML = "<option value=''>Loading…</option>";

		const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/sensors`, {
			headers: {
				"x-api-key": x_api_key
			}
		});
		if (!res.ok) {
			console.error("Failed to load sensors");
			return;
		}
		const data = await res.json();
		const sensors = data.sensors ?? [];

		sensorSelect.innerHTML = "<option value=''>Select sensor</option>";
		for (const s of sensors) {
			const opt = document.createElement("option");
			opt.value = s.sensorId;
			opt.textContent = s.sensorId;
			sensorSelect.appendChild(opt);
		}
		sensorSelect.disabled = false;
	}

	deviceSelect.addEventListener("change", () => {
		const deviceId = deviceSelect.value;
		if (!deviceId) {
			sensorSelect.innerHTML = "<option value=''>Select device first</option>";
			sensorSelect.disabled = true;
			return;
		}
		loadSensors(deviceId);
	});

	await loadDevices();
})();