// Marketplace OR app: a full-screen custom UI over the whole OR module (route /app/or-app/...).
// Rendered in a shadow root so neither ERPNext's styles nor its widgets appear. Server: ui_api.py.

frappe.pages["or-app"].on_page_load = function (wrapper) {
	window.or_app = new OrApp(wrapper);
};
frappe.pages["or-app"].on_page_show = function () {
	if (window.or_app) window.or_app.show();
};

const OR_VERSION = "1.7.0";
// or_app.css is fetched fresh on each page load (it loads once per desk session), so a style fix shows on the next refresh
const orReduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Count the first number in an element up from zero, keeping its prefix, suffix, decimals and grouping. */
function orCountUp(el, ms = 800) {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let node;
	while ((node = walker.nextNode()) && !/\d/.test(node.nodeValue));
	if (!node) return;
	const text = node.nodeValue;
	if (/\d[-/]\d/.test(text)) return;
	const m = text.match(/\d[\d,]*(?:\.\d+)?/);
	if (!m) return;
	const raw = m[0];
	const target = parseFloat(raw.replace(/,/g, ""));
	if (!target) return;
	const dec = (raw.split(".")[1] || "").length;
	const grouped = raw.includes(",");
	const pre = text.slice(0, m.index);
	const post = text.slice(m.index + raw.length);
	const fmt = (v) => (grouped ? v.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : v.toFixed(dec));
	const t0 = performance.now();
	const step = (t) => {
		const p = Math.min((t - t0) / ms, 1);
		if (!node.isConnected) return;
		node.nodeValue = p < 1 ? pre + fmt(target * (1 - Math.pow(1 - p, 3))) + post : text;
		if (p < 1) requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}

/** Minimal ZIP (stored, no compression) — enough to build an .xlsx in the browser without a library. */
function orZip(files) {
	const table = orZip.t || (orZip.t = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	}));
	const crc32 = (d) => {
		let c = 0xffffffff;
		for (let i = 0; i < d.length; i++) c = table[(c ^ d[i]) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const enc = new TextEncoder();
	const now = new Date();
	const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
	const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
	const parts = [];
	const central = [];
	let offset = 0;
	for (const f of files) {
		const name = enc.encode(f.name);
		const data = enc.encode(f.data);
		const crc = crc32(data);
		const local = new DataView(new ArrayBuffer(30));
		[[0, 0x04034b50, 4], [4, 20], [6, 0x0800], [8, 0], [10, time], [12, date], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length], [28, 0]]
			.forEach(([at, v, size]) => (size === 4 ? local.setUint32(at, v, true) : local.setUint16(at, v, true)));
		parts.push(new Uint8Array(local.buffer), name, data);
		const cen = new DataView(new ArrayBuffer(46));
		[[0, 0x02014b50, 4], [4, 20], [6, 20], [8, 0x0800], [10, 0], [12, time], [14, date], [16, crc, 4], [20, data.length, 4], [24, data.length, 4],
			[28, name.length], [30, 0], [32, 0], [34, 0], [36, 0], [38, 0, 4], [42, offset, 4]]
			.forEach(([at, v, size]) => (size === 4 ? cen.setUint32(at, v, true) : cen.setUint16(at, v, true)));
		central.push(new Uint8Array(cen.buffer), name);
		offset += 30 + name.length + data.length;
	}
	const size = central.reduce((a, p) => a + p.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, files.length, true);
	end.setUint16(10, files.length, true);
	end.setUint32(12, size, true);
	end.setUint32(16, offset, true);
	return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** One-sheet .xlsx: bold frozen header, sized columns; cells are numbers, strings or {v, pct}. */
function orXlsx(sheetName, header, rows) {
	return orXlsxBook([{ name: sheetName, header, rows }]);
}

/**
 * Several-sheet .xlsx. Each sheet: {name, header?, rows}. With a header it is bold and frozen; without one
 * the rows are free-form (e.g. a summary page). Cells: numbers, strings, {v} (a percentage) or {b} (bold text).
 */
function orXlsxBook(sheets) {
	const esc = (v) => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const col = (i) => {
		let s = "";
		for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
		return s;
	};
	const shown = (v) => (v && typeof v === "object" ? String(v.b ?? v.v) : String(v ?? ""));
	const text = (ref, v, bold) => `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ""}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
	const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
	const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
	const used = new Set();
	const sheetName = (n, i) => {
		let s = String(n || `Sheet${i + 1}`).replace(/[\[\]:*?/\\]/g, " ").slice(0, 31) || `Sheet${i + 1}`;
		while (used.has(s.toLowerCase())) s = s.slice(0, 28) + ` ${i + 1}`;
		used.add(s.toLowerCase());
		return esc(s);
	};
	const sheetXml = (sh) => {
		const all = sh.header ? [sh.header, ...sh.rows] : sh.rows;
		const ncols = Math.max(1, ...all.map((r) => r.length));
		const widths = Array.from({ length: ncols }, (_, c) => Math.min(60, Math.max(9, ...all.map((r) => shown(r[c]).length + 2))));
		const cell = (v, r, c) => {
			const ref = col(c) + (r + 1);
			if (sh.header && r === 0) return text(ref, v ?? "", true);
			if (v && typeof v === "object" && "b" in v) return v.b == null || v.b === "" ? "" : text(ref, v.b, true);
			if (v && typeof v === "object") return `<c r="${ref}" s="2"><v>${v.v}</v></c>`;
			if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
			if (v == null || v === "") return "";
			return text(ref, v, false);
		};
		const pane = sh.header ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
		return head + `<worksheet ${ns}>${pane}<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${all.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, ri, ci)).join("")}</row>`).join("")}</sheetData></worksheet>`;
	};
	const n = sheets.length;
	const idx = sheets.map((_, i) => i + 1);
	return orZip([
		{ name: "[Content_Types].xml", data: head + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${idx.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
		{ name: "_rels/.rels", data: head + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
		{ name: "xl/workbook.xml", data: head + `<workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name="${sheetName(sh.name, i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
		{ name: "xl/_rels/workbook.xml.rels", data: head + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${idx.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join("")}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
		{ name: "xl/styles.xml", data: head + `<styleSheet ${ns}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>` },
		...sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh) })),
	]);
}

/** A table cell's value for Excel: amounts and counts become numbers, percentages become real percentages. */
function orCellValue(td) {
	const text = (td.innerText || td.textContent || "").split(/\n+/).map((s) => s.trim()).filter(Boolean).join(" · ");
	const t = text.replace(/\s*units?$/i, "").replace(/[₹,\s]/g, "").replace(/^[−–]/, "-");
	if (/^-?\d+(\.\d+)?%$/.test(t)) return { v: parseFloat(t) / 100 };
	if (/^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t)) return parseFloat(t);
	return text;
}

function orDownload(blob, filename) {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const OR_API = "or_model.marketplace_or.ui_api.";

// ------------------------------------------------------------------ helpers

const orEsc = (v) => frappe.utils.escape_html(v == null ? "" : String(v));
const orFlt = (v) => parseFloat(v) || 0;
const orInr = (v, d = 2) =>
	(Number(v) < 0 ? "−" : "") +
	"₹" + Math.abs(Number(v || 0)).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const orQty = (v) => Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const orDate = (d) => (d ? frappe.datetime.str_to_user(String(d).slice(0, 10)) : "");
const orCompact = (v) => {
	const n = Math.abs(v || 0);
	const sign = Number(v) < 0 ? "−" : "";
	if (n >= 1e7) return sign + "₹" + (n / 1e7).toFixed(2) + " Cr";
	if (n >= 1e5) return sign + "₹" + (n / 1e5).toFixed(2) + " L";
	if (n >= 1e3) return sign + "₹" + (n / 1e3).toFixed(1) + "k";
	return orInr(v, 0);
};
const orStrip = (html) => {
	const d = document.createElement("div");
	d.innerHTML = String(html || "").replace(/<br\s*\/?>/gi, "\n");
	return d.textContent.trim();
};

const OR_ICONS = {
	search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
	up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
	down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
	moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
	calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
	back: '<path d="M15 18l-6-6 6-6"/>',
	out: '<path d="M7 17 17 7M9 7h8v8"/>',
	upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
	x: '<path d="M6 6l12 12M18 6 6 18"/>',
	dots: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
	home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-7H9v7H3z"/>',
	truck: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
	ret: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
	check: '<path d="m5 12 5 5L20 7"/>',
	chart: '<rect x="3" y="3" width="18" height="18" rx="9"/><path d="m7 14 3-3 3 2 4-5"/>',
	globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
	swap: '<circle cx="12" cy="12" r="9"/><path d="M9 8v8M9 16l-2-2M15 16V8M15 8l2 2"/>',
	mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
	file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
	edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
	trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
	logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
	grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
	download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
	gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const orIcon = (name) => `<svg class="i" viewBox="0 0 24 24">${OR_ICONS[name] || ""}</svg>`;

const OR_STATUS = {
	Draft: "grey",
	Active: "cyan",
	"Under Reconciliation": "orange",
	Reconciled: "green",
	Closed: "purple",
	Pending: "grey",
	"Variance not invoiced": "red",
	"Notes awaiting submission": "orange",
	Dispatched: "cyan",
	"Partially Received": "orange",
	Received: "green",
	"Return Initiated": "orange",
	"Return Dispatched": "cyan",
	"Return Completed": "green",
	Cancelled: "red",
	"No variance": "grey",
	"Not created": "red",
	Submitted: "green",
	Sale: "lime",
	Return: "purple",
	"Primary Sale": "lime",
	"Primary Return": "purple",
	"Debit Note": "lime",
	"Credit Note": "purple",
	// Sales Order statuses (a tracker's Status is its Sales Order's status)
	"To Deliver and Bill": "orange",
	"To Bill": "orange",
	"To Deliver": "orange",
	"On Hold": "orange",
	Completed: "green",
};
const orPill = (text, colour) =>
	text ? `<span class="pill ${colour || OR_STATUS[text] || "grey"}"><i></i>${orEsc(text)}</span>` : "";

const OR_TABS = [
	["", "Dashboard"],
	["trackers", "Primary Sales"],
	["secondary", "Secondary Sales"],
	["reports", "Reports"],
];
const OR_STATUSES = ["Submitted", "Active", "Under Reconciliation", "Reconciled", "Closed"]; // OR Stage (workflow)
// a tracker's Status = its Sales Order's status; "Draft" orders have no tracker yet (ui_api: `drafts`)
const OR_ORDER_STATUSES = ["To Deliver and Bill", "To Bill", "To Deliver", "Completed", "On Hold", "Closed"];

// ------------------------------------------------------------------ app

class OrApp {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.host = document.createElement("div");
		this.host.className = "orm-host";
		wrapper.appendChild(this.host);
		this.root = this.host.attachShadow({ mode: "open" });
		this.root.innerHTML = `
			<link rel="stylesheet" href="/assets/or_model/or_app/or_app.css?v=${OR_VERSION}-${Date.now()}">
			<div class="stage">
				<div class="panel">
					<header class="top">
						<a class="brand" data-go="">
							<img class="logo-img" src="/assets/or_model/or_app/miraggio.png?v=${OR_VERSION}" alt="Miraggio"><span class="brand-name">OR Workspace</span>
						</a>
						<nav class="tabs"><span class="tab-ink"></span>${OR_TABS.map(([r, l]) => `<a class="tab" data-go="${r}" data-tab="${r}">${l}</a>`).join("")}</nav>
						<div class="top-actions">
							<button class="round" data-act="erp" title="Back to ERPNext">${orIcon("grid")}</button>
							<button class="round theme-btn" data-act="theme" title="Switch to light mode">${orIcon("sun")}</button>
							<button class="round settings-btn" data-go="setup" title="Settings">${orIcon("gear")}</button>
							<div class="menu-wrap">
								<span class="avatar" data-act="user-menu"></span>
								<div class="menu user-menu"></div>
							</div>
						</div>
					</header>
					<main class="main"><div class="spin"></div></main>
				</div>
				<div class="toasts"></div>
			</div>`;
		this.main = this.$(".main");
		let theme = "dark";
		try {
			theme = localStorage.getItem("or_theme") || "dark";
		} catch (e) {
			/* storage blocked: default theme */
		}
		this.setTheme(theme);
		this.bind();
		this.bindDatePicker();
		window.addEventListener("resize", () => this.moveInk(true));
		// Run the entrance the moment a view first puts real content on screen (some views render in stages).
		new MutationObserver(() => {
			if (this._enter == null || !this.main.querySelector(":scope > :not(.spin)")) return;
			const dir = this._enter;
			this._enter = null;
			this.animate(this.main, dir);
		}).observe(this.main, { childList: true });
		new MutationObserver(() => this.enhanceTables()).observe(this.root, { childList: true, subtree: true });
		frappe.router.on("change", () => this.toggleScroll());
		this.ready = this.api("boot").then((b) => {
			this.boot = b;
			this.renderUser();
		});
	}

	$(sel, el) {
		return (el || this.root).querySelector(sel);
	}
	$$(sel, el) {
		return Array.from((el || this.root).querySelectorAll(sel));
	}

	toggleScroll() {
		const on = frappe.get_route()[0] === "or-app";
		document.documentElement.style.overflow = on ? "hidden" : "";
	}

	bind() {
		this.root.addEventListener("click", (e) => {
			const menuBtn = e.target.closest("[data-menu]");
			this.$$(".menu.open").forEach((m) => {
				if (!m.contains(e.target) && (!menuBtn || m !== this.$(menuBtn.dataset.menu))) m.classList.remove("open");
			});
			if (!e.target.closest("[data-act='user-menu']") && !e.target.closest(".user-menu")) this.$(".user-menu").classList.remove("open");
			if (menuBtn) {
				this.$(menuBtn.dataset.menu).classList.toggle("open");
				return;
			}
			const go = e.target.closest("[data-go]");
			if (go) {
				e.preventDefault();
				this.go(...go.dataset.go.split("|"));
				return;
			}
			const ext = e.target.closest("[data-erp]");
			if (ext) {
				e.preventDefault();
				const [doctype, name] = ext.dataset.erp.split("|");
				window.open(`/app/${frappe.router.slug(doctype)}/${encodeURIComponent(name)}`, "_blank");
				return;
			}
			const act = e.target.closest("[data-act]");
			if (act) this.onAct(act.dataset.act, act, e);
		});
		document.addEventListener("keydown", (e) => {
			if (frappe.get_route()[0] !== "or-app") return;
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				e.stopPropagation();
				this.searchDialog();
			}
		}, true);
	}

	/**
	 * Every date field (input.inp[type=date]) opens this app-styled calendar instead of the browser's grey one,
	 * so it matches the dropdown lists in both themes. Picking a date sets the input's ISO value and fires
	 * "change", so the views' own listeners work unchanged. Typing a date still works.
	 */
	bindDatePicker() {
		this.root.addEventListener("click", (e) => {
			const inp = e.target.closest && e.target.closest("input.inp[type=date]");
			if (inp) {
				e.preventDefault();
				if (this._dp && this._dp.inp === inp) return this.closeDatePicker();
				return this.openDatePicker(inp);
			}
			if (this._dp && !this._dp.el.contains(e.target)) this.closeDatePicker();
		}, true);
		this.root.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && this._dp) this.closeDatePicker();
		}, true);
		this.root.addEventListener("scroll", () => this.closeDatePicker(), true);
		window.addEventListener("resize", () => this.closeDatePicker());
	}

	openDatePicker(inp) {
		this.closeDatePicker();
		const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		const today = iso(new Date());
		const view = inp.value ? new Date(inp.value + "T00:00:00") : new Date();
		view.setDate(1);
		const el = document.createElement("div");
		el.className = "dp";
		const stage = this.$(".stage");
		stage.appendChild(el);
		this._dp = { el, inp };

		const pick = (value) => {
			inp.value = value;
			inp.dispatchEvent(new Event("input", { bubbles: true }));
			inp.dispatchEvent(new Event("change", { bubbles: true }));
			this.closeDatePicker();
		};
		const render = () => {
			const y = view.getFullYear(), m = view.getMonth();
			const start = new Date(y, m, 1 - new Date(y, m, 1).getDay()); // grid starts on the Sunday before the 1st
			const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
			el.innerHTML = `
				<div class="dp-head">
					<button class="dp-nav" data-dp="prev" title="Previous month">‹</button>
					<span class="dp-title">${view.toLocaleString("en-IN", { month: "long" })} ${y}</span>
					<button class="dp-nav" data-dp="next" title="Next month">›</button>
				</div>
				<div class="dp-grid">${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => `<span class="dp-wd">${d}</span>`).join("")}
					${days.map((d) => {
						const v = iso(d);
						const cls = ["dp-day", d.getMonth() !== m && "out", v === today && "today", v === inp.value && "sel"].filter(Boolean).join(" ");
						return `<button class="${cls}" data-dp="day" data-d="${v}">${d.getDate()}</button>`;
					}).join("")}
				</div>
				<div class="dp-foot"><button class="dp-link" data-dp="clear">Clear</button><button class="dp-link" data-dp="today">Today</button></div>`;
		};
		el.addEventListener("click", (e) => {
			e.stopPropagation();
			const t = e.target.closest("[data-dp]");
			if (!t) return;
			const a = t.dataset.dp;
			if (a === "prev" || a === "next") {
				view.setMonth(view.getMonth() + (a === "next" ? 1 : -1));
				return render();
			}
			pick(a === "clear" ? "" : a === "today" ? today : t.dataset.d);
		});
		render();

		const r = inp.getBoundingClientRect(), s = stage.getBoundingClientRect();
		const width = el.offsetWidth, height = el.offsetHeight;
		const below = r.bottom + 6 + height <= s.bottom;
		el.style.left = Math.max(8, Math.min(r.left - s.left, s.width - width - 8)) + "px";
		el.style.top = (below ? r.bottom - s.top + 6 : r.top - s.top - height - 6) + "px";
	}

	closeDatePicker() {
		if (!this._dp) return;
		this._dp.el.remove();
		this._dp = null;
	}

	/** Light / dark: a class on the shadow host (or_app.css `:host(.light)`), remembered per browser. */
	setTheme(theme) {
		const light = theme === "light";
		this.host.classList.toggle("light", light);
		const btn = this.$(".theme-btn");
		if (btn) {
			btn.innerHTML = orIcon(light ? "moon" : "sun");
			btn.title = light ? "Switch to dark mode" : "Switch to light mode";
		}
		try {
			localStorage.setItem("or_theme", light ? "light" : "dark");
		} catch (e) {
			/* storage blocked: theme lasts for this visit */
		}
	}

	onAct(act, el, e) {
		if (act === "search") return this.searchDialog();
		if (act === "theme") return this.setTheme(this.host.classList.contains("light") ? "dark" : "light");
		if (act === "erp") return (window.location.href = "/app");
		if (act === "user-menu") return this.$(".user-menu").classList.toggle("open");
		if (act === "classic") {
			localStorage.setItem("or_classic", "1");
			window.location.href = "/app/or-primary-sales-tracker";
			return;
		}
		if (act === "logout") return frappe.app.logout();
		if (this.view && this.view.onAct) this.view.onAct(act, el, e);
	}

	renderUser() {
		const b = this.boot;
		const av = this.$(".avatar");
		if (b.user_image) {
			av.style.backgroundImage = `url("${encodeURI(b.user_image)}")`;
		} else {
			av.textContent = (b.first_name || "?").charAt(0).toUpperCase();
		}
		this.$(".user-menu").innerHTML = `
			<div class="who"><b>${orEsc(b.full_name)}</b>${orEsc(b.user)}</div>
			<div class="sep"></div>
			<a data-act="erp">${orIcon("grid")} Back to ERPNext</a>
			<a data-act="classic">${orIcon("file")} Classic OR forms</a>
			<div class="sep"></div>
			<a data-act="logout">${orIcon("logout")} Log out</a>`;
	}

	/** Highlight the tab for a route right away so the pill starts sliding on click. */
	markTab(sub) {
		const tab = { tracker: "trackers", order: "secondary" }[sub] ?? sub;
		this.$$(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
		this.$(".settings-btn").classList.toggle("on", sub === "setup");
		this.moveInk();
		return tab;
	}

	go(...parts) {
		this.markTab(parts[0] || "");
		const route = ["or-app", ...parts.filter((p) => p !== undefined && p !== null && p !== "")];
		frappe.set_route(...route);
	}

	async show() {
		this.toggleScroll();
		this.$$(".overlay").forEach((o) => o.remove());
		await this.ready;
		const [, sub = "", name] = frappe.get_route();
		const order = ["", "trackers", "secondary", "reports", "setup"];
		const tab = this.markTab(sub);
		const dir = this._tab == null || this._tab === tab ? 0 : Math.sign(order.indexOf(tab) - order.indexOf(this._tab));
		this._tab = tab;
		if (this._shown && !orReduced() && !this.main.querySelector(":scope > .spin")) {
			this.main.classList.add("view-leave");
			await new Promise((r) => setTimeout(r, 130));
			this.main.classList.remove("view-leave");
		}
		this._shown = true;
		const views = {
			"": DashboardView,
			trackers: TrackersView,
			tracker: TrackerView,
			secondary: SecondaryView,
			order: SecondaryOrderView,
			mapping: MappingView,
			reports: ReportsView,
			setup: SetupView,
		};
		const View = views[sub] || DashboardView;
		this.main.innerHTML = '<div class="spin"></div>';
		this.main.scrollTop = 0;
		this._enter = dir;
		const token = (this.token = Symbol());
		this.view = new View(this, name);
		try {
			await this.view.render(token);
		} catch (err) {
			if (this.token === token) {
				this.main.innerHTML = `<div class="empty">${orEsc(err.message || err)}</div>`;
			}
		}
	}

	// -------------------------------------------------------------- data tables: column picker + Excel

	/** Give every data table a "Columns" picker and an "Excel" download (runs again whenever tables re-render). */
	enhanceTables() {
		// Batched into one microtask: runs right after the DOM change and before paint, so hidden columns never flash.
		if (this._tblQueued) return;
		this._tblQueued = true;
		queueMicrotask(() => {
			this._tblQueued = false;
			this.$$("table.t").forEach((t) => {
				try {
					this.enhanceTable(t);
				} catch (e) {
					console.error("OR table tools", e);
				}
			});
		});
	}

	tableLabels(table) {
		return [...table.tHead.rows[0].cells].map((c) => c.textContent.trim());
	}

	enhanceTable(table) {
		if (table.classList.contains("heat") || table.closest(".rx-table") || !table.tHead || !table.tHead.rows.length) return;
		const labels = this.tableLabels(table);
		const cols = labels.filter(Boolean);
		if (cols.length < 2) return;
		const key = "or_cols:" + (frappe.get_route()[1] || "dashboard") + ":" + labels.join("|");
		if (table._sorKey !== key) {
			table._sorKey = key;
			let hidden = [];
			try {
				hidden = JSON.parse(localStorage.getItem(key) || "[]");
			} catch (e) {
				/* storage unavailable: start with every column shown */
			}
			table._sorHidden = new Set(hidden.filter((h) => cols.includes(h)));
			this.addTableTools(table, cols);
		}
		this.applyHidden(table);
	}

	applyHidden(table) {
		const labels = this.tableLabels(table);
		const hide = new Set(labels.map((l, i) => (table._sorHidden.has(l) ? i : -1)).filter((i) => i >= 0));
		for (const row of table.rows) {
			if (row.cells.length !== labels.length) continue;
			[...row.cells].forEach((c, i) => {
				const want = hide.has(i) ? "none" : "";
				if (c.style.display !== want) c.style.display = want;
			});
		}
	}

	addTableTools(table, cols) {
		const anchor = table.closest(".table-wrap") || table;
		const prev = anchor.previousElementSibling;
		const id = "tm" + (this._tmSeq = (this._tmSeq || 0) + 1);
		const tools = document.createElement("div");
		tools.className = "tbl-tools";
		tools.innerHTML = `
			<div class="menu-wrap">
				<button class="tbl-btn" data-menu="#${id}" title="Show or hide columns">${orIcon("grid")} Columns</button>
				<div class="menu tbl-menu" id="${id}"></div>
			</div>
			<button class="tbl-btn xl" data-xl title="Download this table as an Excel file">${orIcon("download")} Excel</button>`;
		const menu = tools.querySelector(".tbl-menu");
		const paint = () => {
			menu.innerHTML = `<div class="tm-head"><span>Columns</span><a data-all>Show all</a></div>` +
				cols.map((c) => `<label><input type="checkbox" value="${orEsc(c)}" ${table._sorHidden.has(c) ? "" : "checked"}> ${orEsc(c)}</label>`).join("");
		};
		const save = () => {
			try {
				localStorage.setItem(table._sorKey, JSON.stringify([...table._sorHidden]));
			} catch (e) {
				/* storage unavailable: the choice lasts until the table re-renders */
			}
			this.applyHidden(table);
		};
		paint();
		menu.addEventListener("change", (e) => {
			const box = e.target;
			if (box.checked) table._sorHidden.delete(box.value);
			else if (cols.length - table._sorHidden.size > 1) table._sorHidden.add(box.value);
			else {
				box.checked = true;
				this.toast("At least one column has to stay visible.", "info");
				return;
			}
			save();
		});
		menu.addEventListener("click", (e) => {
			if (!e.target.closest("[data-all]")) return;
			table._sorHidden.clear();
			paint();
			save();
		});
		tools.querySelector("[data-xl]").addEventListener("click", () => this.exportTable(table));

		if (prev && prev.classList.contains("card-head")) {
			prev.querySelectorAll(":scope > .tbl-tools").forEach((t) => t.remove());
			tools.classList.add("in-head");
			prev.insertBefore(tools, prev.children[1] || null);
		} else {
			if (prev && prev.classList.contains("tbl-tools")) prev.remove();
			tools.classList.add("bar");
			anchor.before(tools);
		}
	}

	exportTable(table) {
		const labels = this.tableLabels(table);
		const idx = labels.map((l, i) => i).filter((i) => labels[i] && !table._sorHidden.has(labels[i]));
		const rows = [];
		for (const section of [...table.tBodies, table.tFoot].filter(Boolean)) {
			for (const row of section.rows) {
				if (row.cells.length === labels.length) rows.push(idx.map((i) => orCellValue(row.cells[i])));
			}
		}
		const anchor = table.closest(".table-wrap") || table;
		const title = ((anchor.closest(".card") || {}).querySelector?.(".card-title")?.textContent
			|| (table.closest(".modal") || {}).querySelector?.(".modal-head h3")?.textContent
			|| this.$(".main .view-head h1")?.textContent || "OR").trim();
		orDownload(orXlsx(title, idx.map((i) => labels[i]), rows), `${title.replace(/[^\w\- ]+/g, "").trim() || "OR"} ${frappe.datetime.get_today()}.xlsx`);
		this.toast(`Downloaded ${rows.length} row${rows.length === 1 ? "" : "s"} to Excel.`);
	}

	/** Keep the white pill under the active tab; it slides when the tab changes. */
	moveInk(instant) {
		const ink = this.$(".tab-ink");
		const on = this.$(".tab.on");
		const nav = this.$(".tabs");
		nav.classList.add("has-ink");
		if (!on) {
			ink.style.opacity = "0";
			return;
		}
		const first = !ink.style.width;
		ink.classList.toggle("instant", !!(instant || first));
		Object.assign(ink.style, { opacity: "1", left: on.offsetLeft + "px", top: on.offsetTop + "px", width: on.offsetWidth + "px", height: on.offsetHeight + "px" });
		if (first) setTimeout(() => this.moveInk(true), 400);
	}

	/** Entrance for freshly rendered content: blocks rise in one after another, bars grow, numbers count up. */
	animate(container, dir = 0) {
		if (!container || orReduced()) return;
		const GROUP = /^(grid2|grid3|ins-kpis|kpis|st-cards|mp-cards|drill-sum|ins-list)$/;
		const items = [];
		const walk = (el, depth) => {
			for (const c of el.children) {
				if (c.classList.contains("spin") || c.classList.contains("drill-gap")) continue;
				if (depth < 2 && [...c.classList].some((k) => GROUP.test(k))) walk(c, depth + 1);
				else items.push(c);
			}
		};
		walk(container, 0);
		container.style.setProperty("--dir", dir);
		items.slice(0, 30).forEach((el, i) => {
			el.style.setProperty("--i", Math.min(i, 14));
			el.classList.add("rise");
		});
		container.classList.add("anim-bars");
		container.querySelectorAll(".ins-kpi .v, .kpi .v, .st-total, .mp-main").forEach((el) => orCountUp(el));
		clearTimeout(container._animT);
		container._animT = setTimeout(() => {
			items.forEach((el) => el.classList.remove("rise"));
			container.classList.remove("anim-bars");
		}, 1800);
	}

	/** Close an overlay with a short fade instead of removing it abruptly. */
	dismiss(ov) {
		if (!ov.isConnected || ov.classList.contains("closing")) return;
		if (orReduced()) return ov.remove();
		ov.classList.add("closing");
		setTimeout(() => ov.remove(), 180);
	}

	stale(token) {
		return this.token !== token;
	}

	// -------------------------------------------------------------- server

	async api(method, args = {}) {
		const res = await fetch("/api/method/" + (method.includes(".") ? method : OR_API + method), {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", "X-Frappe-CSRF-Token": frappe.csrf_token },
			body: JSON.stringify(args),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data.exc || data.exception) throw new Error(this.serverError(data, res.status));
		return data.message;
	}

	serverError(data, status) {
		const msgs = [];
		if (data._server_messages) {
			try {
				JSON.parse(data._server_messages).forEach((m) => {
					try {
						const o = JSON.parse(m);
						msgs.push(o.message || m);
					} catch (e) {
						msgs.push(m);
					}
				});
			} catch (e) {
				/* ignore */
			}
		}
		if (!msgs.length && data.exception) msgs.push(String(data.exception).replace(/^[\w.]+Error:\s*/, ""));
		if (!msgs.length) msgs.push(status === 403 ? "You do not have permission for this." : "Something went wrong. Please try again.");
		return orStrip(msgs.join("\n"));
	}

	async upload(file, doctype, docname) {
		const fd = new FormData();
		fd.append("file", file, file.name);
		fd.append("is_private", "1");
		fd.append("folder", "Home/Attachments");
		if (doctype) fd.append("doctype", doctype);
		if (docname) fd.append("docname", docname);
		const res = await fetch("/api/method/upload_file", {
			method: "POST",
			headers: { Accept: "application/json", "X-Frappe-CSRF-Token": frappe.csrf_token },
			body: fd,
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data.exc) throw new Error(this.serverError(data, res.status));
		return data.message.file_url;
	}

	// -------------------------------------------------------------- feedback

	toast(message, kind = "ok") {
		const t = document.createElement("div");
		t.className = "toast " + (kind === "ok" ? "" : kind);
		t.textContent = message;
		this.$(".toasts").appendChild(t);
		setTimeout(() => {
			t.classList.add("out");
			setTimeout(() => t.remove(), 220);
		}, kind === "error" ? 9000 : 4500);
	}

	confirm(title, message, label = "Confirm") {
		return new Promise((resolve) => {
			const m = this.modal({
				title,
				body: `<div class="note" style="white-space:pre-line">${orEsc(message)}</div>`,
				primary: label,
				onSubmit: () => {
					resolve(true);
					return true;
				},
				onClose: () => resolve(false),
			});
			return m;
		});
	}

	/**
	 * modal({title, fields, body, primary, wide, onSubmit(values, m) -> truthy/Promise, onOpen(m), onClose})
	 * fields: {name, label, type: text|number|date|select|textarea|link|file|check|html, options, reqd, default, help, doctype, filters}
	 */
	modal(opts) {
		const ov = document.createElement("div");
		ov.className = "overlay";
		ov.innerHTML = `
			<div class="modal ${opts.wide ? "wide" : ""}" role="dialog">
				<div class="modal-head"><h3>${orEsc(opts.title)}</h3><button class="round sm ghost" data-x>${orIcon("x")}</button></div>
				<div class="modal-body">${opts.body || ""}${(opts.fields || []).map((f) => this.fieldHtml(f)).join("")}</div>
				<div class="modal-foot">
					<button class="btn" data-x>${opts.primary === false ? "Close" : "Cancel"}</button>
					${opts.primary === false ? "" : `<button class="btn white" data-ok>${orEsc(opts.primary || "Save")}</button>`}
				</div>
			</div>`;
		this.$(".stage").appendChild(ov);
		const m = {
			el: ov,
			close: () => {
				this.dismiss(ov);
				if (opts.onClose && !m.done) opts.onClose();
			},
			values: () => this.readFields(ov, opts.fields || []),
			set: (name, value) => this.setField(ov, name, value),
		};
		this.wireFields(ov, opts.fields || []);
		ov.addEventListener("click", (e) => {
			if (e.target === ov || e.target.closest("[data-x]")) m.close();
		});
		const ok = ov.querySelector("[data-ok]");
		if (ok) {
			ok.addEventListener("click", async () => {
				const values = m.values();
				const missing = (opts.fields || []).filter((f) => f.reqd && (values[f.name] === "" || values[f.name] == null));
				if (missing.length) {
					this.toast("Please fill: " + missing.map((f) => f.label).join(", "), "error");
					return;
				}
				ok.disabled = true;
				const label = ok.textContent;
				ok.textContent = "Working…";
				try {
					const res = await opts.onSubmit(values, m);
					if (res !== false) {
						m.done = true;
						this.dismiss(ov);
					}
				} catch (err) {
					this.toast(err.message || String(err), "error");
				} finally {
					ok.disabled = false;
					ok.textContent = label;
				}
			});
		}
		if (opts.onOpen) opts.onOpen(m);
		const first = ov.querySelector(".modal-body .inp");
		if (first) setTimeout(() => first.focus(), 30);
		return m;
	}

	fieldHtml(f) {
		const id = "f_" + f.name;
		const req = f.reqd ? " <b>*</b>" : "";
		const help = f.help ? `<div class="help">${orEsc(f.help)}</div>` : "";
		const val = f.default == null ? "" : f.default;
		let control;
		switch (f.type) {
			case "html":
				return `<div data-field="${f.name}">${f.html || ""}</div>`;
			case "select":
				control = `<select class="inp" data-name="${f.name}" id="${id}">${(f.options || [])
					.map((o) => {
						const [v, l] = typeof o === "object" ? [o.value, o.label] : [o, o];
						return `<option value="${orEsc(v)}" ${String(v) === String(val) ? "selected" : ""}>${orEsc(l === "" ? "—" : l)}</option>`;
					})
					.join("")}</select>`;
				break;
			case "textarea":
				control = `<textarea class="inp" data-name="${f.name}" id="${id}" spellcheck="false">${orEsc(val)}</textarea>`;
				break;
			case "check":
				control = `<label class="toggle"><input type="checkbox" data-name="${f.name}" ${val ? "checked" : ""}><span class="sw"></span><span>${orEsc(f.label)}</span></label>`;
				return `<div class="fld">${control}${help}</div>`;
			case "file":
				control = `<label class="file-drop" data-file="${f.name}">${orIcon("upload")}<span>${orEsc(f.placeholder || "Choose a file")}</span>
					<input type="file" hidden accept="${orEsc(f.accept || "")}"><input type="hidden" data-name="${f.name}" value=""></label>`;
				break;
			case "link":
				control = `<div class="ac-wrap"><input class="inp" autocomplete="off" data-name="${f.name}" data-link="${orEsc(f.doctype)}" id="${id}" value="${orEsc(val)}" placeholder="${orEsc(f.placeholder || "Search " + f.doctype)}"></div>`;
				break;
			default:
				control = `<input class="inp" type="${f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}" ${f.type === "number" ? 'step="any"' : ""} data-name="${f.name}" id="${id}" value="${orEsc(val)}" placeholder="${orEsc(f.placeholder || "")}">`;
		}
		return `<div class="fld"><label for="${id}">${orEsc(f.label)}${req}</label>${control}${help}</div>`;
	}

	wireFields(root, fields) {
		this.$$("[data-link]", root).forEach((input) => this.linkControl(input, () => {
			const f = fields.find((x) => x.name === input.dataset.name);
			return f && f.filters ? (typeof f.filters === "function" ? f.filters() : f.filters) : {};
		}));
		this.$$("[data-file]", root).forEach((label) => {
			const file = label.querySelector("input[type=file]");
			const hidden = label.querySelector("input[type=hidden]");
			const f = fields.find((x) => x.name === label.dataset.file) || {};
			file.addEventListener("change", async () => {
				if (!file.files[0]) return;
				label.querySelector("span").textContent = "Uploading " + file.files[0].name + "…";
				try {
					hidden.value = await this.upload(file.files[0], f.doctype, f.docname);
					label.classList.add("done");
					label.querySelector("span").textContent = file.files[0].name;
				} catch (err) {
					label.querySelector("span").textContent = "Upload failed, choose again";
					this.toast(err.message, "error");
				}
			});
		});
		fields.forEach((f) => {
			if (f.onchange) {
				const el = root.querySelector(`[data-name="${f.name}"]`);
				if (el) el.addEventListener("change", () => f.onchange(el.type === "checkbox" ? el.checked : el.value));
			}
		});
	}

	readFields(root, fields) {
		const out = {};
		fields.forEach((f) => {
			const el = root.querySelector(`[data-name="${f.name}"]`);
			if (!el) return;
			if (el.type === "checkbox") out[f.name] = el.checked ? 1 : 0;
			else if (f.type === "number") out[f.name] = el.value === "" ? "" : orFlt(el.value);
			else out[f.name] = el.value.trim();
		});
		return out;
	}

	setField(root, name, value) {
		const el = root.querySelector(`[data-name="${name}"]`);
		if (!el) return;
		if (el.type === "checkbox") el.checked = !!value;
		else el.value = value == null ? "" : value;
	}

	/** Autocomplete for a Link input (server whitelist in ui_api.link_search). */
	linkControl(input, getFilters) {
		let box = null;
		let timer = null;
		const stage = this.$(".stage");
		// The list lives on the stage (not inside the field's container) so scrolling tables and cards can't clip it.
		const place = () => {
			if (!box) return;
			const r = input.getBoundingClientRect();
			const st = stage.getBoundingClientRect();
			box.style.width = Math.max(r.width, 280) + "px";
			box.style.left = Math.min(r.left - st.left, st.width - Math.max(r.width, 280) - 8) + "px";
			const below = r.bottom - st.top + 4;
			const fitsBelow = r.bottom + box.offsetHeight + 8 <= st.bottom;
			box.style.top = (fitsBelow ? below : r.top - st.top - box.offsetHeight - 4) + "px";
		};
		const close = () => {
			if (box) box.remove();
			box = null;
			this.root.removeEventListener("scroll", place, true);
		};
		const pick = (v) => {
			input.value = v;
			close();
			input.dispatchEvent(new Event("change", { bubbles: true }));
		};
		const open = async () => {
			const items = await this.api("link_search", {
				doctype: input.dataset.link,
				txt: input.value,
				filters: getFilters ? getFilters() : {},
			}).catch(() => []);
			if (input.getRootNode().activeElement !== input) return;
			close();
			box = document.createElement("div");
			box.className = "ac ac-float";
			box.innerHTML = items.length
				? items.map((it, i) => `<div data-v="${orEsc(it.value)}" class="${i ? "" : "on"}">${orEsc(it.value)}${it.label && it.label !== it.value ? `<small>${orEsc(it.label)}</small>` : ""}</div>`).join("")
				: `<div class="faint">No match</div>`;
			box.addEventListener("mousedown", (e) => {
				const d = e.target.closest("[data-v]");
				if (d) {
					e.preventDefault();
					pick(d.dataset.v);
				}
			});
			stage.appendChild(box);
			place();
			this.root.addEventListener("scroll", place, true);
		};
		input.addEventListener("focus", open);
		input.addEventListener("input", () => {
			clearTimeout(timer);
			timer = setTimeout(open, 180);
		});
		input.addEventListener("blur", () => setTimeout(close, 150));
		input.addEventListener("keydown", (e) => {
			if (!box) return;
			const opts = Array.from(box.querySelectorAll("[data-v]"));
			let i = opts.findIndex((o) => o.classList.contains("on"));
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				if (opts[i]) opts[i].classList.remove("on");
				i = e.key === "ArrowDown" ? Math.min(i + 1, opts.length - 1) : Math.max(i - 1, 0);
				if (opts[i]) opts[i].classList.add("on");
			} else if (e.key === "Enter" && opts[i]) {
				e.preventDefault();
				pick(opts[i].dataset.v);
			} else if (e.key === "Escape") close();
		});
	}

	/** Command-palette search (Ctrl + K): records, secondary orders and quick links. */
	searchDialog() {
		if (this.$(".palette-wrap")) return;
		const quick = [
			["", "Dashboard", "home"],
			["trackers", "Primary Sales", "truck"],
			["secondary", "Secondary Sales", "swap"],
			["reports", "Reports", "chart"],
			["setup", "Settings", "gear"],
		];
		const ov = document.createElement("div");
		ov.className = "overlay palette-wrap";
		ov.innerHTML = `
			<div class="palette" role="dialog" aria-label="Search">
				<div class="pal-input">${orIcon("search")}<input data-q placeholder="Search records, PO numbers, Sales Orders, order IDs, items…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
				<div class="pal-results"></div>
				<div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Ctrl</kbd><kbd>K</kbd> anywhere</span></div>
			</div>`;
		this.$(".stage").appendChild(ov);
		const q = ov.querySelector("[data-q]");
		const box = ov.querySelector(".pal-results");
		let items = [];
		let active = 0;
		let timer;
		const close = () => this.dismiss(ov);
		const paint = () => {
			box.querySelectorAll(".pal-item").forEach((el, i) => el.classList.toggle("on", i === active));
			const on = box.querySelector(".pal-item.on");
			if (on) on.scrollIntoView({ block: "nearest" });
		};
		const showQuick = () => {
			items = quick.map(([route, label, icon]) => ({ go: route, title: label, icon }));
			box.innerHTML = `<div class="pal-group">Go to</div>` + items.map((it, i) => `<a class="pal-item" data-i="${i}"><span class="pal-ico">${orIcon(it.icon)}</span><span class="pal-text"><b>${orEsc(it.title)}</b></span><span class="pal-enter">↵</span></a>`).join("");
			active = 0;
			paint();
		};
		const showResults = (rows) => {
			const groups = [["tracker", "Primary Sales records", "truck", "cyan"], ["secondary", "Secondary sales", "swap", "lime"]];
			items = [];
			let html = "";
			groups.forEach(([type, label, icon, tone]) => {
				const rs = rows.filter((r) => r.type === type);
				if (!rs.length) return;
				html += `<div class="pal-group">${label}</div>`;
				rs.forEach((r) => {
					items.push({ go: `${type === "tracker" ? "tracker" : "order"}|${r.name}` });
					html += `<a class="pal-item" data-i="${items.length - 1}"><span class="pal-ico ${tone}">${orIcon(icon)}</span>
						<span class="pal-text"><b>${orEsc(r.title)}</b><small>${orEsc(r.subtitle)}</small></span><span class="pal-enter">↵</span></a>`;
				});
			});
			box.innerHTML = html || `<div class="pal-empty">${orIcon("search")}<b>No matches for “${orEsc(q.value)}”</b><small>Try a PO number, a record ID like OR-MYN-2026-0001, or an item code.</small></div>`;
			active = 0;
			paint();
		};
		const open = (i) => {
			const it = items[i];
			if (!it) return;
			close();
			this.go(...it.go.split("|"));
		};
		showQuick();
		q.focus();
		q.addEventListener("input", () => {
			clearTimeout(timer);
			const txt = q.value.trim();
			if (txt.length < 2) return showQuick();
			box.innerHTML = `<div class="pal-loading"><span class="dot-pulse"></span> Searching…</div>`;
			timer = setTimeout(async () => {
				const rows = await this.api("global_search", { txt }).catch(() => []);
				if (q.value.trim() === txt) showResults(rows);
			}, 180);
		});
		q.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				active = Math.min(active + 1, items.length - 1);
				paint();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				active = Math.max(active - 1, 0);
				paint();
			} else if (e.key === "Enter") {
				e.preventDefault();
				open(active);
			} else if (e.key === "Escape") {
				close();
			}
		});
		box.addEventListener("mousemove", (e) => {
			const it = e.target.closest(".pal-item");
			if (it && +it.dataset.i !== active) {
				active = +it.dataset.i;
				paint();
			}
		});
		box.addEventListener("click", (e) => {
			const it = e.target.closest(".pal-item");
			if (it) open(+it.dataset.i);
		});
		ov.addEventListener("mousedown", (e) => {
			if (e.target === ov) close();
		});
	}
}

// ------------------------------------------------------------------ views: shared bits

class OrView {
	constructor(app, name) {
		this.app = app;
		this.name = name;
	}
	get main() {
		return this.app.main;
	}
	api(m, a) {
		return this.app.api(m, a);
	}
	$(s) {
		return this.app.$(s, this.main);
	}
	$$(s) {
		return this.app.$$(s, this.main);
	}
	head(title, sub = "", actions = "", back = null) {
		return `<div class="view-head">
			<div>${back ? `<a class="back" data-go="${back[0]}">${orIcon("back")} ${orEsc(back[1])}</a>` : ""}
				<h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div>
			<div class="actions">${actions}</div>
		</div>`;
	}
	marketplaceOptions(all = "All marketplaces") {
		return [{ value: "", label: all }, ...this.app.boot.marketplaces.map((m) => ({ value: m, label: m }))];
	}
	/** Date filter that looks exactly like selectHtml's dropdowns (or_app.css .date-inp). */
	dateHtml(name, value, label) {
		return `<input class="inp sm date-inp" type="date" data-f="${name}" value="${orEsc(value || "")}" title="${orEsc(label)}" aria-label="${orEsc(label)}">`;
	}

	selectHtml(name, options, value) {
		return `<select class="inp sm" data-f="${name}" style="width:auto;min-width:160px">${options
			.map((o) => `<option value="${orEsc(o.value)}" ${String(o.value) === String(value || "") ? "selected" : ""}>${orEsc(o.label)}</option>`)
			.join("")}</select>`;
	}
}

// ------------------------------------------------------------------ dashboard

class DashboardView extends OrView {
	constructor(app) {
		super(app);
		this.period = app._dashPeriod || "Month";
		this.marketplace = app._dashMarketplace || "";
		this.metric = "value";
	}
	async render(token) {
		const d = (this.data = await this.api("or_model.marketplace_or.insights.dashboard", { period: this.period, marketplace: this.marketplace }));
		if (this.app.stale(token)) return;
		this.app._dashPeriod = this.period;
		this.app._dashMarketplace = this.marketplace;
		const k = d.kpis;
		const change = (v, invert) => {
			if (v == null) return `<span class="delta flat">no prior data</span>`;
			const good = invert ? v <= 0 : v >= 0;
			return `<span class="delta ${good ? "up" : "down"}">${v >= 0 ? "▲" : "▼"} ${Math.abs(v).toFixed(1)}%</span>`;
		};
		const periodLabel = { Week: "this week", Month: "this month", Quarter: "this quarter", Year: "this year" }[this.period];
		const mixTotal = k.lines_above + k.lines_at + k.lines_below || 1;
		this.main.innerHTML = `
			<section class="view-head hello">
				<div>
					<h1>Welcome back, <span>${orEsc(d.first_name)}</span></h1>
					<div class="sub">${orDate(d.start)} – ${orDate(d.end)} · ${k.open_records} open records${this.marketplace ? " · " + orEsc(this.marketplace) : ""}</div>
				</div>
				<div class="actions">
					${this.selectHtml("dash-mp", this.marketplaceOptions(), this.marketplace)}
					<div class="seg-ctl">${["Week", "Month", "Quarter", "Year"].map((p) => `<button data-act="period" data-p="${p}" class="${p === this.period ? "on" : ""}">${p}</button>`).join("")}</div>
				</div>
			</section>

			<section class="ins-kpis">
				<div class="ins-kpi hero-kpi c1 clickable" data-act="kpi" data-k="secondary">
					<div class="k">Secondary sales ${periodLabel}</div>
					<div class="v">${orInr(k.secondary_value, 0)}</div>
					<div class="foot">${change(k.secondary_value_change)} <span>${orQty(k.units)} units · ${k.orders} orders · avg ${orInr(k.avg_price)}</span></div>
				</div>
				<div class="ins-kpi c2 clickable" data-act="kpi" data-k="dispatched">
					<div class="k">Dispatched to marketplaces</div>
					<div class="v">${orCompact(k.primary_value)}</div>
					<div class="foot">${change(k.primary_change)} <span>primary sales ${periodLabel}</span></div>
				</div>
				<div class="ins-kpi c3 clickable" data-act="kpi" data-k="sellthrough">
					<div class="k">Sell-through</div>
					<div class="v ${k.sell_through >= 60 ? "lime" : k.sell_through < 25 ? "orange" : ""}">${k.sell_through}%</div>
					<div class="meter"><i style="width:${Math.min(k.sell_through, 100)}%"></i></div>
					<div class="foot"><span>of units received by marketplaces are sold</span></div>
				</div>
				<div class="ins-kpi c4 clickable" data-act="kpi" data-k="held">
					<div class="k">Stock at marketplaces</div>
					<div class="v">${orQty(k.held)} <small>units</small></div>
					<div class="foot"><span>${orCompact(k.held_value)} at your rate${k.in_transit ? ` · ${orQty(k.in_transit)} in transit` : ""}</span></div>
				</div>
				<div class="ins-kpi c5 clickable" data-act="kpi" data-k="realisation">
					<div class="k">Price realisation</div>
					<div class="v ${k.realisation == null ? "" : k.realisation >= 100 ? "lime" : "red"}">${k.realisation == null ? "—" : k.realisation + "%"}</div>
					<div class="mix" title="Sale lines above / at / below your rate">
						<i class="above" style="width:${(k.lines_above / mixTotal) * 100}%"></i><i class="at" style="width:${(k.lines_at / mixTotal) * 100}%"></i><i class="below" style="width:${(k.lines_below / mixTotal) * 100}%"></i>
					</div>
					<div class="foot"><span>${k.lines_above} above · ${k.lines_at} at · ${k.lines_below} below your rate · variance <b class="${k.variance < 0 ? "neg" : "pos"}">${orInr(k.variance, 0)}</b></span></div>
				</div>
				<div class="ins-kpi c6 clickable" data-act="kpi" data-k="returns">
					<div class="k">Customer returns</div>
					<div class="v ${k.return_rate > 10 ? "red" : ""}">${k.return_rate}%</div>
					<div class="foot"><span>${orQty(k.returns_units)} units returned ${periodLabel}</span></div>
				</div>
			</section>

			<section class="ins-row">
				<div class="card span2">
					<div class="card-head">
						<span class="card-title">${orIcon("chart")} Sales trend</span>
						<div class="seg-ctl small-seg">${[["value", "Secondary ₹"], ["units", "Units"], ["primary", "Dispatched ₹"]].map(([m, l]) => `<button data-act="metric" data-m="${m}" class="${m === this.metric ? "on" : ""}">${l}</button>`).join("")}</div>
					</div>
					<div class="trend"></div>
				</div>
				<div class="card">
					<div class="card-head"><span class="card-title">${orIcon("check")} Needs attention</span><span class="pill ${d.actions.length ? "orange" : "green"}"><i></i>${d.actions.length || "All clear"}</span></div>
					<div class="actions-list">
						${d.actions.length ? d.actions.map((a, i) => `<a class="act-item" data-act="action" data-i="${i}">
							<span class="tone ${a.tone}"></span>
							<span class="act-text"><b>${orEsc(a.title)}</b><small>${orEsc(a.detail || "")}</small></span>
							<span class="chev">›</span></a>`).join("")
						: `<div class="empty">Nothing needs your attention right now.</div>`}
					</div>
				</div>
			</section>

			<section class="card">
				<div class="card-head"><span class="card-title">${orIcon("globe")} Marketplace performance</span><span class="muted small">Sales ${periodLabel}; stock and sell-through on open records</span></div>
				${d.marketplaces.length ? `<div class="table-wrap"><table class="t">
					<thead><tr><th>Marketplace</th><th class="num">Sales</th><th style="width:140px">Share</th><th class="num">Units</th><th style="width:150px">Sell-through</th>
					<th class="num">Held</th><th class="num">Held value</th><th class="num">Realisation</th><th class="num">Net variance</th></tr></thead>
					<tbody>${d.marketplaces.map((m) => `<tr class="click" data-act="mp-row" data-mp="${orEsc(m.marketplace)}">
						<td>${orPill(m.marketplace, "lime")}</td>
						<td class="num strong">${orInr(m.period_value || 0, 0)}</td>
						<td><div class="bar-cell"><i style="width:${m.share || 0}%"></i><span>${m.share || 0}%</span></div></td>
						<td class="num">${orQty(m.period_units || 0)}</td>
						<td><div class="bar-cell lime"><i style="width:${Math.min(m.sell_through, 100)}%"></i><span>${m.sell_through}%</span></div></td>
						<td class="num">${orQty(m.held)}</td>
						<td class="num">${orCompact(m.held_value)}</td>
						<td class="num ${m.realisation == null ? "" : m.realisation >= 100 ? "pos" : "neg"}">${m.realisation == null ? "—" : m.realisation + "%"}</td>
						<td class="num ${m.net_variance < 0 ? "neg" : "pos"}">${orInr(m.net_variance, 0)}</td></tr>`).join("")}
					</tbody></table></div>` : `<div class="empty">No marketplace activity yet.</div>`}
			</section>

			<section class="grid3" style="margin-top:12px">
				<div class="card">
					<div class="card-head"><span class="card-title">${orIcon("grid")} Stock ageing at marketplaces</span></div>
					${this.ageingHtml(d.ageing)}
				</div>
				<div class="card">
					<div class="card-head"><span class="card-title">${orIcon("up")} Top sellers ${periodLabel}</span></div>
					${this.topHtml(d.top_items)}
				</div>
				<div class="card">
					<div class="card-head"><span class="card-title">${orIcon("swap")} Stock cover</span>
						<div class="seg-ctl small-seg"><button data-act="cover" data-c="slow" class="${this.cover !== "low" ? "on" : ""}">Slow movers</button><button data-act="cover" data-c="low" class="${this.cover === "low" ? "on" : ""}">Running low</button></div></div>
					<div class="cover-box">${this.coverHtml()}</div>
				</div>
			</section>`;
		this.trend();
		this.$("[data-f=dash-mp]").addEventListener("change", (e) => {
			this.marketplace = e.target.value;
			this.render((this.app.token = Symbol()));
		});
	}

	ageingHtml(rows) {
		const total = rows.reduce((a, r) => a + r.qty, 0);
		if (!total) return `<div class="empty">No stock held at marketplaces.</div>`;
		const colours = ["#d5f65a", "#ffd166", "#ff9f43", "#ff6b6b"];
		return `<div class="stack-bar">${rows.map((r, i) => `<i style="width:${(r.qty / total) * 100}%;background:${colours[i]}" title="${orEsc(r.bucket)}: ${orQty(r.qty)} units"></i>`).join("")}</div>
			<table class="t compact"><tbody>${rows.map((r, i) => `<tr><td><span class="dot" style="background:${colours[i]}"></span>${orEsc(r.bucket)}</td>
				<td class="num">${orQty(r.qty)} units</td><td class="num muted">${orCompact(r.value)}</td><td class="num muted">${total ? Math.round((r.qty / total) * 100) : 0}%</td></tr>`).join("")}</tbody></table>
			<div class="hint">Held since dispatch, oldest first (FIFO). Stock older than 90 days is a candidate for a Primary Return.</div>`;
	}

	topHtml(items) {
		if (!items.length) return `<div class="empty">No secondary sales in this period.</div>`;
		const max = Math.max(...items.map((i) => i.period_value), 1);
		return `<div class="rank">${items.map((i, n) => `<div class="rank-row">
			<span class="rank-n">${n + 1}</span>
			<div class="rank-body"><div class="rank-top"><b>${orEsc(i.item_code)}</b><span>${orInr(i.period_value, 0)}</span></div>
			<div class="rank-bar"><i style="width:${(i.period_value / max) * 100}%"></i></div>
			<small>${orQty(i.period_units)} units · sell-through ${i.sell_through}% · ${orQty(i.held)} still held</small></div></div>`).join("")}</div>`;
	}

	coverHtml() {
		const d = this.data;
		const items = this.cover === "low" ? d.low_cover : d.slow_items;
		if (!items.length) return `<div class="empty">${this.cover === "low" ? "No item is about to run out (cover under 15 days)." : "No stock held."}</div>`;
		return `<div class="rank">${items.map((i) => {
			const days = i.days_cover;
			const tone = days == null ? "red" : days <= 15 ? "orange" : days > 90 ? "red" : "green";
			return `<div class="cover-row"><div><b>${orEsc(i.item_code)}</b><small>${orQty(i.held)} held · ${orQty(i.sold_30d)} sold in 30 days · oldest ${i.oldest_age} days</small></div>
				<span class="pill ${tone}"><i></i>${days == null ? "no sales" : days + " days cover"}</span></div>`;
		}).join("")}</div>
		<div class="hint">Days of cover = units held ÷ average daily sales over the last 30 days.</div>`;
	}

	trend() {
		const data = this.data.trend;
		const box = this.$(".trend");
		const m = this.metric;
		const W = 760, H = 240, L = 54, R = 10, T = 14, B = 26;
		const vals = data.map((t) => t[m] || 0);
		const max = Math.max(...vals, 1);
		const nice = (v) => {
			const p = Math.pow(10, Math.floor(Math.log10(v)));
			return Math.ceil(v / p) * p;
		};
		const top = nice(max);
		const n = data.length;
		const slot = (W - L - R) / Math.max(n, 1);
		const bw = Math.max(Math.min(slot * 0.62, 34), 3);
		const y = (v) => T + (H - T - B) * (1 - v / top);
		const fmt = (v) => (m === "units" ? orQty(v) : orCompact(v));
		const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
		const every = Math.ceil(n / 10);
		box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg"><defs><linearGradient id="orBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d5f65a"/><stop offset="1" stop-color="#7c4dff"/></linearGradient></defs>
			${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 8}" y="${y(t) + 3}" text-anchor="end">${fmt(t)}</text>`).join("")}
			${data.map((t, i) => {
				const x = L + slot * i + (slot - bw) / 2;
				const v = t[m] || 0;
				return `<rect class="bar ${m}" x="${x}" y="${y(v)}" width="${bw}" height="${Math.max(H - B - y(v), v ? 2 : 0)}" rx="${Math.min(4, bw / 3)}" data-i="${i}"/>
					<rect class="hit" x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}" data-i="${i}"/>
					${i % every === 0 ? `<text x="${L + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle">${orEsc(t.label)}</text>` : ""}`;
			}).join("")}
		</svg><div class="tooltip hide"></div>`;
		const tip = box.querySelector(".tooltip");
		box.querySelectorAll(".hit").forEach((r) => {
			r.addEventListener("mouseenter", () => {
				const t = data[+r.dataset.i];
				box.querySelectorAll(".bar").forEach((b) => b.classList.toggle("dim", b.dataset.i !== r.dataset.i));
				tip.innerHTML = `<b>${orEsc(t.label)}</b><div>Secondary <span>${orInr(t.value, 0)}</span></div><div>Units <span>${orQty(t.units)}</span></div><div>Dispatched <span>${orInr(t.primary, 0)}</span></div>`;
				tip.classList.remove("hide");
				const rect = r.getBoundingClientRect();
				const host = box.getBoundingClientRect();
				tip.style.left = Math.min(rect.left - host.left + rect.width / 2, host.width - 90) + "px";
			});
			r.addEventListener("mouseleave", () => {
				tip.classList.add("hide");
				box.querySelectorAll(".bar").forEach((b) => b.classList.remove("dim"));
			});
		});
		if (!vals.some(Boolean)) box.insertAdjacentHTML("beforeend", `<div class="trend-empty">No ${m === "primary" ? "dispatches" : "secondary sales"} in this period</div>`);
	}


	/** Detail popup behind each headline number. */
	/** Insight panel behind each headline number: findings, one card per marketplace, comparisons. */
	async drill(key) {
		const app = this.app;
		const d = this.data;
		const mp = this.marketplace;
		const periodWord = { Week: "this week", Month: "this month", Quarter: "this quarter", Year: "this year" }[this.period];
		const titles = {
			secondary: ["Secondary sales", periodWord],
			dispatched: ["Dispatched to marketplaces", periodWord],
			sellthrough: ["Sell-through", "open records"],
			held: ["Stock at marketplaces", "right now"],
			realisation: ["Price realisation", periodWord],
			returns: ["Customer returns", periodWord],
		};
		const [title, when] = titles[key];
		const m = app.modal({ title: `${title} · ${when}${mp ? " · " + mp : ""}`, primary: false, body: '<div class="drill-body"><div class="spin"></div></div>' });
		m.el.querySelector(".modal").classList.add("xl");

		const api = (dataset, extra = {}) => this.api("or_model.marketplace_or.insights.report_data", { dataset, marketplace: mp, ...extra });
		const today = frappe.datetime.str_to_obj(frappe.datetime.get_today());
		const daysAgo = (n) => frappe.datetime.obj_to_str(new Date(today.getTime() - n * 864e5));
		const inPeriod = (date) => date && date >= d.start && date <= d.end;
		const sum = (rows, f) => rows.reduce((a, r) => a + (typeof f === "function" ? f(r) : r[f] || 0), 0);
		const groupBy = (rows, k) => {
			const g = new Map();
			rows.forEach((r) => {
				const key = r[k] ?? "(blank)";
				if (!g.has(key)) g.set(key, []);
				g.get(key).push(r);
			});
			return g;
		};
		const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
		const PALETTE = ["#d5f65a", "#7dd3fc", "#f472b6", "#fb923c", "#a78bfa", "#2dd4bf", "#facc15", "#f87171"];
		const mpColour = {};
		[...this.app.boot.marketplaces].sort().forEach((name, i) => (mpColour[name] = PALETTE[i % PALETTE.length]));
		const colourOf = (name) => mpColour[name] || "#a78bfa";

		// ---------- building blocks
		const insightsHtml = (items) => `<div class="ins-list">${items.filter(Boolean).map(([tone, text]) => `<div class="ins-item ${tone}"><span class="ins-dot"></span><span>${text}</span></div>`).join("")}</div>`;
		// One card per metric: the overall number, then a line per marketplace.
		// def = { label, total, unit, hint, pct (n is already a %), row: (mp) => ({ v, n, cls, sub }) }
		const statCards = (list, defs) => `<div class="st-cards">${defs.map((c, i) => {
			const rows = list.map((x) => ({ x, ...c.row(x) }));
			const max = Math.max(...rows.map((r) => Math.abs(r.n || 0)), 1e-9);
			return `<div class="st-card t${(i % 6) + 1}">
				<div class="st-label">${c.label}</div>
				<div class="st-total">${c.total}${c.unit ? `<small>${c.unit}</small>` : ""}</div>
				${c.hint ? `<div class="st-hint">${c.hint}</div>` : ""}
				<div class="st-rows">${rows.length ? rows.map((r) => `<div class="st-row" style="--mp:${colourOf(r.x.name)}">
					<span class="st-mp"><i></i>${orEsc(r.x.name)}</span>
					<b class="${r.cls || ""}">${r.v}${r.sub ? `<small>${r.sub}</small>` : ""}</b>
					<span class="st-bar"><i style="width:${Math.min(Math.max(c.pct ? r.n || 0 : (Math.abs(r.n || 0) / max) * 100, 0), 100)}%"></i></span>
				</div>`).join("") : `<div class="faint">No marketplace data</div>`}</div>
			</div>`;
		}).join("")}</div>`;
		const panel = (t, body, hint) => `<div class="card ins-panel"><div class="card-head"><span class="card-title">${t}</span></div>${body}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
		const hbars = (pairs, fmt, colourFn) => {
			if (!pairs.length) return `<div class="empty">Nothing to show.</div>`;
			const max = Math.max(...pairs.map((p) => Math.abs(p[1])), 1);
			return `<div class="hbars">${pairs.map(([g, v, sub]) => `<div class="hbar"><span class="hb-label">${orEsc(g)}${sub ? `<small>${sub}</small>` : ""}</span>
				<span class="hb-track"><i style="width:${(Math.abs(v) / max) * 100}%;${colourFn ? `background:${colourFn(g, v)}` : ""}" class="${v < 0 ? "neg" : ""}"></i></span><span class="hb-val">${fmt(v)}</span></div>`).join("")}</div>`;
		};
		const columns = (pairs, fmt) => {
			if (!pairs.length || !pairs.some((p) => p[1])) return `<div class="empty">Nothing in this period.</div>`;
			const max = Math.max(...pairs.map((p) => Math.abs(p[1])), 1);
			return `<div class="vcols">${pairs.map(([l, v, hl]) => `<div class="vcol ${hl ? "hl" : ""}" title="${orEsc(l)}: ${fmt(v)}"><span class="vv">${v ? fmt(v) : ""}</span><i style="height:${Math.max((Math.abs(v) / max) * 100, v ? 3 : 0)}%"></i><span class="vl">${orEsc(l)}</span></div>`).join("")}</div>`;
		};
		const matrix = (rows, rowKey, colKey, val, fmt) => {
			const rk = [...new Set(rows.map((r) => r[rowKey]))].sort();
			const ck = [...new Set(rows.map((r) => r[colKey]))].sort();
			const cell = (a, b) => sum(rows.filter((r) => r[rowKey] === a && r[colKey] === b), val);
			const max = Math.max(...rk.flatMap((a) => ck.map((b) => cell(a, b))), 1);
			return `<div class="table-wrap"><table class="t heat"><thead><tr><th></th>${ck.map((c) => `<th class="num">${orEsc(c)}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>
				${rk.map((a) => `<tr><td class="strong">${orEsc(a)}</td>${ck.map((b) => {
					const v = cell(a, b);
					// white text only on the deeper cells; pale cells keep the theme's text colour
					return `<td class="num ${v / max > 0.45 ? "hot" : ""}" style="background:rgba(124,77,255,${v ? (0.12 + 0.6 * (v / max)).toFixed(2) : 0})">${v ? fmt(v) : '<span class="faint">·</span>'}</td>`;
				}).join("")}<td class="num strong">${fmt(sum(rows.filter((r) => r[rowKey] === a), val))}</td></tr>`).join("")}</tbody></table></div>`;
		};
		const stack = (parts, total) => `<div class="stack-bar">${parts.map(([label, v, c]) => `<i style="width:${total ? (v / total) * 100 : 0}%;background:${c}" title="${orEsc(label)}: ${orQty(v)}"></i>`).join("")}</div>`;

		let html = "";
		let ins = "";
		let cards = "";
		let charts = "";
		try {
			if (key === "held" || key === "sellthrough") {
				const [positions, lines30] = await Promise.all([api("positions"), api("lines", { from_date: daysAgo(30), to_date: d.end })]);
				const rows = positions.filter((r) => r.status !== "Closed");
				const sold30 = (filter) => sum(lines30.filter((l) => l.qty > 0 && filter(l)), "qty");
				const mpGroups = [...groupBy(rows, "marketplace").entries()];
				const totalHeld = sum(rows, "held");
				const totalValue = sum(rows, "held_value");
				const cover = (held, s30) => (s30 ? Math.round(held / (s30 / 30)) : null);
				const mps = mpGroups.map(([name, rs]) => {
					const held = sum(rs, "held");
					const s30 = sold30((l) => l.marketplace === name);
					const rec = sum(rs, "received");
					return {
						name, rs, held, value: sum(rs, "held_value"), received: rec, sold: sum(rs, "sold_net"), s30,
						st: pct(sum(rs, "sold_net"), rec), cover: cover(held, s30),
						oldest: Math.max(0, ...rs.filter((r) => r.held > 0).map((r) => r.oldest_age || 0)),
						last: rs.map((r) => r.last_sale).filter(Boolean).sort().pop(),
						records: new Set(rs.filter((r) => r.held > 0).map((r) => r.record)).size,
						velocity: s30 / 30,
					};
				});
				const coverText = (c) => (c == null ? "no recent sales" : c + " days");
				const coverClass = (c) => (c == null || c > 90 ? "neg" : c < 15 ? "warn" : "pos");

				if (key === "held") {
					mps.sort((a, b) => b.value - a.value);
					const top = mps[0];
					const ageTotals = { "0-30 days": 0, "31-60 days": 0, "61-90 days": 0, "90+ days": 0 };
					rows.forEach((r) => Object.entries(r.age_buckets || {}).forEach(([b, q]) => (ageTotals[b] += q)));
					const over60 = ageTotals["61-90 days"] + ageTotals["90+ days"];
					const idle = mps.filter((x) => x.held > 0 && !x.s30);
					const items = [...groupBy(rows, "item_code").entries()].map(([code, rs]) => [code, sum(rs, "held_value"), sum(rs, "held")]).sort((a, b) => b[1] - a[1]);
					const slowRec = rows.filter((r) => r.held > 0 && r.received >= 10).sort((a, b) => a.sell_through - b.sell_through)[0];
					ins = insightsHtml([
						top && ["lime", `<b>${orEsc(top.name)}</b> holds <b>${pct(top.held, totalHeld)}%</b> of your stock at marketplaces: ${orQty(top.held)} units worth ${orCompact(top.value)}.`],
						mps.length > 1 && ["cyan", `Spread across <b>${mps.length} marketplaces</b>: ${mps.map((x) => `${orEsc(x.name)} ${orQty(x.held)}`).join(" · ")}.`],
						...mps.filter((x) => x.held > 0 && x.s30).slice(0, 3).map((x) => [x.cover > 90 ? "red" : x.cover < 15 ? "orange" : "green", `At the last 30 days' pace (${orQty(Math.round(x.velocity * 10) / 10)}/day), stock at <b>${orEsc(x.name)}</b> lasts about <b>${x.cover} days</b>${x.cover > 90 ? " — consider a promotion or a Primary Return" : x.cover < 15 ? " — plan the next dispatch" : ""}.`]),
						...idle.map((x) => ["red", `<b>${orEsc(x.name)}</b> sold nothing in the last 30 days: ${orQty(x.held)} units (${orCompact(x.value)}) are idle.`]),
						over60 ? ["orange", `<b>${orQty(over60)} units</b> (${pct(over60, totalHeld)}%) have been at marketplaces for more than 60 days.`] : ["green", "All stock at marketplaces was dispatched within the last 60 days."],
						items.length > 1 && ["purple", `<b>${orEsc(items[0][0])}</b> is ${pct(items[0][1], totalValue)}% of the value held.`],
						slowRec && ["orange", `Slowest record: <b>${orEsc(slowRec.record)}</b> (${orEsc(slowRec.marketplace)}) has sold ${slowRec.sell_through}% of ${orQty(slowRec.received)} received; ${orQty(slowRec.held)} still held.`],
					]);
					const tSold = sum(mps, "sold");
					const tRec = sum(mps, "received");
					const tS30 = sum(mps, "s30");
					cards = statCards(mps, [
						{ label: "Units held", total: orQty(totalHeld), unit: "units", row: (x) => ({ v: orQty(x.held), n: x.held, sub: pct(x.held, totalHeld) + "%" }) },
						{ label: "Value at your rate", total: orCompact(totalValue), row: (x) => ({ v: orCompact(x.value), n: x.value, sub: pct(x.value, totalValue) + "%" }) },
						{ label: "Sell-through", total: pct(tSold, tRec) + "%", pct: 1, hint: "Sold out of units received", row: (x) => ({ v: x.st + "%", n: x.st }) },
						{ label: "Sold in last 30 days", total: orQty(tS30), unit: "units", row: (x) => ({ v: orQty(x.s30), n: x.s30, sub: orQty(Math.round(x.velocity * 10) / 10) + "/day" }) },
						{ label: "Stock cover", total: coverText(cover(totalHeld, tS30)), hint: "How long stock lasts at the current pace", pct: 1, row: (x) => ({ v: coverText(x.cover), n: x.cover == null ? 100 : (x.cover / 180) * 100, cls: coverClass(x.cover) }) },
						{ label: "Oldest stock", total: Math.max(0, ...mps.map((x) => x.oldest)) + " days", pct: 1, row: (x) => ({ v: x.oldest + " days", n: (x.oldest / 120) * 100, cls: x.oldest > 90 ? "neg" : "", sub: x.last ? "last sale " + orDate(x.last) : "no sales yet" }) },
					]);
					charts = `<div class="grid2">${panel("Ageing by marketplace",
						mps.map((x) => {
							const b = {};
							x.rs.forEach((r) => Object.entries(r.age_buckets || {}).forEach(([k, q]) => (b[k] = (b[k] || 0) + q)));
							const total = Object.values(b).reduce((a, v) => a + v, 0);
							return `<div class="age-row"><span>${orEsc(x.name)}</span>${stack([["0-30 days", b["0-30 days"] || 0, "#d5f65a"], ["31-60 days", b["31-60 days"] || 0, "#ffd166"], ["61-90 days", b["61-90 days"] || 0, "#ff9f43"], ["90+ days", b["90+ days"] || 0, "#ff6b6b"]], total)}<b>${orQty(total)}</b></div>`;
						}).join("") + `<div class="legend" style="margin-top:10px"><span><i class="sw-c" style="background:#d5f65a"></i>0-30 d</span><span><i class="sw-c" style="background:#ffd166"></i>31-60 d</span><span><i class="sw-c" style="background:#ff9f43"></i>61-90 d</span><span><i class="sw-c" style="background:#ff6b6b"></i>90+ d</span></div>`,
						"Days since dispatch; sold units are taken from the oldest dispatch first.")}
						${panel("Units held: item × marketplace", matrix(rows.filter((r) => r.held > 0), "item_code", "marketplace", "held", orQty))}</div>`;
				} else {
					mps.sort((a, b) => b.st - a.st);
					const rec = sum(rows, "received");
					const sold = sum(rows, "sold_net");
					const vel = sum(mps, "s30") / 30;
					const recs = [...groupBy(rows, "record").entries()].map(([name, rs]) => ({ name, mp: rs[0].marketplace, st: pct(sum(rs, "sold_net"), sum(rs, "received")), received: sum(rs, "received"), held: sum(rs, "held") })).filter((r) => r.received);
					recs.sort((a, b) => a.st - b.st);
					const items = [...groupBy(rows, "item_code").entries()].map(([code, rs]) => [code, pct(sum(rs, "sold_net"), sum(rs, "received")), `${orQty(sum(rs, "sold_net"))} of ${orQty(sum(rs, "received"))}`]).sort((a, b) => b[1] - a[1]);
					ins = insightsHtml([
						["lime", `Marketplaces have sold <b>${pct(sold, rec)}%</b> of the ${orQty(rec)} units they received (${orQty(sold)} units).`],
						mps.length > 1 && ["green", `Best: <b>${orEsc(mps[0].name)}</b> at ${mps[0].st}%. Lowest: <b>${orEsc(mps[mps.length - 1].name)}</b> at ${mps[mps.length - 1].st}%.`],
						vel ? ["cyan", `Selling about <b>${orQty(Math.round(vel * 10) / 10)} units a day</b> (last 30 days); at that pace the ${orQty(sum(rows, "held"))} units held sell out in about <b>${Math.round(sum(rows, "held") / vel)} days</b>.`] : ["red", "No secondary sales in the last 30 days, so stock is not moving."],
						recs.length && ["orange", `Slowest record: <b>${orEsc(recs[0].name)}</b> (${orEsc(recs[0].mp)}) at ${recs[0].st}% with ${orQty(recs[0].held)} units left.`],
						recs.length > 1 && ["green", `Fastest record: <b>${orEsc(recs[recs.length - 1].name)}</b> at ${recs[recs.length - 1].st}%.`],
						items.length > 1 && ["purple", `Best-selling item: <b>${orEsc(items[0][0])}</b> (${items[0][1]}% sold).`],
					]);
					const held = sum(rows, "held");
					const out = (h, v) => (v ? Math.round(h / v) : null);
					cards = statCards(mps, [
						{ label: "Sell-through", total: pct(sold, rec) + "%", pct: 1, hint: "Sold out of units received", row: (x) => ({ v: x.st + "%", n: x.st }) },
						{ label: "Units sold", total: orQty(sold), unit: `of ${orQty(rec)}`, row: (x) => ({ v: orQty(x.sold), n: x.sold, sub: `of ${orQty(x.received)}` }) },
						{ label: "Selling per day", total: orQty(Math.round(vel * 10) / 10), unit: "units", hint: "Average over the last 30 days", row: (x) => ({ v: orQty(Math.round(x.velocity * 10) / 10), n: x.velocity }) },
						{ label: "Still held", total: orQty(held), unit: "units", row: (x) => ({ v: orQty(x.held), n: x.held, sub: pct(x.held, held) + "%" }) },
						{ label: "Sells out in", total: out(held, vel) == null ? "—" : out(held, vel) + " days", hint: "At the current pace", pct: 1, row: (x) => {
							const o = out(x.held, x.velocity);
							return { v: o == null ? "no recent sales" : o + " days", n: o == null ? 100 : (o / 180) * 100, cls: o == null || o > 90 ? "neg" : o < 15 ? "warn" : "pos" };
						} },
						{ label: "Last sale", total: mps.map((x) => x.last).filter(Boolean).sort().pop() ? orDate(mps.map((x) => x.last).filter(Boolean).sort().pop()) : "—", pct: 1, row: (x) => {
							const ago = x.last ? Math.round((today - frappe.datetime.str_to_obj(x.last)) / 864e5) : null;
							return { v: x.last ? orDate(x.last) : "never", n: ago == null ? 100 : (ago / 60) * 100, cls: ago == null || ago > 30 ? "neg" : "", sub: ago == null ? "" : ago + " days ago" };
						} },
					]);
					charts = `<div class="grid2">${panel("Sell-through by record (slowest first)", hbars(recs.slice(0, 8).map((r) => [r.name, r.st, orEsc(r.mp)]), (v) => v + "%", (g, v) => (v < 25 ? "linear-gradient(90deg,#8a2b2b,#ff6b6b)" : v < 60 ? "linear-gradient(90deg,#8a5a1f,#ffb547)" : "linear-gradient(90deg,#5e7d1a,#d5f65a)")))}
						${panel("Sell-through by item", hbars(items.slice(0, 8), (v) => v + "%"))}</div>`;
				}
			} else if (key === "dispatched") {
				const [moves, positions] = await Promise.all([api("movements"), api("positions", { include_closed: 1 })]);
				const rate = {};
				positions.forEach((p) => (rate[p.record + "|" + p.item_code] = p.primary_rate));
				const rows = moves.filter((r) => r.type === "Primary Sale" && inPeriod(r.date)).map((r) => ({ ...r, value: r.qty * (rate[r.record + "|" + r.item_code] || 0) }));
				const units = sum(rows, "qty");
				const confirmed = sum(rows, "received");
				const pendingRows = rows.filter((r) => r.pending > 0);
				const mps = [...groupBy(rows, "marketplace").entries()].map(([name, rs]) => ({ name, units: sum(rs, "qty"), value: sum(rs, "value"), n: rs.length, conf: pct(sum(rs, "received"), sum(rs, "qty")), pending: sum(rs, "pending"), oldest: Math.max(0, ...rs.filter((r) => r.pending > 0).map((r) => r.age || 0)) })).sort((a, b) => b.units - a.units);
				const byDay = [...groupBy(rows, "date").entries()].sort((a, b) => a[0].localeCompare(b[0]));
				const biggest = rows.slice().sort((a, b) => b.qty - a.qty)[0];
				ins = insightsHtml([
					rows.length ? ["lime", `<b>${rows.length} dispatch${rows.length === 1 ? "" : "es"}</b> sent ${orQty(units)} units (about ${orCompact(sum(rows, "value"))} at your rates) to ${mps.length} marketplace${mps.length === 1 ? "" : "s"}.`] : ["orange", "No dispatches to marketplaces in this period."],
					rows.length && [pendingRows.length ? "orange" : "green", pendingRows.length ? `<b>${orQty(sum(pendingRows, "pending"))} units</b> on ${pendingRows.length} dispatch(es) are not yet confirmed by the marketplace (oldest ${Math.max(...pendingRows.map((r) => r.age || 0))} days).` : `Every dispatch in this period has been confirmed received (${pct(confirmed, units)}%).`],
					mps.length && ["cyan", `<b>${orEsc(mps[0].name)}</b> received the most: ${orQty(mps[0].units)} units (${pct(mps[0].units, units)}%).`],
					biggest && ["purple", `Largest dispatch: ${orQty(biggest.qty)} × ${orEsc(biggest.item_code)} to ${orEsc(biggest.marketplace)} on ${orDate(biggest.date)} (${orEsc(biggest.reference || biggest.record)}).`],
					rows.length && ["green", `Average dispatch: <b>${orQty(Math.round(units / rows.length))} units</b>.`],
				]);
				const value = sum(rows, "value");
				cards = statCards(mps, [
					{ label: "Units dispatched", total: orQty(units), unit: "units", row: (x) => ({ v: orQty(x.units), n: x.units, sub: pct(x.units, units) + "%" }) },
					{ label: "Value at your rate", total: orCompact(value), row: (x) => ({ v: orCompact(x.value), n: x.value, sub: pct(x.value, value) + "%" }) },
					{ label: "Dispatches", total: String(rows.length), row: (x) => ({ v: String(x.n), n: x.n, sub: `avg ${orQty(Math.round(x.units / x.n))} units` }) },
					{ label: "Confirmed by marketplace", total: pct(confirmed, units) + "%", pct: 1, row: (x) => ({ v: x.conf + "%", n: x.conf, cls: x.conf < 100 ? "warn" : "pos" }) },
					{ label: "Awaiting confirmation", total: orQty(units - confirmed), unit: "units", row: (x) => ({ v: x.pending ? orQty(x.pending) : "none", n: x.pending, cls: x.pending ? "neg" : "pos", sub: x.pending ? `oldest ${x.oldest} days` : "" }) },
				]);
				charts = `<div class="grid2">${panel("Units dispatched by day", columns(byDay.map(([day, rs]) => [orDate(day).slice(0, 5), sum(rs, "qty")]), orQty))}
					${panel("Confirmation status", rows.length ? `${stack([["Received", confirmed, "#d5f65a"], ["Awaiting", units - confirmed, "#ff6b6b"]], units)}
						<div class="legend" style="margin-top:10px"><span><i class="sw-c" style="background:#d5f65a"></i>Received ${orQty(confirmed)}</span><span><i class="sw-c" style="background:#ff6b6b"></i>Awaiting ${orQty(units - confirmed)}</span></div>
						${pendingRows.length ? `<div class="pend-list">${pendingRows.sort((a, b) => (b.age || 0) - (a.age || 0)).slice(0, 5).map((r) => `<a class="pend" data-go="tracker|${orEsc(r.record)}"><b>${orEsc(r.record)}</b><span>${orQty(r.pending)} × ${orEsc(r.item_code)} · ${r.age} days</span></a>`).join("")}</div>` : ""}` : `<div class="empty">—</div>`)}</div>`;
			} else {
				const all = await api("lines", { from_date: d.start, to_date: d.end });
				const sales = all.filter((l) => l.qty > 0);
				if (key === "secondary") {
					const value = sum(sales, "value");
					const units = sum(sales, "qty");
					const mps = [...groupBy(sales, "marketplace").entries()].map(([name, rs]) => ({ name, value: sum(rs, "value"), units: sum(rs, "qty"), orders: new Set(rs.map((r) => r.order_id)).size, avg: sum(rs, "qty") ? sum(rs, "value") / sum(rs, "qty") : 0, real: pct(sum(rs, (r) => r.net_rate * r.qty), sum(rs, (r) => r.primary_rate * r.qty)) })).sort((a, b) => b.value - a.value);
					const days = [...groupBy(sales, "sale_date").entries()].map(([day, rs]) => [day, sum(rs, "value")]).sort((a, b) => a[0].localeCompare(b[0]));
					const best = days.slice().sort((a, b) => b[1] - a[1])[0];
					const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
					const byWd = wd.map(() => 0);
					sales.forEach((l) => (byWd[(new Date(l.sale_date).getDay() + 6) % 7] += l.value));
					const bestWd = byWd.indexOf(Math.max(...byWd));
					const items = [...groupBy(sales, "item_code").entries()].map(([code, rs]) => [code, sum(rs, "value"), `${orQty(sum(rs, "qty"))} units`]).sort((a, b) => b[1] - a[1]);
					const ch = d.kpis.secondary_value_change;
					ins = insightsHtml([
						sales.length ? ["lime", `<b>${orInr(value, 0)}</b> from ${orQty(units)} units in ${new Set(sales.map((r) => r.order_id)).size} orders; average ${orInr(units ? value / units : 0)} a unit.`] : ["orange", "No secondary sales in this period."],
						ch != null && [ch >= 0 ? "green" : "red", `${ch >= 0 ? "Up" : "Down"} <b>${Math.abs(ch)}%</b> on the previous period.`],
						mps.length && ["cyan", `<b>${orEsc(mps[0].name)}</b> brought in ${pct(mps[0].value, value)}% of sales (${orCompact(mps[0].value)}).`],
						best && ["purple", `Best day: <b>${orDate(best[0])}</b> with ${orCompact(best[1])} (${pct(best[1], value)}% of the period).`],
						sales.length && ["green", `Strongest weekday: <b>${wd[bestWd]}</b>.`],
						items.length && ["lime", `Top item: <b>${orEsc(items[0][0])}</b> — ${orCompact(items[0][1])} (${pct(items[0][1], value)}%).`],
					]);
					const orders = new Set(sales.map((r) => r.order_id)).size;
					cards = statCards(mps, [
						{ label: "Sales value", total: orInr(value, 0), hint: ch == null ? "" : `${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch)}% vs previous period`, row: (x) => ({ v: orCompact(x.value), n: x.value, sub: pct(x.value, value) + "%" }) },
						{ label: "Units sold", total: orQty(units), unit: "units", row: (x) => ({ v: orQty(x.units), n: x.units, sub: pct(x.units, units) + "%" }) },
						{ label: "Orders", total: String(orders), row: (x) => ({ v: String(x.orders), n: x.orders }) },
						{ label: "Average order value", total: orders ? orInr(value / orders, 0) : "—", row: (x) => ({ v: x.orders ? orInr(x.value / x.orders, 0) : "—", n: x.orders ? x.value / x.orders : 0, sub: x.orders ? `${Math.round((x.units / x.orders) * 10) / 10} units/order` : "" }) },
						{ label: "Average selling price", total: units ? orInr(value / units) : "—", unit: "a unit", row: (x) => ({ v: orInr(x.avg), n: x.avg }) },
						{ label: "Realisation", total: d.kpis.realisation == null ? "—" : d.kpis.realisation + "%", hint: "After commission, vs your rate", pct: 1, row: (x) => ({ v: x.real + "%", n: x.real, cls: x.real >= 100 ? "pos" : "neg" }) },
					]);
					charts = `<div class="grid2">${panel("Sales by day", columns(days.map(([day, v]) => [orDate(day).slice(0, 5), v, best && day === best[0]]), orCompact))}
						${panel("Sales by weekday", columns(wd.map((w, i) => [w, byWd[i], i === bestWd && byWd[i] > 0]), orCompact))}</div>
						<div style="margin-top:12px">${panel("Top items", hbars(items.slice(0, 8), orCompact))}</div>`;
				} else if (key === "realisation") {
					const real = (rs) => pct(sum(rs, (r) => r.net_rate * r.qty), sum(rs, (r) => r.primary_rate * r.qty));
					const variance = sum(sales, "variance");
					const below = sales.filter((r) => r.realisation != null && r.realisation < 99.5);
					const commission = sum(sales, (r) => (r.selling_rate - r.net_rate) * r.qty);
					const mps = [...groupBy(sales, "marketplace").entries()].map(([name, rs]) => ({ name, real: real(rs), variance: sum(rs, "variance"), comm: sum(rs, (r) => (r.selling_rate - r.net_rate) * r.qty), avg: sum(rs, "qty") ? sum(rs, "value") / sum(rs, "qty") : 0, yours: sum(rs, "qty") ? sum(rs, (r) => r.primary_rate * r.qty) / sum(rs, "qty") : 0, below: rs.filter((r) => r.realisation < 99.5).length, n: rs.length })).sort((a, b) => a.real - b.real);
					const bands = [["Below 80%", (v) => v < 80, "#ff6b6b"], ["80–95%", (v) => v >= 80 && v < 95, "#ff9f43"], ["95–105%", (v) => v >= 95 && v <= 105, "#a1a1aa"], ["105–120%", (v) => v > 105 && v <= 120, "#a3e635"], ["Above 120%", (v) => v > 120, "#d5f65a"]];
					const items = [...groupBy(sales, "item_code").entries()].map(([code, rs]) => ({ code, real: real(rs), avg: sum(rs, "value") / sum(rs, "qty"), yours: sum(rs, (r) => r.primary_rate * r.qty) / sum(rs, "qty") })).sort((a, b) => a.real - b.real);
					ins = insightsHtml([
						sales.length ? [d.kpis.realisation >= 100 ? "green" : "red", `After commission, marketplaces realised <b>${d.kpis.realisation}%</b> of your rate: a net variance of <b>${orInr(variance, 0)}</b>.`] : ["orange", "No secondary sales in this period."],
						below.length && ["red", `<b>${below.length} of ${sales.length}</b> sale lines sold below your rate, losing ${orInr(Math.abs(sum(below, "variance")), 0)}.`],
						commission > 0 && ["purple", `Marketplace commission this period: <b>${orInr(commission, 0)}</b>.`],
						mps.length > 1 && ["orange", `Weakest pricing: <b>${orEsc(mps[0].name)}</b> at ${mps[0].real}%. Strongest: <b>${orEsc(mps[mps.length - 1].name)}</b> at ${mps[mps.length - 1].real}%.`],
						items.length && ["cyan", `Item realising least: <b>${orEsc(items[0].code)}</b> — sold at ${orInr(items[0].avg)} on average vs your ${orInr(items[0].yours)}.`],
						sales.some((r) => r.note_status === "Not created") && ["red", `${sales.filter((r) => r.note_status === "Not created").length} line(s) with a variance have no debit / credit note yet.`],
					]);
					const su = sum(sales, "qty");
					cards = statCards(mps, [
						{ label: "Realisation", total: d.kpis.realisation == null ? "—" : d.kpis.realisation + "%", hint: "Selling rate after commission ÷ your rate", pct: 1, row: (x) => ({ v: x.real + "%", n: x.real, cls: x.real >= 100 ? "pos" : "neg" }) },
						{ label: "Net variance", total: orInr(variance, 0), row: (x) => ({ v: orInr(x.variance, 0), n: x.variance, cls: x.variance < 0 ? "neg" : "pos" }) },
						{ label: "Commission paid", total: orInr(commission, 0), row: (x) => ({ v: orInr(x.comm, 0), n: x.comm }) },
						{ label: "Average sold at", total: su ? orInr(sum(sales, "value") / su) : "—", unit: su ? `vs your ${orInr(sum(sales, (r) => r.primary_rate * r.qty) / su)}` : "", pct: 1, row: (x) => ({ v: orInr(x.avg), n: x.yours ? (x.avg / x.yours) * 100 : 0, sub: `your ${orInr(x.yours)}`, cls: x.avg >= x.yours ? "pos" : "neg" }) },
						{ label: "Lines below your rate", total: `${below.length} of ${sales.length}`, pct: 1, row: (x) => ({ v: `${x.below} of ${x.n}`, n: pct(x.below, x.n), cls: x.below ? "neg" : "pos", sub: pct(x.below, x.n) + "%" }) },
					]);
					charts = `<div class="grid2">${panel("How sale lines priced (units)", columns(bands.map(([l, f]) => [l, sum(sales.filter((r) => r.realisation != null && f(r.realisation)), "qty")]), orQty), "Realisation = selling rate after commission ÷ your rate.")}
						${panel("Average sold price vs your rate, by item", items.length ? `<div class="cmp-list">${items.slice(0, 8).map((i) => {
							const max = Math.max(i.avg, i.yours, 1);
							return `<div class="cmp"><span class="cmp-name">${orEsc(i.code)}<small class="${i.real >= 100 ? "pos" : "neg"}">${i.real}%</small></span>
								<div class="cmp-bars"><div><i class="sold" style="width:${(i.avg / max) * 100}%"></i><em>${orInr(i.avg)}</em></div><div><i class="yours" style="width:${(i.yours / max) * 100}%"></i><em>${orInr(i.yours)}</em></div></div></div>`;
						}).join("")}</div><div class="legend" style="margin-top:8px"><span><i class="sw-c" style="background:#d5f65a"></i>Sold at</span><span><i class="sw-c" style="background:#a78bfa"></i>Your rate</span></div>` : `<div class="empty">—</div>`)}</div>`;
				} else {
					const returns = all.filter((l) => l.qty < 0);
					const ru = -sum(returns, "qty");
					const su = sum(sales, "qty");
					const names = [...new Set([...sales, ...returns].map((r) => r.marketplace))];
					const mps = names.map((name) => {
						const s = sum(sales.filter((r) => r.marketplace === name), "qty");
						const rr = -sum(returns.filter((r) => r.marketplace === name), "qty");
						return { name, sold: s, ret: rr, rate: pct(rr, s), value: -sum(returns.filter((r) => r.marketplace === name), "value") };
					}).sort((a, b) => b.rate - a.rate);
					const items = [...new Set(sales.map((r) => r.item_code))].map((code) => {
						const s = sum(sales.filter((r) => r.item_code === code), "qty");
						const rr = -sum(returns.filter((r) => r.item_code === code), "qty");
						return [code, pct(rr, s), `${orQty(rr)} of ${orQty(s)} returned`];
					}).sort((a, b) => b[1] - a[1]);
					ins = insightsHtml([
						ru ? ["orange", `Customers returned <b>${orQty(ru)} units</b> — <b>${pct(ru, su)}%</b> of the ${orQty(su)} sold — reversing ${orInr(-sum(returns, "value"), 0)} of sales.`] : ["green", `No customer returns in this period on ${orQty(su)} units sold.`],
						mps.length > 1 && ru && ["red", `Highest return rate: <b>${orEsc(mps[0].name)}</b> at ${mps[0].rate}%.`],
						items.length && items[0][1] > 0 && ["purple", `Most returned item: <b>${orEsc(items[0][0])}</b> (${items[0][1]}% of units sold).`],
						ru && ["cyan", "Returned units go back into the stock held at the marketplace, so they can sell again."],
					]);
					const rv = -sum(returns, "value");
					cards = statCards(mps, [
						{ label: "Return rate", total: pct(ru, su) + "%", hint: "Units returned ÷ units sold", pct: 1, row: (x) => ({ v: x.rate + "%", n: x.rate, cls: x.rate > 10 ? "neg" : "" }) },
						{ label: "Units returned", total: orQty(ru), unit: "units", row: (x) => ({ v: orQty(x.ret), n: x.ret, cls: x.ret ? "neg" : "" }) },
						{ label: "Units sold", total: orQty(su), unit: "units", row: (x) => ({ v: orQty(x.sold), n: x.sold }) },
						{ label: "Sales value reversed", total: orInr(rv, 0), row: (x) => ({ v: orInr(x.value, 0), n: x.value }) },
					]);
					charts = `<div>${panel("Return rate by item", hbars(items.slice(0, 8), (v) => v + "%"))}</div>`;
				}
			}
			html = cards + `<div class="drill-gap"></div>` + charts + (ins ? `<div class="card ins-panel drill-points"><div class="card-head"><span class="card-title">Key insights</span></div>${ins}</div>` : "");
		} catch (err) {
			html = `<div class="empty">${orEsc(err.message)}</div>`;
		}
		const body = m.el.querySelector(".drill-body");
		if (!body) return;
		body.innerHTML = html + `<div class="actions" style="justify-content:space-between;margin-top:14px"><span class="muted small">Need every row? The report has the full detail with filters and export.</span><button class="btn white" data-act="drill-report" data-k="${key}">${orIcon("chart")} Open detailed report</button></div>`;
		app.animate(body);
	}

	onAct(act, el) {
		const app = this.app;
		if (act === "period") {
			this.period = el.dataset.p;
			this.render((app.token = Symbol()));
		} else if (act === "metric") {
			this.metric = el.dataset.m;
			this.$$("[data-act=metric]").forEach((b) => b.classList.toggle("on", b === el));
			this.trend();
		} else if (act === "cover") {
			this.cover = el.dataset.c;
			this.$$("[data-act=cover]").forEach((b) => b.classList.toggle("on", b === el));
			this.$(".cover-box").innerHTML = this.coverHtml();
		} else if (act === "kpi") {
			this.drill(el.dataset.k);
		} else if (act === "drill-report") {
			const focus = { held: { focus: "held", sort: { key: "held_value", dir: -1 } }, sellthrough: { sort: { key: "sell_through", dir: 1 } } }[el.dataset.k] || {};
			const dated = ["secondary", "realisation", "returns"].includes(el.dataset.k) ? { from: this.data.start, to: this.data.end, hidden: { range_value: false } } : {};
			app._reportPreset = { marketplace: this.marketplace, ...focus, ...dated };
			app.go("reports");
		} else if (act === "mp-row") {
			app._trackerFilters = { marketplace: el.dataset.mp, status: "", search: "" };
			app.go("trackers");
		} else if (act === "action") {
			const a = this.data.actions[+el.dataset.i];
			if (a.record) return app.go("tracker", a.record);
			const statusFor = { approve: "Under Reconciliation", close: "Reconciled" }[a.key];
			if (statusFor) {
				app._trackerFilters = { marketplace: this.marketplace, status: statusFor, search: "" };
				return app.go("trackers");
			}
			const reportFor = {
				unconfirmed: { focus: "pending_dispatch" },
				return_initiated: { focus: "return_initiated" },
				return_transit: { focus: "return_transit" },
				aged: { focus: "held", sort: { key: "oldest_age", dir: -1 } },
				variance: { focus: "variance" },
				draft_notes: { focus: "draft_notes" },
			}[a.key];
			app._reportPreset = reportFor || null;
			app.go("reports");
		}
	}
}


// ------------------------------------------------------------------ trackers list

class TrackersView extends OrView {
	constructor(app) {
		super(app);
		this.filters = Object.assign({ marketplace: "", status: "", search: "" }, app._trackerFilters || {});
		this.limit = 50;
	}
	async render(token) {
		const res = await this.api("trackers", { ...this.filters, limit: this.limit });
		if (this.app.stale(token)) return;
		this.app._trackerFilters = this.filters;
		const rows = res.rows;
		const drafts = res.drafts || [];
		const draftsOnly = this.filters.status === "__drafts";
		const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
		const open = rows.filter((r) => r.status !== "Closed");
		const sum = (k) => open.reduce((a, r) => a + orFlt(r[k]), 0);
		this.main.innerHTML = `
			${this.head("Primary <span>Sales</span>", "One record per OR Sales Order (created from the Sales Order page): what each marketplace received, sold and still holds.")}
			<div class="kpis">
				<div class="kpi"><div class="k">Open records</div><div class="v">${open.length}</div></div>
				<div class="kpi"><div class="k">Ordered qty</div><div class="v">${orQty(sum("ordered_qty"))}</div></div>
				<div class="kpi"><div class="k">Stock at marketplaces</div><div class="v lime">${orQty(sum("virtual_stock"))}</div></div>
				<div class="kpi"><div class="k">Primary sale in transit</div><div class="v">${orQty(sum("stock_in_transit"))}</div></div>
				<div class="kpi"><div class="k">Secondary sales value</div><div class="v">${orCompact(sum("secondary_sales_value"))}</div></div>
			</div>
			<div class="filters">
				<label class="search">${orIcon("search")}<input data-f="search" placeholder="Search by ID, PO number or Sales Order" value="${orEsc(this.filters.search)}"></label>
				${this.selectHtml("marketplace", this.marketplaceOptions(), this.filters.marketplace)}
			</div>
			<div class="chips" style="margin-bottom:12px">
				<button class="chip ${this.filters.status ? "" : "on"}" data-act="status" data-s="">All<b>${total}</b></button>
				<button class="chip draft-chip ${draftsOnly ? "on" : ""}" data-act="status" data-s="__drafts">Draft<b>${drafts.length}</b></button>
				${OR_ORDER_STATUSES.map((s) => `<button class="chip ${this.filters.status === s ? "on" : ""}" data-act="status" data-s="${s}">${s}<b>${res.counts[s] || 0}</b></button>`).join("")}
			</div>
			${drafts.length && (draftsOnly || !this.filters.status) ? this.draftsHtml(drafts) : ""}
			${draftsOnly ? (drafts.length ? "" : `<div class="card"><div class="empty">No draft OR Sales Orders. Sales Orders with Flow = OR saved as draft appear here until they are submitted.</div></div>`) : `<div class="card">
				${rows.length ? `<div class="table-wrap"><table class="t">
					<thead><tr><th>Primary Sales</th><th>Marketplace</th><th>Sales Order</th><th class="num">Ordered</th><th class="num">Dispatched</th><th class="num">Received</th>
						<th class="num">Sold</th><th class="num">At marketplace</th><th class="num">Secondary value</th><th class="num">Net variance</th><th>Status</th></tr></thead>
					<tbody>${rows.map((r) => `<tr class="click" data-go="tracker|${orEsc(r.name)}">
						<td class="strong">${orEsc(r.name)}<span class="sub">PO ${orEsc(r.marketplace_po_no || "—")}${r.po_date ? " · " + orDate(r.po_date) : ""}</span></td>
						<td>${orPill(r.marketplace, "lime")}</td>
						<td>${orEsc(r.sales_order)}</td>
						<td class="num strong">${orQty(r.ordered_qty)}</td>
						<td class="num">${orQty(r.total_dispatched_qty)}</td>
						<td class="num">${orQty(r.marketplace_received_qty)}</td>
						<td class="num">${orQty(r.total_sold_qty)}</td>
						<td class="num strong">${orQty(r.virtual_stock)}</td>
						<td class="num">${orInr(r.secondary_sales_value)}</td>
						<td class="num" style="color:${orFlt(r.net_price_variance) < 0 ? "var(--red)" : orFlt(r.net_price_variance) > 0 ? "var(--lime)" : "inherit"}">${orInr(r.net_price_variance)}</td>
						<td>${orPill(r.order_status || r.status)}<span class="sub">OR: ${orEsc(r.status)}${r.reconciliation_status && r.reconciliation_status !== "Pending" && r.reconciliation_status !== "Reconciled" ? " · " + orEsc(r.reconciliation_status) : ""}</span></td>
					</tr>`).join("")}</tbody></table></div>
					${rows.length >= this.limit ? `<div class="more-row"><button class="btn sm" data-act="more">Load more</button></div>` : ""}`
				: `<div class="empty">No trackers match. Submitting a Sales Order with Flow = OR creates one.</div>`}
			</div>`}`;
		this.bindFilters();
	}
	/** Saved-but-not-submitted OR Sales Orders: no Primary Sales record exists until they are submitted. */
	draftsHtml(drafts) {
		return `<div class="card drafts-card">
			<div class="card-head"><span class="card-title">${orIcon("file")} Draft OR orders <span class="faint small">· not submitted yet</span></span></div>
			<div class="hint" style="margin:-6px 0 10px">Submitting a draft creates its Primary Sales record.</div>
			<div class="table-wrap"><table class="t"><thead><tr><th>Sales Order</th><th>Marketplace</th><th>PO</th><th>Order date</th><th>Created by</th><th class="num">Qty</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>
			${drafts.map((o) => `<tr>
				<td class="strong">${orEsc(o.name)}<span class="sub">${orEsc(o.customer)}</span></td>
				<td>${orPill(o.or_marketplace || "—", "lime")}</td>
				<td>${orEsc(o.customer_po_number || "—")}${o.customer_po_date ? `<span class="sub">${orDate(o.customer_po_date)}</span>` : ""}</td>
				<td>${orDate(o.transaction_date)}</td>
				<td>${orEsc(o.owner_name || o.owner)}</td>
				<td class="num">${orQty(o.total_qty)}</td>
				<td class="num">${orInr(o.grand_total)}</td>
				<td>${orPill("Draft", "red")}</td>
				<td class="num nowrap"><button class="btn sm" data-erp="Sales Order|${orEsc(o.name)}">${orIcon("out")} Open</button>
					${o.can_submit ? `<button class="btn sm lime" data-act="submit-draft" data-n="${orEsc(o.name)}">Submit</button>` : ""}</td>
			</tr>`).join("")}</tbody></table></div></div>`;
	}
	bindFilters() {
		const s = this.$("[data-f=search]");
		let t;
		s.addEventListener("input", () => {
			clearTimeout(t);
			t = setTimeout(() => {
				this.filters.search = s.value.trim();
				this.reload(true);
			}, 300);
		});
		this.$("[data-f=marketplace]").addEventListener("change", (e) => {
			this.filters.marketplace = e.target.value;
			this.reload();
		});
	}
	async reload(keepFocus) {
		const pos = keepFocus ? this.$("[data-f=search]").selectionStart : null;
		await this.render((this.app.token = Symbol()));
		if (keepFocus) {
			const s = this.$("[data-f=search]");
			s.focus();
			s.setSelectionRange(pos, pos);
		}
	}
	onAct(act, el) {
		if (act === "status") {
			this.filters.status = el.dataset.s;
			this.reload();
		} else if (act === "more") {
			this.limit += 50;
			this.reload();
		} else if (act === "submit-draft") {
			this.app.confirm("Submit Sales Order", `Submit ${el.dataset.n}? This creates its Primary Sales record.`, "Submit").then(async (yes) => {
				if (!yes) return;
				try {
					const r = await this.api("submit_order", { name: el.dataset.n });
					this.app.toast(`Sales Order ${r.name} submitted${r.tracker ? `; Primary Sales ${r.tracker} created` : ""}`);
					if (r.tracker) this.app.go("tracker", r.tracker);
					else this.reload();
				} catch (err) {
					this.app.toast(err.message, "error");
				}
			});
		}
	}
}

// ------------------------------------------------------------------ tracker detail

class TrackerView extends OrView {
	async render(token) {
		const d = (this.data = await this.api("tracker", { name: this.name }));
		if (this.app.stale(token)) return;
		const doc = d.doc;
		const moves = doc.stock_movements || [];
		const notes = doc.price_notes || [];
		const can = d.can_write;
		const held = d.item_summary.filter((i) => i.available > 0);
		const has = {
			receipt: can && moves.some(isReceivable),
			initiate: can && held.length,
			dispatchRet: can && moves.some((r) => r.status === "Return Initiated"),
			dispatch: can && this.app.boot.can_deliver && !d.setup_missing && (d.pending_delivery || []).length,
			invoice: can && this.app.boot.can_invoice && !d.setup_missing && orFlt(d.to_invoice) > 0,
			putaway: can && this.app.boot.can_deliver && moves.some(isPutaway),
			cancelRet: can && moves.some(isCancellable),
			import: can,
			secReturn: can && d.lines.some((l) => !l.is_return && orFlt(l.qty) - orFlt(l.returned_qty) > 0),
			notes: can && !d.setup_missing && doc.reconciliation_status === "Variance not invoiced",
			submitNotes: can && notes.some((n) => n.status === "Draft"),
		};
		const so = d.sales_order || {};
		// nothing dispatched yet: show the Primary Sales Order instead of a page of zeros
		const dispatched = moves.some((r) => r.movement_type === "Primary Sale" && r.status !== "Cancelled");
		const orderItems = d.order_items || [];
		const ses = d.delivery_notes || [];
		const dispatchSes = ses.filter((s) => !s.is_return);
		const seLink = (n) => `<a class="link" data-erp="Delivery Note|${orEsc(n)}">${orEsc(n)}</a>`;
		const siLink = (n) => `<a class="link" data-erp="Sales Invoice|${orEsc(n)}">${orEsc(n)}</a>`;
		const jeLink = (n) => `<a class="link" data-erp="Journal Entry|${orEsc(n)}">${orEsc(n)}</a>`;
		const ledgerBtn = (dt, n) => `<button class="btn sm" data-act="ledger" data-dt="${orEsc(dt)}" data-dn="${orEsc(n)}">Ledger</button>`;
		const setupBanner = d.setup_missing ? `<div class="banner red">${orEsc(d.setup_missing)}</div>` : "";
		const waiting = dispatched
			? ""
			: `<div class="banner orange">Not dispatched yet. Use “Pick, Pack &amp; Dispatch” once the goods are packed: a Delivery Note takes them out of your warehouse (an outright sale).</div>`;
		const invoiceBanner = has.invoice
			? `<div class="banner orange">${orQty(d.to_invoice)} dispatched unit(s) are not invoiced to ${orEsc(doc.marketplace)} yet. Use “Create Primary Invoice”.</div>`
			: "";
		const orderQty = orderItems.reduce((a, i) => a + orFlt(i.qty), 0);
		const deliveredQty = orderItems.reduce((a, i) => a + orFlt(i.delivered_qty), 0);
		const orderKpis = `
				${kpi("Ordered qty", orQty(orderQty))}
				${kpi("Order value", orCompact(orderItems.reduce((a, i) => a + orFlt(i.amount), 0)), "lav")}
				${kpi("Delivered", orQty(deliveredQty))}
				${kpi("To deliver", orQty(orderQty - deliveredQty), orderQty - deliveredQty ? "lime" : "")}
				${kpi("Dispatches", dispatchSes.length || "None yet")}`;
		const orderCard = `
			<div class="card">
				<div class="card-head"><span class="card-title">${orIcon("grid")} Order details</span>
					<span class="muted small">Primary Sales Order <a class="link" data-erp="Sales Order|${orEsc(doc.sales_order)}">${orEsc(doc.sales_order)}</a>
					${so.transaction_date ? " · " + orDate(so.transaction_date) : ""}${so.delivery_date ? " · deliver by " + orDate(so.delivery_date) : ""}${so.status ? " · " + orEsc(so.status) : ""}</span></div>
				${orderItems.length ? `<div class="table-wrap"><table class="t"><thead><tr>
					<th>Item</th><th>Item name</th><th class="num">Ordered</th><th>UOM</th><th class="num">Rate</th><th class="num">Amount</th>
					<th class="num">Delivered</th><th class="num">To deliver</th><th>Warehouse</th></tr></thead>
					<tbody>${orderItems.map((i) => `<tr><td class="strong">${orEsc(i.item_code)}</td><td>${orEsc(i.item_name || "")}</td>
						<td class="num">${orQty(i.qty)}</td><td>${orEsc(i.uom || "")}</td><td class="num">${orInr(i.rate)}</td><td class="num">${orInr(i.amount)}</td>
						<td class="num">${orQty(i.delivered_qty)}</td><td class="num strong">${orQty(orFlt(i.qty) - orFlt(i.delivered_qty))}</td>
						<td>${orEsc(i.warehouse || "")}</td></tr>`).join("")}</tbody></table></div>`
				: `<div class="empty">The Sales Order has no items.</div>`}
				<div class="hint" style="margin-top:10px">The stock stays reserved for this order until it is dispatched.</div>
			</div>`;
		const banner =
			doc.reconciliation_status === "Variance not invoiced"
				? `<div class="banner red">Rate difference not settled yet: some secondary sales are not in a credit / debit note. Use “Month-end settlement”.</div>`
				: doc.reconciliation_status === "Notes awaiting submission"
				? `<div class="banner orange">Draft debit / credit notes are waiting for approval.</div>`
				: doc.status === "Closed"
				? `<div class="banner green">This tracker is closed and read-only.</div>`
				: "";
		const primaryBtns = [
			has.dispatch && `<button class="btn white" data-act="dispatch">${orIcon("truck")} Pick, Pack &amp; Dispatch</button>`,
			has.invoice && `<button class="btn white" data-act="invoice">${orIcon("file")} Create Primary Invoice</button>`,
			has.receipt && `<button class="btn white" data-act="receipt">${orIcon("check")} Record POD</button>`,
			has.import && `<button class="btn white" data-act="import">${orIcon("upload")} Import sales</button>`,
			has.putaway && `<button class="btn white" data-act="putaway">${orIcon("ret")} Putaway</button>`,
			has.notes && `<button class="btn purple" data-act="notes">Month-end settlement</button>`,
			has.submitNotes && this.app.boot.can_approve && `<button class="btn purple" data-act="submit-notes">Submit notes</button>`,
			...d.transitions.map((t) => `<button class="btn ${t === "Close" ? "danger" : ""}" data-act="wf" data-a="${orEsc(t)}">${orEsc(t)}</button>`),
			`<button class="btn" data-act="report" title="Excel: summary, secondary sales, stock ledger, accounting ledger, rate difference notes">${orIcon("download")} Download report</button>`,
		].filter(Boolean);
		const moreItems = [
			has.initiate && `<a data-act="initiate">${orIcon("ret")} Primary Return (from marketplace)</a>`,
			has.dispatchRet && `<a data-act="dispatch-ret">Mark Primary Return dispatched</a>`,
			has.putaway && `<a data-act="putaway">Putaway returned goods</a>`,
			has.cancelRet && `<a data-act="cancel-ret">Cancel a Primary Return</a>`,
			has.secReturn && `<a data-act="sec-return">Secondary Return</a>`,
			`<div class="sep"></div>`,
			`<a data-erp="Sales Order|${orEsc(doc.sales_order)}">${orIcon("out")} Open Sales Order</a>`,
			`<a data-go="reports">OR Dashboard Report</a>`,
		].filter(Boolean);
		this.main.innerHTML = `
			${this.head(orEsc(doc.name) + ` <span>${orEsc(doc.marketplace)}</span>`,
				`${orPill(doc.order_status || doc.status)} <span class="muted small">OR stage</span> ${orPill(doc.status)} ${doc.reconciliation_status && !["Pending", "Reconciled", doc.status].includes(doc.reconciliation_status) ? orPill(doc.reconciliation_status) : ""}
				 <span>PO <b style="color:var(--text)">${orEsc(doc.marketplace_po_no)}</b>${doc.po_date ? " · " + orDate(doc.po_date) : ""}</span>
				 <span>Sales Order <a class="link" data-erp="Sales Order|${orEsc(doc.sales_order)}">${orEsc(doc.sales_order)}</a></span>
				 <span>${orEsc(so.customer_name || doc.customer || "")}</span>
				 ${doc.approved_by ? `<span>Approved by ${orEsc(doc.approved_by)}</span>` : ""}`,
				primaryBtns.join("") + `<div class="menu-wrap"><button class="round ghost" data-menu=".trk-menu">${orIcon("dots")}</button><div class="menu trk-menu">${moreItems.join("")}</div></div>`,
				["trackers", "Primary Sales"])}
			${setupBanner}
			${banner}
			${waiting}
			${invoiceBanner}
			${dispatched ? "" : `<div class="kpis">${orderKpis}</div>${orderCard}`}
			<div class="kpis ${dispatched ? "" : "hide"}">
				${kpi("Dispatched", orQty(doc.total_dispatched_qty))}
				${kpi("Received by marketplace", orQty(doc.marketplace_received_qty))}
				${kpi("In transit", orQty(doc.stock_in_transit))}
				${kpi("Sold (secondary)", orQty(doc.total_sold_qty))}
				${kpi("Stock at marketplace (virtual)", orQty(doc.virtual_stock), "lime")}
				${kpi("Return in transit", orQty(doc.return_in_transit))}
				${kpi("Primary sales value", orCompact(doc.primary_sales_value))}
				${kpi("Secondary sales value", orCompact(doc.secondary_sales_value), "lav")}
				${kpi("Commission", orCompact(doc.marketplace_commission))}
				${kpi("Net price variance", orInr(doc.net_price_variance), orFlt(doc.net_price_variance) < 0 ? "red" : "lime")}
				${kpi("OR Sale Provision", orInr(doc.provision_amount), orFlt(doc.provision_amount) ? "red" : "")}
				${kpi("Debit / credit notes", orCompact(doc.debit_note_amount) + " / " + orCompact(doc.credit_note_amount))}
			</div>
			<div class="card ${dispatched ? "" : "hide"}">
				<div class="card-head"><span class="card-title">${orIcon("grid")} Item summary</span></div>
				${d.item_summary.length ? `<div class="table-wrap"><table class="t"><thead><tr>
					<th>Item</th><th>SKU</th><th class="num">Received</th><th class="num">Sold</th><th class="num">Sec. returned</th>
					<th class="num">Returns dispatched</th><th class="num">At marketplace</th><th>Last sale</th><th class="num">Primary value</th>
					<th class="num">Secondary value</th><th class="num">Commission</th><th class="num">Net variance</th></tr></thead>
					<tbody>${d.item_summary.map((r) => `<tr><td class="strong">${orEsc(r.item_code)}</td><td>${orEsc(r.marketplace_sku || "")}</td>
						<td class="num">${orQty(r.received)}</td><td class="num">${orQty(r.sold)}</td><td class="num">${orQty(r.secondary_returned)}</td>
						<td class="num">${orQty(r.return_dispatched)}</td><td class="num strong">${orQty(r.virtual_stock)}</td><td>${orDate(r.last_sale)}</td>
						<td class="num">${orInr(r.primary_value)}</td><td class="num">${orInr(r.secondary_value)}</td><td class="num">${orInr(r.commission_value)}</td>
						<td class="num">${orInr(r.net_variance)}</td></tr>`).join("")}</tbody></table></div>`
				: `<div class="empty">No Primary Sale yet. Use “Pick, Pack &amp; Dispatch”.</div>`}
			</div>
			<div class="card ${dispatched ? "" : "hide"}">
				<div class="card-head"><span class="card-title">${orIcon("truck")} Primary sales &amp; returns</span></div>
				${moves.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>Type</th><th>Item</th><th class="num">Qty</th><th class="num">Received</th>
					<th class="num">Pending</th><th>Status</th><th>Reference</th><th>Dispatch</th><th>AWB</th><th>POD</th><th></th></tr></thead>
					<tbody>${moves.map((r) => `<tr><td class="faint">${r.idx}</td><td>${orPill(r.movement_type)}</td><td class="strong">${orEsc(r.item_code)}</td>
						<td class="num">${orQty(r.qty)}</td><td class="num">${orQty(r.received_qty)}</td><td class="num">${orQty(r.pending_qty)}</td>
						<td>${orPill(r.status)}</td>
						<td>${r.movement_type === "Primary Return" ? orEsc(r.reference_name || "") : ""}${r.delivery_note ? `<span class="sub">${seLink(r.delivery_note)}</span>` : ""}${r.sales_invoice ? `<span class="sub">${siLink(r.sales_invoice)}</span>` : ""}</td>
						<td>${orDate(r.dispatch_date)}</td><td>${orEsc(r.awb_no || "")}</td>
						<td>${r.pod ? `<a class="link" href="${orEsc(r.pod)}" target="_blank">View</a>` : ""}</td>
						<td class="num nowrap">
							${can && isReceivable(r) ? `<button class="btn sm" data-act="receipt" data-row="${r.name}">Receive</button>` : ""}
							${can && r.status === "Return Initiated" ? `<button class="btn sm" data-act="dispatch-ret" data-row="${r.name}">Dispatched</button>` : ""}
							${can && isPutaway(r) ? `<button class="btn sm" data-act="putaway" data-row="${r.name}">Putaway</button>` : ""}
							${can && isCancellable(r) ? `<button class="btn sm danger" data-act="cancel-ret" data-row="${r.name}">Cancel</button>` : ""}
						</td></tr>`).join("")}</tbody></table></div>`
				: `<div class="empty">Dispatches appear here after “Pick, Pack &amp; Dispatch”.</div>`}
			</div>
			<div class="card ${ses.length || (d.invoices || []).length ? "" : "hide"}">
				<div class="card-head"><span class="card-title">${orIcon("file")} Stock &amp; accounting entries</span>
					<span class="muted small">Only Delivery Notes move stock; the marketplace's stock is virtual
					<button class="btn sm" data-act="ledger" style="margin-left:8px">All ledgers</button></span></div>
				<div class="table-wrap"><table class="t"><thead><tr><th>Document</th><th>Step</th><th>Date</th><th class="num">Qty / Amount</th><th>Details</th><th></th></tr></thead><tbody>
					${ses.map((s) => `<tr><td class="strong">${seLink(s.name)}</td><td>${orPill(s.is_return ? "Return Delivery" : "Dispatch")}</td><td>${orDate(s.posting_date)}</td>
						<td class="num">${orQty(s.qty)}</td><td class="muted small">${orEsc([s.warehouse, s.return_against ? "against " + s.return_against : "", s.lr_no ? "AWB " + s.lr_no : ""].filter(Boolean).join(" · "))}${s.docstatus ? "" : " · Draft"}</td>
						<td class="num">${s.docstatus ? ledgerBtn("Delivery Note", s.name) : ""}</td></tr>`).join("")}
					${(d.invoices || []).map((s) => `<tr><td class="strong">${siLink(s.name)}</td><td>${orPill(s.or_document_type || "Sales Invoice")}</td><td>${orDate(s.posting_date)}</td>
						<td class="num">${orInr(s.grand_total)}</td><td class="muted small">${orEsc(s.customer || "")}${s.return_against ? " · against " + orEsc(s.return_against) : ""} · ${orEsc(s.docstatus ? s.status : "Draft")}</td>
						<td class="num">${s.docstatus ? ledgerBtn("Sales Invoice", s.name) : ""}</td></tr>`).join("")}
					${(d.journals || []).map((j) => `<tr><td class="strong">${jeLink(j.name)}</td><td>${orPill(j.or_purpose)}</td><td>${orDate(j.posting_date)}</td>
						<td class="num">${orInr(j.total_debit)}</td><td class="muted small">${orEsc(j.or_against || "")}</td>
						<td class="num">${ledgerBtn("Journal Entry", j.name)}</td></tr>`).join("")}
				</tbody></table></div>
			</div>
			<div class="grid2">
				<div class="card">
					<div class="card-head"><span class="card-title">${orIcon("swap")} Secondary sales</span>
						${can ? `<button class="btn sm" data-act="import">${orIcon("upload")} Import</button>` : ""}</div>
					${d.lines.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Order</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Variance</th><th>Note</th><th></th></tr></thead>
						<tbody>${d.lines.slice(0, 50).map((l) => `<tr class="click" data-go="order|${orEsc(l.name)}">
							<td class="strong">${orEsc(l.marketplace_order_id)}<span class="sub">${orDate(l.sale_date)}${l.is_return ? " · return" : ""}</span></td>
							<td>${orEsc(l.item_code)}</td><td class="num">${orQty(l.qty)}${orFlt(l.returned_qty) ? `<span class="sub">${orQty(l.returned_qty)} returned</span>` : ""}</td>
							<td class="num">${orInr(l.selling_rate)}</td><td class="num">${orInr(l.total_variance)}</td><td>${orPill(l.note_status)}</td>
							<td class="num">${can && !l.is_return && orFlt(l.qty) - orFlt(l.returned_qty) > 0 ? `<button class="btn sm" data-act="sec-return" data-line="${orEsc(l.name)}">Return</button>` : ""}</td>
						</tr>`).join("")}</tbody></table></div>
						${d.lines.length > 50 ? `<div class="more-row"><button class="btn sm" data-act="all-lines">All ${d.lines.length} lines</button></div>` : ""}`
					: `<div class="empty">No secondary sales yet. Import the marketplace's sales report.</div>`}
				</div>
				<div class="card">
					<div class="card-head"><span class="card-title">${orIcon("file")} Rate difference notes</span></div>
					${notes.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Note</th><th>Group</th><th class="num">Lines</th><th class="num">Amount</th><th>Status</th></tr></thead>
						<tbody>${notes.map((n) => `<tr><td>${orPill(n.note_type)}<span class="sub"><a class="link" data-erp="Sales Invoice|${orEsc(n.sales_invoice)}">${orEsc(n.sales_invoice)}</a></span></td>
							<td>${orEsc(n.group_key)}</td><td class="num">${n.line_count}</td><td class="num">${orInr(n.amount)}</td>
							<td>${orPill(n.status)}${n.submitted_on ? `<span class="sub">${orDate(n.submitted_on)}</span>` : ""}</td></tr>`).join("")}</tbody></table></div>`
					: `<div class="empty">Debit / credit notes for price variances appear here.</div>`}
				</div>
			</div>`;
	}

	act(method, args) {
		return this.api("tracker_action", { name: this.name, action: method, args });
	}
	refresh(msg) {
		if (msg) this.app.toast(msg);
		return this.render((this.app.token = Symbol()));
	}

	async onAct(act, el) {
		const d = this.data;
		const doc = d.doc;
		const moves = doc.stock_movements || [];
		const rowLabel = (r) => `${r.idx}. ${r.movement_type}${r.reference_name ? " " + r.reference_name : ""}: ${orQty(r.qty)} × ${r.item_code} (${r.status})`;
		const app = this.app;
		if (act === "wf") {
			const a = el.dataset.a;
			if (!(await app.confirm(a, `${a} ${doc.name}?`, a))) return;
			try {
				const status = await this.api("apply_workflow_action", { name: doc.name, action: a });
				this.refresh(`${doc.name} is now ${status}`);
			} catch (err) {
				app.toast(err.message, "error");
			}
		} else if (act === "receipt") {
			// one POD, received qty SKU by SKU; lines grouped by the dispatch (Delivery Note) they came on
			const open = moves.filter(isReceivable);
			const sku = Object.fromEntries((d.item_summary || []).map((i) => [i.item_code, i.marketplace_sku || ""]));
			const groupOf = (r) => r.delivery_note || r.reference_name || r.name;
			const groups = [];
			open.forEach((r) => {
				let g = groups.find((x) => x.key === groupOf(r));
				if (!g) groups.push((g = { key: groupOf(r), rows: [], date: r.dispatch_date, awb: r.awb_no }));
				g.rows.push(r);
			});
			const pendingOf = (r) => orFlt(r.qty) - orFlt(r.received_qty);
			const clicked = el.dataset.row && open.find((r) => r.name === el.dataset.row);
			const options = [
				...groups.map((g) => ({ value: g.key, label: `${g.key}${g.date ? " · " + orDate(g.date) : ""}${g.awb ? " · AWB " + g.awb : ""} — ${g.rows.length} SKU(s), ${orQty(g.rows.reduce((a, r) => a + pendingOf(r), 0))} pending` })),
				...(groups.length > 1 ? [{ value: "__all", label: `All pending dispatches — ${open.length} line(s)` }] : []),
			];
			const rowsFor = (key) => (key === "__all" ? open : (groups.find((g) => g.key === key) || { rows: [] }).rows);
			const lineHtml = (key) => {
				const rows = rowsFor(key);
				return `<div class="table-wrap"><table class="egrid"><thead><tr><th>Item</th><th>SKU</th>${key === "__all" ? "<th>Dispatch</th>" : ""}
					<th class="num">Dispatched</th><th class="num">Received earlier</th><th class="num">Pending</th><th style="width:130px">Received now</th><th class="num">Short</th></tr></thead><tbody>
					${rows.map((r) => `<tr data-row="${orEsc(r.name)}" data-pending="${pendingOf(r)}"><td><b>${orEsc(r.item_code)}</b></td><td>${orEsc(sku[r.item_code] || "—")}</td>
						${key === "__all" ? `<td class="small">${orEsc(groupOf(r))}</td>` : ""}
						<td class="num">${orQty(r.qty)}</td><td class="num">${orQty(r.received_qty)}</td><td class="num">${orQty(pendingOf(r))}</td>
						<td><input class="inp sm" type="number" min="0" step="any" data-qty value="${pendingOf(r)}"></td>
						<td class="num" data-short>0</td></tr>`).join("")}
					</tbody></table></div>
					<div class="hint" style="margin-top:6px">Enter what the marketplace actually received per SKU. A short qty stays in transit and can be received later with another POD; 0 skips the SKU.</div>`;
			};
			const updateShort = (mm) => mm.el.querySelectorAll("tr[data-row]").forEach((tr) => {
				const short = Math.max(orFlt(tr.dataset.pending) - orFlt(tr.querySelector("[data-qty]").value), 0);
				const cell = tr.querySelector("[data-short]");
				cell.textContent = orQty(short);
				cell.style.color = short ? "var(--red)" : "";
			});
			const draw = (mm, key) => {
				mm.el.querySelector("[data-lines]").innerHTML = lineHtml(key);
				updateShort(mm);
			};
			const pre = clicked ? groupOf(clicked) : groups[0] && groups[0].key;
			const m = app.modal({
				title: "Record POD (marketplace receipt)",
				wide: true,
				body: `<div class="note">The marketplace confirmed what it received. Upload its signed POD once and enter the received qty for each SKU; the units move from in transit to the marketplace's stock on this tracker (virtual: no stock entry, the goods left your stock with the Delivery Note).</div><div data-lines></div>`,
				fields: [
					{ name: "dispatch", label: "Dispatch", type: "select", reqd: 1, default: pre, options, onchange: (v) => draw(m, v) },
					{ name: "pod", label: "POD (proof of delivery)", type: "file", reqd: 1, doctype: "OR Primary Sales Tracker", docname: doc.name, placeholder: "Upload the POD (PDF or image)" },
					{ name: "posting_date", label: "Received on", type: "date", default: app.boot.today },
				],
				onOpen: (mm) => {
					draw(mm, pre);
					mm.el.addEventListener("input", (e) => e.target.matches("[data-qty]") && updateShort(mm));
				},
				primary: "Record receipt",
				onSubmit: async (v, mm) => {
					const lines = Array.from(mm.el.querySelectorAll("tr[data-row]")).map((tr) => ({ row: tr.dataset.row, qty: orFlt(tr.querySelector("[data-qty]").value), pending: orFlt(tr.dataset.pending) }));
					const over = lines.find((l) => l.qty > l.pending + 1e-9);
					if (over) throw new Error(`Received qty can't be more than the pending qty (${orQty(over.pending)}).`);
					const chosen = lines.filter((l) => l.qty > 0).map(({ row, qty }) => ({ row, qty }));
					if (!chosen.length) throw new Error("Enter the received qty for at least one SKU.");
					const entry = await this.act("record_receipts", { lines: JSON.stringify(chosen), pod: v.pod, posting_date: v.posting_date });
					this.refresh(`Receipt recorded for ${chosen.length} SKU(s)${entry ? " · " + entry : ""}`);
				},
			});
		} else if (act === "initiate") {
			const held = d.item_summary.filter((i) => i.available > 0);
			app.modal({
				title: `Primary Return from ${doc.marketplace}`,
				body: `<div class="note">The marketplace is sending unsold goods back. Track it here; mark it dispatched when the marketplace ships it, and use “Putaway” when it arrives: a return Delivery Note then brings it back into your stock.</div>`,
				fields: [
					{ name: "item_code", label: "Item", type: "select", reqd: 1, options: held.map((i) => ({ value: i.item_code, label: `${i.item_code} (${orQty(i.available)} held)` })) },
					{ name: "qty", label: "Qty", type: "number", reqd: 1 },
					{ name: "reference", label: "Marketplace return no", type: "text", reqd: 1 },
					{ name: "initiation_date", label: "Initiation date", type: "date", default: app.boot.today },
					{ name: "awb_no", label: "AWB / Tracking ID", type: "text" },
				],
				primary: "Initiate return",
				onSubmit: async (v) => {
					await this.act("initiate_return", v);
					this.refresh("Primary Return initiated");
				},
			});
		} else if (act === "dispatch-ret") {
			const rows = moves.filter((r) => r.status === "Return Initiated");
			app.modal({
				title: "Mark Primary Return dispatched",
				fields: [
					{ name: "row", label: "Return", type: "select", reqd: 1, default: el.dataset.row, options: rows.map((r) => ({ value: r.name, label: rowLabel(r) })) },
					{ name: "awb_no", label: "AWB / Tracking ID", type: "text", reqd: 1 },
					{ name: "dispatch_date", label: "Dispatch date", type: "date", default: app.boot.today },
				],
				primary: "Mark dispatched",
				onSubmit: async (v) => {
					await this.act("mark_dispatched", v);
					this.refresh("Return marked dispatched");
				},
			});
		} else if (act === "dispatch") {
			const whOptions = (app.boot.warehouses || []).map((w) => `<option value="${orEsc(w)}">${orEsc(w)}</option>`).join("");
			app.modal({
				title: "Pick, Pack & Dispatch",
				wide: true,
				primary: "Dispatch",
				body: `<div class="note">The goods are picked and packed for ${orEsc(doc.marketplace)}. A Delivery Note against ${orEsc(doc.sales_order)} takes them out of your warehouse: an outright sale. Then create the Primary Invoice.</div>
					<div class="table-wrap"><table class="egrid"><thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">Dispatched</th><th>From warehouse</th><th style="width:120px">Qty</th></tr></thead><tbody>
					${d.pending_delivery.map((r) => `<tr data-detail="${orEsc(r.name)}"><td><b>${orEsc(r.item_code)}</b><div class="faint small">${orEsc(r.item_name || "")}</div></td>
						<td class="num">${orQty(r.qty)}</td><td class="num">${orQty(r.delivered_qty)}</td>
						<td><select class="inp sm" data-wh>${r.warehouse ? "" : `<option value="">Choose…</option>`}${whOptions.replace(`value="${orEsc(r.warehouse || "")}"`, `value="${orEsc(r.warehouse || "")}" selected`)}</select></td>
						<td><input class="inp sm" type="number" step="any" data-qty value="${orFlt(r.qty) - orFlt(r.delivered_qty)}"></td></tr>`).join("")}
					</tbody></table></div>`,
				fields: [
					{ name: "awb_no", label: "AWB / Tracking ID", type: "text" },
					{ name: "posting_date", label: "Dispatch date", type: "date", default: app.boot.today },
				],
				onSubmit: async (v, mm) => {
					const items = Array.from(mm.el.querySelectorAll("tr[data-detail]"))
						.map((tr) => ({ so_detail: tr.dataset.detail, warehouse: tr.querySelector("[data-wh]").value, qty: orFlt(tr.querySelector("[data-qty]").value) }))
						.filter((r) => r.qty > 0);
					if (!items.length) throw new Error("Enter a quantity to dispatch.");
					if (items.some((r) => !r.warehouse)) throw new Error("Choose the warehouse to dispatch each item from.");
					const name = await this.act("dispatch", { items: JSON.stringify(items), awb_no: v.awb_no, posting_date: v.posting_date });
					this.refresh(`Dispatched: ${name}`);
				},
			});
		} else if (act === "report") {
			el.disabled = true;
			try {
				// built and formatted on the server (marketplace_or/report_xlsx.py)
				const res = await fetch(`/api/method/or_model.marketplace_or.report_xlsx.download?name=${encodeURIComponent(doc.name)}`, {
					headers: { "X-Frappe-CSRF-Token": frappe.csrf_token },
				});
				if (!res.ok) throw new Error(app.serverError(await res.json().catch(() => ({})), res.status));
				orDownload(await res.blob(), `${doc.name} report ${app.boot.today}.xlsx`);
				app.toast("Report downloaded");
			} catch (err) {
				app.toast(err.message, "error");
			} finally {
				el.disabled = false;
			}
		} else if (act === "ledger") {
			const one = el.dataset.dn;
			const m = app.modal({
				title: one ? `Ledger · ${one}` : `All ledgers · ${doc.name}`,
				primary: false,
				body: '<div class="ledger-body"><div class="spin"></div></div>',
			});
			m.el.querySelector(".modal").classList.add("xl");
			const box = m.el.querySelector(".ledger-body");
			try {
				const r = await this.api("document_ledger", { name: doc.name, doctype: el.dataset.dt, docname: one });
				box.innerHTML = orLedgerHtml(r, !one);
			} catch (err) {
				box.innerHTML = `<div class="banner red">${orEsc(err.message)}</div>`;
			}
		} else if (act === "invoice") {
			app.modal({
				title: "Create Primary Invoice",
				body: `<div class="note">Bills ${orEsc(doc.marketplace)} for the ${orQty(d.to_invoice)} dispatched, uninvoiced unit(s) at the order rates: a standard Sales Invoice for each Delivery Note not yet billed.</div>`,
				fields: [{ name: "posting_date", label: "Invoice date", type: "date", default: app.boot.today }],
				primary: "Create & submit",
				onSubmit: async (v) => {
					const name = await this.act("make_primary_invoice", v);
					this.refresh(`Primary Invoice ${name} submitted`);
				},
			});
		} else if (act === "putaway") {
			const rows = moves.filter(isPutaway);
			const pre = el.dataset.row || (rows[0] && rows[0].name);
			const pending = (name) => {
				const r = rows.find((x) => x.name === name);
				return r ? orFlt(r.qty) - orFlt(r.received_qty) : "";
			};
			// by default the goods go back to the warehouse they were dispatched from
			const homeOf = (name) => {
				const r = rows.find((x) => x.name === name);
				return (r && (d.dispatch_warehouses || {})[r.item_code]) || "";
			};
			const m = app.modal({
				title: "Putaway returned goods",
				body: `<div class="note">The Primary Return arrived. A return Delivery Note brings it back into the warehouse you choose (by default the one it was dispatched from), and a Credit Note against the Primary Invoice credits ${orEsc(doc.marketplace)} for it.</div>`,
				fields: [
					{ name: "row", label: "Primary Return", type: "select", reqd: 1, default: pre, options: rows.map((r) => ({ value: r.name, label: rowLabel(r) + ` — ${orQty(orFlt(r.qty) - orFlt(r.received_qty))} to put away` })),
						onchange: (v) => {
							m.set("qty", pending(v));
							m.set("warehouse", homeOf(v));
						} },
					{ name: "qty", label: "Qty", type: "number", reqd: 1, default: pending(pre) },
					{ name: "warehouse", label: "Put away in", type: "select", reqd: 1, default: homeOf(pre), options: (app.boot.warehouses || []).map((w) => ({ value: w, label: w })) },
					{ name: "posting_date", label: "Date", type: "date", default: app.boot.today },
				],
				primary: "Put away",
				onSubmit: async (v) => {
					const r = await this.act("putaway", v);
					this.refresh(`Put away (${r.delivery_note})${r.credit_notes && r.credit_notes.length ? ", credit note " + r.credit_notes.join(", ") : ""}`);
				},
			});
		} else if (act === "cancel-ret") {
			const rows = moves.filter(isCancellable);
			app.modal({
				title: "Cancel Primary Return",
				body: `<div class="note">Only returns not yet put away can be cancelled (the units count as held by the marketplace again). A dispatch is undone by cancelling its Delivery Note.</div>`,
				fields: [{ name: "row", label: "Return", type: "select", reqd: 1, default: el.dataset.row, options: rows.map((r) => ({ value: r.name, label: rowLabel(r) })) }],
				primary: "Cancel return",
				onSubmit: async (v) => {
					await this.act("cancel_movement", v);
					this.refresh("Primary Return cancelled");
				},
			});
		} else if (act === "import") {
			const fmt = (app.boot.import_formats || {})[doc.marketplace];
			const im = app.modal({
				title: "Import secondary sales",
				wide: true,
				body: fmt ? orFormatHtml(fmt) + `<button class="btn sm" type="button" data-tpl>${orIcon("download")} Download ${orEsc(doc.marketplace)} template</button>` +
					(fmt.po_column ? `<div class="note" style="margin-top:10px">Only lines with PO ${orEsc(doc.marketplace_po_no || "")} are imported here; import the whole report from Secondary Sales to fill every record.</div>` : "")
					: `<div class="note">Columns: marketplace_order_id, sale_date (YYYY-MM-DD), marketplace_sku, qty, selling_price.</div>`,
				fields: [
					{ name: "file_url", label: "CSV / XLSX file", type: "file", accept: ".csv,.xlsx,.xls", doctype: "OR Primary Sales Tracker", docname: doc.name, placeholder: "Choose the sales report" },
					{ name: "csv_text", label: "Or paste CSV", type: "textarea", default: (fmt ? orFormatHeaders(fmt).join(",") : "marketplace_order_id,sale_date,marketplace_sku,qty,selling_price") + "\n" },
				],
				onOpen: (mm) => mm.el.addEventListener("click", (e) => e.target.closest("[data-tpl]") && fmt && orFormatTemplate(fmt)),
				primary: "Import",
				onSubmit: async (v) => {
					const pasted = (v.csv_text || "").trim().includes("\n");
					if (!v.file_url && !pasted) throw new Error("Upload a file or paste at least one sales line.");
					const r = await this.act("import_secondary_sales", v.file_url ? { file_url: v.file_url } : { csv_text: v.csv_text });
					const parts = [`Imported ${r.imported} line(s) (batch ${r.batch}).`];
					if (r.duplicates && r.duplicates.length) parts.push(`Skipped ${r.duplicates.length} duplicate(s).`);
					if (r.filtered) parts.push(`${r.filtered} row(s) left out by the row filter.`);
					if (r.other_po) parts.push(`${r.other_po} row(s) belong to other POs.`);
					parts.push(...orReturnsText(r));
					parts.push(r.variance_lines ? `${r.variance_lines} with price variance; ${r.notes_created} note(s) created.` : "No price variance.");
					this.refresh(parts.join(" "));
				},
			});
		} else if (act === "sec-return") {
			const open = d.lines.filter((l) => !l.is_return && orFlt(l.qty) - orFlt(l.returned_qty) > 0);
			const pre = el.dataset.line || (open[0] && open[0].name);
			const left = (n) => {
				const l = open.find((x) => x.name === n);
				return l ? orFlt(l.qty) - orFlt(l.returned_qty) : "";
			};
			const mm = app.modal({
				title: "Secondary Return",
				body: `<div class="note">An end customer returned goods to ${orEsc(doc.marketplace)}. The units go back to the marketplace's virtual stock and the sale's price variance (and its OR Sale Provision) is reversed for them.</div>`,
				fields: [
					{ name: "or_secondary_sales_order", label: "Secondary sale", type: "select", reqd: 1, default: pre,
						options: open.map((l) => ({ value: l.name, label: `${l.marketplace_order_id} · ${l.item_code} · ${orQty(orFlt(l.qty) - orFlt(l.returned_qty))} returnable` })),
						onchange: (v) => mm.set("qty", left(v)) },
					{ name: "qty", label: "Return qty", type: "number", reqd: 1, default: left(pre) },
					{ name: "return_date", label: "Return date", type: "date", default: app.boot.today },
					{ name: "marketplace_return_id", label: "Marketplace return ID", type: "text", help: "Left blank: the order ID with -R1, -R2 …" },
				],
				primary: "Record return",
				onSubmit: async (v) => {
					const name = await this.act("record_secondary_return", v);
					this.refresh(`Secondary Return ${name} recorded`);
				},
			});
		} else if (act === "notes") {
			const today = new Date(app.boot.today);
			const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
			const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
			app.modal({
				title: "Month-end settlement",
				body: `<div class="note">For the secondary sales up to this date: one Credit Note (secondary rate below primary) and one Debit Note (above) per Primary Invoice, made against it. The Credit Note clears the OR Sale Provision booked at import (Provision Dr / ${orEsc(doc.marketplace)} Cr); the Debit Note bills the excess (${orEsc(doc.marketplace)} Dr / OR Sales Variance Cr).</div>`,
				fields: [{ name: "upto", label: "Sales up to", type: "date", reqd: 1, default: iso(lastMonthEnd) }],
				primary: "Create notes",
				onSubmit: async (v) => {
					const names = await this.act("create_notes", v);
					this.refresh(names && names.length ? `${names.length} note(s) created` : "Nothing to settle up to that date (or the sales are not invoiced yet)");
				},
			});
		} else if (act === "submit-notes") {
			if (!(await app.confirm("Submit notes", "Submit every draft debit and credit note on this tracker?", "Submit all"))) return;
			try {
				const n = await this.act("submit_draft_notes");
				this.refresh(`${n} note(s) submitted`);
			} catch (err) {
				app.toast(err.message, "error");
			}
		} else if (act === "all-lines") {
			app._secondaryFilters = { tracker: doc.name };
			app.go("secondary");
		}
	}
}

const isReceivable = (r) => r.movement_type === "Primary Sale" && ["Dispatched", "Partially Received"].includes(r.status);
const isCancellable = (r) => ["Return Initiated", "Return Dispatched"].includes(r.status) && !r.from_sales_return && !orFlt(r.received_qty);
/** Stock Ledger and General Ledger rows of OR documents (ui_api.document_ledger). `all`: rows of many vouchers. */
const orLedgerHtml = (r, all) => {
	const voucherLink = (row) => `<a class="link" data-erp="${orEsc(row.voucher_type)}|${orEsc(row.voucher_no)}">${orEsc(row.voucher_no)}</a>`;
	const signed = (v, digits) => {
		const n = orFlt(v);
		return `<span style="color:${n < 0 ? "var(--red)" : n > 0 ? "var(--lime)" : "inherit"}">${n > 0 ? "+" : ""}${digits ? orInr(n) : orQty(n)}</span>`;
	};
	const drafts = r.vouchers.filter((v) => v.docstatus !== 1);
	if (drafts.length && !all) return `<div class="banner orange">${orEsc(drafts[0].name)} is not submitted, so it has posted nothing yet.</div>`;

	const stock = !r.can_see_stock
		? `<div class="hint">You don't have access to the Stock Ledger.</div>`
		: r.stock.length
		? `<div class="table-wrap"><table class="t"><thead><tr>${all ? "<th>Document</th>" : ""}<th>Date</th><th>Item</th><th>Warehouse</th>
			<th class="num">Qty in / out</th><th class="num">Valuation rate</th><th class="num">Stock value change</th><th class="num">Balance qty</th></tr></thead><tbody>
			${r.stock.map((s) => `<tr>${all ? `<td>${voucherLink(s)}</td>` : ""}<td>${orDate(s.posting_date)}</td><td class="strong">${orEsc(s.item_code)}</td>
				<td>${orEsc(s.warehouse)}</td><td class="num">${signed(s.actual_qty)}</td><td class="num">${orInr(s.valuation_rate)}</td>
				<td class="num">${signed(s.stock_value_difference, true)}</td><td class="num">${orQty(s.qty_after_transaction)}</td></tr>`).join("")}
			</tbody></table></div>`
		: `<div class="hint">No stock movement${all ? "" : " (this document does not move stock)"}.</div>`;

	let debit = 0;
	let credit = 0;
	r.gl.forEach((g) => {
		debit += orFlt(g.debit);
		credit += orFlt(g.credit);
	});
	const gl = !r.can_see_gl
		? `<div class="hint">You don't have access to the General Ledger.</div>`
		: r.gl.length
		? `<div class="table-wrap"><table class="t"><thead><tr>${all ? "<th>Document</th>" : ""}<th>Date</th><th>Account</th><th>Party</th>
			<th class="num">Debit</th><th class="num">Credit</th><th>Cost center</th></tr></thead><tbody>
			${r.gl.map((g) => `<tr>${all ? `<td>${voucherLink(g)}</td>` : ""}<td>${orDate(g.posting_date)}</td><td class="strong">${orEsc(g.account)}</td>
				<td>${g.party ? `${orEsc(g.party)}<span class="sub">${orEsc(g.party_type)}</span>` : ""}</td>
				<td class="num">${orFlt(g.debit) ? orInr(g.debit) : ""}</td><td class="num">${orFlt(g.credit) ? orInr(g.credit) : ""}</td>
				<td class="muted small">${orEsc(g.cost_center || "")}</td></tr>`).join("")}
			<tr class="strong"><td colspan="${all ? 4 : 3}">Total</td><td class="num">${orInr(debit)}</td><td class="num">${orInr(credit)}</td><td></td></tr>
			</tbody></table></div>`
		: `<div class="hint">No accounting entry${all ? "" : " (this document posts no accounts)"}.</div>`;

	// all documents: the net effect per account, so the overall position is visible at a glance
	let net = "";
	if (all && r.gl.length) {
		const byAcc = new Map();
		r.gl.forEach((g) => {
			const k = g.account + (g.party ? ` · ${g.party}` : "");
			byAcc.set(k, (byAcc.get(k) || 0) + orFlt(g.debit) - orFlt(g.credit));
		});
		net = `<h4 class="muted small" style="margin:18px 0 8px">NET EFFECT BY ACCOUNT</h4><div class="table-wrap"><table class="t"><thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
			${[...byAcc].filter(([, v]) => Math.abs(v) >= 0.005).map(([k, v]) => `<tr><td class="strong">${orEsc(k)}</td><td class="num">${v > 0 ? orInr(v) : ""}</td><td class="num">${v < 0 ? orInr(-v) : ""}</td></tr>`).join("")
				|| `<tr><td colspan="3" class="hint">Every account nets to zero.</td></tr>`}
			</tbody></table></div>`;
	}
	return `${all ? `<div class="hint">${r.vouchers.length} submitted document(s) of this record.</div>` : ""}
		<h4 class="muted small" style="margin:12px 0 8px">STOCK LEDGER</h4>${stock}
		<h4 class="muted small" style="margin:18px 0 8px">ACCOUNTING LEDGER</h4>${gl}${net}`;
};

const isPutaway = (r) => r.movement_type === "Primary Return" && ["Return Dispatched", "Partially Received"].includes(r.status);
const kpi = (k, v, cls = "") => `<div class="kpi"><div class="k">${orEsc(k)}</div><div class="v ${cls}">${orEsc(v)}</div></div>`;

// ------------------------------------------------------------------ secondary-sales import formats (Settings > import formats)

/** The column headings a marketplace's file must have, in the order of a template. */
const orFormatHeaders = (f) => [
	...String(f.order_id_column || "").split("+").map((h) => h.trim()),
	f.sale_date_column, f.sku_column, f.qty_column, f.price_column, f.payout_column, f.po_column, f.filter_column, f.type_column, f.return_date_column,
].filter((h, i, all) => h && all.indexOf(h) === i);

/** The returns part of an import result, for the message shown after importing. */
function orReturnsText(r) {
	const parts = [];
	if (r.returns) parts.push(`Recorded ${r.returns} customer return(s).`);
	if (r.return_duplicates) parts.push(`${r.return_duplicates} return(s) were already recorded.`);
	const un = r.returns_unmatched || [];
	if (un.length) parts.push(`${un.length} return(s) left out because their sale is not in the system or its record is closed (e.g. ${un.slice(0, 2).join("; ")}).`);
	return parts;
}

/** A short, readable description of a marketplace's import format. */
function orFormatHtml(f) {
	if (!f) return "";
	const col = (label, heading) => `<div class="fmt-row"><span>${label}</span><b>${orEsc(heading)}</b></div>`;
	return `<div class="fmt-box">
		<div class="fmt-title">${f.configured ? `${orEsc(f.marketplace)} format` : "Standard format"} · headings in row ${orEsc(f.header_row)}</div>
		${col("Order ID", f.order_id_column)}${col("Sale date", f.sale_date_column + (f.date_format && f.date_format !== "Auto" ? `  (${f.date_format})` : ""))}
		${col("SKU", f.sku_column)}${col("Quantity", f.qty_column)}${col("Selling price", f.price_column + (f.price_type === "Line total" ? "  (line total ÷ qty)" : ""))}
		${f.payout_column ? col("Net payout", f.payout_column + "  (commission % per line)") : ""}
		${f.po_column ? col("PO number", f.po_column) : ""}
		${f.filter_column && f.filter_values ? col("Only rows where", `${f.filter_column} = ${f.filter_values}`) : ""}
		${f.type_column && f.return_values ? col("Customer returns", `${f.type_column} = ${f.return_values}` + (f.return_date_column ? `  (dated by ${f.return_date_column})` : "")) : ""}
		<div class="fmt-foot">${f.po_column ? "Lines go to the Primary Sales record with that PO number." : "Lines go to the oldest open Primary Sales record that still holds the item."} Duplicate order IDs are skipped. Lines with a negative quantity${f.type_column && f.return_values ? " or a return type" : ""} are recorded as returns against their sale.</div>
	</div>`;
}

/** Download an empty Excel template with a marketplace's column headings. */
function orFormatTemplate(f) {
	orDownload(orXlsx(`${f.marketplace} sales`, orFormatHeaders(f), []), `${f.marketplace} secondary sales template.xlsx`);
}

// ------------------------------------------------------------------ secondary sales

class SecondaryView extends OrView {
	constructor(app) {
		super(app);
		this.filters = Object.assign({ marketplace: "", kind: "", note_status: "", search: "", tracker: "", from_date: "", to_date: "" }, app._secondaryFilters || {});
		this.limit = 50;
	}
	async render(token) {
		const res = await this.api("secondary_orders", { ...this.filters, limit: this.limit });
		if (this.app.stale(token)) return;
		this.app._secondaryFilters = this.filters;
		const rows = res.rows;
		this.main.innerHTML = `
			${this.head("Secondary <span>Sales</span>", "Marketplace sales to end customers, imported from the marketplaces' reports. Tracking only: nothing here posts stock or accounts.",
				this.app.boot.can_import ? `<button class="btn white" data-act="import">${orIcon("upload")} Import sales</button>` : "")}
			<div class="kpis">
				${kpi("Lines", orQty(res.total_count))}
				${kpi("Units", orQty(res.total_qty), "lime")}
				${kpi("Value (shown lines)", orCompact(res.page_value))}
			</div>
			<div class="filters">
				<label class="search">${orIcon("search")}<input data-f="search" placeholder="Order ID, item or SKU" value="${orEsc(this.filters.search)}"></label>
				${this.selectHtml("marketplace", this.marketplaceOptions(), this.filters.marketplace)}
				${this.selectHtml("note_status", [{ value: "", label: "Any note status" }, ...["No variance", "Not created", "Draft", "Submitted"].map((s) => ({ value: s, label: s }))], this.filters.note_status)}
				${this.dateHtml("from_date", this.filters.from_date, "From")}
				${this.dateHtml("to_date", this.filters.to_date, "To")}
				<div class="seg-ctl">${[["", "All"], ["Sales", "Sales"], ["Returns", "Returns"]].map(([v, l]) => `<button data-act="kind" data-k="${v}" class="${this.filters.kind === v ? "on" : ""}">${l}</button>`).join("")}</div>
				${this.filters.tracker ? `<button class="chip on" data-act="clear-tracker">${orEsc(this.filters.tracker)} ✕</button>` : ""}
			</div>
			<div class="card">
				${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Order</th><th>Marketplace</th><th>Tracker</th><th>Item</th>
					<th class="num">Qty</th><th class="num">Selling rate</th><th class="num">Primary rate</th><th class="num">Value</th><th class="num">Variance</th><th>Note</th></tr></thead>
					<tbody>${rows.map((r) => `<tr class="click" data-go="order|${orEsc(r.name)}">
						<td class="strong">${orEsc(r.marketplace_order_id)}<span class="sub">${orDate(r.sale_date)}${r.is_return ? " · Return" : ""}</span></td>
						<td>${orPill(r.marketplace, r.is_return ? "purple" : "lime")}</td><td>${orEsc(r.or_reference || "")}</td>
						<td>${orEsc(r.item_code)}<span class="sub">${orEsc(r.marketplace_sku || "")}</span></td>
						<td class="num">${orQty(r.qty)}${orFlt(r.returned_qty) ? `<span class="sub">${orQty(r.returned_qty)} returned</span>` : ""}</td>
						<td class="num">${orInr(r.selling_rate)}</td><td class="num">${orInr(r.primary_rate)}</td>
						<td class="num ${orFlt(r.qty) < 0 ? "amt neg" : ""}">${orInr(orFlt(r.qty) * orFlt(r.selling_rate))}</td>
						<td class="num">${orInr(r.total_variance)}</td><td>${orPill(r.note_status)}</td></tr>`).join("")}</tbody></table></div>
					${rows.length >= this.limit ? `<div class="more-row"><button class="btn sm" data-act="more">Load more</button></div>` : ""}`
				: `<div class="empty">No secondary sales match these filters.</div>`}
			</div>`;
		const s = this.$("[data-f=search]");
		let t;
		s.addEventListener("input", () => {
			clearTimeout(t);
			t = setTimeout(async () => {
				this.filters.search = s.value.trim();
				const pos = s.selectionStart;
				await this.render((this.app.token = Symbol()));
				const n = this.$("[data-f=search]");
				n.focus();
				n.setSelectionRange(pos, pos);
			}, 300);
		});
		["marketplace", "note_status", "from_date", "to_date"].forEach((f) =>
			this.$(`[data-f=${f}]`).addEventListener("change", (e) => {
				this.filters[f] = e.target.value;
				this.render((this.app.token = Symbol()));
			})
		);
	}
	onAct(act, el) {
		if (act === "import") return this.importDialog();
		if (act === "kind") this.filters.kind = el.dataset.k;
		else if (act === "more") this.limit += 50;
		else if (act === "clear-tracker") this.filters.tracker = "";
		else return;
		this.render((this.app.token = Symbol()));
	}
	/** Import a marketplace's sales report: pick the marketplace first, its format decides how the file is read. */
	importDialog() {
		const app = this.app;
		const formats = app.boot.import_formats || {};
		const first = this.filters.marketplace || app.boot.marketplaces[0] || "";
		const show = (mp) => {
			const f = formats[mp];
			const box = m.el.querySelector("[data-field=fmt]");
			if (box) box.innerHTML = mp ? orFormatHtml(f) + `<button class="btn sm" type="button" data-tpl>${orIcon("download")} Download ${orEsc(mp)} template</button>` : `<div class="note">Select the marketplace to see its file format.</div>`;
			const paste = m.el.querySelector("[data-name=csv_text]");
			if (paste && (!paste.value.trim() || paste.dataset.auto === "1")) {
				paste.value = f ? orFormatHeaders(f).join(",") + "\n" : "";
				paste.dataset.auto = "1";
			}
		};
		const m = app.modal({
			title: "Import secondary sales",
			wide: true,
			fields: [
				{ name: "marketplace", label: "Marketplace", type: "select", reqd: 1, default: first,
					options: ["", ...app.boot.marketplaces].map((v) => ({ value: v, label: v || "Select marketplace" })), onchange: (v) => show(v) },
				{ name: "fmt", type: "html", html: "" },
				{ name: "file_url", label: "Sales report (CSV / XLSX)", type: "file", accept: ".csv,.xlsx,.xls", doctype: "", docname: "", placeholder: "Choose the marketplace's sales report" },
				{ name: "csv_text", label: "Or paste CSV", type: "textarea", default: "" },
			],
			primary: "Import",
			onOpen: (mm) => {
				mm.el.addEventListener("click", (e) => {
					if (!e.target.closest("[data-tpl]")) return;
					const mp = mm.el.querySelector("[data-name=marketplace]").value;
					if (formats[mp]) orFormatTemplate(formats[mp]);
				});
				mm.el.querySelector("[data-name=csv_text]").addEventListener("input", (e) => (e.target.dataset.auto = "0"));
			},
			onSubmit: async (v) => {
				if (!v.marketplace) throw new Error("Select the marketplace whose sales report this is.");
				const pasted = (v.csv_text || "").trim().includes("\n");
				if (!v.file_url && !pasted) throw new Error("Upload the sales report or paste at least one sales line.");
				const r = await this.api("import_marketplace_sales", { marketplace: v.marketplace, ...(v.file_url ? { file_url: v.file_url } : { csv_text: v.csv_text }) });
				const recs = Object.entries(r.records || {});
				const parts = [`Imported ${r.imported} line(s) into ${recs.length} record(s)${recs.length <= 3 ? ` (${recs.map(([n, c]) => `${n}: ${c}`).join(", ")})` : ""}.`];
				if (r.duplicates && r.duplicates.length) parts.push(`Skipped ${r.duplicates.length} duplicate(s).`);
				if (r.filtered) parts.push(`${r.filtered} row(s) left out by the row filter.`);
				parts.push(...orReturnsText(r));
				parts.push(r.variance_lines ? `${r.variance_lines} with price variance; ${r.notes_created} note(s) created.` : "No price variance.");
				app.toast(parts.join(" "));
				this.filters.marketplace = v.marketplace;
				this.render((app.token = Symbol()));
			},
		});
		show(first);
	}
}

class SecondaryOrderView extends OrView {
	async render(token) {
		const d = (this.data = await this.api("secondary_order", { name: this.name }));
		if (this.app.stale(token)) return;
		const doc = d.doc;
		const left = orFlt(doc.qty) - orFlt(doc.returned_qty);
		const field = (k, v) => `<div><div class="k">${orEsc(k)}</div><div class="v">${v}</div></div>`;
		this.main.innerHTML = `
			${this.head(orEsc(doc.marketplace_order_id) + ` <span>${doc.is_return ? "Return" : "Sale"}</span>`,
				`${orPill(doc.marketplace, doc.is_return ? "purple" : "lime")} ${orPill(doc.note_status)} <span>${orDate(doc.sale_date)}</span> <span class="faint">${orEsc(doc.name)}</span>`,
				!doc.is_return && left > 0 ? `<button class="btn white" data-act="return">${orIcon("ret")} Secondary Return</button>` : "",
				["secondary", "Secondary Sales"])}
			<div class="kpis">
				${kpi("Qty", orQty(doc.qty))}
				${kpi("Returned", orQty(doc.returned_qty))}
				${kpi("Selling rate", orInr(doc.selling_rate), "lav")}
				${kpi("Primary rate", orInr(doc.primary_rate))}
				${kpi("Commission", orQty(doc.commission_percent) + "%")}
				${kpi("Total variance", orInr(doc.total_variance), orFlt(doc.total_variance) < 0 ? "red" : "lime")}
			</div>
			<div class="card"><div class="kv">
				${field("Tracker", doc.or_reference ? `<a class="link" data-go="tracker|${orEsc(doc.or_reference)}">${orEsc(doc.or_reference)}</a>` : "—")}
				${field("Sales Order", doc.sales_order ? `<a class="link" data-erp="Sales Order|${orEsc(doc.sales_order)}">${orEsc(doc.sales_order)}</a>` : "—")}
				${field("Marketplace PO", orEsc(doc.marketplace_po_no || "—"))}
				${field("Item", orEsc(doc.item_code))}
				${field("Marketplace SKU", orEsc(doc.marketplace_sku || "—"))}
				${field("Import batch", orEsc(doc.import_batch || "—"))}
				${field("Net secondary rate", orInr(doc.net_secondary_rate))}
				${field("Variance per unit", orInr(doc.variance_per_unit))}
				${field("Note", doc.sales_invoice ? `<a class="link" data-erp="Sales Invoice|${orEsc(doc.sales_invoice)}">${orEsc(doc.sales_invoice)}</a>` : "—")}
				${doc.return_against ? field("Return against", `<a class="link" data-go="order|${orEsc(doc.return_against)}">${orEsc(doc.return_against)}</a>`) : ""}
			</div></div>
			${d.returns.length ? `<div class="card"><div class="card-head"><span class="card-title">${orIcon("ret")} Returns</span></div>
				<table class="t"><tbody>${d.returns.map((r) => `<tr class="click" data-go="order|${orEsc(r.name)}"><td class="strong">${orEsc(r.marketplace_order_id)}</td><td>${orDate(r.sale_date)}</td><td class="num">${orQty(r.qty)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
	}
	onAct(act) {
		if (act !== "return") return;
		const doc = this.data.doc;
		const left = orFlt(doc.qty) - orFlt(doc.returned_qty);
		this.app.modal({
			title: `Secondary Return: ${doc.marketplace_order_id}`,
			fields: [
				{ name: "qty", label: "Return qty", type: "number", reqd: 1, default: left, help: `${orQty(doc.qty)} × ${doc.item_code} sold; ${orQty(left)} can still be returned.` },
				{ name: "return_date", label: "Return date", type: "date", default: this.app.boot.today },
				{ name: "marketplace_return_id", label: "Marketplace return ID", type: "text", help: "Left blank: the order ID with -R1, -R2 …" },
			],
			primary: "Record return",
			onSubmit: async (v) => {
				const name = await this.api("record_secondary_return", { or_secondary_sales_order: doc.name, ...v });
				this.app.toast(`Secondary Return ${name} recorded`);
				this.render((this.app.token = Symbol()));
			},
		});
	}
}

// ------------------------------------------------------------------ item mapping

class MappingView extends OrView {
	constructor(app) {
		super(app);
		this.filters = { marketplace: "", search: "" };
	}
	async render(token) {
		const rows = (this.rows = await this.api("mappings", this.filters));
		if (this.app.stale(token)) return;
		this.main.innerHTML = `
			${this.head("Item <span>Mapping</span>", "Each marketplace SKU and the item it is, with your primary rate. Imports match on the SKU.",
				`<button class="btn white" data-act="add">${orIcon("plus")} Add mapping</button>`)}
			<div class="filters">
				<label class="search">${orIcon("search")}<input data-f="search" placeholder="SKU, item code or name" value="${orEsc(this.filters.search)}"></label>
				${this.selectHtml("marketplace", this.marketplaceOptions(), this.filters.marketplace)}
			</div>
			<div class="card">
				${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Marketplace</th><th>Marketplace SKU</th><th>Item</th><th class="num">Primary rate</th><th></th></tr></thead>
					<tbody>${rows.map((r) => `<tr><td>${orPill(r.marketplace, "lime")}</td><td class="strong">${orEsc(r.marketplace_sku)}</td>
						<td>${orEsc(r.item_code)}<span class="sub">${orEsc(r.item_name || "")}</span></td><td class="num">${orInr(r.primary_rate)}</td>
						<td class="num nowrap"><button class="round sm" data-act="edit" data-n="${orEsc(r.name)}" title="Edit">${orIcon("edit")}</button>
						<button class="round sm" data-act="del" data-n="${orEsc(r.name)}" title="Delete">${orIcon("trash")}</button></td></tr>`).join("")}</tbody></table></div>`
				: `<div class="empty">No mappings yet.</div>`}
			</div>`;
		const s = this.$("[data-f=search]");
		let t;
		s.addEventListener("input", () => {
			clearTimeout(t);
			t = setTimeout(async () => {
				this.filters.search = s.value.trim();
				const pos = s.selectionStart;
				await this.render((this.app.token = Symbol()));
				const n = this.$("[data-f=search]");
				n.focus();
				n.setSelectionRange(pos, pos);
			}, 300);
		});
		this.$("[data-f=marketplace]").addEventListener("change", (e) => {
			this.filters.marketplace = e.target.value;
			this.render((this.app.token = Symbol()));
		});
	}
	async onAct(act, el) {
		const row = this.rows.find((r) => r.name === el.dataset.n) || {};
		if (act === "add" || act === "edit") {
			this.app.modal({
				title: act === "add" ? "Add item mapping" : "Edit item mapping",
				fields: [
					{ name: "marketplace", label: "Marketplace", type: "select", reqd: 1, default: row.marketplace || this.filters.marketplace, options: this.app.boot.marketplaces },
					{ name: "marketplace_sku", label: "Marketplace SKU", type: "text", reqd: 1, default: row.marketplace_sku },
					{ name: "item_code", label: "Item", type: "link", doctype: "Item", reqd: 1, default: row.item_code },
					{ name: "primary_rate", label: "Primary rate (your rate to the marketplace)", type: "number", reqd: 1, default: row.primary_rate },
				],
				onSubmit: async (v) => {
					await this.api("save_mapping", { data: { ...v, name: row.name } });
					this.app.toast("Mapping saved");
					this.render((this.app.token = Symbol()));
				},
			});
		} else if (act === "del") {
			if (!(await this.app.confirm("Delete mapping", `Delete ${row.marketplace} SKU ${row.marketplace_sku}?`, "Delete"))) return;
			try {
				await this.api("delete_record", { doctype: "OR Item Mapping", name: row.name });
				this.app.toast("Mapping deleted");
				this.render((this.app.token = Symbol()));
			} catch (err) {
				this.app.toast(err.message, "error");
			}
		}
	}
}

// ------------------------------------------------------------------ reports


const OR_REPORT_COLS = [
	["record", "Record", "text"], ["marketplace", "Marketplace", "text"], ["po_no", "PO", "text", null, true], ["status", "Status", "status"],
	["item_code", "Item", "text"], ["dispatched", "Dispatched", "qty", "sum"], ["received", "Received", "qty", "sum"],
	["in_transit", "In transit", "qty", "sum"], ["sold", "Sold", "qty", "sum"], ["secondary_returned", "Cust. returns", "qty", "sum"],
	["return_dispatched", "Returned to you", "qty", "sum", true], ["held", "Held", "qty", "sum"], ["primary_rate", "Your rate", "money", "avg", true],
	["held_value", "Held value", "money", "sum"], ["secondary_value", "Secondary value", "money", "sum"],
	["range_value", "Sales in date range", "money", "sum", true], ["range_units", "Units in date range", "qty", "sum", true],
	["commission", "Commission", "money", "sum", true], ["net_variance", "Net variance", "money", "sum"],
	["sell_through", "Sell-through", "pct", "sellthrough"], ["pending_dispatch", "Unconfirmed", "qty", "sum", true],
	["last_sale", "Last sale", "date", "max"], ["oldest_age", "Oldest stock (days)", "qty", "max"],
];
const OR_REPORT_GROUPS = [["marketplace", "Marketplace"], ["record", "Record"], ["item_code", "Item"], ["status", "Status"]];
const OR_FOCUS = {
	pending_dispatch: ["Dispatches not confirmed", (r) => r.pending_dispatch > 0],
	return_initiated: ["Returns initiated", (r) => r.returns_initiated > 0],
	return_transit: ["Returns on the way back", (r) => r.returns_transit > 0],
	variance: ["Variance without a note", (r) => r.uninvoiced_lines > 0],
	draft_notes: ["Draft notes", (r) => r.draft_lines > 0],
	held: ["Holding stock", (r) => r.held > 0],
};

class ReportsView extends OrView {
	constructor(app) {
		super(app);
		let saved = {};
		try {
			saved = JSON.parse(localStorage.getItem("or_report_v2") || "{}");
		} catch (e) {
			saved = {};
		}
		const preset = app._reportPreset || {};
		app._reportPreset = null;
		this.s = Object.assign(
			{ marketplace: "", from: "", to: "", closed: 0, search: "", group: "", sort: null, hidden: {}, chart: true, metric: "held", drill: {}, focus: "" },
			saved,
			{ drill: {}, focus: "", sort: saved.sort || null },
			preset
		);
		this.expanded = new Set();
		this.openRows = new Set();
		this.limit = 200;
	}
	save() {
		const { group, hidden, chart, metric, closed } = this.s;
		try {
			localStorage.setItem("or_report_v2", JSON.stringify({ group, hidden, chart, metric, closed }));
		} catch (e) {
			/* ignore */
		}
	}
	cols() {
		return OR_REPORT_COLS
			.map(([key, label, type, agg, hide]) => ({ key, label, type, agg, hide: this.s.hidden[key] ?? !!hide }))
			.filter((c) => !c.hide);
	}
	async render(token) {
		this.main.innerHTML = this.shell();
		this.bind();
		await this.load(token);
	}
	async load(token) {
		this.$(".rx-body").innerHTML = '<div class="spin"></div>';
		const args = { marketplace: this.s.marketplace, include_closed: this.s.closed };
		const dated = { ...args, from_date: this.s.from, to_date: this.s.to };
		const [positions, lines, movements] = await Promise.all([
			this.api("or_model.marketplace_or.insights.report_data", { dataset: "positions", ...args }),
			this.api("or_model.marketplace_or.insights.report_data", { dataset: "lines", ...dated }),
			this.api("or_model.marketplace_or.insights.report_data", { dataset: "movements", ...args }),
		]);
		if (token && this.app.stale(token)) return;
		const key = (r) => r.record + "\u0000" + r.item_code;
		this.lines = {};
		this.moves = {};
		lines.forEach((l) => (this.lines[key(l)] = this.lines[key(l)] || []).push(l));
		movements.forEach((m) => (this.moves[key(m)] = this.moves[key(m)] || []).push(m));
		this.rows = positions.map((p) => {
			const ls = this.lines[key(p)] || [];
			const ms = this.moves[key(p)] || [];
			return Object.assign(p, {
				range_value: Math.round(ls.reduce((a, l) => a + (l.qty > 0 ? l.value : 0), 0) * 100) / 100,
				range_units: ls.reduce((a, l) => a + (l.qty > 0 ? l.qty : 0), 0),
				pending_dispatch: ms.filter((m) => m.type === "Primary Sale").reduce((a, m) => a + (m.pending || 0), 0),
				returns_initiated: ms.filter((m) => m.status === "Return Initiated").length,
				returns_transit: ms.filter((m) => ["Return Dispatched", "Partially Received"].includes(m.status) && m.type === "Primary Return").length,
				uninvoiced_lines: ls.filter((l) => l.note_status === "Not created").length,
				draft_lines: ls.filter((l) => l.note_status === "Draft").length,
				_key: key(p),
			});
		});
		this.draw();
	}
	shell() {
		const groupOpts = [{ value: "", label: "No grouping" }, ...OR_REPORT_GROUPS.map(([g, l]) => ({ value: g, label: "Group by " + l }))];
		return `
			${this.head("OR <span>Report</span>", "Everything in one place: stock per record and item, with its dispatches, returns and secondary sales. Click a row to see its details.",
				`<button class="btn" data-act="csv">${orIcon("download")} Export Excel</button>`)}
			<div class="filters">
				<label class="search">${orIcon("search")}<input data-f="search" placeholder="Search record, PO, item, marketplace…" value="${orEsc(this.s.search)}"></label>
				${this.selectHtml("marketplace", this.marketplaceOptions(), this.s.marketplace)}
				${this.dateHtml("from", this.s.from, "Sales from")}
				${this.dateHtml("to", this.s.to, "Sales to")}
				${this.selectHtml("group", groupOpts, this.s.group)}
				${this.selectHtml("focus", [{ value: "", label: "Show all rows" }, ...Object.entries(OR_FOCUS).map(([k, [l]]) => ({ value: k, label: "Only: " + l }))], this.s.focus)}
				<label class="toggle small"><input type="checkbox" data-f="closed" ${this.s.closed ? "checked" : ""}><span class="sw"></span><span>Include closed</span></label>
				<div class="menu-wrap"><button class="btn sm" data-menu=".col-menu">${orIcon("grid")} Columns</button><div class="menu col-menu"></div></div>
				<button class="btn sm ${this.s.chart ? "white" : ""}" data-act="chart">${orIcon("chart")} Chart</button>
			</div>
			<div class="drills"></div>
			<div class="rx-summary rx-sections"></div>
			<div class="card rx-chart ${this.s.chart ? "" : "hide"}"></div>
			<div class="card rx-body"></div>`;
	}
	bind() {
		const s = this.$("[data-f=search]");
		let t;
		s.addEventListener("input", () => {
			clearTimeout(t);
			t = setTimeout(() => {
				this.s.search = s.value.trim();
				this.draw();
			}, 200);
		});
		const reload = () => this.load((this.app.token = Symbol()));
		this.$("[data-f=marketplace]").addEventListener("change", (e) => {
			this.s.marketplace = e.target.value;
			reload();
		});
		["from", "to"].forEach((f) => this.$(`[data-f=${f}]`).addEventListener("change", (e) => {
			this.s[f] = e.target.value;
			if (this.s.from || this.s.to) this.s.hidden.range_value = false;
			reload();
		}));
		this.$("[data-f=group]").addEventListener("change", (e) => {
			this.s.group = e.target.value;
			this.expanded.clear();
			this.save();
			this.draw();
		});
		this.$("[data-f=focus]").addEventListener("change", (e) => {
			this.s.focus = e.target.value;
			this.draw();
		});
		this.$("[data-f=closed]").addEventListener("change", (e) => {
			this.s.closed = e.target.checked ? 1 : 0;
			this.save();
			reload();
		});
		this.$(".col-menu").addEventListener("change", (e) => {
			const k = e.target.dataset.col;
			if (!k) return;
			this.s.hidden[k] = !e.target.checked;
			this.save();
			this.draw();
		});
	}

	filtered() {
		const q = this.s.search.toLowerCase();
		let rows = this.rows.filter((r) => Object.entries(this.s.drill).every(([k, v]) => String(r[k] ?? "") === String(v)));
		if (this.s.focus && OR_FOCUS[this.s.focus]) rows = rows.filter(OR_FOCUS[this.s.focus][1]);
		if (q) rows = rows.filter((r) => ["record", "marketplace", "po_no", "status", "item_code", "sales_order"].some((k) => String(r[k] ?? "").toLowerCase().includes(q)));
		if (this.s.sort) {
			const { key, dir } = this.s.sort;
			rows = rows.slice().sort((a, b) => {
				const x = a[key], y = b[key];
				if (x == null && y == null) return 0;
				if (x == null) return 1;
				if (y == null) return -1;
				return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
			});
		}
		return rows;
	}

	agg(rows, col) {
		const nums = rows.map((r) => r[col.key]).filter((v) => v != null && v !== "");
		switch (col.agg) {
			case "sum": return nums.reduce((a, v) => a + Number(v), 0);
			case "avg": return nums.length ? nums.reduce((a, v) => a + Number(v), 0) / nums.length : null;
			case "max": return nums.length ? nums.reduce((a, v) => (v > a ? v : a)) : null;
			case "sellthrough": {
				const rec = rows.reduce((a, r) => a + (r.received || 0), 0);
				const sold = rows.reduce((a, r) => a + (r.sold_net || 0), 0);
				return rec ? Math.round((sold / rec) * 1000) / 10 : 0;
			}
			default: return null;
		}
	}

	fmt(col, v, row) {
		if (v == null || v === "") return '<span class="faint">—</span>';
		switch (col.type) {
			case "money": return `<span class="${col.key.includes("variance") ? (v < 0 ? "neg" : v > 0 ? "pos" : "") : ""}">${orInr(v)}</span>`;
			case "qty": return orQty(v);
			case "pct": return `<div class="bar-cell lime mini"><i style="width:${Math.min(v, 100)}%"></i><span>${v}%</span></div>`;
			case "date": return orDate(v);
			case "status": return row ? `<a class="drill" data-act="drill-bar" data-k="${col.key}" data-v="${orEsc(v)}">${orPill(v)}</a>` : orPill(v);
			default:
				if (row && ["marketplace", "item_code", "record", "po_no"].includes(col.key)) {
					return `<a class="drill" data-act="drill-bar" data-k="${col.key}" data-v="${orEsc(v)}" title="Filter by ${orEsc(v)}">${col.key === "marketplace" ? orPill(v, "lime") : orEsc(v)}</a>`;
				}
				return orEsc(v);
		}
	}

	detailHtml(r, span) {
		const ms = this.moves[r._key] || [];
		const ls = (this.lines[r._key] || []).slice().reverse();
		const movesTable = ms.length
			? `<table class="t compact"><thead><tr><th>Date</th><th>Type</th><th>Status</th><th class="num">Qty</th><th class="num">Received</th><th class="num">Pending</th><th>Reference</th></tr></thead><tbody>
				${ms.map((m) => `<tr><td>${orDate(m.date)}</td><td>${orPill(m.type)}</td><td>${orPill(m.status)}</td><td class="num">${orQty(m.qty)}</td><td class="num">${orQty(m.received)}</td>
				<td class="num">${m.pending ? `<b class="neg">${orQty(m.pending)}</b>${m.age != null ? `<span class="sub">${m.age} days</span>` : ""}` : "0"}</td><td>${orEsc(m.reference || "")}${m.awb_no ? `<span class="sub">AWB ${orEsc(m.awb_no)}</span>` : ""}</td></tr>`).join("")}</tbody></table>`
			: `<div class="empty">No dispatches yet.</div>`;
		const linesTable = ls.length
			? `<table class="t compact"><thead><tr><th>Date</th><th>Order</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Realisation</th><th class="num">Variance</th><th>Note</th></tr></thead><tbody>
				${ls.slice(0, 40).map((l) => `<tr class="click" data-go="order|${orEsc(l.name)}"><td>${orDate(l.sale_date)}</td><td>${orEsc(l.order_id)}${l.qty < 0 ? `<span class="sub">return</span>` : ""}</td>
				<td class="num">${orQty(l.qty)}</td><td class="num">${orInr(l.selling_rate)}</td>
				<td class="num ${l.realisation >= 100 ? "pos" : "neg"}">${l.realisation == null ? "—" : l.realisation + "%"}</td>
				<td class="num ${l.variance < 0 ? "neg" : "pos"}">${orInr(l.variance)}</td><td>${orPill(l.note_status)}</td></tr>`).join("")}</tbody></table>
				${ls.length > 40 ? `<div class="hint">Showing the latest 40 of ${ls.length} lines.</div>` : ""}`
			: `<div class="empty">No secondary sales${this.s.from || this.s.to ? " in this date range" : ""}.</div>`;
		return `<tr class="detail-row"><td colspan="${span}">
			<div class="detail-grid">
				<div><h4>Dispatches &amp; returns</h4>${movesTable}</div>
				<div><h4>Secondary sales</h4>${linesTable}</div>
			</div>
			<div class="actions" style="margin-top:12px">
				<button class="btn sm white" data-go="tracker|${orEsc(r.record)}">${orIcon("out")} Open ${orEsc(r.record)}</button>
				<span class="muted small">${orEsc(r.marketplace)} · PO ${orEsc(r.po_no || "—")} · Sales Order ${orEsc(r.sales_order || "")} · your rate ${orInr(r.primary_rate)}</span>
			</div></td></tr>`;
	}

	// Summary cards in four sections, over the rows shown (filters, search and focus apply).
	summaryHtml(rows) {
		const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
		const records = [...new Map(rows.map((r) => [r.record, r])).values()];
		const perRecord = (k) => records.reduce((a, r) => a + (r[k] || 0), 0); // notes belong to a record, not an item
		const received = sum("received");
		const ranged = this.s.from || this.s.to;
		const variance = sum("net_variance");
		const debit = perRecord("rec_debit_notes");
		const credit = perRecord("rec_credit_notes");
		const sign = (v) => (v < 0 ? "red" : v > 0 ? "lime" : "");
		// compact: each group is one grid row (3-4 tiles), the headline figure sits on one line
		const tile = (label, value, cls = "", title = label) =>
			`<div class="rx-tile" title="${orEsc(title)}"><div class="k">${orEsc(label)}</div><div class="v ${cls}">${orEsc(value)}</div></div>`;
		const group = (label, cols, tiles) =>
			`${label ? `<div class="rx-sub">${orEsc(label)}</div>` : ""}<div class="rx-tiles" style="--cols:${cols}">${tiles.join("")}</div>`;
		const hero = (label, value, cls) =>
			`<div class="rx-hero"><span class="k">${orEsc(label)}</span><span class="v ${cls}">${orEsc(value)}</span></div>`;
		const section = (tone, title, hint, body) => `
			<div class="rx-sec ${tone}">
				<div class="rx-sec-head"><span class="rx-sec-title">${orEsc(title)}</span><span class="rx-sec-hint">${orEsc(hint)}</span></div>
				<div class="rx-sec-body">${body}</div>
			</div>`;
		const orange = (k) => (sum(k) ? "orange" : "");
		return [
			section("cyan", "Primary Sale & Return", "You ↔ marketplace",
				group("Primary Sale", 3, [
					tile("Dispatched", orQty(sum("dispatched"))),
					tile("Received", orQty(received), "", "Received by marketplace"),
					tile("In transit", orQty(sum("in_transit")), orange("in_transit")),
					tile("Unconfirmed", orQty(sum("pending_dispatch")), sum("pending_dispatch") ? "red" : "", "Dispatches the marketplace has not confirmed"),
					tile("Sales value", orCompact(sum("primary_value")), "", "Primary sales value"),
					tile("Records", orQty(records.length)),
				]) +
				group("Primary Return", 4, [
					tile("Initiated", orQty(sum("return_initiated"))),
					tile("Pending", orQty(sum("return_pending")), orange("return_pending"), "Initiated, not yet dispatched"),
					tile("In transit", orQty(sum("return_in_transit")), orange("return_in_transit")),
					tile("Received", orQty(sum("return_received")), "", "Received back"),
				])),
			section("green", "Secondary Sale & Return", "Marketplace ↔ customers",
				group("Secondary Sale", 4, [
					tile("Sold", orQty(sum("sold"))),
					tile(ranged ? "In range" : "Sales value", orCompact(ranged ? sum("range_value") : sum("secondary_value")), "lav",
						ranged ? "Sales in date range" : "Secondary sales value"),
					tile("Commission", orCompact(sum("commission")), "", "Marketplace commission"),
					tile("Sell-through", received ? Math.round((sum("sold_net") / received) * 1000) / 10 + "%" : "—"),
				]) +
				group("Secondary Return", 4, [
					tile("Returns", orQty(sum("secondary_returned")), "", "Customer returns"),
					tile("Net sold", orQty(sum("sold_net"))),
				])),
			section("lime", "Stock at Marketplace", "Held by marketplaces now",
				hero("Stock at marketplace", orQty(sum("held")) + " units", "lime") +
				group("", 4, [
					tile("Held value", orCompact(sum("held_value"))),
					tile("Oldest", rows.length ? Math.max(...rows.map((r) => r.oldest_age || 0)) + " days" : "—", "", "Oldest stock"),
					tile("Received", orQty(received), "", "Received by marketplace"),
					tile("Returned", orQty(sum("return_dispatched")), "", "Returned to you"),
				])),
			section("lav", "Price Variance & Notes", "Debit / credit notes",
				hero("Net price variance", orInr(variance, 0), sign(variance)) +
				group("", 3, [
					tile("Debit notes", orCompact(debit), "", "Debit notes submitted"),
					tile("Credit notes", orCompact(credit), "", "Credit notes submitted"),
					tile("Net adjust.", orCompact(debit - credit), sign(debit - credit), "Net adjustment"),
				])),
		].join("");
	}

	draw() {
		const cols = this.cols();
		const rows = this.filtered();
		this.visible = rows;
		const numeric = (c) => ["qty", "money", "pct"].includes(c.type);
		const span = cols.length + 1;

		this.$(".col-menu").innerHTML = OR_REPORT_COLS.map(([key, label, , , hide]) => {
			const hidden = this.s.hidden[key] ?? !!hide;
			return `<label class="col-opt"><input type="checkbox" data-col="${key}" ${hidden ? "" : "checked"}> ${orEsc(label)}</label>`;
		}).join("");

		const chips = Object.entries(this.s.drill).map(([k, v]) => `<button class="chip on" data-act="undrill" data-k="${k}">${orEsc((OR_REPORT_COLS.find((c) => c[0] === k) || [k, k])[1])}: ${orEsc(v)} ✕</button>`);
		if (this.s.focus && OR_FOCUS[this.s.focus]) chips.unshift(`<button class="chip focus-chip" data-act="unfocus">${orEsc(OR_FOCUS[this.s.focus][0])} ✕</button>`);
		this.$(".drills").innerHTML = chips.length ? `<span class="muted small">Filtered by</span> ${chips.join("")}<button class="chip" data-act="undrill-all">Clear all</button>` : "";

		this.$(".rx-summary").innerHTML = this.summaryHtml(rows);

		this.drawChart(rows);

		if (!rows.length) {
			this.$(".rx-body").innerHTML = `<div class="empty">No rows match these filters.</div>`;
			return;
		}
		const mark = (c) => (this.s.sort && this.s.sort.key === c.key ? (this.s.sort.dir > 0 ? " ▲" : " ▼") : "");
		const head = `<tr><th style="width:28px"></th>${cols.map((c) => `<th class="${numeric(c) ? "num" : ""} sortable" data-act="sort" data-k="${c.key}">${orEsc(c.label)}${mark(c)}</th>`).join("")}</tr>`;
		const rowHtml = (r, i) => {
			const open = this.openRows.has(r._key);
			return `<tr class="click ${open ? "open-row" : ""}" data-act="row" data-i="${i}"><td class="caret">${open ? "▾" : "▸"}</td>${cols.map((c) => `<td class="${numeric(c) ? "num" : ""}">${this.fmt(c, r[c.key], r)}</td>`).join("")}</tr>${open ? this.detailHtml(r, span) : ""}`;
		};
		let body = "";
		if (this.s.group) {
			const groups = new Map();
			rows.forEach((r, i) => {
				const g = r[this.s.group] ?? "(blank)";
				if (!groups.has(g)) groups.set(g, []);
				groups.get(g).push([r, i]);
			});
			const ordered = [...groups.entries()];
			const sortCol = this.s.sort && cols.find((c) => c.key === this.s.sort.key && c.agg);
			if (sortCol) ordered.sort((a, b) => ((this.agg(a[1].map((x) => x[0]), sortCol) || 0) - (this.agg(b[1].map((x) => x[0]), sortCol) || 0)) * this.s.sort.dir);
			ordered.forEach(([g, items]) => {
				const open = this.expanded.has(String(g));
				const gr = items.map((x) => x[0]);
				body += `<tr class="grp" data-act="toggle" data-g="${orEsc(g)}"><td class="caret">${open ? "▾" : "▸"}</td>${cols.map((c, ci) => {
					if (ci === 0) return `<td class="strong">${orEsc(g)} <span class="faint small">· ${items.length}</span></td>`;
					if (c.key === this.s.group) return "<td></td>";
					const v = c.agg ? this.agg(gr, c) : null;
					return `<td class="${numeric(c) ? "num" : ""} strong">${v == null ? "" : this.fmt(c, Math.round(v * 100) / 100)}</td>`;
				}).join("")}</tr>`;
				if (open) body += items.slice(0, 300).map(([r, i]) => rowHtml(r, i)).join("");
			});
		} else {
			body = rows.slice(0, this.limit).map((r, i) => rowHtml(r, i)).join("");
		}
		const foot = `<tr><td></td>${cols.map((c, ci) => {
			if (ci === 0) return `<td>Total</td>`;
			const v = c.agg && c.agg !== "max" && c.agg !== "avg" ? this.agg(rows, c) : null;
			return `<td class="${numeric(c) ? "num" : ""}">${v == null ? "" : this.fmt(c, Math.round(v * 100) / 100)}</td>`;
		}).join("")}</tr>`;
		this.$(".rx-body").innerHTML = `<div class="table-wrap rx-table"><table class="t"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>
			${!this.s.group && rows.length > this.limit ? `<div class="more-row"><button class="btn sm" data-act="more">Show more (${rows.length - this.limit} left)</button></div>` : ""}`;
	}

	drawChart(rows) {
		const box = this.$(".rx-chart");
		if (!this.s.chart) return;
		const metrics = OR_REPORT_COLS.filter((c) => c[3] === "sum").map((c) => ({ key: c[0], label: c[1], type: c[2] }));
		const col = metrics.find((c) => c.key === this.s.metric) || metrics.find((c) => c.key === "held");
		const dim = this.s.group || "marketplace";
		const totals = new Map();
		rows.forEach((r) => {
			const g = r[dim] ?? "(blank)";
			totals.set(g, (totals.get(g) || 0) + (Number(r[col.key]) || 0));
		});
		const data = [...totals.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12);
		const max = Math.max(...data.map((d) => Math.abs(d[1])), 1);
		const dimLabel = (OR_REPORT_GROUPS.find((g) => g[0] === dim) || [dim, dim])[1];
		box.innerHTML = `<div class="card-head"><span class="card-title">${orIcon("chart")} ${orEsc(col.label)} by ${orEsc(dimLabel.toLowerCase())}</span>
			<select class="inp sm" data-f="metric" style="width:auto">${metrics.map((c) => `<option value="${c.key}" ${c.key === col.key ? "selected" : ""}>${orEsc(c.label)}</option>`).join("")}</select></div>
			${data.length ? `<div class="hbars">${data.map(([g, v]) => `<a class="hbar" data-act="drill-bar" data-k="${dim}" data-v="${orEsc(g)}" title="Click to filter by ${orEsc(g)}">
				<span class="hb-label">${orEsc(g)}</span><span class="hb-track"><i class="${v < 0 ? "neg" : ""}" style="width:${(Math.abs(v) / max) * 100}%"></i></span>
				<span class="hb-val">${col.type === "money" ? orCompact(v) : orQty(v)}</span></a>`).join("")}</div>
				<div class="hint">Click a bar to filter the table. Group the table to chart by record, item or status.</div>` : `<div class="empty">Nothing to chart.</div>`}`;
		box.querySelector("[data-f=metric]").addEventListener("change", (e) => {
			this.s.metric = e.target.value;
			this.save();
			this.drawChart(this.visible);
		});
	}

	onAct(act, el) {
		if (act === "sort") {
			const k = el.dataset.k;
			this.s.sort = this.s.sort && this.s.sort.key === k ? (this.s.sort.dir === 1 ? { key: k, dir: -1 } : null) : { key: k, dir: 1 };
			return this.draw();
		}
		if (act === "row") {
			const r = this.visible[+el.dataset.i];
			if (!r) return;
			this.openRows.has(r._key) ? this.openRows.delete(r._key) : this.openRows.add(r._key);
			return this.draw();
		}
		if (act === "toggle") {
			const g = el.dataset.g;
			this.expanded.has(g) ? this.expanded.delete(g) : this.expanded.add(g);
			return this.draw();
		}
		if (act === "drill-bar") {
			this.s.drill[el.dataset.k] = el.dataset.v;
			return this.draw();
		}
		if (act === "undrill") {
			delete this.s.drill[el.dataset.k];
			return this.draw();
		}
		if (act === "unfocus") {
			this.s.focus = "";
			this.$("[data-f=focus]").value = "";
			return this.draw();
		}
		if (act === "undrill-all") {
			this.s.drill = {};
			this.s.focus = "";
			this.$("[data-f=focus]").value = "";
			return this.draw();
		}
		if (act === "chart") {
			this.s.chart = !this.s.chart;
			this.save();
			el.classList.toggle("white", this.s.chart);
			this.$(".rx-chart").classList.toggle("hide", !this.s.chart);
			return this.drawChart(this.visible);
		}
		if (act === "more") {
			this.limit += 200;
			return this.draw();
		}
		if (act === "csv") {
			const cols = this.cols();
			const rows = this.visible.map((r) => cols.map((c) => (typeof r[c.key] === "number" || typeof r[c.key] === "string" ? r[c.key] : r[c.key] == null ? "" : String(r[c.key]))));
			orDownload(orXlsx("OR Report", cols.map((c) => c.label), rows), `OR Report ${frappe.datetime.get_today()}.xlsx`);
			this.app.toast(`Downloaded ${rows.length} row${rows.length === 1 ? "" : "s"} to Excel.`);
		}
	}
}

// ------------------------------------------------------------------ setup

/** Marketplace OR Account fields: [name, label, dialog type, doctype, filters]; no type = edited in the grid. */
const OR_ACCOUNT_FIELDS = [
	["marketplace"], ["customer"], ["debit_note_series"], ["credit_note_series"], ["cost_center"],
	["provision_account", "OR Sale Provision account (liability)", "link", "Account", { root_type: "Liability" }],
	["variance_account", "OR Sales Variance account (expense)", "link", "Account", { root_type: "Expense" }],
];

class SetupView extends OrView {
	async render(token) {
		const d = (this.data = await this.api("setup_data"));
		if (this.app.stale(token)) return;
		const s = d.settings;
		this.tables = s
			? {
					customer_marketplaces: (s.customer_marketplaces || []).map((r) => ({ customer: r.customer, marketplace: r.marketplace })),
					commissions: (s.commissions || []).map((r) => ({ marketplace: r.marketplace, commission_percent: r.commission_percent })),
					accounts: (s.accounts || []).map((r) => Object.fromEntries(OR_ACCOUNT_FIELDS.map(([f]) => [f, r[f]]))),
			  }
			: null;
		const canSet = this.app.boot.can_setup;
		this.main.innerHTML = `
			${this.head("OR <span>Settings</span>", "Marketplaces and how price-variance notes are created and approved.")}
			<div>
				<div class="card">
					<div class="card-head"><span class="card-title">${orIcon("globe")} Marketplaces</span>${canSet ? `<button class="btn sm" data-act="mp-add">${orIcon("plus")} Add</button>` : ""}</div>
					<table class="t"><thead><tr><th>Marketplace</th><th>Abbreviation</th><th></th></tr></thead><tbody>
					${d.marketplaces.map((m) => `<tr><td class="strong">${orEsc(m.name)}</td><td>${orEsc(m.abbreviation)}</td>
						<td class="num">${canSet ? `<button class="round sm" data-act="mp-edit" data-n="${orEsc(m.name)}">${orIcon("edit")}</button>` : ""}</td></tr>`).join("")}
					</tbody></table>
				</div>
			</div>
			${s ? `<div class="card" style="margin-top:12px">
				<div class="card-head"><span class="card-title">${orIcon("file")} OR settings</span>${canSet ? `<button class="btn white" data-act="save-settings">${orIcon("check")} Save settings</button>` : ""}</div>
				<div class="form-grid settings-form">
					${this.app.fieldHtml({ name: "group_notes_by", label: "Group notes by", type: "select", options: d.options.group_notes_by, default: s.group_notes_by })}
					${this.app.fieldHtml({ name: "approver_role", label: "Role that approves notes", type: "link", doctype: "Role", default: s.approver_role })}
					${this.app.fieldHtml({ name: "auto_create_notes", label: "Create draft notes after each import", type: "check", default: s.auto_create_notes })}
					${this.app.fieldHtml({ name: "auto_submit_notes", label: "Submit notes automatically", type: "check", default: s.auto_submit_notes })}
				</div>
				<h4 class="muted small" style="margin:22px 0 8px">CUSTOMER ↔ MARKETPLACE</h4>
				<div data-table="customer_marketplaces"></div>
				<h4 class="muted small" style="margin:22px 0 8px">MARKETPLACE COMMISSION</h4>
				<div data-table="commissions"></div>
				<h4 class="muted small" style="margin:22px 0 8px">MARKETPLACE ACCOUNTS (billing customer, note series, cost center)</h4>
				<div data-table="accounts"></div>
			</div>
			<div class="card" style="margin-top:12px">
				<div class="card-head"><span class="card-title">${orIcon("swap")} OR ledgers</span></div>
				<div class="hint" style="margin:-4px 0 12px">The primary sale is a normal sale (Delivery Note and Sales Invoice); the marketplace's stock and secondary sales are virtual. Only the price variance posts: sales below the primary rate book OR Sales Variance Dr / OR Sale Provision Cr at import, cleared by the month-end Credit Note; sales above it are billed by a Debit Note to OR Sales Variance. “Set up masters” creates the missing ledgers.</div>
				<div class="table-wrap"><table class="t"><thead><tr><th>Marketplace</th><th>Billing customer</th><th>OR Sale Provision</th><th>OR Sales Variance</th><th></th></tr></thead><tbody>
				${this.tables.accounts.map((r, i) => `<tr><td class="strong">${orEsc(r.marketplace || "")}</td>
					<td>${orEsc(r.customer || "—")}</td>
					<td class="small">${orEsc(r.provision_account || "—")}</td>
					<td class="small">${orEsc(r.variance_account || "—")}</td>
					<td class="num nowrap">${canSet && r.marketplace ? `<button class="btn sm" data-act="acc-edit" data-i="${i}">${orIcon("edit")} Edit</button>
						<button class="btn sm" data-act="acc-masters" data-i="${i}">Set up masters</button>` : ""}</td></tr>`).join("")
					|| `<tr><td colspan="5" class="empty">Add a row under Marketplace Accounts first.</td></tr>`}
				</tbody></table></div>
			</div>` : ""}
			${this.formatsHtml(canSet)}`;
		if (s) {
			this.app.wireFields(this.$(".settings-form"), [{ name: "approver_role", doctype: "Role" }]);
			this.renderTables();
		}
	}
	/** "Secondary sales import formats": how each marketplace's sales report is read. */
	formatsHtml(canSet) {
		const formats = this.app.boot.import_formats || {};
		const mps = this.app.boot.marketplaces;
		return `<div class="card" style="margin-top:12px">
			<div class="card-head"><span class="card-title">${orIcon("upload")} Secondary sales import formats</span></div>
			<div class="hint" style="margin:-4px 0 12px">Each marketplace's sales report has its own columns. Set which column holds each value; Import sales then reads that marketplace's file this way. Without a format the standard columns are used.</div>
			<div class="table-wrap"><table class="t"><thead><tr><th>Marketplace</th><th>Order ID</th><th>Sale date</th><th>SKU</th><th>Quantity</th><th>Selling price</th><th>Matching</th><th>Format</th><th></th></tr></thead><tbody>
			${mps.map((mp) => {
				const f = formats[mp] || {};
				return `<tr><td class="strong">${orEsc(mp)}</td>
					<td>${orEsc(f.order_id_column)}</td>
					<td>${orEsc(f.sale_date_column)}<span class="sub">${orEsc(f.date_format || "Auto")}</span></td>
					<td>${orEsc(f.sku_column)}</td><td>${orEsc(f.qty_column)}</td>
					<td>${orEsc(f.price_column)}<span class="sub">${orEsc(f.price_type || "Unit price")}</span></td>
					<td>${f.po_column ? `By PO (${orEsc(f.po_column)})` : "Oldest record first"}${f.filter_column && f.filter_values ? `<span class="sub">only ${orEsc(f.filter_column)} = ${orEsc(f.filter_values)}</span>` : ""}${f.payout_column ? `<span class="sub">payout: ${orEsc(f.payout_column)}</span>` : ""}${f.type_column && f.return_values ? `<span class="sub">returns: ${orEsc(f.type_column)} = ${orEsc(f.return_values)}</span>` : ""}</td>
					<td>${f.configured ? orPill("Custom", "lime") : orPill("Standard", "grey")}</td>
					<td class="num nowrap">${canSet ? `<button class="btn sm" data-act="fmt-edit" data-mp="${orEsc(mp)}">${orIcon("edit")} Edit format</button>` : ""}</td></tr>`;
			}).join("")}
			</tbody></table></div></div>`;
	}
	formatDialog(mp) {
		const app = this.app;
		const f = (app.boot.import_formats || {})[mp] || {};
		app.modal({
			title: `${mp} import format`,
			wide: true,
			body: `<div class="note">Type the column headings exactly as they appear in ${orEsc(mp)}'s sales report (upper / lower case and extra spaces don't matter).</div>`,
			fields: [
				{ name: "header_row", label: "Headings are in row", type: "number", reqd: 1, default: f.header_row || 1, help: "1 = the first row. Use a higher number when the report has title lines above the headings." },
				{ name: "order_id_column", label: "Order ID column", type: "text", reqd: 1, default: f.order_id_column, placeholder: "e.g. Order No",
					help: "Several columns can be joined with + (e.g. order_group_id + sku_code) when one column is not unique per line." },
				{ name: "sale_date_column", label: "Sale date column", type: "text", reqd: 1, default: f.sale_date_column, placeholder: "e.g. Order Date" },
				{ name: "date_format", label: "Dates are written as", type: "select", default: f.date_format || "Auto",
					options: ["Auto", "YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MMM-YYYY", "DD MMM YYYY"],
					help: "Auto reads 2026-10-05, 05-10-2026, 05/10/2026 and 05-Oct-2026. Excel date cells always work." },
				{ name: "sku_column", label: "SKU column", type: "text", reqd: 1, default: f.sku_column, placeholder: "e.g. Seller SKU" },
				{ name: "qty_column", label: "Quantity column", type: "text", reqd: 1, default: f.qty_column, placeholder: "e.g. Quantity" },
				{ name: "price_column", label: "Selling price column", type: "text", reqd: 1, default: f.price_column, placeholder: "e.g. Selling Price" },
				{ name: "price_type", label: "Selling price is", type: "select", default: f.price_type || "Unit price", options: ["Unit price", "Line total"],
					help: "Line total: the amount for the whole line; it is divided by the quantity." },
				{ name: "payout_column", label: "Net payout column (optional)", type: "text", default: f.payout_column, placeholder: "e.g. Final Payable",
					help: "What the marketplace pays you, read like the selling price. When set, each line's commission % comes from the file instead of Settings." },
				{ name: "po_column", label: "PO number column (optional)", type: "text", default: f.po_column,
					help: "Lines are matched to the Primary Sales record with this PO. Leave blank to fill the oldest open record that holds the item." },
				{ name: "filter_column", label: "Only import rows where column (optional)", type: "text", default: f.filter_column, placeholder: "e.g. Order Status" },
				{ name: "filter_values", label: "…has one of these values", type: "text", default: f.filter_values, placeholder: "e.g. Delivered, Shipped", help: "Comma separated. Rows with any other value are skipped." },
				{ name: "type_column", label: "Transaction type column (optional)", type: "text", default: f.type_column, placeholder: "e.g. Transaction Type",
					help: "Lines whose value is one of the return values below are customer returns, recorded against the sale with the same Order ID. Lines with a negative quantity are always returns." },
				{ name: "return_values", label: "…return values", type: "text", default: f.return_values, placeholder: "e.g. RETURN" },
				{ name: "return_date_column", label: "Return date column (optional)", type: "text", default: f.return_date_column, placeholder: "e.g. last_modified_on",
					help: "Leave blank to date returns by the sale date column." },
				{ name: "reset", label: "Use the standard columns instead (remove this format)", type: "check", default: 0 },
			],
			primary: "Save format",
			onSubmit: async (v) => {
				const { reset, ...data } = v;
				app.boot.import_formats = await this.api("save_import_format", { marketplace: mp, data, reset });
				app.toast(reset ? `${mp} now uses the standard columns` : `${mp} import format saved`);
				this.render((app.token = Symbol()));
			},
		});
	}
	tableSpec() {
		const mps = this.app.boot.marketplaces;
		return {
			customer_marketplaces: [["customer", "Customer", "link", "Customer"], ["marketplace", "Marketplace", "select", mps]],
			commissions: [["marketplace", "Marketplace", "select", mps], ["commission_percent", "Commission %", "number"]],
			accounts: [
				["marketplace", "Marketplace", "select", mps], ["customer", "Billing customer", "link", "Customer"],
				["debit_note_series", "Debit note series", "text"], ["credit_note_series", "Credit note series", "text"],
				["cost_center", "Cost center", "link", "Cost Center"],
			],
		};
	}
	renderTables() {
		const spec = this.tableSpec();
		const canSet = this.app.boot.can_setup;
		Object.entries(spec).forEach(([table, cols]) => {
			const box = this.$(`[data-table="${table}"]`);
			box.innerHTML = `<div class="table-wrap"><table class="egrid"><thead><tr>${cols.map((c) => `<th>${c[1]}</th>`).join("")}<th></th></tr></thead><tbody>
				${this.tables[table].map((row, i) => `<tr data-i="${i}">${cols.map(([f, , type, opt]) => `<td>${
					type === "select"
						? `<select class="inp sm" data-c="${f}">${["", ...opt].map((o) => `<option ${o === row[f] ? "selected" : ""}>${orEsc(o)}</option>`).join("")}</select>`
						: `<div class="ac-wrap"><input class="inp sm" data-c="${f}" ${type === "link" ? `data-link="${opt}" autocomplete="off"` : ""} ${type === "number" ? 'type="number" step="any"' : ""} value="${orEsc(row[f] == null ? "" : row[f])}"></div>`
				}</td>`).join("")}<td class="x">${canSet ? `<button class="round sm ghost" data-act="row-del" data-t="${table}" data-i="${i}">${orIcon("x")}</button>` : ""}</td></tr>`).join("")}
				</tbody></table></div>${canSet ? `<button class="btn sm" data-act="row-add" data-t="${table}" style="margin-top:8px">${orIcon("plus")} Add row</button>` : ""}`;
			box.querySelectorAll("[data-link]").forEach((inp) => this.app.linkControl(inp, () => ({})));
		});
	}
	collect() {
		Object.keys(this.tables).forEach((table) => {
			this.$$(`[data-table="${table}"] tr[data-i]`).forEach((tr) => {
				const row = this.tables[table][tr.dataset.i];
				tr.querySelectorAll("[data-c]").forEach((el) => (row[el.dataset.c] = el.value));
			});
		});
	}
	async onAct(act, el) {
		const app = this.app;
		const reload = (msg) => {
			if (msg) app.toast(msg);
			return this.render((app.token = Symbol()));
		};
		if (act === "acc-edit") {
			this.collect();
			const row = this.tables.accounts[+el.dataset.i];
			const company = app.boot.company;
			const fields = OR_ACCOUNT_FIELDS.filter(([, , type]) => type).map(([name, label, type, doctype, filters]) => ({
				name, label, type, doctype, default: row[name], filters: type === "link" ? { ...(filters || {}), ...(doctype === "Warehouse" || doctype === "Account" ? { company } : {}) } : undefined,
			}));
			app.modal({
				title: `${row.marketplace}: OR ledgers`,
				wide: true,
				fields,
				primary: "Save",
				onSubmit: async (v) => {
					Object.assign(row, v);
					await this.api("save_settings", { data: { accounts: this.tables.accounts } });
					reload(`${row.marketplace} saved`);
				},
			});
		} else if (act === "acc-masters") {
			this.collect();
			const row = this.tables.accounts[+el.dataset.i];
			app.modal({
				title: `Set up OR masters for ${row.marketplace}`,
				body: `<div class="note">Creates what is missing and fills the empty fields: ledgers “${orEsc(row.marketplace)} OR Sale Provision” (Current Liabilities) and “${orEsc(row.marketplace)} OR Sales Variance” (Indirect Expenses). Fields already set are kept.</div>`,
				fields: [
					{ name: "billing_customer", label: "Billing customer", type: "link", doctype: "Customer", default: row.customer, reqd: 1 },
				],
				primary: "Set up",
				onSubmit: async (v) => {
					await this.api("setup_masters", { marketplace: row.marketplace, ...v });
					reload(`${row.marketplace} OR masters set up`);
				},
			});
		} else if (act === "row-add") {
			this.collect();
			this.tables[el.dataset.t].push({});
			this.renderTables();
		} else if (act === "row-del") {
			this.collect();
			this.tables[el.dataset.t].splice(+el.dataset.i, 1);
			this.renderTables();
		} else if (act === "save-settings") {
			this.collect();
			const form = app.readFields(this.$(".settings-form"), [
				{ name: "group_notes_by" }, { name: "approver_role" }, { name: "auto_create_notes" }, { name: "auto_submit_notes" },
			]);
			try {
				await this.api("save_settings", { data: { ...form, ...this.tables } });
				const b = await this.api("boot");
				app.boot = b;
				reload("Settings saved");
			} catch (err) {
				app.toast(err.message, "error");
			}
		} else if (act === "fmt-edit") {
			this.formatDialog(el.dataset.mp);
		} else if (act === "mp-add" || act === "mp-edit") {
			const mp = this.data.marketplaces.find((m) => m.name === el.dataset.n) || {};
			app.modal({
				title: mp.name ? `Edit ${mp.name}` : "Add marketplace",
				fields: [
					...(mp.name ? [] : [{ name: "marketplace_name", label: "Marketplace", type: "text", reqd: 1 }]),
					{ name: "abbreviation", label: "Abbreviation (1-4 letters, used in tracker names)", type: "text", reqd: 1, default: mp.abbreviation },
				],
				onSubmit: async (v) => {
					await this.api("save_marketplace", { data: { ...v, name: mp.name } });
					app.boot = await this.api("boot");
					reload("Marketplace saved");
				},
			});
		}
	}
}
