import frappe

from or_model.marketplace_or import sales


@frappe.whitelist(methods=["POST"])
def record_secondary_return(or_secondary_sales_order, qty, return_date=None, marketplace_return_id=None):
	"""Secondary Return from the OR Secondary Sales Order form; same rules as on the OR Primary Sales Tracker."""
	or_name = frappe.db.get_value("OR Secondary Sales Order", or_secondary_sales_order, "or_reference")
	ort = frappe.get_doc("OR Primary Sales Tracker", or_name)
	ort.check_permission("write")
	return sales.record_secondary_return(ort, or_secondary_sales_order, qty, return_date, marketplace_return_id)


@frappe.whitelist()
@frappe.validate_and_sanitize_search_inputs
def or_sales_orders(doctype, txt, searchfield, start, page_len, filters):
	"""Sales Orders that have a OR Primary Sales Tracker, optionally for one marketplace."""
	conditions = {"sales_order": ("like", f"%{txt}%")}
	if (filters or {}).get("marketplace"):
		conditions["marketplace"] = filters["marketplace"]
	return frappe.get_list(
		"OR Primary Sales Tracker",
		filters=conditions,
		fields=["sales_order", "marketplace", "marketplace_po_no"],
		order_by="creation desc",
		limit_start=start,
		limit_page_length=page_len,
		as_list=True,
	)
