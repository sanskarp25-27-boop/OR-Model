"""Primary Sales and Primary Returns on an OR Primary Sales Tracker. Only the Delivery Notes move stock
(postings.py); every other step is virtual, kept on the tracker rows:

    Pick, pack & dispatch                     -> Delivery Note (stock out); Primary Sale row (Dispatched)
    Marketplace confirms receipt (with POD)   -> Record receipt on that row: in transit -> at the marketplace
    Marketplace raises a return               -> Primary Return row (Return Initiated)
    Return shipped back (AWB)                 -> Mark dispatched: at the marketplace -> return in transit
    Goods arrive and are put away             -> Putaway: return Delivery Note (stock back) plus Return Credit Note

The tracker rows are the record of what the marketplace holds; it never appears in the Stock Ledger.
"""

import frappe
from frappe import _
from frappe.utils import flt, nowdate

from or_model.marketplace_or import calculations, postings

OR = "OR Primary Sales Tracker"


# Manual actions (called from the OR form)


def record_receipt(ort, row_name, qty, pod=None, posting_date=None):
	"""One dispatch line received (kept for single-line calls); see record_receipts."""
	record_receipts(ort, [{"row": row_name, "qty": qty}], pod, posting_date)
	return row_name


def record_receipts(ort, lines, pod=None, posting_date=None):
	"""The marketplace confirmed receipt with one POD, SKU by SKU: lines = [{row, qty}] on dispatched Primary
	Sale rows. A qty below what was dispatched leaves the rest in transit (short receipt)."""
	require_editable(ort)
	if not pod:
		frappe.throw(_("Attach the POD (Proof of Delivery) to record the marketplace's receipt."))
	lines = [line for line in (frappe.parse_json(lines) or []) if flt(line.get("qty")) > 0]
	if not lines:
		frappe.throw(_("Enter the received qty for at least one SKU."))

	rows = []
	for line in lines:
		row = _row(ort, line.get("row"))
		qty = flt(line.get("qty"))
		if row.movement_type != calculations.OUTBOUND or row.status not in ("Dispatched", "Partially Received"):
			frappe.throw(_("Receipts are recorded on dispatched Primary Sale rows. Primary Returns are received by Putaway."))
		pending = flt(row.qty) - flt(row.received_qty)
		if qty > pending + 1e-9:
			frappe.throw(_("{0}: received qty {1} is more than the {2} pending.").format(row.item_code, f"{qty:g}", f"{pending:g}"))
		rows.append((row, qty))

	# virtual: the goods already left your stock with the Delivery Note; the POD only moves them from
	# "in transit" to "at the marketplace" on the tracker
	for row, qty in rows:
		row.received_qty = flt(row.received_qty) + qty
		row.status = "Received" if row.received_qty >= flt(row.qty) else "Partially Received"
		row.pod = pod
	_attach_pod(ort, pod)
	save(ort)
	ort.add_comment(
		"Info",
		_("Primary Sale receipt recorded (POD {0}): {1}").format(pod, ", ".join(f"{qty:g} x {row.item_code}" for row, qty in rows)),
	)
	return None


def _attach_pod(ort, file_url):
	"""Attach the uploaded POD to the OR Primary Sales Tracker so it is listed with its attachments."""
	file_name = frappe.db.get_value("File", {"file_url": file_url, "attached_to_name": ("is", "not set")}, "name")
	if file_name:
		frappe.db.set_value("File", file_name, {"attached_to_doctype": OR, "attached_to_name": ort.name})
	elif not frappe.db.exists("File", {"file_url": file_url, "attached_to_doctype": OR, "attached_to_name": ort.name}):
		frappe.throw(_("The POD file {0} was not found. Attach it again.").format(file_url))


def initiate_return(ort, item_code, qty, reference, initiation_date=None, awb_no=None):
	require_editable(ort)
	qty = _positive(qty)
	if not reference:
		frappe.throw(_("Enter the marketplace's return number."))
	position = calculations.item_positions(ort.stock_movements, ort.get_lines()).get(item_code) or {}
	available = flt(position.get("available"))
	if qty > available + 1e-9:
		frappe.throw(
			_("Only {0} units of {1} are held by {2} and not already in a Primary Return.").format(
				max(available, 0), item_code, ort.marketplace
			)
		)
	row = ort.append(
		"stock_movements",
		{
			"movement_type": calculations.RETURN,
			"item_code": item_code,
			"qty": qty,
			"received_qty": 0,
			"reference_name": reference,
			"initiation_date": initiation_date or nowdate(),
			"awb_no": awb_no or "",
			"status": "Return Initiated",
		},
	)
	save(ort)
	return row.name


def mark_dispatched(ort, row_name, awb_no=None, dispatch_date=None):
	require_editable(ort)
	row = _row(ort, row_name)
	if row.status != "Return Initiated":
		frappe.throw(_("Only a Primary Return in status Return Initiated can be marked dispatched."))
	if not (awb_no or row.awb_no):
		frappe.throw(_("Enter the AWB / Tracking ID of the return shipment."))
	row.dispatch_date = dispatch_date or nowdate()
	row.awb_no = awb_no or row.awb_no
	row.status = "Return Dispatched"  # virtual: the goods come back into stock at Putaway
	save(ort)
	return row.name


def putaway(ort, row_name, qty, warehouse=None, posting_date=None):
	"""Returned goods arrived at your warehouse and are put away: a return Delivery Note brings them back into
	stock, and the marketplace is credited for them on the primary invoice(s)."""
	require_editable(ort)
	row = _row(ort, row_name)
	qty = _positive(qty)
	if row.movement_type != calculations.RETURN or row.status not in ("Return Dispatched", "Partially Received"):
		frappe.throw(_("Put away goods of a Primary Return that is dispatched (in transit back to you)."))
	pending = flt(row.qty) - flt(row.received_qty)
	if qty > pending + 1e-9:
		frappe.throw(_("Qty must be between 1 and {0}.").format(f"{pending:g}"))
	entry, credit_notes = postings.putaway(ort, row, qty, warehouse, posting_date)
	row.received_qty = flt(row.received_qty) + qty
	row.status = "Return Completed" if row.received_qty >= flt(row.qty) else "Partially Received"
	row.delivery_note = entry.split(", ")[-1] if entry else row.delivery_note
	if credit_notes:
		row.sales_invoice = credit_notes[-1]
	save(ort)
	ort.add_comment(
		"Info",
		_("Primary Return {0}: {1} x {2} put away ({3}){4}").format(
			row.reference_name, f"{qty:g}", row.item_code, entry,
			_(", credit note {0}").format(", ".join(credit_notes)) if credit_notes else "",
		),
	)
	return {"delivery_note": entry, "credit_notes": credit_notes}


def cancel_movement(ort, row_name):
	require_editable(ort)
	row = _row(ort, row_name)
	if row.movement_type != calculations.RETURN:
		frappe.throw(_("A Primary Sale follows its Delivery Note: cancel the Delivery Note instead."))
	if flt(row.received_qty):
		frappe.throw(_("Part of this Primary Return has already been put away, so it cannot be cancelled."))
	row.status = "Cancelled"
	save(ort)
	return row.name


# Helpers shared with sales.py and notes.py


def require_editable(ort):
	ort.check_permission("write")
	if ort.status == "Closed":
		frappe.throw(_("{0} is Closed and read-only.").format(ort.name))


def save(ort, system=False):
	ort.flags.ignore_permissions = True
	ort.flags.or_system = system
	ort.save()


def set_system_status(ort, status, reason):
	"""Automatic workflow steps (first dispatch, first import) that no user chooses."""
	ort.db_set("status", status, notify=True)
	ort.add_comment("Info", _("Status changed to {0}: {1}").format(_(status), reason))


def _row(ort, row_name):
	for row in ort.stock_movements:
		if row.name == row_name:
			return row
	frappe.throw(_("Stock movement {0} not found on {1}.").format(row_name, ort.name))


def _positive(qty):
	qty = flt(qty)
	if qty <= 0:
		frappe.throw(_("Qty must be greater than zero."))
	return qty
