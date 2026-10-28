"""Month-end rate-difference settlement, on the Secondary Rate without Commission against the Primary Rate:
a Credit Note when it is below the Primary Rate, a Debit Note when above.

Notes are Sales Invoices (no stock) to the billing customer, one per (month, primary invoice, note type), made
against the Primary Sales Invoice the units were billed on. A line sold below the primary rate posts to the OR
Sale Provision booked at import (the Credit Note clears it: Provision Dr / Customer Cr); a line above it posts to
the OR Sales Variance (the Debit Note: Customer Dr / Variance Cr). Each OR Secondary Sales Order points at
exactly one note row, so a line can never be noted twice.

Return Credit Notes (goods put away after a primary return) are made here too.
"""

import frappe
from frappe import _
from frappe.utils import add_months, flt, get_last_day, getdate, nowdate

from or_model.marketplace_or import calculations, postings, stock
from or_model.marketplace_or.doctype.marketplace_or_settings.marketplace_or_settings import (
	default_company,
	get_account,
)

OR = "OR Primary Sales Tracker"
SECONDARY = "OR Secondary Sales Order"
NOTE_TYPES = (calculations.DEBIT_NOTE, calculations.CREDIT_NOTE)


def create_notes(ort, upto=None):
	"""Month-end settlement for secondary sales up to `upto` (default: the end of last month)."""
	stock.require_editable(ort)
	postings.config(ort.marketplace)
	upto = getdate(upto) if upto else get_last_day(add_months(nowdate(), -1))
	settings = frappe.get_cached_doc("Marketplace OR Settings")
	account = get_account(ort.marketplace)
	postings.assign_primary_invoices(ort, upto)
	lines = [line for line in ort.get_lines() if getdate(line.sale_date) <= upto]
	groups = calculations.group_lines_for_notes(lines, settings.group_notes_by or "Month", by_invoice=True)
	if not groups:
		stock.save(ort)
		return []

	created = []
	for group in groups:
		invoice = _note_invoice(ort, account, group, min(upto, getdate(nowdate())))
		row = ort.append(
			"price_notes",
			{
				"note_type": group["note_type"],
				"group_key": f"{group['group_key']} · {group['primary_invoice']}",
				"line_count": len(group["lines"]),
				"amount": group["amount"],
				"status": "Draft",
				"sales_invoice": invoice.name,
			},
		)
		created.append((row, group, invoice))
	stock.save(ort)  # gives the note rows their names

	for row, group, invoice in created:
		for line in group["lines"]:
			frappe.db.set_value(
				SECONDARY,
				line.name,
				{"price_note": row.name, "note_status": "Draft", "sales_invoice": invoice.name},
				update_modified=False,
			)
	ort.add_comment(
		"Info",
		_("Created {0} draft note(s): {1}").format(
			len(created), ", ".join(f"{r.note_type} {flt(r.amount):,.2f} ({r.group_key})" for r, _g, _i in created)
		),
	)

	if settings.auto_submit_notes:
		frappe.flags.or_auto_submit = True
		try:
			for _row, _group, invoice in created:
				invoice.reload()
				invoice.submit()
		finally:
			frappe.flags.or_auto_submit = False
		ort.reload()
	else:
		stock.save(ort)  # recalculate now that the lines are in notes
	return [row.name for row, _group, _invoice in created]


def submit_draft_notes(ort):
	stock.require_editable(ort)
	_require_approver()
	drafts = [row.sales_invoice for row in ort.price_notes if row.status == "Draft"]
	if not drafts:
		frappe.throw(_("There are no draft notes to submit."))
	for name in drafts:
		frappe.get_doc("Sales Invoice", name).submit()
	ort.reload()
	return len(drafts)


# Sales Invoice hooks


def before_invoice_submit(doc, method=None):
	if doc.get("or_document_type") in NOTE_TYPES and not frappe.flags.or_auto_submit:
		_require_approver()


def on_invoice_submit(doc, method=None):
	if doc.get("or_document_type") not in NOTE_TYPES:
		return
	ort = frappe.get_doc(OR, doc.or_reference)
	row = _note_row(ort, doc.name)
	row.status = "Submitted"
	row.submitted_on = nowdate()
	ort.last_note_submitted_on = nowdate()
	_set_line_status(row.name, "Submitted")
	stock.save(ort, system=True)


def before_invoice_cancel(doc, method=None):
	if doc.get("or_document_type") not in NOTE_TYPES:
		return
	if frappe.db.get_value(OR, doc.or_reference, "status") == "Closed":
		frappe.throw(_("{0} is Closed, so its notes cannot be cancelled.").format(doc.or_reference))


def on_invoice_cancel(doc, method=None):
	if doc.get("or_document_type") not in NOTE_TYPES:
		return
	ort = frappe.get_doc(OR, doc.or_reference)
	row = _note_row(ort, doc.name)
	# free the lines so they can go into a new note
	for line in frappe.get_all(SECONDARY, filters={"price_note": row.name}, pluck="name"):
		frappe.db.set_value(
			SECONDARY,
			line,
			{"price_note": None, "note_status": "Not created", "sales_invoice": None},
			update_modified=False,
		)
	ort.remove(row)
	stock.save(ort, system=True)
	if ort.status == "Reconciled":
		stock.set_system_status(ort, "Under Reconciliation", _("note {0} cancelled").format(doc.name))


# Helpers


def _note_invoice(ort, account, group, posting_date=None):
	debit = group["note_type"] == calculations.DEBIT_NOTE
	lines = group["lines"]
	primary = group.get("primary_invoice")
	# ERPNext refuses a non-return invoice against a Closed / On Hold order; the note is still found via or_reference
	link_order = not debit or frappe.db.get_value("Sales Order", ort.sales_order, "status") not in ("Closed", "On Hold")
	# a credit note links to its invoice (return_against) while ERPNext's returnable qty allows it; otherwise it is
	# a standalone note naming the invoice. A debit note always links (ERPNext checks no qty on debit notes).
	against = primary
	if primary and not debit:
		need = {}
		for line in lines:
			need[line.item_code] = need.get(line.item_code, 0) + abs(flt(line.qty))
		if any(postings.returnable_on_invoice(primary, code) < qty - 1e-9 for code, qty in need.items()):
			against = None

	invoice = frappe.new_doc("Sales Invoice")
	invoice.update(
		{
			"naming_series": account.debit_note_series if debit else account.credit_note_series,
			# a note against an invoice goes to that invoice's customer (ERPNext requires it)
			"customer": (primary and frappe.db.get_value("Sales Invoice", primary, "customer")) or ort.customer or account.customer,
			"company": default_company(),
			"posting_date": posting_date or nowdate(),
			"set_posting_time": 1 if posting_date else 0,
			"is_debit_note": 1 if debit else 0,
			"is_return": 0 if debit else 1,
			"return_against": against,
			"update_stock": 0,
			"ignore_pricing_rule": 1,
			"cost_center": account.cost_center,
			"or_reference": ort.name,
			"or_document_type": group["note_type"],
			"remarks": _("{0} rate difference, {1}: {2} lines. Primary invoice: {3}").format(
				ort.name, group["group_key"], len(lines), primary or "-"
			),
		}
	)
	invoice.flags.dont_auto_add_taxes = True
	for line in lines:
		net = calculations.net_secondary_rate(line)
		per_unit = abs(net - flt(line.primary_rate))
		qty = abs(flt(line.qty))  # a Secondary Return line has negative qty; the note type carries the direction
		invoice.append(
			"items",
			{
				"item_code": line.item_code,
				"qty": qty if debit else -qty,
				"rate": per_unit,
				"price_list_rate": per_unit,
				# below the primary rate: the variance was provided for at import, so the note clears the
				# OR Sale Provision; above it: the note bills (or, for a return, refunds) the OR Sales Variance
				"income_account": account.provision_account if postings.below_primary(line) else account.variance_account,
				"cost_center": account.cost_center,
				# sales_order without so_detail: linked to the order, its billed amount is untouched
				"sales_order": ort.sales_order if link_order else None,
				"or_secondary_sales_order": line.name,
				"description": _(
					"{0} {7} {1} ({2}): Secondary Rate {3}, Commission {4}%, Secondary Rate without Commission {5}, Primary Rate {6}"
				).format(
					ort.marketplace,
					line.marketplace_order_id,
					line.sale_date,
					flt(line.selling_rate),
					flt(line.get("commission_percent")),
					net,
					flt(line.primary_rate),
					_("secondary return") if flt(line.qty) < 0 else _("secondary sale"),
				),
			},
		)
	invoice.insert(ignore_permissions=True)
	return invoice


def make_return_invoice(ort, primary_invoice, item_code, qty, posting_date=None):
	"""Return Credit Note: credit qty units of item_code returned and put away, against the primary invoice
	that billed them (its rate and taxes), no stock (the return Delivery Note brought the goods back). Submitted at once."""
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import make_sales_return

	account = get_account(ort.marketplace)
	note = make_sales_return(primary_invoice)
	kept, left = [], flt(qty)
	for item in note.items:
		if item.item_code != item_code or left <= 1e-9:
			continue
		take = min(left, abs(flt(item.qty)))
		item.qty = -take
		left -= take
		kept.append(item)
	if not kept:
		frappe.throw(_("{0} is not on {1}.").format(item_code, primary_invoice))
	note.set("items", kept)
	note.update(
		{
			"naming_series": account.credit_note_series or note.naming_series,
			"update_stock": 0,
			"or_reference": ort.name,
			"or_document_type": postings.RETURN_CREDIT_NOTE,
			"remarks": _("{0}: {1} × {2} returned by {3} and put away").format(ort.name, f"{flt(qty):g}", item_code, ort.marketplace),
		}
	)
	if posting_date:
		note.set_posting_time = 1
		note.posting_date = posting_date
	note.flags.ignore_permissions = True
	note.insert()
	note.submit()
	return note.name


def _note_row(ort, invoice_name):
	for row in ort.price_notes:
		if row.sales_invoice == invoice_name:
			return row
	frappe.throw(_("{0} is not a note on {1}.").format(invoice_name, ort.name))


def _set_line_status(note_row, status):
	for line in frappe.get_all(SECONDARY, filters={"price_note": note_row}, pluck="name"):
		frappe.db.set_value(SECONDARY, line, "note_status", status, update_modified=False)


def _require_approver():
	role = frappe.db.get_single_value("Marketplace OR Settings", "approver_role") or "Accounts Manager"
	if role not in frappe.get_roles():
		frappe.throw(_("Only users with the {0} role can submit debit and credit notes.").format(role), frappe.PermissionError)
