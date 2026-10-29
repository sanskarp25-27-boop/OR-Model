"""Stock and accounting documents of the OR process: an outright sale to the marketplace.

The primary sale is an ordinary sale: a Delivery Note takes the goods out of your warehouse and a Sales
Invoice bills the marketplace at the primary rate. Everything after that is virtual: the POD, the
marketplace's stock and its secondary sales live only on the OR Primary Sales Tracker, never in the Stock
Ledger. The only entries of a secondary sale are for its price variance:

    Dispatch (Delivery Note)          own warehouse -> customer (standard stock and COGS entries)
    Primary invoice (Sales Invoice)   Billing Customer Dr / Sales Cr, at the primary rate (standard)
    POD, marketplace stock            no entries (tracker only)
    Secondary sale below primary      Journal: OR Sales Variance Dr / OR Sale Provision Cr (primary - secondary)
    Secondary sale above primary      no entry; month-end Debit Note
    Month-end Credit Note             OR Sale Provision Dr / Billing Customer Cr, against the primary invoice
    Month-end Debit Note              Billing Customer Dr / OR Sales Variance Cr, against the primary invoice
    Primary return put away           Return Delivery Note (stock back) + Return Credit Note on the primary invoice

Example, primary rate 299 and secondary 289 after commission: the import books 10 to the provision, and
the month-end Credit Note of 10 clears it against the marketplace's balance. A secondary return posts its
sale's provision entry reversed.
"""

from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate

from or_model.marketplace_or import calculations
from or_model.marketplace_or.doctype.marketplace_or_settings.marketplace_or_settings import default_company, get_account

OR = "OR Primary Sales Tracker"
SECONDARY = "OR Secondary Sales Order"
NOTE_TYPES = (calculations.DEBIT_NOTE, calculations.CREDIT_NOTE)
PRIMARY_INVOICE = "Primary Invoice"
RETURN_CREDIT_NOTE = "Return Credit Note"

REQUIRED = {
	"provision_account": "OR Sale Provision Account",
	"variance_account": "OR Sales Variance Account",
}


def config(marketplace):
	"""The marketplace's accounting row, with every ledger the process needs."""
	row = get_account(marketplace)
	missing = [label for field, label in REQUIRED.items() if not row.get(field)]
	if missing:
		frappe.throw(
			_("Set up {0} for OR under Marketplace OR Settings > Marketplace Accounts (or use “Set up OR masters”): {1}.").format(
				marketplace, ", ".join(missing)
			),
			title=_("OR accounting not set up"),
		)
	return row


def is_or_order(sales_order):
	return bool(sales_order) and frappe.get_cached_value("Sales Order", sales_order, "sales_flow") == "OR"


def tracker_of(sales_order):
	if not is_or_order(sales_order):
		return None
	return frappe.db.get_value("Sales Order", sales_order, "or_record") or frappe.db.get_value(OR, {"sales_order": sales_order})


# ---------------------------------------------------------------- helpers


def _journal(ort, purpose, against, posting_date, lines, remark):
	"""Make and submit one Journal Entry. lines: (account, signed amount: + debit / - credit)."""
	cfg = get_account(ort.marketplace)
	merged = defaultdict(float)
	for account, amount in lines:
		merged[account] += flt(amount, 2)
	je = frappe.new_doc("Journal Entry")
	je.update(
		{
			"voucher_type": "Journal Entry",
			"company": default_company(),
			"posting_date": posting_date or nowdate(),
			"or_reference": ort.name,
			"or_purpose": purpose,
			"or_against": against,
			"user_remark": remark,
		}
	)
	for account, amount in merged.items():
		if abs(amount) < 0.005:
			continue
		je.append(
			"accounts",
			{
				"account": account,
				"debit_in_account_currency": amount if amount > 0 else 0,
				"credit_in_account_currency": -amount if amount < 0 else 0,
				"cost_center": cfg.cost_center,
			},
		)
	if not je.accounts:
		return None
	je.flags.ignore_permissions = True
	je.insert()
	je.submit()
	return je.name


below_primary = calculations.below_primary
provision_amount = calculations.provision_amount


def journal_before_cancel(doc, method=None):
	"""A Sale Provision entry belongs to its imported secondary sales: it cannot be cancelled on its own."""
	if doc.get("or_reference") and doc.get("or_purpose") == "Sale Provision" and not frappe.flags.or_reversing:
		frappe.throw(_("{0} is the OR Sale Provision of secondary sales on {1}. It cannot be cancelled on its own.").format(doc.name, doc.or_reference))


# ---------------------------------------------------------------- primary sale: Delivery Note and POD


def dispatch(ort, items, awb_no=None, posting_date=None):
	"""Pick, pack & dispatch: a Delivery Note against the Primary Sales Order for the qty entered per line.
	A draft Delivery Note already made for the order (e.g. by an automation on Sales Order submit) is used
	instead of a new one. Its submit adds the Primary Sale rows (delivery_note_on_submit).

	items: [{so_detail, qty, warehouse}] (the warehouse defaults to the Sales Order line's).
	"""
	from erpnext.selling.doctype.sales_order.sales_order import make_delivery_note

	from or_model.marketplace_or import stock

	stock.require_editable(ort)
	config(ort.marketplace)
	frappe.has_permission("Delivery Note", "submit", throw=True)
	wanted = {}
	for line in items:
		qty = flt(line.get("qty"))
		if qty > 0:
			wanted[line.get("so_detail")] = (qty, line.get("warehouse"))
	if not wanted:
		frappe.throw(_("Enter a quantity for at least one item."))

	left = {
		r.name: flt(r.qty) - flt(r.delivered_qty)
		for r in frappe.get_all("Sales Order Item", filters={"parent": ort.sales_order}, fields=["name", "qty", "delivered_qty"])
	}
	draft = frappe.db.sql(
		"""select distinct dn.name from `tabDelivery Note` dn join `tabDelivery Note Item` i on i.parent = dn.name
		where dn.docstatus = 0 and dn.is_return = 0 and i.against_sales_order = %s order by dn.creation limit 1""",
		ort.sales_order,
	)
	dn = frappe.get_doc("Delivery Note", draft[0][0]) if draft else make_delivery_note(ort.sales_order)
	kept = []
	for item in dn.items:
		if item.so_detail not in wanted:
			continue
		qty, warehouse = wanted.pop(item.so_detail)
		if qty > flt(left.get(item.so_detail)) + 1e-9:
			frappe.throw(_("{0}: only {1} left to dispatch on {2}.").format(item.item_code, f"{flt(left.get(item.so_detail)):g}", ort.sales_order))
		item.qty = qty
		if warehouse:
			item.warehouse = warehouse
		if not item.warehouse:
			frappe.throw(_("Set the warehouse to dispatch {0} from.").format(item.item_code))
		kept.append(item)
	if wanted:
		frappe.throw(_("Sales Order line(s) {0} have nothing left to dispatch on {1}.").format(", ".join(wanted), ort.sales_order))
	dn.set("items", kept)
	dn.lr_no = awb_no or dn.get("lr_no")
	if posting_date:
		dn.set_posting_time = 1
		dn.posting_date = posting_date
	dn.flags.ignore_permissions = True
	dn.save()
	dn.submit()
	return dn.name


def delivery_note_validate(doc, method=None):
	"""A Delivery Note of an OR order is a Primary Sale (dispatch); a return one comes only from Putaway."""
	order = next((i.against_sales_order for i in doc.items if is_or_order(i.against_sales_order)), None)
	if not order:
		return
	tracker = tracker_of(order)
	if not tracker:
		# an automation may draft the Delivery Note in the order's on_submit, before the tracker is made
		if doc.docstatus == 0:
			return
		frappe.throw(_("{0} has no OR Primary Sales Tracker. Submit the Sales Order first.").format(order))
	doc.or_reference = tracker
	if doc.is_return and not frappe.flags.or_putaway:
		frappe.throw(
			_("{0} is an OR order. Record the primary return in the OR app (Initiate Return, then Putaway): it makes this return Delivery Note.").format(order),
			title=_("Not allowed for OR"),
		)


def delivery_note_on_submit(doc, method=None):
	"""Add the Primary Sale rows (one per item) for a dispatch Delivery Note."""
	if not doc.get("or_reference") or doc.is_return:
		return
	from or_model.marketplace_or import stock

	ort = frappe.get_doc(OR, doc.or_reference)
	by_item = defaultdict(float)
	for item in doc.items:
		by_item[item.item_code] += flt(item.stock_qty or item.qty)
	# an invoice may already bill this Delivery Note (made by an automation in its own on_submit)
	invoice = frappe.db.get_value(
		"Sales Invoice Item", {"delivery_note": doc.name, "docstatus": 1}, "parent"
	)
	for item_code, qty in by_item.items():
		ort.append(
			"stock_movements",
			{
				"movement_type": calculations.OUTBOUND,
				"item_code": item_code,
				"qty": qty,
				"received_qty": 0,
				"reference_name": doc.name,
				"delivery_note": doc.name,
				"initiation_date": doc.posting_date,
				"dispatch_date": doc.posting_date,
				"awb_no": doc.get("lr_no") or "",
				"status": "Dispatched",
				"sales_invoice": invoice,
			},
		)
	stock.save(ort, system=True)
	if ort.status == "Submitted":
		stock.set_system_status(ort, "Active", _("first dispatch ({0})").format(doc.name))


def delivery_note_before_cancel(doc, method=None):
	if not doc.get("or_reference") or doc.is_return:
		return
	ort = frappe.get_doc(OR, doc.or_reference)
	if any(r.delivery_note == doc.name and flt(r.received_qty) for r in ort.stock_movements):
		frappe.throw(_("{0} has already confirmed receiving goods from {1}. Record a Primary Return instead.").format(ort.marketplace, doc.name))


def delivery_note_on_cancel(doc, method=None):
	if not doc.get("or_reference") or doc.is_return:
		return
	from or_model.marketplace_or import stock

	ort = frappe.get_doc(OR, doc.or_reference)
	for row in ort.stock_movements:
		if row.delivery_note == doc.name and row.movement_type == calculations.OUTBOUND:
			row.status = "Cancelled"
	stock.save(ort, system=True)


# ---------------------------------------------------------------- primary sales invoice


def make_primary_invoice(ort, posting_date=None):
	"""Bill the marketplace for every dispatch not yet billed: a standard Sales Invoice per Delivery Note."""
	from erpnext.stock.doctype.delivery_note.delivery_note import make_sales_invoice

	from or_model.marketplace_or import stock

	stock.require_editable(ort)
	frappe.has_permission("Sales Invoice", "create", throw=True)
	notes = list(dict.fromkeys(
		r.delivery_note for r in ort.stock_movements
		if r.movement_type == calculations.OUTBOUND and r.status not in ("Draft", "Cancelled") and r.delivery_note
	))
	made = []
	for dn in notes:
		if flt(frappe.db.get_value("Delivery Note", dn, "per_billed")) >= 100:
			continue
		si = make_sales_invoice(dn)
		if not si.items:
			continue
		if posting_date:
			si.set_posting_time = 1
			si.posting_date = posting_date
		si.flags.ignore_permissions = True
		si.insert()
		si.submit()
		made.append(si.name)
	if not made:
		frappe.throw(_("Everything dispatched on {0} is already invoiced.").format(ort.name))
	return ", ".join(made)


def _order_of_invoice(doc):
	for item in doc.items:
		order = item.sales_order or (item.dn_detail and frappe.db.get_value("Delivery Note Item", item.dn_detail, "against_sales_order"))
		if is_or_order(order):
			return order
	return None


def sales_invoice_validate(doc, method=None):
	"""A Sales Invoice billing an OR order is its Primary Invoice; a return against one is a Return Credit Note."""
	if doc.get("or_document_type") in (*NOTE_TYPES, RETURN_CREDIT_NOTE):
		return
	if doc.is_return and doc.return_against and frappe.db.get_value("Sales Invoice", doc.return_against, "or_document_type") == PRIMARY_INVOICE:
		doc.or_reference = frappe.db.get_value("Sales Invoice", doc.return_against, "or_reference")
		doc.or_document_type = RETURN_CREDIT_NOTE
		return
	order = _order_of_invoice(doc)
	if not order or doc.is_return:
		return
	tracker = tracker_of(order)
	if tracker:
		doc.or_reference = tracker
		doc.or_document_type = PRIMARY_INVOICE


def sales_invoice_on_submit(doc, method=None):
	if doc.get("or_reference") and doc.get("or_document_type") == PRIMARY_INVOICE:
		_link_invoice_to_dispatches(frappe.get_doc(OR, doc.or_reference), doc)


def sales_invoice_on_cancel(doc, method=None):
	if not doc.get("or_reference") or doc.get("or_document_type") != PRIMARY_INVOICE:
		return
	for row in frappe.get_all("Marketplace OR Stock Movement", filters={"parent": doc.or_reference, "sales_invoice": doc.name}, pluck="name"):
		frappe.db.set_value("Marketplace OR Stock Movement", row, "sales_invoice", None, update_modified=False)


def _link_invoice_to_dispatches(ort, invoice):
	"""Show the invoice on the dispatch rows of the Delivery Notes it bills."""
	billed = {i.delivery_note for i in invoice.items if i.delivery_note}
	for row in ort.stock_movements:
		if row.movement_type == calculations.OUTBOUND and row.delivery_note in billed and not row.sales_invoice:
			row.db_set("sales_invoice", invoice.name, update_modified=False)


def primary_invoices(ort_name):
	"""{(invoice, item_code): qty} of the submitted Primary Invoices, oldest first."""
	rows = frappe.db.sql(
		"""select si.name, i.item_code, sum(i.qty) qty from `tabSales Invoice Item` i join `tabSales Invoice` si on si.name = i.parent
		where si.docstatus = 1 and si.or_reference = %s and si.or_document_type = %s
		group by si.name, i.item_code order by si.posting_date, si.creation""",
		(ort_name, PRIMARY_INVOICE),
		as_dict=True,
	)
	return {(r.name, r.item_code): flt(r.qty) for r in rows}


def _returned_on(ort_name):
	"""{(invoice, item_code): qty} credited by Return Credit Notes (drafts included, so they are not doubled)."""
	rows = frappe.db.sql(
		"""select si.return_against, i.item_code, sum(-i.qty) from `tabSales Invoice Item` i join `tabSales Invoice` si on si.name = i.parent
		where si.docstatus < 2 and si.or_reference = %s and si.or_document_type = %s and ifnull(si.return_against, '') != ''
		group by si.return_against, i.item_code""",
		(ort_name, RETURN_CREDIT_NOTE),
	)
	return {(inv, code): flt(qty) for inv, code, qty in rows}


def _assigned(ort_name):
	"""{(invoice, item_code): net qty} of secondary sales already tied to a primary invoice."""
	rows = frappe.db.sql(
		"""select primary_invoice, item_code, sum(qty) from `tab{0}` where or_reference = %s and ifnull(primary_invoice, '') != ''
		group by primary_invoice, item_code""".format(SECONDARY),
		ort_name,
	)
	return {(inv, code): flt(qty) for inv, code, qty in rows}


def assign_primary_invoices(ort, upto=None):
	"""Tie each secondary sale (not yet in a note) to the primary invoice its units were billed on, oldest
	invoice first; a secondary return follows its sale. Lines with no invoice yet wait for the next run."""
	invoices = primary_invoices(ort.name)
	if not invoices:
		return
	left = defaultdict(float)
	assigned, returned = _assigned(ort.name), _returned_on(ort.name)
	for key, qty in invoices.items():
		left[key] = qty - assigned.get(key, 0) - returned.get(key, 0)
	order = [inv for inv, _code in invoices]  # oldest first
	lines = frappe.get_all(
		SECONDARY,
		filters={"or_reference": ort.name, "primary_invoice": ("is", "not set"), "price_note": ("is", "not set"),
			**({"sale_date": ("<=", upto)} if upto else {})},
		fields=["name", "item_code", "qty", "is_return", "return_against"],
		order_by="sale_date, creation",
	)
	for line in lines:
		if line.is_return:
			invoice = frappe.db.get_value(SECONDARY, line.return_against, "primary_invoice")
		else:
			candidates = [inv for inv in dict.fromkeys(order) if left.get((inv, line.item_code), 0) > 1e-9]
			invoice = next((inv for inv in candidates if left[(inv, line.item_code)] >= flt(line.qty) - 1e-9), candidates[0] if candidates else None)
		if not invoice:
			continue
		left[(invoice, line.item_code)] -= flt(line.qty)
		frappe.db.set_value(SECONDARY, line.name, "primary_invoice", invoice, update_modified=False)


def returnable_on_invoice(invoice, item_code):
	"""Qty ERPNext still accepts on a return against the invoice for the item."""
	billed = flt(frappe.db.sql("select sum(qty) from `tabSales Invoice Item` where parent = %s and item_code = %s", (invoice, item_code))[0][0])
	returned = flt(frappe.db.sql(
		"""select sum(-i.qty) from `tabSales Invoice Item` i join `tabSales Invoice` si on si.name = i.parent
		where si.docstatus < 2 and si.is_return = 1 and si.return_against = %s and i.item_code = %s""",
		(invoice, item_code),
	)[0][0])
	return billed - returned


# ---------------------------------------------------------------- secondary sales and returns (virtual stock)


def post_secondary(ort, lines, reference, posting_date=None):
	"""The provision entry of imported secondary sales / secondary returns (OR Secondary Sales Order docs).

	No stock moves: the marketplace's stock is virtual. Lines sold below the primary rate book their
	variance: OR Sales Variance Dr / OR Sale Provision Cr; a secondary return posts it reversed. Lines
	above the primary rate post nothing now: their month-end Debit Note bills the difference.
	"""
	if not lines:
		return
	cfg = config(ort.marketplace)
	date = min(getdate(posting_date or max(getdate(line.sale_date) for line in lines)), getdate(nowdate()))
	amount = flt(sum(provision_amount(line) for line in lines), 2)
	if abs(amount) < 0.005:
		return
	je = _journal(ort, "Sale Provision", reference, date, [
		(cfg.variance_account, amount),
		(cfg.provision_account, -amount),
	], _("{0}: secondary {1} at {2} below the primary rate ({3} line(s))").format(
		ort.name, _("returns") if amount < 0 else _("sales"), ort.marketplace, len(lines)
	))
	for line in lines:
		if provision_amount(line):
			frappe.db.set_value(SECONDARY, line.name, "journal_entry", je, update_modified=False)


# ---------------------------------------------------------------- primary returns


def putaway(ort, row, qty, warehouse=None, posting_date=None):
	"""Returned goods arrived and are put away: a return Delivery Note against the dispatch Delivery Note(s)
	brings them back into the chosen warehouse (by default the one they left from), then a Return Credit Note
	against the primary invoice(s) that billed them."""
	target = warehouse or dispatch_warehouses(ort).get(row.item_code)
	if not target:
		frappe.throw(_("Choose the warehouse to put the goods away in."))
	names = _return_delivery_notes(ort, row, qty, target, posting_date)
	notes = return_credit_notes(ort, row.item_code, qty, posting_date)
	return ", ".join(names), notes


def _return_delivery_notes(ort, row, qty, warehouse, posting_date=None):
	"""Return Delivery Notes for qty units of the item, against the dispatch notes still holding them (newest first)."""
	from erpnext.stock.doctype.delivery_note.delivery_note import make_sales_return

	delivered = frappe.db.sql(
		"""select dn.name, sum(i.stock_qty) qty from `tabDelivery Note Item` i join `tabDelivery Note` dn on dn.name = i.parent
		where dn.docstatus = 1 and dn.is_return = 0 and dn.or_reference = %s and i.item_code = %s
		group by dn.name order by dn.posting_date desc, dn.creation desc""",
		(ort.name, row.item_code),
		as_dict=True,
	)
	made, left = [], flt(qty)
	for d in delivered:
		if left <= 1e-9:
			break
		back = -flt(frappe.db.sql(
			"""select sum(i.stock_qty) from `tabDelivery Note Item` i join `tabDelivery Note` dn on dn.name = i.parent
			where dn.docstatus = 1 and dn.is_return = 1 and dn.return_against = %s and i.item_code = %s""",
			(d.name, row.item_code),
		)[0][0])
		take = min(left, flt(d.qty) - back)
		if take <= 1e-9:
			continue
		ret = make_sales_return(d.name)
		kept, need = [], take
		for item in ret.items:
			if item.item_code != row.item_code or need <= 1e-9:
				continue
			part = min(need, abs(flt(item.qty)))
			item.qty = -part
			item.warehouse = warehouse
			need -= part
			kept.append(item)
		ret.set("items", kept)
		ret.lr_no = row.awb_no or ret.get("lr_no")
		if posting_date:
			ret.set_posting_time = 1
			ret.posting_date = posting_date
		ret.flags.ignore_permissions = True
		frappe.flags.or_putaway = True
		try:
			ret.insert()
			ret.submit()
		finally:
			frappe.flags.or_putaway = False
		made.append(ret.name)
		left -= take - need
	if left > 1e-9:
		frappe.throw(_("Only {0} × {1} of {2}'s Delivery Notes can still be returned.").format(f"{flt(qty) - left:g}", row.item_code, ort.name))
	return made


def dispatch_warehouses(ort):
	"""{item_code: warehouse its latest dispatch left from}, else the Sales Order line's warehouse."""
	out = {
		r.item_code: r.warehouse
		for r in frappe.get_all("Sales Order Item", filters={"parent": ort.sales_order}, fields=["item_code", "warehouse"], order_by="idx")
		if r.warehouse
	}
	for code, warehouse in frappe.db.sql(
		"""select i.item_code, i.warehouse from `tabDelivery Note Item` i join `tabDelivery Note` dn on dn.name = i.parent
		where dn.docstatus = 1 and dn.is_return = 0 and dn.or_reference = %s
		order by dn.posting_date, dn.creation""",
		ort.name,
	):
		out[code] = warehouse
	return out


def return_credit_notes(ort, item_code, qty, posting_date=None):
	"""Credit the marketplace for returned goods on the primary invoices that billed them (oldest first,
	units not sold and not returned yet). Units never invoiced need no credit note."""
	from or_model.marketplace_or.notes import make_return_invoice

	invoices = primary_invoices(ort.name)
	assigned, returned = _assigned(ort.name), _returned_on(ort.name)
	made = []
	left = flt(qty)
	for (invoice, code), billed in invoices.items():
		if code != item_code or left <= 1e-9:
			continue
		room = billed - assigned.get((invoice, code), 0) - returned.get((invoice, code), 0)
		take = min(left, room, returnable_on_invoice(invoice, code))
		if take <= 1e-9:
			continue
		made.append(make_return_invoice(ort, invoice, item_code, take, posting_date))
		left -= take
	return made


# ---------------------------------------------------------------- masters


@frappe.whitelist()
def setup_masters(marketplace, billing_customer=None):
	"""Create (if missing) and set the ledgers and billing customer of a marketplace's OR process."""
	frappe.has_permission("Marketplace OR Settings", "write", throw=True)
	company = default_company()
	name = frappe.db.get_value("OR Marketplace", marketplace, "marketplace_name") or marketplace
	label = name.title() if name.isupper() else name

	def account(account_name, root_type, parent_names):
		existing = frappe.db.get_value("Account", {"account_name": account_name, "company": company})
		if existing:
			return existing
		parent = next((p for p in (frappe.db.get_value("Account", {"account_name": n, "company": company, "is_group": 1}) for n in parent_names) if p), None)
		parent = parent or frappe.db.get_value("Account", {"root_type": root_type, "company": company, "is_group": 1, "parent_account": ("is", "not set")})
		return frappe.get_doc({"doctype": "Account", "account_name": account_name, "parent_account": parent, "company": company, "is_group": 0}).insert(ignore_permissions=True).name

	def customer(customer_name):
		if frappe.db.exists("Customer", customer_name):
			return customer_name
		return frappe.get_doc({"doctype": "Customer", "customer_name": customer_name, "customer_type": "Company",
			"customer_group": frappe.db.get_value("Customer Group", {"is_group": 0}) or "All Customer Groups",
			"territory": frappe.db.get_value("Territory", {"is_group": 0}) or "All Territories"}).insert(ignore_permissions=True).name

	values = {
		"provision_account": account(f"{label} OR Sale Provision", "Liability", ("Current Liabilities", "Liabilities")),
		"variance_account": account(f"{label} OR Sales Variance", "Expense", ("Indirect Expenses", "Expenses")),
	}
	settings = frappe.get_doc("Marketplace OR Settings")
	row = next((r for r in settings.accounts if r.marketplace == marketplace), None)
	if not row:
		row = settings.append("accounts", {"marketplace": marketplace, "cost_center": frappe.get_cached_value("Company", company, "cost_center")})
	if billing_customer:
		row.customer = customer(billing_customer)
	for field, value in values.items():
		if not row.get(field):
			row.set(field, value)
	if not row.customer:
		frappe.throw(_("Enter the Billing Customer of {0}.").format(marketplace))
	settings.flags.ignore_permissions = True
	settings.save()
	frappe.clear_document_cache("Marketplace OR Settings")
	return {f: row.get(f) for f in ("customer", *values)}
