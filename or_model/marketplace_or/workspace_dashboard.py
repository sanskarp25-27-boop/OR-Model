"""Data for the Marketplace OR workspace dashboard (the dark "OR Dashboard" Custom HTML Block).

Figures are tracking numbers, like the rest of the module:
    Primary sales    = OR dispatches (Delivery Notes) at the Sales Order rate
    Secondary sales  = OR Secondary Sales Orders (marketplace sales to end customers; returns are negative)
    Returns          = Secondary returns in the period
"""

from collections import defaultdict
from datetime import timedelta

import frappe
from frappe.utils import add_months, flt, get_first_day, getdate, nowdate

TRACKER = "OR Primary Sales Tracker"
SECONDARY = "OR Secondary Sales Order"
PERIODS = ("Week", "Month", "Year")
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


@frappe.whitelist()
def get_dashboard(period="Month"):
	frappe.has_permission(TRACKER, "read", throw=True)
	if period not in PERIODS:
		period = "Month"

	today = getdate(nowdate())
	start, prev_start = _period_start(today, period)
	length = (today - start).days
	prev_end = prev_start + timedelta(days=length)

	secondary = _secondary_by_day(start, today)
	returns = _returns_by_day(start, today)
	primary = _primary_by_day(start, today)
	sec_total = sum(secondary.values())
	prev_sec = sum(_secondary_by_day(prev_start, prev_end).values())
	prim_total = sum(primary.values())
	prev_prim = sum(_primary_by_day(prev_start, prev_end).values())
	ret_total = sum(returns.values())
	prev_ret = sum(_returns_by_day(prev_start, prev_end).values())

	days = [start + timedelta(days=i) for i in range(length + 1)]
	trackers = frappe.db.sql(
		f"""select sum(virtual_stock) as held, sum(stock_in_transit) as transit, count(name) as open_count
		from `tab{TRACKER}` where status != 'Closed'""",
		as_dict=True,
	)[0]

	return {
		"user_first_name": frappe.db.get_value("User", frappe.session.user, "first_name") or frappe.session.user,
		"user_image": frappe.db.get_value("User", frappe.session.user, "user_image"),
		"period": period,
		"start": str(start),
		"end": str(today),
		"hero": {
			"label": "Secondary sales",
			"value": sec_total,
			"change": _change(sec_total, prev_sec),
			"held_units": flt(trackers.held),
			"transit_units": flt(trackers.transit),
			"open_trackers": trackers.open_count or 0,
		},
		"segments": [
			{"key": "primary", "label": "Primary", "value": prim_total, "change": _change(prim_total, prev_prim)},
			{
				"key": "secondary",
				"label": "Secondary",
				"value": sec_total,
				"change": _change(sec_total, prev_sec),
				"bars": [round(secondary.get(d, 0), 2) for d in days][-28:],
			},
			{
				"key": "returns",
				"label": "Returns",
				"value": ret_total,
				"change": _change(ret_total, prev_ret),
				"bars": [round(returns.get(d, 0), 2) for d in days][-8:],
			},
		],
		"trend": _monthly_trend(today),
		"heatmap": _heatmap(start, today),
		"recent": _recent(),
		"links": {"settings": "/app/marketplace-orm-settings"},
	}


def _period_start(today, period):
	if period == "Week":
		start = today - timedelta(days=today.weekday())
		return start, start - timedelta(days=7)
	if period == "Year":
		start = today.replace(month=1, day=1)
		return start, start.replace(year=start.year - 1)
	start = get_first_day(today)
	return start, getdate(add_months(start, -1))


def _change(current, previous):
	if not previous:
		return None
	return round((flt(current) - flt(previous)) / abs(flt(previous)) * 100, 2)


def _secondary_by_day(start, end):
	rows = frappe.db.sql(
		f"""select sale_date, sum(qty * selling_rate) from `tab{SECONDARY}`
		where sale_date between %s and %s and is_return = 0 group by sale_date""",
		(start, end),
	)
	return {getdate(d): flt(v) for d, v in rows}


def _returns_by_day(start, end):
	rows = frappe.db.sql(
		f"""select sale_date, sum(-qty * selling_rate) from `tab{SECONDARY}`
		where sale_date between %s and %s and is_return = 1 group by sale_date""",
		(start, end),
	)
	return {getdate(d): flt(v) for d, v in rows}


def _primary_by_day(start, end):
	from or_model.marketplace_or.insights import _primary_dispatch

	return {d: value for d, (value, _qty) in _primary_dispatch(start, end).items()}


def _monthly_trend(today):
	"""Primary vs secondary sales value for the last 6 months."""
	first = getdate(add_months(get_first_day(today), -5))
	secondary = _secondary_by_day(first, today)
	primary = _primary_by_day(first, today)
	months = [getdate(add_months(first, i)) for i in range(6)]
	sec = defaultdict(float)
	prim = defaultdict(float)
	for d, v in secondary.items():
		sec[(d.year, d.month)] += v
	for d, v in primary.items():
		prim[(d.year, d.month)] += v
	return [
		{
			"label": m.strftime("%b"),
			"secondary": round(sec[(m.year, m.month)], 2),
			"primary": round(prim[(m.year, m.month)], 2),
		}
		for m in months
	]


def _heatmap(start, end):
	"""Secondary sale units per marketplace and weekday in the period."""
	marketplaces = frappe.get_all("OR Marketplace", pluck="name", order_by="name")
	cells = {m: [0.0] * 7 for m in marketplaces}
	for marketplace, sale_date, qty in frappe.db.sql(
		f"""select marketplace, sale_date, sum(qty) from `tab{SECONDARY}`
		where sale_date between %s and %s and is_return = 0 group by marketplace, sale_date""",
		(start, end),
	):
		if marketplace in cells:
			cells[marketplace][getdate(sale_date).weekday()] += flt(qty)
	peak = max([v for row in cells.values() for v in row] or [0])
	return {
		"days": WEEKDAYS,
		"rows": [{"label": m, "values": cells[m]} for m in marketplaces],
		"max": peak,
	}


def _recent():
	rows = frappe.get_all(
		SECONDARY,
		fields=["name", "marketplace_order_id", "item_code", "marketplace", "is_return", "qty", "selling_rate", "sale_date"],
		order_by="creation desc",
		limit=5,
	)
	return [
		{
			"name": r.name,
			"title": r.marketplace_order_id or r.name,
			"subtitle": r.item_code,
			"tag": r.marketplace,
			"kind": "Return" if r.is_return else "Sale",
			"amount": round(flt(r.qty) * flt(r.selling_rate), 2),
			"date": str(r.sale_date),
		}
		for r in rows
	]
