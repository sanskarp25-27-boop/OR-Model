// Flow / Channel / Marketplace on Sales Order. Server side: or_model/marketplace_or/sales_order.py
const OR_SETTINGS = "or_model.marketplace_or.doctype.marketplace_or_settings.marketplace_or_settings";

frappe.ui.form.on("Sales Order", {
	sales_flow(frm) {
		if (frm.doc.sales_flow !== "OR") frm.set_value("or_marketplace", null);
		else set_marketplace_from_customer(frm);
		if (frm.doc.sales_flow === "B2C/D2C") {
			frm.set_value("customer_po_number", null);
			frm.set_value("customer_po_date", null);
		} else {
			if (!frm.doc.customer_po_number && frm.doc.po_no) frm.set_value("customer_po_number", frm.doc.po_no);
			if (!frm.doc.customer_po_date && frm.doc.po_date) frm.set_value("customer_po_date", frm.doc.po_date);
		}
	},

	customer(frm) {
		if (frm.doc.sales_flow === "OR") set_marketplace_from_customer(frm);
	},

	customer_po_number(frm) {
		if (frm.doc.customer_po_number) frm.set_value("po_no", frm.doc.customer_po_number);
	},

	customer_po_date(frm) {
		if (frm.doc.customer_po_date) frm.set_value("po_date", frm.doc.customer_po_date);
	},

	or_marketplace(frm) {
		if (!frm.doc.or_marketplace) return;
		frappe.xcall(`${OR_SETTINGS}.get_marketplace_customer`, { marketplace: frm.doc.or_marketplace }).then((customer) => {
			if (customer && frm.doc.customer !== customer) frm.set_value("customer", customer);
		});
	},

	refresh(frm) {
		if (frm.doc.or_record) {
			frm.add_custom_button(__("OR Primary Sales Tracker"), () => frappe.set_route("Form", "OR Primary Sales Tracker", frm.doc.or_record), __("View"));
		}
	},
});

function set_marketplace_from_customer(frm) {
	if (!frm.doc.customer) return;
	frappe.xcall(`${OR_SETTINGS}.get_customer_marketplace`, { customer: frm.doc.customer }).then((marketplace) => {
		if (marketplace && frm.doc.or_marketplace !== marketplace) frm.set_value("or_marketplace", marketplace);
	});
}
