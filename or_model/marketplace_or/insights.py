"""Insights for the OR app: the dashboard (`dashboard`) and the interactive report (`report_data`).

Positions per Primary Sales record and item come from calculations.item_positions, the same numbers the
records show. Held stock is valued at your rate to the marketplace (the Sales Order rate). Ageing is FIFO:
what was sold or sent back is taken from the oldest dispatch first; the rest is still held since its
dispatch date.
"""

from collections import defaultdict
from datetime import timedelta

import frappe
from frappe.utils import add_months, flt, get_first_day, getdate, nowdate

from or_model.marketplace_or import calculations

TRACKER = "OR Primary Sales Tracker"
SECONDARY = "OR Secondary Sales Order"
AGE_BUCKETS = [(0, 30, "0-30 days"), (31, 60, "31-60 days"), (61, 90, "61-90 days"), (91, 10**6, "90+ days")]


# ---------------------------------------------------------------- shared data


def _period(period, today):
	if period == "Week":
		start = today - timedelta(days=today.weekday())
		return start, start - timedelta(days=7)
	if period == "Year":
		start = today.replace(month=1, day=1)
		return start, start.replace(year=start.year - 1)
	if period == "Quarter":
		start = today.replace(month=((today.month - 1) // 3) * 3 + 1, day=1)
		return start, getdate(add_months(start, -3))
	start = get_first_day(today)
	return start, getdate(add_months(start, -1))


def _load(marketplace=None, include_closed=True):
	"""Records, their movements, secondary lines and Sales Order rates."""
	filters = {}
	if marketplace:
		filters["marketplace"] = marketplace
	if not include_closed:
		filters["status"] = ("!=", "Closed")
	records = frappe.get_list(
		TRACKER,
		filters=filters,
		fields=["name", "marketplace", "sales_order", "marketplace_po_no", "po_date", "customer", "status", "order_status",
			"reconciliation_status", "variance_not_invoiced"],
		limit_page_length=0,
	)
	names = [r.name for r in records]
	movements = defaultdict(list)
	notes = defaultdict(list)
	lines = defaultdict(list)
	rates = {}
	if names:
		for m in frappe.get_all(
			"Marketplace OR Stock Movement",
			filters={"parent": ("in", names), "parenttype": TRACKER},
			fields=["parent", "name", "movement_type", "item_code", "qty", "received_qty", "status", "dispatch_date",
				"initiation_date", "delivery_note", "reference_name", "awb_no", "from_sales_return", "pod"],
			order_by="idx",
		):
			movements[m.parent].append(m)
		for n in frappe.get_all(
			"Marketplace OR Price Note",
			filters={"parent": ("in", names), "parenttype": TRACKER},
			fields=["parent", "note_type", "amount", "status", "sales_invoice"],
		):
			notes[n.parent].append(n)
		for line in frappe.get_all(
			SECONDARY,
			filters={"or_reference": ("in", names)},
			fields=["name", "or_reference", "marketplace", "marketplace_order_id", "sale_date", "item_code", "marketplace_sku",
				"qty", "primary_rate", "selling_rate", "commission_percent", "note_status", "sales_invoice", "is_return"],
			order_by="sale_date",
		):
			lines[line.or_reference].append(line)
		orders = list({r.sales_order for r in records if r.sales_order})
		for row in frappe.get_all(
			"Sales Order Item", filters={"parent": ("in", orders)}, fields=["parent", "item_code", "rate"], order_by="idx"
		):
			rates.setdefault((row.parent, row.item_code), flt(row.rate))
	return records, movements, notes, lines, rates


def _positions(records, movements, lines, rates, today):
	"""One row per record and item with quantities, values, sell-through and FIFO ageing."""
	rows = []
	for rec in records:
		positions = calculations.item_positions(movements[rec.name], lines[rec.name])
		for item_code, p in positions.items():
			rate = rates.get((rec.sales_order, item_code)) or (
				flt(p["primary_value"]) / flt(p["sold"]) if flt(p["sold"]) else 0
			)
			sold_net = flt(p["sold"]) - flt(p["secondary_returned"])
			ages = _ageing(movements[rec.name], item_code, sold_net + flt(p["return_dispatched"]), today)
			held = max(flt(p["virtual_stock"]), 0)
			rows.append(
				{
					"record": rec.name,
					"marketplace": rec.marketplace,
					"sales_order": rec.sales_order,
					"po_no": rec.marketplace_po_no,
					"status": rec.order_status or rec.status,  # shown as Status: the Sales Order's status
					"or_stage": rec.status,
					"item_code": item_code,
					"dispatched": flt(p["dispatched"]),
					"received": flt(p["received"]),
					"in_transit": flt(p["in_transit"]),
					"sold_without_pod": flt(p["sold_without_pod"]),
					"sold": flt(p["sold"]),
					"secondary_returned": flt(p["secondary_returned"]),
					"sold_net": sold_net,
					"return_dispatched": flt(p["return_dispatched"]),
					"return_in_transit": flt(p["return_in_transit"]),
					"return_initiated": flt(p["return_initiated"]),
					"return_pending": flt(p["return_pending"]),
					"return_received": flt(p["return_received"]),
					"held": held,
					"primary_rate": rate,
					"held_value": round(held * rate, 2),
					"primary_value": round(flt(p["primary_value"]), 2),
					"secondary_value": round(flt(p["secondary_value"]), 2),
					"commission": round(flt(p["commission_value"]), 2),
					"net_variance": round(flt(p["net_variance"]), 2),
					"sell_through": round(sold_net / flt(p["received"]) * 100, 1) if flt(p["received"]) else 0,
					"last_sale": str(p["last_sale"]) if p["last_sale"] else None,
					"oldest_age": max((a["age"] for a in ages if a["qty"] > 0), default=0),
					"ages": ages,
				}
			)
	return rows


def _ageing(movements, item_code, consumed, today):
	"""FIFO: remaining qty per received dispatch, with its age in days."""
	out = []
	left_to_consume = consumed
	dispatches = sorted(
		(m for m in movements if m.movement_type == calculations.OUTBOUND and m.item_code == item_code and flt(m.received_qty) > 0),
		key=lambda m: str(m.dispatch_date or ""),
	)
	for m in dispatches:
		qty = flt(m.received_qty)
		used = min(qty, max(left_to_consume, 0))
		left_to_consume -= used
		remaining = qty - used
		age = (today - getdate(m.dispatch_date)).days if m.dispatch_date else 0
		out.append({"qty": remaining, "age": age})
	return out


def _bucket(age):
	for lo, hi, label in AGE_BUCKETS:
		if lo <= age <= hi:
			return label
	return AGE_BUCKETS[-1][2]


def _primary_dispatch(start, end, marketplace=None):
	"""Value (without tax) and units dispatched to marketplaces per day: the OR dispatch Delivery Notes."""
	cond = "and t.marketplace = %(mp)s" if marketplace else ""
	rows = frappe.db.sql(
		f"""select dn.posting_date d, i.stock_qty q, i.base_net_amount v
		from `tabDelivery Note Item` i join `tabDelivery Note` dn on dn.name = i.parent
		join `tab{TRACKER}` t on t.name = dn.or_reference
		where dn.docstatus = 1 and dn.is_return = 0 and dn.posting_date between %(s)s and %(e)s {cond}""",
		{"s": start, "e": end, "mp": marketplace},
		as_dict=True,
	)
	out = defaultdict(lambda: [0.0, 0.0])
	for r in rows:
		out[getdate(r.d)][0] += flt(r.v)
		out[getdate(r.d)][1] += flt(r.q)
	return {d: (flt(v, 2), q) for d, (v, q) in out.items()}


def _pct(current, previous):
	if not previous:
		return None
	return round((flt(current) - flt(previous)) / abs(flt(previous)) * 100, 1)


# ---------------------------------------------------------------- dashboard


@frappe.whitelist()
def dashboard(period="Month", marketplace=None):
	frappe.has_permission(TRACKER, "read", throw=True)
	today = getdate(nowdate())
	start, prev_start = _period(period, today)
	prev_end = prev_start + (today - start)
	marketplace = marketplace or None

	records, movements, notes, lines, rates = _load(marketplace)
	positions = _positions(records, movements, lines, rates, today)
	open_names = {r.name for r in records if r.status != "Closed"}
	open_pos = [p for p in positions if p["record"] in open_names]
	all_lines = [l for ls in lines.values() for l in ls]

	def in_range(line, a, b):
		return line.sale_date and a <= getdate(line.sale_date) <= b

	cur = [l for l in all_lines if in_range(l, start, today)]
	prev = [l for l in all_lines if in_range(l, prev_start, prev_end)]
	sales = lambda ls: [l for l in ls if flt(l.qty) > 0]  # noqa: E731
	value = lambda ls: sum(flt(l.qty) * flt(l.selling_rate) for l in ls)  # noqa: E731
	units = lambda ls: sum(flt(l.qty) for l in ls)  # noqa: E731

	cur_sales, prev_sales = sales(cur), sales(prev)
	cur_returns = [l for l in cur if flt(l.qty) < 0]
	prim = _primary_dispatch(start, today, marketplace)
	prev_prim = _primary_dispatch(prev_start, prev_end, marketplace)
	prim_value = sum(v for v, _ in prim.values())

	# price realisation in the period: what the marketplace realised (after commission) vs your primary rate
	net_value = sum(flt(l.qty) * calculations.net_secondary_rate(l) for l in cur_sales)
	primary_of_sold = sum(flt(l.qty) * flt(l.primary_rate) for l in cur_sales)
	above = sum(1 for l in cur_sales if calculations.net_secondary_rate(l) > flt(l.primary_rate) + 0.005)
	below = sum(1 for l in cur_sales if calculations.net_secondary_rate(l) < flt(l.primary_rate) - 0.005)

	received = sum(p["received"] for p in open_pos)
	sold_net = sum(p["sold_net"] for p in open_pos)
	held = sum(p["held"] for p in open_pos)
	held_value = sum(p["held_value"] for p in open_pos)

	kpis = {
		"secondary_value": round(value(cur_sales), 2),
		"secondary_value_change": _pct(value(cur_sales), value(prev_sales)),
		"units": units(cur_sales),
		"units_change": _pct(units(cur_sales), units(prev_sales)),
		"orders": len({l.marketplace_order_id for l in cur_sales}),
		"avg_price": round(value(cur_sales) / units(cur_sales), 2) if units(cur_sales) else 0,
		"primary_value": round(prim_value, 2),
		"primary_change": _pct(prim_value, sum(v for v, _ in prev_prim.values())),
		"returns_units": -units(cur_returns),
		"return_rate": round(-units(cur_returns) / units(cur_sales) * 100, 1) if units(cur_sales) else 0,
		"sell_through": round(sold_net / received * 100, 1) if received else 0,
		"held": held,
		"held_value": round(held_value, 2),
		"in_transit": sum(p["in_transit"] for p in open_pos),
		"realisation": round(net_value / primary_of_sold * 100, 1) if primary_of_sold else None,
		"variance": round(sum(calculations.line_variance(l) for l in cur), 2),
		"lines_above": above,
		"lines_below": below,
		"lines_at": len(cur_sales) - above - below,
		"open_records": len(open_names),
	}

	# trend: daily for week / month, monthly for quarter / year
	trend = []
	if period in ("Week", "Month"):
		day = start
		while day <= today:
			ls = [l for l in cur if getdate(l.sale_date) == day]
			trend.append({"label": day.strftime("%d %b"), "value": round(value(sales(ls)), 2), "units": units(sales(ls)),
				"primary": round(prim.get(day, (0, 0))[0], 2)})
			day += timedelta(days=1)
	else:
		month = start
		while month <= today:
			nxt = getdate(add_months(month, 1))
			ls = [l for l in cur if month <= getdate(l.sale_date) < nxt]
			pv = sum(v for d, (v, _) in prim.items() if month <= d < nxt)
			trend.append({"label": month.strftime("%b %y"), "value": round(value(sales(ls)), 2), "units": units(sales(ls)), "primary": round(pv, 2)})
			month = nxt

	# marketplaces
	by_mp = defaultdict(lambda: defaultdict(float))
	for p in open_pos:
		m = by_mp[p["marketplace"]]
		for k in ("dispatched", "received", "in_transit", "sold_net", "held", "held_value", "secondary_value", "primary_value", "net_variance", "commission"):
			m[k] += p[k]
	for l in cur_sales:
		by_mp[l.marketplace]["period_value"] += flt(l.qty) * flt(l.selling_rate)
		by_mp[l.marketplace]["period_units"] += flt(l.qty)
	for l in cur_returns:
		by_mp[l.marketplace]["period_returns"] += -flt(l.qty)
	marketplaces = []
	for name, m in sorted(by_mp.items(), key=lambda kv: -kv[1]["period_value"]):
		marketplaces.append({
			"marketplace": name,
			**{k: round(v, 2) for k, v in m.items()},
			"sell_through": round(m["sold_net"] / m["received"] * 100, 1) if m["received"] else 0,
			"realisation": round((m["secondary_value"] - m["commission"]) / m["primary_value"] * 100, 1) if m["primary_value"] else None,
			"share": round(m["period_value"] / value(cur_sales) * 100, 1) if value(cur_sales) else 0,
		})

	# items: velocity over the last 30 days -> days of cover
	since = today - timedelta(days=30)
	sold30 = defaultdict(float)
	for l in all_lines:
		if l.sale_date and getdate(l.sale_date) >= since:
			sold30[l.item_code] += flt(l.qty)
	items = defaultdict(lambda: defaultdict(float))
	for p in open_pos:
		it = items[p["item_code"]]
		for k in ("received", "sold_net", "held", "held_value", "secondary_value"):
			it[k] += p[k]
		it["oldest_age"] = max(it["oldest_age"], p["oldest_age"] if p["held"] else 0)
	period_item = defaultdict(lambda: [0.0, 0.0])
	for l in cur_sales:
		period_item[l.item_code][0] += flt(l.qty) * flt(l.selling_rate)
		period_item[l.item_code][1] += flt(l.qty)
	item_rows = []
	for code, it in items.items():
		velocity = sold30[code] / 30
		item_rows.append({
			"item_code": code,
			"held": it["held"],
			"held_value": round(it["held_value"], 2),
			"sell_through": round(it["sold_net"] / it["received"] * 100, 1) if it["received"] else 0,
			"sold_30d": sold30[code],
			"days_cover": round(it["held"] / velocity) if velocity else None,
			"oldest_age": int(it["oldest_age"]),
			"period_value": round(period_item[code][0], 2),
			"period_units": period_item[code][1],
		})
	top = sorted([i for i in item_rows if i["period_value"] > 0], key=lambda i: -i["period_value"])[:6]
	slow = sorted([i for i in item_rows if i["held"] > 0], key=lambda i: (-(i["days_cover"] or 10**6), -i["oldest_age"]))[:6]
	low_cover = sorted([i for i in item_rows if i["days_cover"] is not None and i["days_cover"] <= 15], key=lambda i: i["days_cover"])[:6]

	# ageing of stock held at marketplaces
	ageing = {label: {"qty": 0.0, "value": 0.0} for _, _, label in AGE_BUCKETS}
	for p in open_pos:
		for a in p["ages"]:
			if a["qty"] > 0:
				b = ageing[_bucket(a["age"])]
				b["qty"] += a["qty"]
				b["value"] += a["qty"] * p["primary_rate"]
	ageing_rows = [{"bucket": k, "qty": round(v["qty"], 2), "value": round(v["value"], 2)} for k, v in ageing.items()]

	# action centre (most urgent first)
	actions = []
	# top priority: secondary sales imported against a dispatch whose receipt (POD) is not submitted yet,
	# i.e. more units sold than the marketplace has confirmed receiving
	no_pod = []
	for p in open_pos:
		if p["sold_without_pod"] > 1e-9:
			dns = sorted({m.delivery_note for m in movements[p["record"]] if m.movement_type == calculations.OUTBOUND
				and m.item_code == p["item_code"] and m.status in ("Dispatched", "Partially Received") and m.delivery_note})
			no_pod.append((p, dns))
	if no_pod:
		no_pod.sort(key=lambda x: -x[0]["sold_without_pod"])
		recs = list(dict.fromkeys(p["record"] for p, _ in no_pod))
		units = sum(p["sold_without_pod"] for p, _ in no_pod)
		actions.append({"key": "no_pod", "tone": "red", "count": len(recs),
			"title": f"{units:g} unit(s) sold before the POD was submitted",
			"detail": " · ".join(
				f"{p['record']}: {p['sold_without_pod']:g} × {p['item_code']} sold, {', '.join(dns) or 'dispatch'} awaiting POD"
				for p, dns in no_pod[:3]) + (" …" if len(no_pod) > 3 else ""),
			"record": recs[0]})
	unconfirmed = [(r, m) for r in records if r.name in open_names for m in movements[r.name]
		if m.movement_type == calculations.OUTBOUND and m.status in ("Dispatched", "Partially Received")]
	if unconfirmed:
		oldest = max(((today - getdate(m.dispatch_date)).days for _, m in unconfirmed if m.dispatch_date), default=0)
		actions.append({"key": "unconfirmed", "tone": "orange" if oldest <= 7 else "red", "count": len(unconfirmed),
			"title": f"{len(unconfirmed)} dispatch(es) not confirmed by the marketplace",
			"detail": f"{sum(flt(m.qty) - flt(m.received_qty) for _, m in unconfirmed):g} units in transit · oldest {oldest} days",
			"record": unconfirmed[0][0].name if len(unconfirmed) == 1 else None})
	ret_pending = [(r, m) for r in records for m in movements[r.name] if m.movement_type == calculations.RETURN and m.status == "Return Initiated"]
	if ret_pending:
		actions.append({"key": "return_initiated", "tone": "orange", "count": len(ret_pending),
			"title": f"{len(ret_pending)} return(s) initiated, not yet dispatched by the marketplace",
			"detail": f"{sum(flt(m.qty) for _, m in ret_pending):g} units", "record": ret_pending[0][0].name if len(ret_pending) == 1 else None})
	ret_transit = [(r, m) for r in records for m in movements[r.name] if m.movement_type == calculations.RETURN and m.status in ("Return Dispatched", "Partially Received")]
	if ret_transit:
		actions.append({"key": "return_transit", "tone": "cyan", "count": len(ret_transit),
			"title": f"{len(ret_transit)} return(s) on the way back",
			"detail": f"{sum(flt(m.qty) - flt(m.received_qty) for _, m in ret_transit):g} units to receive", "record": ret_transit[0][0].name if len(ret_transit) == 1 else None})
	uninvoiced = [r for r in records if flt(r.variance_not_invoiced)]
	if uninvoiced:
		pending_lines = sum(1 for r in uninvoiced for l in lines[r.name] if l.note_status == "Not created")
		actions.append({"key": "variance", "tone": "red", "count": len(uninvoiced),
			"title": "Rate difference not settled (month-end settlement due)",
			"detail": f"{pending_lines} secondary sale line(s) not in a debit / credit note on {len(uninvoiced)} record(s)",
			"record": uninvoiced[0].name if len(uninvoiced) == 1 else None})
	drafts = [(r, n) for r in records for n in notes[r.name] if n.status == "Draft"]
	if drafts:
		actions.append({"key": "draft_notes", "tone": "purple", "count": len(drafts),
			"title": f"{len(drafts)} draft note(s) waiting for approval",
			"detail": f"₹{sum(flt(n.amount) for _, n in drafts):,.2f}", "record": drafts[0][0].name if len(drafts) == 1 else None})
	approve = [r for r in records if r.status == "Under Reconciliation" and r.reconciliation_status == "Reconciled"]
	if approve:
		actions.append({"key": "approve", "tone": "green", "count": len(approve), "title": f"{len(approve)} record(s) ready to approve",
			"detail": ", ".join(r.name for r in approve[:3]), "record": approve[0].name if len(approve) == 1 else None})
	held_by = defaultdict(float)
	for p in positions:
		held_by[p["record"]] += p["held"]
	close = [r for r in records if r.status == "Reconciled" and held_by[r.name] <= 0]
	if close:
		actions.append({"key": "close", "tone": "green", "count": len(close), "title": f"{len(close)} record(s) sold out and reconciled: ready to close",
			"detail": ", ".join(r.name for r in close[:3]), "record": close[0].name if len(close) == 1 else None})
	aged = sum(a["qty"] for p in open_pos for a in p["ages"] if a["qty"] > 0 and a["age"] > 90)
	if aged:
		actions.append({"key": "aged", "tone": "red", "count": int(aged), "title": f"{aged:g} units held for more than 90 days",
			"detail": "Consider a Primary Return or a price action", "record": None})

	user = frappe.db.get_value("User", frappe.session.user, ["first_name"], as_dict=True)
	return {
		"first_name": user.first_name or frappe.session.user,
		"period": period,
		"start": str(start),
		"end": str(today),
		"kpis": kpis,
		"trend": trend,
		"marketplaces": marketplaces,
		"top_items": top,
		"slow_items": slow,
		"low_cover": low_cover,
		"ageing": ageing_rows,
		"actions": actions,
	}


# ---------------------------------------------------------------- interactive report


@frappe.whitelist()
def report_data(dataset="positions", marketplace=None, from_date=None, to_date=None, include_closed=0):
	frappe.has_permission(TRACKER, "read", throw=True)
	today = getdate(nowdate())
	records, movements, notes, lines, rates = _load(marketplace or None, include_closed=bool(int(include_closed or 0)))
	by_name = {r.name: r for r in records}
	a = getdate(from_date) if from_date else None
	b = getdate(to_date) if to_date else None

	def dated(d):
		if not d:
			return not (a or b)
		d = getdate(d)
		return (not a or d >= a) and (not b or d <= b)

	if dataset == "positions":
		rows = _positions(records, movements, lines, rates, today)
		# notes belong to a record, not an item: every row carries its record's totals (rec_*);
		# the OR Report sums them once per record
		submitted = lambda name, kind: round(  # noqa: E731
			sum(flt(n.amount) for n in notes[name] if n.status == "Submitted" and n.note_type == kind), 2
		)
		for r in rows:
			buckets = {label: 0.0 for _, _, label in AGE_BUCKETS}
			for a in r.pop("ages", []):
				if a["qty"] > 0:
					buckets[_bucket(a["age"])] += a["qty"]
			r["age_buckets"] = buckets
			r["rec_debit_notes"] = submitted(r["record"], calculations.DEBIT_NOTE)
			r["rec_credit_notes"] = submitted(r["record"], calculations.CREDIT_NOTE)
			r["rec_not_in_note"] = flt(by_name[r["record"]].variance_not_invoiced)
		return rows

	if dataset == "lines":
		out = []
		for name, ls in lines.items():
			rec = by_name.get(name)
			for l in ls:
				if not dated(l.sale_date):
					continue
				net = calculations.net_secondary_rate(l)
				out.append({
					"name": l.name, "sale_date": str(l.sale_date) if l.sale_date else None, "month": str(l.sale_date)[:7] if l.sale_date else None,
					"marketplace": l.marketplace, "record": name, "po_no": rec.marketplace_po_no if rec else None,
					"order_id": l.marketplace_order_id, "kind": "Return" if flt(l.qty) < 0 else "Sale", "item_code": l.item_code,
					"sku": l.marketplace_sku, "qty": flt(l.qty), "selling_rate": flt(l.selling_rate), "commission_percent": flt(l.commission_percent),
					"net_rate": net, "primary_rate": flt(l.primary_rate), "value": round(flt(l.qty) * flt(l.selling_rate), 2),
					"variance": round(calculations.line_variance(l), 2), "note_status": l.note_status, "note": l.sales_invoice,
					"realisation": round(net / flt(l.primary_rate) * 100, 1) if flt(l.primary_rate) else None,
				})
		return out

	if dataset == "movements":
		out = []
		for name, ms in movements.items():
			rec = by_name.get(name)
			for m in ms:
				date = m.dispatch_date or m.initiation_date
				if not dated(date):
					continue
				pending = calculations.pending_qty(m)
				out.append({
					"record": name, "marketplace": rec.marketplace if rec else None, "po_no": rec.marketplace_po_no if rec else None,
					"type": m.movement_type, "status": m.status, "item_code": m.item_code, "qty": flt(m.qty), "received": flt(m.received_qty),
					"pending": pending, "date": str(date) if date else None, "month": str(date)[:7] if date else None,
					"age": (today - getdate(date)).days if date and pending > 0 else None,
					"reference": m.delivery_note or m.reference_name, "awb_no": m.awb_no,
				})
		return out

	frappe.throw("Unknown dataset")
