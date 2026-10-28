from collections import defaultdict

import frappe
from frappe.utils import add_days, getdate, nowdate
from frappe.utils.dashboard import cache_source

DAYS = 14


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
	"""Secondary-sale units per day for the last two weeks, one line per marketplace."""
	start = getdate(add_days(nowdate(), -(DAYS - 1)))
	days = [add_days(start, i) for i in range(DAYS)]
	rows = frappe.get_list(
		"OR Secondary Sales Order",
		filters={"sale_date": (">=", start)},
		fields=["marketplace", "sale_date", {"SUM": "qty", "as": "qty"}],
		group_by="marketplace, sale_date",
	)
	sold = defaultdict(dict)
	for row in rows:
		sold[row.marketplace][getdate(row.sale_date)] = row.qty or 0

	return {
		"labels": [day.strftime("%d %b") for day in days],
		"datasets": [
			{"name": marketplace, "values": [by_day.get(day, 0) for day in days]}
			for marketplace, by_day in sorted(sold.items())
		],
		"type": "line",
	}
