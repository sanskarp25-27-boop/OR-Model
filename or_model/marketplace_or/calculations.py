"""OR quantities and price variance as plain functions, so they can be tested without a database.

Rows can be dicts or Frappe documents; only `.get()` is used.

Primary Sale / Primary Return: between you and the marketplace (movement rows on the OR Primary Sales Tracker).
Secondary Sale / Secondary Return: the marketplace and its end customer (OR Secondary Sales Orders; a
Secondary Return is one with negative qty against the sale it returns).

    Stock in Transit     = primary sale dispatched (not Draft/Cancelled) - primary sale received
    Stock at Marketplace = primary sale received - secondary sold + secondary returned - primary return dispatched
    Return in Transit    = primary return dispatched - primary return received
    Return Pending       = primary return initiated - primary return dispatched

A return only reduces virtual stock once it is dispatched, so nothing is counted twice.

Price variance per unit = Secondary Rate without Commission - Primary Rate, where
Secondary Rate without Commission = Secondary Rate x (1 - commission %).
"""

from collections import defaultdict
from datetime import date

from frappe.utils import flt, getdate

OUTBOUND = "Primary Sale"
RETURN = "Primary Return"
DEBIT_NOTE = "Debit Note"
CREDIT_NOTE = "Credit Note"

OUTBOUND_STATUSES = ("Draft", "Dispatched", "Partially Received", "Received", "Cancelled")
RETURN_STATUSES = ("Return Initiated", "Return Dispatched", "Partially Received", "Return Completed", "Cancelled")

QTY_PRECISION = 6


def net_rate(secondary_rate, commission_percent):
	"""Secondary Rate without Commission: the commission % is deducted from the Secondary Rate."""
	return flt(flt(secondary_rate) * (1 - flt(commission_percent) / 100), 2)


def net_secondary_rate(line):
	return net_rate(line.get("selling_rate"), line.get("commission_percent"))


def note_type_for(primary_rate, net_secondary_rate):
	"""Secondary Rate without Commission above the Primary Rate -> Debit Note; below -> Credit Note; equal -> none."""
	difference = flt(net_secondary_rate) - flt(primary_rate)
	if abs(difference) < 0.005:
		return None
	return DEBIT_NOTE if difference > 0 else CREDIT_NOTE


def line_note_type(line):
	"""Note due for a line, from the sign of its variance.

	A Secondary Return carries a negative qty, so it reverses its sale: a sale that needed a
	Credit Note gets a Debit Note for the returned units, and the other way round.
	"""
	variance = line_variance(line)
	if abs(variance) < 0.005:
		return None
	return DEBIT_NOTE if variance > 0 else CREDIT_NOTE


def line_variance(line):
	return (net_secondary_rate(line) - flt(line.get("primary_rate"))) * flt(line.get("qty"))


def below_primary(line):
	"""The sale behind a line went below the primary rate: its variance is booked to the OR Sale Provision."""
	return flt(line.get("primary_rate")) - net_secondary_rate(line) > 0.005


def provision_amount(line):
	"""Primary minus secondary value of a line sold below the primary rate (negative for a secondary return)."""
	if not below_primary(line):
		return 0.0
	return (flt(line.get("primary_rate")) - net_secondary_rate(line)) * flt(line.get("qty"))


def pending_qty(movement):
	if movement.get("status") in ("Draft", "Cancelled", "Return Initiated"):
		return 0
	return flt(movement.get("qty")) - flt(movement.get("received_qty"))


def item_positions(movements, lines):
	"""Quantities and values per item code."""
	positions = defaultdict(_empty_position)

	for movement in movements:
		status = movement.get("status")
		if status == "Cancelled":
			continue
		qty, received = flt(movement.get("qty")), flt(movement.get("received_qty"))
		position = positions[movement.get("item_code")]

		if movement.get("movement_type") == OUTBOUND:
			if status == "Draft":
				continue
			position["dispatched"] += qty
			position["received"] += received
		else:
			position["return_initiated"] += qty
			if status != "Return Initiated":
				position["return_dispatched"] += qty
			position["return_received"] += received

	for line in lines:
		# a Secondary Return is a line with negative qty: it nets off the values and gives the stock back
		qty = flt(line.get("qty"))
		variance = line_variance(line)
		position = positions[line.get("item_code")]
		if qty < 0:
			position["secondary_returned"] -= qty
		else:
			position["sold"] += qty
		position["primary_value"] += qty * flt(line.get("primary_rate"))
		position["secondary_value"] += qty * flt(line.get("selling_rate"))
		position["commission_value"] += qty * (flt(line.get("selling_rate")) - net_secondary_rate(line))
		position["net_variance"] += variance
		position["debit_variance"] += max(variance, 0)
		position["credit_variance"] += max(-variance, 0)
		sale_date = line.get("sale_date")
		if sale_date and (not position["last_sale"] or getdate(sale_date) > getdate(position["last_sale"])):
			position["last_sale"] = sale_date

	for position in positions.values():
		position["in_transit"] = position["dispatched"] - position["received"]
		virtual = position["received"] - position["sold"] + position["secondary_returned"] - position["return_dispatched"]
		# the marketplace may report sales of dispatched units before their POD is recorded: those units
		# come out of the in-transit qty, so neither figure goes negative and their total stays right
		position["sold_without_pod"] = max(-virtual, 0)
		position["in_transit"] -= position["sold_without_pod"]
		position["virtual_stock"] = max(virtual, 0)
		position["return_in_transit"] = position["return_dispatched"] - position["return_received"]
		position["return_pending"] = position["return_initiated"] - position["return_dispatched"]
		# what can still be reported sold or sent back: held stock not already earmarked for a return
		position["available"] = position["virtual_stock"] - position["return_pending"]
		# what secondary sales may be imported against: held stock plus units dispatched without a POD yet
		position["sellable"] = position["available"] + position["in_transit"]
		for key, value in position.items():
			if isinstance(value, float):
				position[key] = round(value, QTY_PRECISION)

	return dict(positions)


def summarize(movements, lines, notes):
	"""Every calculated field on OR Primary Sales Tracker."""
	positions = item_positions(movements, lines).values()
	total = lambda key: round(sum(p[key] for p in positions), QTY_PRECISION)  # noqa: E731

	submitted = [n for n in notes if n.get("status") == "Submitted"]
	debit = sum(flt(n.get("amount")) for n in submitted if n.get("note_type") == DEBIT_NOTE)
	credit = sum(flt(n.get("amount")) for n in submitted if n.get("note_type") == CREDIT_NOTE)

	variance_lines = [line for line in lines if line_note_type(line)]
	without_note = [line for line in variance_lines if not line.get("price_note")]

	if not lines:
		reconciliation = "Pending"
	elif without_note:
		reconciliation = "Variance not invoiced"
	elif any(n.get("status") == "Draft" for n in notes):
		reconciliation = "Notes awaiting submission"
	else:
		reconciliation = "Reconciled"

	return {
		"total_dispatched_qty": total("dispatched"),
		"marketplace_received_qty": total("received"),
		"pending_receipt_qty": total("in_transit"),
		"total_sold_qty": total("sold"),
		"secondary_return_qty": total("secondary_returned"),
		"primary_sales_value": total("primary_value"),
		"secondary_sales_value": total("secondary_value"),
		"marketplace_commission": total("commission_value"),
		"net_price_variance": total("net_variance"),
		"virtual_stock": total("virtual_stock"),
		"stock_in_transit": total("in_transit"),
		"return_in_transit": total("return_in_transit"),
		"return_initiated_qty": total("return_initiated"),
		"return_received_qty": total("return_received"),
		"return_pending_qty": total("return_pending"),
		"debit_note_amount": debit,
		"credit_note_amount": credit,
		"net_adjustment_amount": debit - credit,
		# booked at import and not yet cleared by a submitted note
		"provision_amount": round(sum(provision_amount(line) for line in lines if line.get("note_status") != "Submitted"), 2),
		"variance_not_invoiced": sum(abs(line_variance(line)) for line in without_note),
		"reconciliation_status": reconciliation,
	}


def group_lines_for_notes(lines, group_by, by_invoice=False):
	"""One group per (month / sale date / import batch, primary invoice, note type) for variance lines not yet
	in a note. With by_invoice, lines not yet tied to a primary invoice wait (they are left out)."""
	groups = {}
	for line in lines:
		note_type = line_note_type(line)
		if not note_type or line.get("price_note"):
			continue
		invoice = line.get("primary_invoice") or ""
		if by_invoice and not invoice:
			continue
		if group_by == "Import Batch":
			key = line.get("import_batch")
		elif group_by == "Month":
			key = getdate(line.get("sale_date")).strftime("%Y-%m")
		else:
			key = str(getdate(line.get("sale_date")))
		groups.setdefault((key, invoice, note_type), []).append(line)

	return [
		{
			"group_key": key,
			"primary_invoice": invoice or None,
			"note_type": note_type,
			"lines": group,
			"amount": round(sum(abs(line_variance(line)) for line in group), 2),
		}
		for (key, invoice, note_type), group in sorted(groups.items())
	]


def validate_import_rows(rows, sku_map, existing_order_ids, available_by_item, commission_percent=0):
	"""Check a secondary-sales file.

	Returns (accepted, duplicates, errors). Nothing should be imported when errors is not empty.
	sku_map: {marketplace_sku: {"item_code", "primary_rate"}}; available_by_item: {item_code: qty};
	commission_percent: the marketplace's commission, stored on every accepted line.
	"""
	accepted, duplicates, errors = [], [], []
	seen = set(existing_order_ids)
	needed = defaultdict(float)

	for number, row in enumerate(rows, start=1):
		number = row.get("_row") or number  # the row's line number in the original file, when known
		order_id = str(row.get("marketplace_order_id") or "").strip()
		sku = str(row.get("marketplace_sku") or "").strip()
		if not order_id:
			errors.append(f"Row {number}: marketplace_order_id is missing")
			continue
		if order_id in seen:
			duplicates.append(order_id)
			continue

		mapping = sku_map.get(sku)
		if not mapping:
			errors.append(f"Row {number}: SKU {sku or '(blank)'} is not set on any Item for this marketplace")
			continue
		if flt(mapping["primary_rate"]) <= 0:
			errors.append(
				f"Row {number}: no primary rate for {mapping['item_code']}: it is not on the Sales Order "
				"and has no OR Item Mapping"
			)
			continue

		try:
			sale_date = _parse_date(row.get("sale_date"))
			qty = float(row.get("qty"))
			selling_price = float(row.get("selling_price"))
		except (TypeError, ValueError):
			errors.append(f"Row {number}: check sale_date (YYYY-MM-DD), qty and selling_price")
			continue
		if qty <= 0 or selling_price < 0:
			errors.append(f"Row {number}: qty must be above 0 and selling_price cannot be negative")
			continue

		seen.add(order_id)
		needed[mapping["item_code"]] += qty
		# a line can carry its own commission (worked out from the file's net payout)
		line_commission = row.get("commission_percent")
		line_commission = commission_percent if line_commission in (None, "") else line_commission
		accepted.append(
			{
				"marketplace_order_id": order_id,
				"sale_date": sale_date,
				"marketplace_sku": sku,
				"item_code": mapping["item_code"],
				"qty": qty,
				"primary_rate": flt(mapping["primary_rate"]),
				"selling_rate": selling_price,
				"commission_percent": flt(line_commission),
				"net_secondary_rate": net_rate(selling_price, line_commission),
			}
		)

	for item_code, qty in needed.items():
		available = flt(available_by_item.get(item_code))
		if qty > available + 1e-9:
			errors.append(
				f"{qty:g} x {item_code} reported as secondary sales, but only {max(available, 0):g} are held by the "
				"marketplace or dispatched to it, and not already in a primary return"
			)

	return accepted, duplicates, errors


def _parse_date(value):
	if isinstance(value, date):
		return value
	text = str(value or "").strip()
	if len(text) != 10 or text[4] != "-" or text[7] != "-":
		raise ValueError(text)
	return getdate(text)


def _empty_position():
	return {
		"dispatched": 0.0,
		"received": 0.0,
		"sold": 0.0,
		"secondary_returned": 0.0,
		"return_initiated": 0.0,
		"return_dispatched": 0.0,
		"return_received": 0.0,
		"primary_value": 0.0,
		"secondary_value": 0.0,
		"commission_value": 0.0,
		"net_variance": 0.0,
		"debit_variance": 0.0,
		"credit_variance": 0.0,
		"last_sale": None,
	}
