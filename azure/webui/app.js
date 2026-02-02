(async () => {
    const allowedEmail = "s2525304@edu.savonia.fi";

    const res = await fetch("/.auth/me");
    const data = await res.json();
    const claims = data?.clientPrincipal?.claims ?? [];

    const email =
        claims.find(c => c.typ === "preferred_username")?.val ||
        "";

    if (email !== allowedEmail) {
        document.body.innerHTML = "<h2>Access denied</h2>";
        return;
    }

    document.getElementById("auth-status").textContent =
        `Logged in as ${email}`;
    document.getElementById("app").hidden = false;
})();