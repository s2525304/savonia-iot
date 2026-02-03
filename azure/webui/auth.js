// auth.js
(function (global) {
    "use strict";

    async function getClientPrincipal() {
        const res = await fetch("/.auth/me", { credentials: "same-origin" });
        if (!res.ok) return null;

        const data = await res.json().catch(() => null);
        return data?.clientPrincipal ?? null;
    }

    function getRoles(principal) {
        const roles = principal?.userRoles;
        return Array.isArray(roles) ? roles : [];
    }

    function hasRole(principal, role) {
        return getRoles(principal).includes(role);
    }

    function renderRoles(roles) {
        const rolesEl = document.getElementById("auth-roles");
        if (rolesEl) {
            rolesEl.textContent = roles.join(", ");
        } else {
            console.log("User roles:", roles);
        }
    }

    function setAuthStatus(text) {
        const el = document.getElementById("auth-status");
        if (el) el.textContent = text;
    }

    function setAppVisible(visible) {
        const appEl = document.getElementById("app");
        if (appEl) appEl.hidden = !visible;
    }

    function renderLoggedInUser(principal) {
        const provider = principal?.identityProvider;
        const claims = principal?.claims ?? [];

        const email =
            claims.find(c => c.typ === "preferred_username")?.val ||
            claims.find(c => c.typ === "emails")?.val ||
            "";

        const githubUser = principal?.userDetails || "";

        setAuthStatus(
            provider === "github"
                ? `Logged in as ${githubUser}`
                : `Logged in as ${email}`
        );
    }

    /**
     * Ensures user is authenticated AND has SWA role "webui".
     * - On success: shows app and returns principal
     * - On failure: updates UI and returns null
     */
    async function requireWebui() {
        const principal = await getClientPrincipal();

        if (!principal) {
            // Not logged in (or auth not configured)
            document.body.innerHTML = "<h2>Not authenticated</h2>";
            return null;
        }

        const roles = getRoles(principal);
        renderRoles(roles);

        if (!hasRole(principal, "webui")) {
            setAuthStatus(
                "Logged in, but you do not have permission to use this app (missing role: webui)."
            );
            setAppVisible(false);
            return null;
        }

        renderLoggedInUser(principal);
        setAppVisible(true);
        return principal;
    }

    global.Auth = {
        getClientPrincipal,
        getRoles,
        hasRole,
        requireWebui
    };
})(window);