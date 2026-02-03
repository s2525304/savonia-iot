(() => {
    function pad2(n) {
        return String(n).padStart(2, "0");
    }

    function toDatetimeLocalValue(d) {
        // datetime-local expects local time without timezone, format: YYYY-MM-DDTHH:MM
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    function parseDatetimeLocal(value) {
        // value like 2026-02-03T14:05
        // Interpreted as local time
        return value ? new Date(value) : null;
    }

    function toIsoFromDatetimeLocal(value) {
        // datetime-local value is interpreted as local time by Date()
        const d = parseDatetimeLocal(value);
        return d ? d.toISOString() : null;
    }

    function clampDate(d, min, max) {
        if (d < min) return new Date(min);
        if (d > max) return new Date(max);
        return d;
    }

    function formatFilenameSafe(s) {
        return String(s).replace(/[^a-z0-9._-]+/gi, "_");
    }

    window.Utils = {
        toDatetimeLocalValue,
        toIsoFromDatetimeLocal,
        parseDatetimeLocal,
        clampDate,
        formatFilenameSafe
    };
})();