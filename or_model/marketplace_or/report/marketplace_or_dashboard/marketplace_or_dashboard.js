frappe.query_reports["Marketplace OR Dashboard"] = {
	filters: [
		{
			fieldname: "marketplace",
			label: __("Marketplace"),
			fieldtype: "Link",
			options: "OR Marketplace",
			// blank = All Marketplaces
			on_change() {
				const report = frappe.query_report;
				if (report.get_filter_value("sales_order") || report.get_filter_value("marketplace_po_no")) {
					report.set_filter_value({ sales_order: "", marketplace_po_no: "" });
				} else {
					report.refresh();
				}
			},
		},
		{
			fieldname: "sales_order",
			label: __("Primary Sales Order"),
			fieldtype: "Link",
			options: "Sales Order",
			get_query: () => ({
				query: "or_model.marketplace_or.api.or_sales_orders",
				filters: { marketplace: frappe.query_report.get_filter_value("marketplace") },
			}),
			on_change() {
				const so = frappe.query_report.get_filter_value("sales_order");
				const sync = (po) => {
					if ((frappe.query_report.get_filter_value("marketplace_po_no") || "") !== (po || "")) {
						frappe.query_report.set_filter_value("marketplace_po_no", po || "");
					} else {
						frappe.query_report.refresh();
					}
				};
				if (!so) return sync("");
				frappe.db
					.get_value("OR Primary Sales Tracker", { sales_order: so }, "marketplace_po_no")
					.then((r) => sync(r.message && r.message.marketplace_po_no));
			},
		},
		{
			fieldname: "marketplace_po_no",
			label: __("Marketplace PO No"),
			fieldtype: "Data",
			on_change() {
				const po = frappe.query_report.get_filter_value("marketplace_po_no");
				const so = frappe.query_report.get_filter_value("sales_order");
				if (!po) {
					if (so) frappe.query_report.set_filter_value("sales_order", "");
					else frappe.query_report.refresh();
					return;
				}
				frappe.db.get_value("OR Primary Sales Tracker", { marketplace_po_no: po }, "sales_order").then((r) => {
					const match = r.message && r.message.sales_order;
					if (match && match !== so) frappe.query_report.set_filter_value("sales_order", match);
					else frappe.query_report.refresh();
				});
			},
		},
		{
			fieldname: "view",
			label: __("View"),
			fieldtype: "Select",
			options: "Item-wise summary\nPrice variance details",
			description: __("Price variance = (Secondary Rate without Commission - Primary Rate) x qty"),
			default: "Item-wise summary",
		},
	],

	onload(report) {
		add_sor_summary_style();
		// the report page is shared by every report: group the summary only for this one
		const standard = frappe.views.QueryReport.prototype.render_summary;
		report.render_summary = function (data) {
			const grouped = this.report_name === "Marketplace OR Dashboard" && data.length && data[0].group;
			if (grouped) return render_grouped_summary(this, data);
			this.$summary.removeClass("orm-summary");
			return standard.call(this, data);
		};
	},

	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (!data) return value;
		if (column.fieldname === "note_status") {
			const color = { "Not created": "red", Draft: "orange", Submitted: "green" }[data.note_status];
			return color ? `<span class="indicator-pill ${color}">${value}</span>` : value;
		}
		if (["total_variance", "variance_per_unit"].includes(column.fieldname)) {
			const v = data[column.fieldname];
			return v > 0 ? `<span class="text-success">${value}</span>` : v < 0 ? `<span class="text-danger">${value}</span>` : value;
		}
		return value;
	},
};

// Four panels, in the order the python sends them (marketplace_or_dashboard._summary): figures as
// tiles (label above value) on a fixed two-column grid, so every label and value lines up.
const OR_SECTIONS = {
	"Primary Sale & Return": { accent: "#2B4C7E", hint: __("You ↔ marketplace") },
	"Secondary Sale & Return": { accent: "#2F6F4F", hint: __("Marketplace ↔ customers") },
	"Stock at Marketplace": { accent: "#9A7B2F", hint: __("Held by the marketplace now") },
	"Price Variance & Notes": { accent: "#5B4A8A", hint: __("Debit / Credit Notes") },
};

function or_value(item) {
	const df = { fieldtype: item.datatype || "Float" };
	if (item.datatype === "Currency") df.options = "currency";
	return frappe.format(item.value, df, { only_value: true });
}

function or_tone(item) {
	const tone = (item.indicator || "").toLowerCase();
	return tone === "green" || tone === "red" ? ` orm-tone-${tone}` : "";
}

function render_grouped_summary(report, data) {
	const esc = frappe.utils.escape_html;
	const sections = {};
	data.forEach((item) => (sections[item.group] = sections[item.group] || []).push(item));

	const panels = Object.entries(sections).map(([section, items]) => {
		const style = OR_SECTIONS[section] || { accent: "var(--gray-600)", hint: "" };
		let tiles = "";
		let current = null;
		items.forEach((item) => {
			if (item.subsection && item.subsection !== current) {
				current = item.subsection;
				tiles += `<div class="orm-sub"><span>${esc(current)}</span></div>`;
			}
			const label = esc(item.label);
			tiles += `<div class="orm-tile${item.wide ? " orm-tile-wide" : ""}">
				<div class="orm-tile-label" title="${label}">${label}</div>
				<div class="orm-tile-value${or_tone(item)}">${or_value(item)}</div>
			</div>`;
		});
		return `<div class="orm-panel" style="--orm-accent: ${style.accent}">
			<div class="orm-panel-head">
				<span class="orm-panel-title">${esc(__(section))}</span>
				<span class="orm-panel-hint">${esc(style.hint)}</span>
			</div>
			<div class="orm-tiles">${tiles}</div>
		</div>`;
	});

	report.$summary.empty().addClass("orm-summary").html(panels.join("")).show();
}

function add_sor_summary_style() {
	if (document.getElementById("orm-tiles-style")) return;
	$(`<style id="orm-tiles-style">
		.report-summary.orm-summary {
			display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: stretch; gap: 14px;
			margin: 0 0 16px; padding: 0; background: transparent; border: none; box-shadow: none;
		}
		@media (max-width: 1199px) { .report-summary.orm-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
		@media (max-width: 640px) { .report-summary.orm-summary { grid-template-columns: minmax(0, 1fr); } }

		.orm-panel {
			display: flex; flex-direction: column; min-width: 0;
			border: 1px solid var(--border-color); border-top: 3px solid var(--orm-accent); border-radius: 10px;
			background: color-mix(in srgb, var(--orm-accent) 5%, var(--card-bg, #fff));
		}
		.orm-panel-head {
			display: flex; align-items: center; justify-content: space-between; gap: 10px;
			height: 44px; padding: 0 16px; border-bottom: 1px solid color-mix(in srgb, var(--orm-accent) 15%, var(--border-color));
		}
		.orm-panel-title {
			color: var(--orm-accent); font-size: 13px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
			white-space: nowrap;
		}
		.orm-panel-hint {
			color: var(--text-muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
		}

		.orm-tiles {
			display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: min-content;
			column-gap: 8px; row-gap: 4px; padding: 10px 12px 14px;
		}
		.orm-tile { padding: 8px 4px; text-align: center; min-width: 0; }
		.orm-tile-wide { grid-column: 1 / -1; padding: 10px 4px 12px; }
		.orm-tile-label {
			color: var(--text-muted); font-size: 12.5px; line-height: 1.3;
			white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		}
		.orm-tile-value {
			margin-top: 4px; color: var(--text-color); font-size: 18px; font-weight: 600; line-height: 1.25;
			font-variant-numeric: tabular-nums; white-space: nowrap;
		}
		.orm-tile-wide .orm-tile-value { font-size: 26px; font-weight: 700; }
		.orm-tone-green { color: var(--green-600, #2F855A) !important; }
		.orm-tone-red { color: var(--red-600, #C53030) !important; }

		.orm-sub {
			grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; margin: 6px 0 0;
			color: var(--orm-accent); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
		}
		.orm-sub::before, .orm-sub::after {
			content: ""; flex: 1; height: 1px; background: color-mix(in srgb, var(--orm-accent) 25%, var(--border-color));
		}

		[data-theme="dark"] .orm-panel { background: color-mix(in srgb, var(--orm-accent) 12%, var(--card-bg)); }
		[data-theme="dark"] .orm-panel-title, [data-theme="dark"] .orm-sub { color: color-mix(in srgb, var(--orm-accent) 50%, #fff); }
	</style>`).appendTo("head");
}
