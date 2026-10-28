// OR Secondary Sales Order: a sale by the marketplace to an end customer, or a Secondary Return against one.
frappe.ui.form.on("OR Secondary Sales Order", {
	refresh(frm) {
		if (frm.doc.is_return) {
			frm.dashboard.set_headline(__("Secondary Return against {0}", [frm.doc.return_against.bold()]), "orange");
			return;
		}
		const left = flt(frm.doc.qty) - flt(frm.doc.returned_qty);
		if (left > 0) {
			frm.add_custom_button(__("Secondary Return"), () => secondary_return_dialog(frm, left));
		}
		if (flt(frm.doc.returned_qty)) {
			frm.add_custom_button(
				__("Secondary Returns"),
				() => frappe.set_route("List", "OR Secondary Sales Order", { return_against: frm.doc.name }),
				__("View")
			);
		}
	},
});

function secondary_return_dialog(frm, left) {
	const dialog = new frappe.ui.Dialog({
		title: __("Secondary Return: {0}", [frm.doc.marketplace_order_id]),
		fields: [
			{
				fieldname: "qty",
				fieldtype: "Float",
				label: __("Return Qty"),
				reqd: 1,
				default: left,
				description: __("{0} x {1} sold; {2} can still be returned.", [frm.doc.qty, frm.doc.item_code, left]),
			},
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
			frappe
				.xcall("or_model.marketplace_or.api.record_secondary_return", { or_secondary_sales_order: frm.doc.name, ...values })
				.then((name) => {
					frappe.show_alert({ message: __("Secondary Return {0} recorded", [name]), indicator: "green" });
					frm.reload_doc();
				});
		},
	});
	dialog.show();
}
