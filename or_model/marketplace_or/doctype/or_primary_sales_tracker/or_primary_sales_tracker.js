// OR Primary Sales Tracker. Server side: or_primary_sales_tracker.py, stock.py, sales.py, notes.py
frappe.ui.form.on("OR Primary Sales Tracker", {
	setup(frm) {
		frm.set_query("sales_order", () => ({
			filters: { docstatus: 1, customer: frm.doc.customer || "__none__" },
		}));
	},

	marketplace(frm) {
		if (!frm.doc.marketplace) return;
		frappe
			.xcall(
				"or_model.marketplace_or.doctype.marketplace_or_settings.marketplace_or_settings.get_marketplace_customer",
				{ marketplace: frm.doc.marketplace }
			)
			.then((customer) => frm.set_value("customer", customer));
	},

	refresh(frm) {
		render_item_summary(frm);
		if (frm.is_new() || frm.doc.status === "Closed") return;

		const act = (method, args = {}) =>
			(frm.is_dirty() ? frm.save() : Promise.resolve())
				.then(() => frm.call(method, args))
				.then((r) => {
					frm.reload_doc();
					return r.message;
				});
		const rows = frm.doc.stock_movements || [];
		const create = __("Create");
		const moves = __("Primary Sales & Returns");
		const sales = __("Secondary Sales");

		// Primary Sale rows come from dispatches in the OR app; Primary Returns are received by Putaway
		frm.add_custom_button(__("Primary Return"), () => return_dialog(frm, act), create);

		if (rows.some((r) => r.status === "Return Initiated")) {
			frm.add_custom_button(__("Mark Primary Return dispatched"), () => mark_dispatched_dialog(frm, act), moves);
		}
		if (rows.some(is_receivable)) {
			frm.add_custom_button(__("Record Primary Sale receipt"), () => receipt_dialog(frm, act), moves);
		}
		if (rows.some(is_cancellable)) {
			frm.add_custom_button(__("Cancel Primary Return"), () => cancel_dialog(frm, act), moves);
		}

		frm.add_custom_button(__("Import secondary sales"), () => import_dialog(frm, act), sales);
		frm.add_custom_button(__("Secondary Return"), () => secondary_return_dialog(frm, act), sales);
		frm.add_custom_button(
			__("Create debit / credit notes"),
			() => act("create_notes").then((names) => frappe.show_alert(notes_message(names), 7)),
			sales
		);
		frm.add_custom_button(
			__("Submit all draft notes"),
			() =>
				frappe.confirm(__("Submit every draft debit and credit note on this record?"), () =>
					act("submit_draft_notes").then((n) =>
						frappe.show_alert({ message: __("{0} note(s) submitted", [n]), indicator: "green" })
					)
				),
			sales
		);

		if (frm.doc.reconciliation_status === "Variance not invoiced") {
			frm.dashboard.set_headline_alert(
				__("Rate difference not settled yet: some secondary sales are not in a credit / debit note. Run Month-end settlement in the OR app."),
				"red"
			);
		} else if (frm.doc.reconciliation_status === "Notes awaiting submission") {
			frm.dashboard.set_headline_alert(__("Draft debit / credit notes are waiting for approval."), "orange");
		}
	},
});

const is_cancellable = (r) =>
	["Return Initiated", "Return Dispatched"].includes(r.status) && !r.from_sales_return && !flt(r.received_qty);

const is_receivable = (r) => r.movement_type === "Primary Sale" && ["Dispatched", "Partially Received"].includes(r.status);

const row_label = (r) =>
	`${r.idx}. ${r.movement_type}${r.reference_name ? " " + r.reference_name : ""}: ${r.qty} x ${r.item_code} (${r.status})`;

const row_options = (frm, filter) =>
	(frm.doc.stock_movements || []).filter(filter).map((r) => ({ value: r.name, label: row_label(r) }));

function return_dialog(frm, act) {
	const held = ((frm.doc.__onload || {}).item_summary || []).filter((i) => i.available > 0);
	if (!held.length) {
		frappe.msgprint(__("{0} holds no stock on this record that can be returned.", [frm.doc.marketplace]));
		return;
	}
	const dialog = new frappe.ui.Dialog({
		title: __("Primary Return from {0}", [frm.doc.marketplace]),
		fields: [
			{
				fieldname: "item_code",
				fieldtype: "Select",
				label: __("Item"),
				reqd: 1,
				options: held.map((i) => ({ value: i.item_code, label: `${i.item_code} (${i.available} held)` })),
			},
			{ fieldname: "qty", fieldtype: "Float", label: __("Qty"), reqd: 1 },
			{ fieldname: "reference", fieldtype: "Data", label: __("Marketplace Return No"), reqd: 1 },
			{ fieldname: "col", fieldtype: "Column Break" },
			{ fieldname: "initiation_date", fieldtype: "Date", label: __("Return Initiation Date"), default: frappe.datetime.get_today() },
			{ fieldname: "awb_no", fieldtype: "Data", label: __("AWB / Tracking ID") },
		],
		primary_action_label: __("Initiate Primary Return"),
		primary_action(values) {
			dialog.hide();
			act("initiate_return", values).then(() => frappe.show_alert({ message: __("Primary Return initiated"), indicator: "green" }));
		},
	});
	dialog.show();
}

function mark_dispatched_dialog(frm, act) {
	const dialog = new frappe.ui.Dialog({
		title: __("Mark Primary Return dispatched"),
		fields: [
			{
				fieldname: "row",
				fieldtype: "Select",
				label: __("Movement"),
				reqd: 1,
				options: row_options(frm, (r) => r.status === "Return Initiated"),
			},
			{ fieldname: "dispatch_date", fieldtype: "Date", label: __("Dispatch Date"), default: frappe.datetime.get_today() },
			{ fieldname: "awb_no", fieldtype: "Data", label: __("AWB / Tracking ID"), reqd: 1 },
		],
		primary_action_label: __("Mark dispatched"),
		primary_action(values) {
			dialog.hide();
			act("mark_dispatched", values);
		},
	});
	dialog.show();
}

function receipt_dialog(frm, act) {
	const open = (frm.doc.stock_movements || []).filter(is_receivable);
	const dialog = new frappe.ui.Dialog({
		title: __("Record Primary Sale receipt"),
		fields: [
			{
				fieldname: "row",
				fieldtype: "Select",
				label: __("Movement"),
				reqd: 1,
				options: open.map((r) => ({ value: r.name, label: row_label(r) + ` - ${r.qty - r.received_qty} pending` })),
				onchange() {
					const r = open.find((x) => x.name === dialog.get_value("row"));
					if (r) dialog.set_value("qty", r.qty - r.received_qty);
				},
			},
			{ fieldname: "qty", fieldtype: "Float", label: __("Received Qty"), reqd: 1 },
			{
				fieldname: "pod",
				fieldtype: "Attach",
				label: __("POD (Proof of Delivery)"),
				reqd: 1,
				description: __("The marketplace's signed delivery receipt. Saved on the movement row and in this record's attachments."),
			},
		],
		primary_action_label: __("Record receipt"),
		primary_action(values) {
			dialog.hide();
			act("record_receipt", values).then(() => frappe.show_alert({ message: __("Receipt recorded"), indicator: "green" }));
		},
	});
	dialog.show();
	dialog.fields_dict.row.df.onchange();
}

function cancel_dialog(frm, act) {
	const dialog = new frappe.ui.Dialog({
		title: __("Cancel Primary Return"),
		fields: [
			{ fieldname: "row", fieldtype: "Select", label: __("Primary Return"), reqd: 1, options: row_options(frm, is_cancellable) },
			{
				fieldname: "note",
				fieldtype: "HTML",
				options: `<p class="text-muted">${__("Only Primary Returns not yet put away can be cancelled. A dispatch is undone by cancelling its Delivery Note.")}</p>`,
			},
		],
		primary_action_label: __("Cancel Primary Return"),
		primary_action(values) {
			dialog.hide();
			act("cancel_movement", values);
		},
	});
	dialog.show();
}

function import_dialog(frm, act) {
	const dialog = new frappe.ui.Dialog({
		title: __("Import secondary sales"),
		fields: [
			{
				fieldname: "help",
				fieldtype: "HTML",
				options: `<p class="text-muted">${__(
					"Columns: marketplace_order_id, sale_date (YYYY-MM-DD), marketplace_sku, qty, selling_price. Attach a CSV / XLSX file or paste CSV below. Duplicate order IDs are skipped."
				)}</p>`,
			},
			{ fieldname: "file_url", fieldtype: "Attach", label: __("CSV / XLSX File") },
			{
				fieldname: "csv_text",
				fieldtype: "Code",
				label: __("Or paste CSV"),
				default: "marketplace_order_id,sale_date,marketplace_sku,qty,selling_price\n",
			},
		],
		primary_action_label: __("Import"),
		primary_action(values) {
			if (!values.file_url && !(values.csv_text || "").trim().includes("\n")) {
				frappe.msgprint(__("Attach a file or paste at least one sales line."));
				return;
			}
			dialog.hide();
			act("import_secondary_sales", values).then((r) => {
				const parts = [__("Imported {0} line(s) in batch {1}.", [r.imported, r.batch])];
				if (r.duplicates.length) parts.push(__("Skipped {0} duplicate order ID(s).", [r.duplicates.length]));
				parts.push(
					r.variance_lines
						? __("{0} line(s) have a price variance; {1} note(s) created.", [r.variance_lines, r.notes_created])
						: __("No price variance.")
				);
				frappe.msgprint({
					title: __("Secondary sales imported"),
					indicator: "green",
					message:
						parts.join(" ") +
						(r.variance_lines
							? `<br><br><a href="/desk/or-secondary-sales-order?or_reference=${encodeURIComponent(
									frm.doc.name
							  )}&note_status=%5B%22!%3D%22%2C%22No%20variance%22%5D">${__("View OR Secondary Sales Orders with variance")}</a>`
							: ""),
				});
			});
		},
	});
	dialog.show();
}

function secondary_return_dialog(frm, act, or_secondary_sales_order) {
	const dialog = new frappe.ui.Dialog({
		title: __("Secondary Return"),
		fields: [
			{
				fieldname: "help",
				fieldtype: "HTML",
				options: `<p class="text-muted">${__(
					"An end customer returned goods to {0}. The units go back to Stock at Marketplace, and the sale's price variance is reversed for them.",
					[frm.doc.marketplace]
				)}</p>`,
			},
			{
				fieldname: "or_secondary_sales_order",
				fieldtype: "Link",
				label: __("OR Secondary Sales Order"),
				options: "OR Secondary Sales Order",
				reqd: 1,
				default: or_secondary_sales_order,
				get_query: () => ({ filters: { or_reference: frm.doc.name, is_return: 0 } }),
				onchange() {
					const name = dialog.get_value("or_secondary_sales_order");
					if (!name) return;
					frappe.db.get_value("OR Secondary Sales Order", name, ["qty", "returned_qty", "item_code", "marketplace_order_id"]).then(({ message: s }) => {
						if (!s) return;
						const left = flt(s.qty) - flt(s.returned_qty);
						dialog.set_df_property(
							"qty",
							"description",
							__("{0} x {1} sold on order {2}; {3} can still be returned.", [s.qty, s.item_code, s.marketplace_order_id, left])
						);
						if (!dialog.get_value("qty")) dialog.set_value("qty", left);
					});
				},
			},
			{ fieldname: "qty", fieldtype: "Float", label: __("Return Qty"), reqd: 1 },
			{ fieldname: "col", fieldtype: "Column Break" },
			{ fieldname: "return_date", fieldtype: "Date", label: __("Return Date"), default: frappe.datetime.get_today() },
			{
				fieldname: "marketplace_return_id",
				fieldtype: "Data",
				label: __("Marketplace Return ID"),
				description: __("Left blank: the order ID with -R1, -R2 ..."),
			},
		],
		primary_action_label: __("Record Secondary Return"),
		primary_action(values) {
			dialog.hide();
			act("record_secondary_return", values).then((name) =>
				frappe.show_alert({ message: __("Secondary Return {0} recorded", [name]), indicator: "green" })
			);
		},
	});
	dialog.show();
	if (or_secondary_sales_order) dialog.fields_dict.or_secondary_sales_order.df.onchange();
}

function notes_message(names) {
	return names && names.length
		? { message: __("{0} note(s) created", [names.length]), indicator: "green" }
		: { message: __("Every variance line is already in a note"), indicator: "blue" };
}

function render_item_summary(frm) {
	const wrapper = frm.fields_dict.item_summary_html && frm.fields_dict.item_summary_html.$wrapper;
	if (!wrapper) return;
	const rows = (frm.doc.__onload || {}).item_summary || [];
	if (!rows.length) {
		wrapper.html(`<p class="text-muted">${__("No Primary Sale yet. Dispatch it with Pick, Pack & Dispatch in the OR app and it appears here.")}</p>`);
		return;
	}
	const num = (v) => format_number(v, null, 0);
	const money = (v) => format_currency(v);
	wrapper.html(`
		<table class="table table-bordered table-sm">
			<thead><tr>
				<th>${__("Item Code")}</th><th>${__("Marketplace SKU")}</th>
				<th class="text-right">${__("Primary Sale Received")}</th><th class="text-right">${__("Secondary Sold")}</th>
				<th class="text-right">${__("Secondary Returned")}</th>
				<th class="text-right">${__("Primary Returns Dispatched")}</th><th class="text-right">${__("Stock at Marketplace")}</th>
				<th>${__("Last Secondary Sale")}</th><th class="text-right">${__("Primary Value")}</th>
				<th class="text-right">${__("Secondary Value")}</th><th class="text-right">${__("Commission")}</th>
				<th class="text-right">${__("Net Variance")}</th>
			</tr></thead>
			<tbody>${rows
				.map(
					(r) => `<tr>
				<td><b>${frappe.utils.escape_html(r.item_code)}</b></td>
				<td>${frappe.utils.escape_html(r.marketplace_sku || "")}</td>
				<td class="text-right">${num(r.received)}</td><td class="text-right">${num(r.sold)}</td>
				<td class="text-right">${num(r.secondary_returned)}</td>
				<td class="text-right">${num(r.return_dispatched)}</td><td class="text-right"><b>${num(r.virtual_stock)}</b></td>
				<td>${r.last_sale ? frappe.datetime.str_to_user(r.last_sale) : ""}</td>
				<td class="text-right">${money(r.primary_value)}</td><td class="text-right">${money(r.secondary_value)}</td>
				<td class="text-right">${money(r.commission_value)}</td><td class="text-right">${money(r.net_variance)}</td></tr>`
				)
				.join("")}</tbody>
		</table>`);
}
