// Runs inside the Custom HTML Block's shadow root (`root_element` is provided by Frappe).
const $ = (sel) => root_element.querySelector(sel);
const $$ = (sel) => Array.from(root_element.querySelectorAll(sel));
const esc = (v) => frappe.utils.escape_html(v == null ? "" : String(v));
const inr = (v, digits = 2) =>
	"₹" + Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const compact = (v) => {
	const n = Math.abs(v || 0);
	if (n >= 1e7) return "₹" + (v / 1e7).toFixed(2) + " Cr";
	if (n >= 1e5) return "₹" + (v / 1e5).toFixed(2) + " L";
	if (n >= 1e3) return "₹" + (v / 1e3).toFixed(1) + "k";
	return inr(v, 0);
};
const fmtDate = (d) => (d ? frappe.datetime.str_to_user(d) : "");

const ROUTES = {
	workspace: () => frappe.set_route("marketplace-ort"),
	trackers: () => frappe.set_route("List", "OR Primary Sales Tracker"),
	secondary: () => frappe.set_route("List", "OR Secondary Sales Order"),
	"secondary-returns": () => frappe.set_route("List", "OR Secondary Sales Order", { is_return: 1 }),
	mapping: () => frappe.set_route("List", "OR Item Mapping"),
	report: () => frappe.set_route("query-report", "Marketplace OR Dashboard"),
	settings: () => frappe.set_route("Form", "Marketplace OR Settings"),
	search: () => {
		const bar = document.querySelector("#navbar-search, .search-bar input");
		if (bar) bar.focus();
		else frappe.set_route("List", "OR Primary Sales Tracker");
	},
	notifications: () => frappe.set_route("List", "Notification Log"),
};

let period = "Month";

root_element.addEventListener("click", (e) => {
	const more = e.target.closest(".more");
	if (more) {
		$(".more-menu").classList.toggle("open");
		return;
	}
	if (!e.target.closest(".more-menu")) $(".more-menu").classList.remove("open");

	const p = e.target.closest("[data-period]");
	if (p) {
		period = p.dataset.period;
		$$("[data-period]").forEach((b) => b.classList.toggle("on", b === p));
		load();
		return;
	}
	const r = e.target.closest("[data-route]");
	if (r && ROUTES[r.dataset.route]) {
		e.preventDefault();
		ROUTES[r.dataset.route]();
		return;
	}
	const doc = e.target.closest("[data-doc]");
	if (doc) frappe.set_route("Form", "OR Secondary Sales Order", doc.dataset.doc);
});

function load() {
	const overlay = $(".loading");
	overlay.style.display = "grid";
	// frappe.call returns a jQuery promise: no .finally(), so hide the overlay in both callbacks
	frappe.call({
		method: "or_model.marketplace_or.workspace_dashboard.get_dashboard",
		args: { period },
		callback: (r) => {
			overlay.style.display = "none";
			render(r.message);
		},
		error: () => {
			overlay.style.display = "none";
		},
	});
}

function render(d) {
	if (!d) return;
	$(".first-name").textContent = d.user_first_name;
	const avatar = $(".avatar");
	if (d.user_image) {
		avatar.style.backgroundImage = `url("${encodeURI(d.user_image)}")`;
		avatar.textContent = "";
	} else {
		avatar.textContent = (d.user_first_name || "?").charAt(0).toUpperCase();
	}

	// hero
	const [int, dec] = inr(d.hero.value).split(".");
	$(".big-int").textContent = int;
	$(".big-dec").textContent = "." + (dec || "00");
	setChange($(".hero-change"), d.hero.change);
	$(".held").textContent = Number(d.hero.held_units).toLocaleString("en-IN");
	$(".transit").textContent = Number(d.hero.transit_units).toLocaleString("en-IN");
	$(".d-start").textContent = fmtDate(d.start);
	$(".d-end").textContent = fmtDate(d.end);

	renderSegments(d.segments);
	renderChart(d.trend);
	renderHeat(d.heatmap);
	renderRecent(d.recent);
}

function setChange(el, change) {
	if (change === null || change === undefined) {
		el.textContent = "";
		return;
	}
	el.textContent = (change >= 0 ? "+" : "") + change.toFixed(2).replace(".", ",") + "%";
	el.classList.toggle("down", change < 0);
}

function renderSegments(segments) {
	const box = $(".segments");
	const max = Math.max(...segments.map((s) => s.value), 1);
	const avg = segments.reduce((a, s) => a + s.value, 0) / segments.length;
	const base = 104; // px: bars + caption, so the value label never overlaps them
	const usable = 100; // px of height that scales with the value
	const weights = [2.4, 2.4, 1];
	box.innerHTML = segments
		.map((s, i) => {
			const h = base + (s.value / max) * usable;
			const change = s.change === null || s.change === undefined ? "" : (s.change >= 0 ? "+ " : "− ") + Math.abs(s.change).toFixed(0) + "%";
			let bars;
			if (s.key === "primary") {
				bars = `<div class="seg-bars"><div class="solid" title="${esc(inr(s.value))}"></div></div>`;
			} else {
				const vals = s.bars && s.bars.length ? s.bars : [0];
				const top = Math.max(...vals, 1);
				bars = `<div class="seg-bars ${s.key === "returns" ? "faint" : ""}">${vals
					.map((v) => `<div class="thin" style="opacity:${(0.35 + 0.65 * (v / top)).toFixed(2)}" title="${esc(inr(v))}"></div>`)
					.join("")}</div>`;
			}
			return `<div class="seg" style="flex:${weights[i] || 1}">
				<div class="seg-line" style="height:${h}px"></div>
				<div class="seg-value" style="bottom:${h - 22}px">${esc(inr(s.value))}</div>
				<div class="seg-meta"><b>${esc(change)}</b>${esc(s.label)}</div>
				${bars}
			</div>`;
		})
		.join("");
	const avgH = base + (avg / max) * usable;
	box.insertAdjacentHTML("beforeend", `<div class="avg" style="bottom:${avgH}px"><span>Average</span></div>`);
}

function smoothPath(points) {
	if (!points.length) return "";
	let d = `M${points[0][0]},${points[0][1]}`;
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i - 1] || points[i];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[i + 2] || p2;
		const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
		const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
		d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0]},${p2[1]}`;
	}
	return d;
}

function renderChart(trend) {
	const W = 340, H = 200, top = 14, bottom = 172, left = 4, right = W - 4;
	const max = Math.max(...trend.map((t) => Math.max(t.secondary, t.primary)), 1);
	const x = (i) => left + (i * (right - left)) / Math.max(trend.length - 1, 1);
	const y = (v) => bottom - (v / max) * (bottom - top - 24);
	const sec = trend.map((t, i) => [Math.round(x(i)), Math.round(y(t.secondary))]);
	const prim = trend.map((t, i) => [Math.round(x(i)), Math.round(y(t.primary))]);
	const secPath = smoothPath(sec);
	const last = trend.length - 1;
	const tipX = Math.min(sec[last][0] - 74, W - 78);
	$(".chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
		<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#d5f65a" stop-opacity=".28"/><stop offset="1" stop-color="#d5f65a" stop-opacity="0"/>
		</linearGradient></defs>
		<path d="${secPath} L${sec[last][0]},${bottom} L${sec[0][0]},${bottom} Z" fill="url(#g)" stroke="none"/>
		<path d="${smoothPath(prim)}" stroke="#9a9aa2" stroke-width="1.4" stroke-dasharray="4 4" fill="none"/>
		<path d="${secPath}" stroke="#d5f65a" stroke-width="2" fill="none"/>
		<line x1="${sec[last][0]}" y1="${top}" x2="${sec[last][0]}" y2="${bottom}" stroke="#555" stroke-dasharray="3 3"/>
		<circle cx="${sec[last][0]}" cy="${sec[last][1]}" r="3.5" fill="#d5f65a" stroke="none"/>
		<circle cx="${prim[last][0]}" cy="${prim[last][1]}" r="3" fill="#e5e5e8" stroke="none"/>
		<g class="tip"><rect x="${tipX}" y="${top}" width="70" height="18" rx="9"/><text x="${tipX + 9}" y="${top + 12.5}">${esc(compact(trend[last].secondary))}</text></g>
		<g class="tip"><rect x="${tipX}" y="${top + 24}" width="70" height="18" rx="9"/><text x="${tipX + 9}" y="${top + 36.5}">${esc(compact(trend[last].primary))}</text></g>
		${trend.map((t, i) => `<text x="${x(i)}" y="${H - 4}" text-anchor="${i === 0 ? "start" : i === last ? "end" : "middle"}">${esc(t.label)}</text>`).join("")}
	</svg>`;
}

function renderHeat(h) {
	const box = $(".heat");
	box.style.gridTemplateColumns = `64px repeat(${h.days.length}, 1fr)`;
	const level = (v) => {
		if (!v || !h.max) return 1;
		return 1 + Math.min(4, Math.ceil((v / h.max) * 4));
	};
	const colours = { 1: "#241c3a", 2: "#3b2a6e", 3: "#5b37c7", 4: "#7c4dff", 5: "#b49cff" };
	let html = "<div></div>" + h.days.map((d) => `<div class="hd">${esc(d)}</div>`).join("");
	if (!h.rows.length) html += `<div class="empty" style="grid-column:1/-1">No marketplaces yet</div>`;
	h.rows.forEach((row) => {
		html += `<div class="rl" title="${esc(row.label)}">${esc(row.label)}</div>`;
		row.values.forEach((v, i) => {
			html += `<div class="cell" style="background:${colours[level(v)]}" title="${esc(row.label)} · ${esc(h.days[i])}: ${v} units"></div>`;
		});
	});
	box.innerHTML = html;
}

function renderRecent(rows) {
	const box = $(".recent");
	if (!rows.length) {
		box.innerHTML = `<div class="empty">No secondary sales yet. Import them from a OR Primary Sales Tracker.</div>`;
		return;
	}
	box.innerHTML = rows
		.map(
			(r) => `<div class="row">
				<div class="t">${esc(r.title)}<small>${esc(r.subtitle || "")} · ${esc(fmtDate(r.date))}</small></div>
				<span class="tag"><i style="background:${r.kind === "Return" ? "#a78bfa" : "#d5f65a"}"></i>${esc(r.tag)}</span>
				<div class="amt ${r.amount < 0 ? "neg" : ""}">${r.amount >= 0 ? "+" : "−"}${esc(inr(Math.abs(r.amount)))}</div>
				<button class="kebab" data-doc="${esc(r.name)}" title="Open">⋮</button>
			</div>`
		)
		.join("");
}

load();
