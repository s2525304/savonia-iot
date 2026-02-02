(async () => {
	// Allow-list for this demo. For GitHub, SWA does not provide your school email by default.
	const allowedGithubUser = "s2525304";
	const allowedEmail = "s2525304@edu.savonia.fi";

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
})();