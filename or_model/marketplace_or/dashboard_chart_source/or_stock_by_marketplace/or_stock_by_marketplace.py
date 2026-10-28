import frappe
from frappe import _
from frappe.utils.dashboard import cache_source

FIELDS = (
	("Sold", "total_sold_qty"),
	("Stock at marketplace", "virtual_stock"),
	("Stock in transit", "stock_in_transit"),
	("Return in transit", "return_in_transit"),
)


@frappe.whitelist()
@cache_source
def get(
	chart_name=None,
	chart=None,
	no_cache=None,
	filters=None,
	from_date=None,
	to_date=None,
	timespan=None,
	time_interval=None,
	heatmap_year=None,
):
	rows = frappe.get_list(
		"OR Primary Sales Tracker",
		fields=["marketplace", *({"SUM": field, "as": field} for _label, field in FIELDS)],
		group_by="marketplace",
		order_by="marketplace",
	)
	return {
		"labels": [row.marketplace for row in rows],
		"datasets": [{"name": _(label), "values": [row.get(field) or 0 for row in rows]} for label, field in FIELDS],
		"type": "bar",
	}
