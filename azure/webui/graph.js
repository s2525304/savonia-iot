// graph.js
(() => {
    "use strict";

    function createLineGraph({ canvas, legends, legendBox }) {
        if (!canvas) throw new Error("createLineGraph: missing canvas");

        const ctx = canvas.getContext("2d");

        // Optional polish: crosshair cursor
        canvas.style.cursor = "crosshair";

        // --- Click-and-drag zoom state ---
        let dragStartX = null;
        let dragCurrentX = null;

        // Callbacks
        let onZoomCb = null;

        // Cached last render
        let lastRaw = null;
        let lastHourly = null;
        let lastOpts = null;

        // Optional alert trigger bounds (set via opts.trigger or setTrigger)
        // Shape: { min?: number, max?: number } | null
        let trigger = null;

        function resizeCanvasToDisplaySize() {
            // Make canvas crisp on HiDPI displays
            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            const width = Math.max(1, Math.round(rect.width * dpr));
            const height = Math.max(1, Math.round((rect.height || 420) * dpr));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
            return { width, height, dpr };
        }

        function drawLineChart(rawRows, hourlyRows, opts) {
            const { width, height } = resizeCanvasToDisplaySize();
            ctx.clearRect(0, 0, width, height);

            const showRaw = legends?.raw?.checked ?? true;
            const showAvg = legends?.avg?.checked ?? true;
            const showMin = legends?.min?.checked ?? true;
            const showMax = legends?.max?.checked ?? true;

            if (opts && Object.prototype.hasOwnProperty.call(opts, "trigger")) {
                trigger = opts.trigger ?? null;
            }

            if (!rawRows.length && !hourlyRows.length) {
                if (legendBox) legendBox.hidden = true;
                ctx.font = "16px system-ui";
                ctx.fillText("No data", 16, 28);
                canvas._series = null;
                return;
            }

            if (legendBox) legendBox.hidden = false;

            const pointsRaw = [];
            for (const [ts, _seq, value] of rawRows) {
                const t = new Date(ts).getTime();
                const v = Number(value);
                if (Number.isFinite(t) && Number.isFinite(v)) pointsRaw.push([t, v]);
            }

            const pointsAvg = [];
            const pointsMin = [];
            const pointsMax = [];
            for (const [ts, avg, min, max] of hourlyRows) {
                const t0 = new Date(ts).getTime();
                if (!Number.isFinite(t0)) continue;
                const t = t0 + 30 * 60 * 1000;
                if (Number.isFinite(avg)) pointsAvg.push([t, avg]);
                if (Number.isFinite(min)) pointsMin.push([t, min]);
                if (Number.isFinite(max)) pointsMax.push([t, max]);
            }

            const allPoints = [...pointsRaw, ...pointsAvg, ...pointsMin, ...pointsMax];
            if (!allPoints.length) {
                if (legendBox) legendBox.hidden = true;
                ctx.font = "16px system-ui";
                ctx.fillText("No numeric data", 16, 28);
                canvas._series = null;
                return;
            }

            let minT = Infinity, maxT = -Infinity, minV = Infinity, maxV = -Infinity;
            for (const [t, v] of allPoints) {
                if (t < minT) minT = t;
                if (t > maxT) maxT = t;
                if (v < minV) minV = v;
                if (v > maxV) maxV = v;
            }

            // Ensure trigger lines are visible by including them in the y-range.
            if (trigger) {
                if (Number.isFinite(trigger.min)) {
                    if (trigger.min < minV) minV = trigger.min;
                    if (trigger.min > maxV) maxV = trigger.min;
                }
                if (Number.isFinite(trigger.max)) {
                    if (trigger.max < minV) minV = trigger.max;
                    if (trigger.max > maxV) maxV = trigger.max;
                }
            }

            if (minV === maxV) {
                minV -= 1;
                maxV += 1;
            } else {
                const pad = (maxV - minV) * 0.05;
                minV -= pad;
                maxV += pad;
            }

            const padL = 48, padR = 16, padT = 16, padB = 40;
            const plotW = width - padL - padR;
            const plotH = height - padT - padB;

            const x = (t) => padL + ((t - minT) / (maxT - minT || 1)) * plotW;
            const y = (v) => padT + (1 - (v - minV) / (maxV - minV || 1)) * plotH;

            // Axes
            ctx.lineWidth = 1;
            ctx.strokeStyle = "#cbd5e1";
            ctx.beginPath();
            ctx.moveTo(padL, padT);
            ctx.lineTo(padL, padT + plotH);
            ctx.lineTo(padL + plotW, padT + plotH);
            ctx.stroke();

            // Title
            ctx.fillStyle = "#111827";
            ctx.font = "12px system-ui";
            ctx.fillText(opts?.title ?? "Measurements", padL, 12);

            // Y labels
            ctx.fillStyle = "#374151";
            ctx.fillText(`${minV.toFixed(2)}`, 8, padT + plotH);
            ctx.fillText(`${maxV.toFixed(2)}`, 8, padT + 10);

            // X-axis ticks (time)
            const tickCount = 6;
            ctx.fillStyle = "#374151";
            ctx.font = "11px system-ui";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";

            for (let i = 0; i < tickCount; i++) {
                const frac = tickCount === 1 ? 0 : i / (tickCount - 1);
                const t = minT + frac * (maxT - minT);
                const px = x(t);

                // tick line
                ctx.strokeStyle = "#cbd5e1";
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(px, padT + plotH);
                ctx.lineTo(px, padT + plotH + 6);
                ctx.stroke();

                const dt = new Date(t);
                // If the range spans multiple days, include date; otherwise show time.
                const spanMs = maxT - minT;
                const spanDays = spanMs / (24 * 60 * 60 * 1000);
                const label = spanDays >= 1
                    ? dt.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
                    : dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

                ctx.fillText(label, px, padT + plotH + 8);
            }

            // Restore defaults for other text
            ctx.textAlign = "start";
            ctx.textBaseline = "alphabetic";

            function drawLine(points, color, widthPx) {
                if (points.length < 2) return;
                ctx.strokeStyle = color;
                ctx.lineWidth = widthPx;
                ctx.beginPath();
                for (let i = 0; i < points.length; i++) {
                    const [t, v] = points[i];
                    const px = x(t);
                    const py = y(v);
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                }
                ctx.stroke();
            }

            // Conditionally draw lines based on legend checkboxes
            if (showRaw) drawLine(pointsRaw, "#9ca3af", 1);
            if (showMin) drawLine(pointsMin, "#7c3aed", 1.5);
            if (showMax) drawLine(pointsMax, "#14b8a6", 1.5);
            if (showAvg) drawLine(pointsAvg, "#2563eb", 2);

            // Alert trigger overlay (dotted red horizontal lines)
            if (trigger) {
                ctx.save();
                ctx.strokeStyle = "#ef4444";
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 6]);

                if (Number.isFinite(trigger.min)) {
                    const py = y(trigger.min);
                    ctx.beginPath();
                    ctx.moveTo(padL, py);
                    ctx.lineTo(padL + plotW, py);
                    ctx.stroke();
                }

                if (Number.isFinite(trigger.max)) {
                    const py = y(trigger.max);
                    ctx.beginPath();
                    ctx.moveTo(padL, py);
                    ctx.lineTo(padL + plotW, py);
                    ctx.stroke();
                }

                ctx.restore();
            }

            canvas._series = {
                raw: showRaw ? pointsRaw : [],
                avg: showAvg ? pointsAvg : [],
                min: showMin ? pointsMin : [],
                max: showMax ? pointsMax : [],
                scales: { minT, maxT, minV, maxV, padL, padT, plotW, plotH },
                trigger,
            };
        }

        function nearestPoint(points, t) {
            let best;
            let bestDist = Infinity;
            for (const [pt, pv] of points) {
                const d = Math.abs(pt - t);
                if (d < bestDist) {
                    bestDist = d;
                    best = [pt, pv];
                }
            }
            return best;
        }

        function pixelToTime(xPix, scales) {
            const { minT, maxT, padL, plotW } = scales;
            return minT + ((xPix - padL) / plotW) * (maxT - minT || 1);
        }

        function isInsidePlot(xPix, yPix, scales) {
            const { padL, padT, plotW, plotH } = scales;
            return (
                xPix >= padL &&
                xPix <= padL + plotW &&
                yPix >= padT &&
                yPix <= padT + plotH
            );
        }

        function redraw() {
            if (lastRaw && lastHourly) drawLineChart(lastRaw, lastHourly, lastOpts);
        }

        function render(rawRows, hourlyRows, opts) {
            lastRaw = rawRows;
            lastHourly = hourlyRows;
            lastOpts = opts;
            drawLineChart(rawRows, hourlyRows, opts);
        }

        function onZoom(cb) {
            onZoomCb = cb;
        }

        function setTrigger(nextTrigger) {
            trigger = nextTrigger ?? null;
            redraw();
        }

        // Legend changes -> redraw
        [legends?.raw, legends?.avg, legends?.min, legends?.max].forEach(cb => {
            cb?.addEventListener("change", redraw);
        });

        // Tooltip + drag overlay
        canvas.addEventListener("mousemove", (ev) => {
            const s = canvas._series;
            if (!s) return;

            const rect = canvas.getBoundingClientRect();
            const xPix = ev.clientX - rect.left;
            const { minT, maxT, padL, padT, plotW, plotH } = s.scales;

            if (xPix < padL || xPix > padL + plotW) return;

            const t = minT + ((xPix - padL) / plotW) * (maxT - minT || 1);

            const hits = [];
            if (s.raw.length) hits.push(["Raw", nearestPoint(s.raw, t)]);
            if (s.avg.length) hits.push(["Avg", nearestPoint(s.avg, t)]);
            if (s.min.length) hits.push(["Min", nearestPoint(s.min, t)]);
            if (s.max.length) hits.push(["Max", nearestPoint(s.max, t)]);

            const tooltip = hits
                .filter(([, p]) => p)
                .map(([name, [pt, pv]]) =>
                    `${name}: ${pv.toFixed(2)} @ ${new Date(pt).toLocaleString()}`
                )
                .join(" | ");

            if (!tooltip) return;

            // Redraw base chart
            redraw();

            const yPix = padT + plotH / 2;

            ctx.fillStyle = "rgba(255,255,255,0.9)";
            ctx.fillRect(xPix + 8, yPix - 18, ctx.measureText(tooltip).width + 8, 20);
            ctx.strokeStyle = "#9ca3af";
            ctx.strokeRect(xPix + 8, yPix - 18, ctx.measureText(tooltip).width + 8, 20);
            ctx.fillStyle = "#111827";
            ctx.font = "12px system-ui";
            ctx.fillText(tooltip, xPix + 12, yPix - 4);

            // Drag overlay
            if (dragStartX !== null && dragCurrentX !== null) {
                const x0 = Math.min(dragStartX, dragCurrentX);
                const x1 = Math.max(dragStartX, dragCurrentX);
                ctx.fillStyle = "rgba(59,130,246,0.15)";
                ctx.fillRect(x0, s.scales.padT, x1 - x0, s.scales.plotH);
            }
        });

        // Drag start
        canvas.addEventListener("mousedown", (ev) => {
            const s = canvas._series;
            if (!s) return;

            const rect = canvas.getBoundingClientRect();
            const xPix = ev.clientX - rect.left;
            const yPix = ev.clientY - rect.top;

            if (!isInsidePlot(xPix, yPix, s.scales)) return;

            dragStartX = xPix;
            dragCurrentX = xPix;
        });

        // Drag move
        canvas.addEventListener("mousemove", (ev) => {
            if (dragStartX === null) return;
            const rect = canvas.getBoundingClientRect();
            dragCurrentX = ev.clientX - rect.left;
            redraw();
        });

        // Drag end -> zoom callback
        canvas.addEventListener("mouseup", async () => {
            const s = canvas._series;
            if (!s || dragStartX === null || dragCurrentX === null) {
                dragStartX = dragCurrentX = null;
                return;
            }

            const dx = Math.abs(dragCurrentX - dragStartX);
            if (dx < 6) {
                dragStartX = dragCurrentX = null;
                return;
            }

            const x0 = Math.min(dragStartX, dragCurrentX);
            const x1 = Math.max(dragStartX, dragCurrentX);

            const tFrom = pixelToTime(x0, s.scales);
            const tTo = pixelToTime(x1, s.scales);

            dragStartX = dragCurrentX = null;

            if (typeof onZoomCb === "function") {
                await onZoomCb(tFrom, tTo);
            }
        });

        canvas.addEventListener("mouseleave", () => {
            dragStartX = dragCurrentX = null;
        });

        return { render, redraw, onZoom, setTrigger };
    }

    window.Graph = { createLineGraph };
})();