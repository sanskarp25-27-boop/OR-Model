"""Server side of the OR app (page "or-app", /app/ort): the custom full-screen UI for Marketplace OR.

Every function checks permissions itself and reuses the module's existing logic (stock.py, sales.py,
notes.py, the OR Primary Sales Tracker controller), so the custom UI and the standard forms behave the same.
"""

import json

import frappe
from frappe import _
from frappe.utils import cint, flt, nowdate

from or_model.marketplace_or.doctype.marketplace_or_settings.marketplace_or_settings import default_company

TRACKER = "OR Primary Sales Tracker"
SECONDARY = "OR Secondary Sales Order"
MAPPING = "OR Item Mapping"
SETTINGS = "Marketplace OR Settings"

TRACKER_ACTIONS = {
	"dispatch",
	"make_primary_invoice",
	"putaway",
	"initiate_return",
	"mark_dispatched",
	"record_receipt",
	"record_receipts",
	"cancel_movement",
	"import_secondary_sales",
	"record_secondary_return",
	"create_notes",
	"submit_draft_notes",
}

LINK_DOCTYPES = {
	"Item": ["item_name"],
	"Customer": ["customer_name"],
	"Warehouse": [],
	"OR Marketplace": [],
	"Account": ["account_name"],
	"Cost Center": [],
	"Role": [],
}


def _args(value):
	if isinstance(value, str):
		value = json.loads(value or "{}")
	return frappe._dict(value or {})


# ---------------------------------------------------------------- boot


@frappe.whitelist()
def boot():
	frappe.has_permission(TRACKER, "read", throw=True)
	user = frappe.db.get_value("User", frappe.session.user, ["first_name", "full_name", "user_image"], as_dict=True)
	roles = set(frappe.get_roles())
	approver = frappe.db.get_single_value(SETTINGS, "approver_role") or "Accounts Manager"
	return {
		"user": frappe.session.user,
		"first_name": user.first_name or frappe.session.user,
		"full_name": user.full_name or frappe.session.user,
		"user_image": user.user_image,
		"can_approve": approver in roles or "System Manager" in roles,
		"can_setup": bool(frappe.has_permission(SETTINGS, "write")),
		"can_deliver": bool(frappe.has_permission("Delivery Note", "submit")),
		"can_invoice": bool(frappe.has_permission("Sales Invoice", "submit")),
		"can_import": bool(frappe.has_permission(TRACKER, "write")),
		"marketplaces": frappe.get_all("OR Marketplace", pluck="name", order_by="name"),
		"import_formats": _import_formats(),
		"warehouses": frappe.get_all(
			"Warehouse", filters={"is_group": 0, "disabled": 0, "company": default_company()}, pluck="name", order_by="name"
		),
		"company": default_company(),
		"today": nowdate(),
	}


# ---------------------------------------------------------------- trackers


@frappe.whitelist()
def trackers(marketplace=None, status=None, search=None, start=0, limit=50):
	"""`status` filters on the Sales Order's status (order_status); "__drafts" means unsubmitted orders,
	which have no tracker yet and come back in `drafts`."""
	frappe.has_permission(TRACKER, "read", throw=True)
	filters = {}
	if marketplace:
		filters["marketplace"] = marketplace
	if status:
		filters["order_status"] = status
	or_filters = None
	if search:
		like = f"%{search}%"
		or_filters = {"name": ("like", like), "marketplace_po_no": ("like", like), "sales_order": ("like", like)}
	rows = frappe.get_list(
		TRACKER,
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name", "marketplace", "sales_order", "marketplace_po_no", "po_date", "customer", "status", "order_status",
			"reconciliation_status", "total_dispatched_qty", "marketplace_received_qty", "stock_in_transit",
			"total_sold_qty", "virtual_stock", "primary_sales_value", "secondary_sales_value",
			"net_price_variance", "variance_not_invoiced", "modified",
		],
		order_by="modified desc",
		limit_start=cint(start),
		limit_page_length=cint(limit) or 50,
	)
	# ordered qty from the Primary Sales Order, so a tracker with nothing dispatched still shows a number
	ordered = dict(
		frappe.get_all(
			"Sales Order",
			filters={"name": ("in", [r.sales_order for r in rows if r.sales_order] or [""])},
			fields=["name", "total_qty"],
			as_list=True,
		)
	)
	for r in rows:
		r.ordered_qty = flt(ordered.get(r.sales_order))
	counts = {}
	for row in frappe.get_list(TRACKER, fields=["order_status"], limit_page_length=0):
		counts[row.order_status] = counts.get(row.order_status, 0) + 1
	drafts = _draft_sor_orders(marketplace, search)
	counts["Draft"] = len(drafts)  # unsubmitted OR orders: no tracker yet, listed from `drafts`
	return {"rows": rows, "counts": counts, "drafts": drafts}


def _draft_sor_orders(marketplace=None, search=None):
	"""OR Sales Orders saved but not submitted yet: they get a Primary Sales record only on submit."""
	if not frappe.has_permission("Sales Order", "read"):
		return []
	filters = {"sales_flow": "OR", "docstatus": 0}
	if marketplace:
		filters["or_marketplace"] = marketplace
	or_filters = None
	if search:
		like = f"%{search}%"
		or_filters = {"name": ("like", like), "customer_po_number": ("like", like), "customer": ("like", like)}
	rows = frappe.get_list(
		"Sales Order",
		filters=filters,
		or_filters=or_filters,
		fields=["name", "customer", "or_marketplace", "customer_po_number", "customer_po_date", "transaction_date", "grand_total", "total_qty", "owner", "modified"],
		order_by="modified desc",
		limit_page_length=100,
	)
	can_submit = frappe.has_permission("Sales Order", "submit")
	for r in rows:
		r.owner_name = frappe.utils.get_fullname(r.owner)
		r.can_submit = can_submit
	return rows


@frappe.whitelist()
def tracker(name):
	doc = frappe.get_doc(TRACKER, name)
	doc.check_permission("read")
	from frappe.model.workflow import get_transitions

	try:
		transitions = [t.action for t in get_transitions(doc)]
	except Exception:
		transitions = []
	so = frappe.db.get_value(
		"Sales Order", doc.sales_order,
		["customer", "customer_name", "transaction_date", "delivery_date", "grand_total", "per_delivered", "status", "set_warehouse"],
		as_dict=True,
	) or {}
	lines = frappe.get_all(
		SECONDARY,
		filters={"or_reference": name},
		fields=[
			"name", "marketplace_order_id", "sale_date", "item_code", "qty", "returned_qty", "is_return",
			"primary_rate", "selling_rate", "commission_percent", "total_variance", "note_status", "sales_invoice",
		],
		order_by="sale_date desc, creation desc",
	)
	data = doc.as_dict(convert_dates_to_str=True)
	return {
		"doc": data,
		"item_summary": doc.item_summary(),
		"lines": lines,
		"transitions": transitions,
		"can_write": bool(frappe.has_permission(TRACKER, "write", doc=doc)) and doc.status != "Closed",
		"sales_order": so,
		"pending_delivery": _pending_delivery(doc.sales_order),
		# shown while nothing is dispatched yet, so a new tracker is not just zeros
		"order_items": _order_items(doc.sales_order),
		**_postings(doc),
	}


def _postings(doc):
	"""The Delivery Notes, invoices and journals of this tracker, plus its setup."""
	from or_model.marketplace_or import postings

	delivery_notes = frappe.db.sql(
		"""select dn.name, dn.docstatus, dn.posting_date, dn.is_return, dn.return_against, dn.per_billed, dn.lr_no,
			sum(i.stock_qty) qty, min(i.warehouse) warehouse
		from `tabDelivery Note` dn join `tabDelivery Note Item` i on i.parent = dn.name
		where dn.or_reference = %s and dn.docstatus < 2
		group by dn.name order by dn.posting_date, dn.creation""",
		doc.name,
		as_dict=True,
	)
	invoices = frappe.get_all(
		"Sales Invoice",
		filters={"or_reference": doc.name, "docstatus": ("<", 2)},
		fields=["name", "docstatus", "status", "posting_date", "or_document_type", "grand_total", "base_net_total", "return_against", "customer"],
		order_by="posting_date, creation",
	)
	journals = frappe.get_all(
		"Journal Entry",
		filters={"or_reference": doc.name, "docstatus": 1},
		fields=["name", "posting_date", "or_purpose", "or_against", "total_debit"],
		order_by="posting_date, creation",
	)
	dispatched = sum(flt(r.qty) for r in doc.stock_movements if r.movement_type == "Primary Sale" and r.status not in ("Draft", "Cancelled"))
	invoiced = flt(
		frappe.db.sql(
			"""select sum(i.qty) from `tabSales Invoice Item` i join `tabSales Invoice` si on si.name = i.parent
			where si.docstatus < 2 and si.or_reference = %s and si.or_document_type = 'Primary Invoice'""",
			doc.name,
		)[0][0]
	)
	try:
		cfg = postings.config(doc.marketplace)
		setup_missing = None
	except frappe.ValidationError as e:
		frappe.clear_last_message()
		cfg, setup_missing = frappe._dict(), frappe.utils.strip_html(str(e))
	return {
		"delivery_notes": delivery_notes,
		"invoices": invoices,
		"journals": journals,
		"to_invoice": max(dispatched - invoiced, 0),
		"setup_missing": setup_missing,
		"accounts": {k: cfg.get(k) for k in ("provision_account", "variance_account")},
		# putaway defaults to the warehouse each item was dispatched from
		"dispatch_warehouses": postings.dispatch_warehouses(doc),
	}


@frappe.whitelist(methods=["POST"])
def tracker_action(name, action, args=None):
	if action not in TRACKER_ACTIONS:
		frappe.throw(_("Unknown action {0}.").format(action))
	doc = frappe.get_doc(TRACKER, name)
	doc.check_permission("write")
	result = getattr(doc, action)(**_args(args))
	return result


@frappe.whitelist(methods=["POST"])
def apply_workflow_action(name, action):
	from frappe.model.workflow import apply_workflow

	doc = frappe.get_doc(TRACKER, name)
	doc.check_permission("read")
	return apply_workflow(doc, action).status


# ---------------------------------------------------------------- dispatch and primary returns (ERPNext documents)


def _pending_delivery(sales_order):
	if not sales_order:
		return []
	return [
		row
		for row in frappe.get_all(
			"Sales Order Item",
			filters={"parent": sales_order},
			fields=["name", "item_code", "item_name", "qty", "delivered_qty", "warehouse", "rate"],
			order_by="idx",
		)
		if flt(row.qty) - flt(row.delivered_qty) > 0
	]


def _order_items(sales_order):
	"""Every line of the Primary Sales Order, with what has been delivered so far."""
	if not sales_order:
		return []
	return frappe.get_all(
		"Sales Order Item",
		filters={"parent": sales_order},
		fields=["item_code", "item_name", "qty", "uom", "rate", "amount", "delivered_qty", "delivery_date", "warehouse"],
		order_by="idx",
	)


LEDGER_DOCTYPES = ("Delivery Note", "Sales Invoice", "Journal Entry")


@frappe.whitelist()
def document_ledger(name, doctype=None, docname=None):
	"""Stock Ledger and General Ledger rows posted by one document of a tracker (or, without docname, by
	every document the tracker created)."""
	tracker_doc = frappe.get_doc(TRACKER, name)
	tracker_doc.check_permission("read")
	if docname:
		if doctype not in LEDGER_DOCTYPES or frappe.db.get_value(doctype, docname, "or_reference") != name:
			frappe.throw(_("{0} {1} is not a document of {2}.").format(doctype, docname, name))
		vouchers = [(doctype, docname)]
	else:
		vouchers = [
			(dt, v)
			for dt in LEDGER_DOCTYPES
			for v in frappe.get_all(dt, filters={"or_reference": name, "docstatus": 1}, pluck="name", order_by="posting_date, creation")
		]
	for dt in {dt for dt, _v in vouchers}:
		frappe.has_permission(dt, "read", throw=True)
	names = [v for _dt, v in vouchers] or [""]

	stock = []
	if frappe.has_permission("Stock Ledger Entry", "read"):
		stock = frappe.get_all(
			"Stock Ledger Entry",
			filters={"voucher_no": ("in", names), "is_cancelled": 0},
			fields=["voucher_type", "voucher_no", "posting_date", "item_code", "warehouse", "actual_qty", "valuation_rate",
				"stock_value_difference", "qty_after_transaction"],
			order_by="posting_date, posting_time, creation",
		)
	gl = []
	if frappe.has_permission("GL Entry", "read"):
		gl = frappe.get_all(
			"GL Entry",
			filters={"voucher_no": ("in", names), "is_cancelled": 0},
			fields=["voucher_type", "voucher_no", "posting_date", "account", "party_type", "party", "debit", "credit", "cost_center"],
			order_by="posting_date, creation, debit desc",
		)
	docstatus = {v: frappe.db.get_value(dt, v, "docstatus") for dt, v in vouchers}
	return {
		"vouchers": [{"doctype": dt, "name": v, "docstatus": docstatus[v]} for dt, v in vouchers],
		"stock": stock,
		"gl": gl,
		"can_see_stock": bool(frappe.has_permission("Stock Ledger Entry", "read")),
		"can_see_gl": bool(frappe.has_permission("GL Entry", "read")),
	}


@frappe.whitelist()
def tracker_report(name):
	"""Everything for the record's downloadable report: summary, secondary sales, ledgers and notes."""
	data = tracker(name)  # checks read permission
	data["lines"] = frappe.get_all(
		SECONDARY,
		filters={"or_reference": name},
		fields=[
			"name", "marketplace_order_id", "sale_date", "is_return", "return_against", "marketplace_sku", "item_code", "qty",
			"returned_qty", "primary_rate", "selling_rate", "commission_percent", "net_secondary_rate", "variance_per_unit",
			"total_variance", "note_status", "sales_invoice", "primary_invoice", "journal_entry", "import_batch",
		],
		order_by="sale_date, creation",
	)
	data["ledger"] = document_ledger(name)
	notes = data["doc"].get("price_notes") or []
	invoices = {
		r.name: r
		for r in frappe.get_all(
			"Sales Invoice",
			filters={"name": ("in", [n.get("sales_invoice") for n in notes if n.get("sales_invoice")] or [""])},
			fields=["name", "posting_date", "customer", "return_against", "grand_total", "status", "docstatus"],
		)
	}
	data["notes"] = [{**n, "invoice": invoices.get(n.get("sales_invoice"))} for n in notes]
	data["generated_on"] = frappe.utils.now()
	data["generated_by"] = frappe.utils.get_fullname(frappe.session.user)
	return data


@frappe.whitelist(methods=["POST"])
def create_delivery(name, items, awb_no=None, posting_date=None, **kwargs):
	"""Pick, pack & dispatch: a Delivery Note against the Primary Sales Order (stock leaves your warehouse)."""
	return {"name": frappe.get_doc(TRACKER, name).dispatch(items, awb_no, posting_date)}


@frappe.whitelist(methods=["POST"])
def setup_masters(marketplace, billing_customer=None, **kwargs):
	from or_model.marketplace_or import postings

	return postings.setup_masters(marketplace, billing_customer)

# ---------------------------------------------------------------- secondary sales


@frappe.whitelist()
def secondary_orders(marketplace=None, tracker=None, kind=None, note_status=None, search=None, from_date=None, to_date=None, start=0, limit=50):
	frappe.has_permission(SECONDARY, "read", throw=True)
	filters = {}
	if marketplace:
		filters["marketplace"] = marketplace
	if tracker:
		filters["or_reference"] = tracker
	if kind == "Sales":
		filters["is_return"] = 0
	elif kind == "Returns":
		filters["is_return"] = 1
	if note_status:
		filters["note_status"] = note_status
	if from_date and to_date:
		filters["sale_date"] = ("between", [from_date, to_date])
	elif from_date:
		filters["sale_date"] = (">=", from_date)
	elif to_date:
		filters["sale_date"] = ("<=", to_date)
	or_filters = None
	if search:
		like = f"%{search}%"
		or_filters = {"name": ("like", like), "marketplace_order_id": ("like", like), "item_code": ("like", like), "marketplace_sku": ("like", like)}
	rows = frappe.get_list(
		SECONDARY,
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name", "marketplace", "marketplace_order_id", "sale_date", "is_return", "or_reference", "item_code",
			"marketplace_sku", "qty", "returned_qty", "selling_rate", "primary_rate", "total_variance", "note_status",
		],
		order_by="sale_date desc, creation desc",
		limit_start=cint(start),
		limit_page_length=cint(limit) or 50,
	)
	totals = frappe.get_list(
		SECONDARY,
		filters=filters,
		or_filters=or_filters,
		fields=[{"SUM": "qty", "as": "qty"}, {"COUNT": "*", "as": "count"}],
		limit_page_length=0,
	)
	value = sum(flt(r.qty) * flt(r.selling_rate) for r in rows)
	return {"rows": rows, "total_count": totals[0].count if totals else 0, "total_qty": flt(totals[0].qty) if totals else 0, "page_value": value}


@frappe.whitelist()
def secondary_order(name):
	doc = frappe.get_doc(SECONDARY, name)
	doc.check_permission("read")
	returns = frappe.get_all(
		SECONDARY, filters={"return_against": name}, fields=["name", "marketplace_order_id", "sale_date", "qty"], order_by="sale_date"
	)
	return {"doc": doc.as_dict(convert_dates_to_str=True), "returns": returns}


@frappe.whitelist(methods=["POST"])
def record_secondary_return(or_secondary_sales_order, qty, return_date=None, marketplace_return_id=None):
	from or_model.marketplace_or import api

	return api.record_secondary_return(or_secondary_sales_order, qty, return_date, marketplace_return_id)


# ---------------------------------------------------------------- item mapping


@frappe.whitelist()
def mappings(marketplace=None, search=None):
	frappe.has_permission(MAPPING, "read", throw=True)
	filters = {"marketplace": marketplace} if marketplace else {}
	or_filters = None
	if search:
		like = f"%{search}%"
		or_filters = {"marketplace_sku": ("like", like), "item_code": ("like", like), "item_name": ("like", like)}
	return frappe.get_list(
		MAPPING,
		filters=filters,
		or_filters=or_filters,
		fields=["name", "marketplace", "marketplace_sku", "item_code", "item_name", "primary_rate", "modified"],
		order_by="marketplace, marketplace_sku",
		limit_page_length=500,
	)


@frappe.whitelist(methods=["POST"])
def save_mapping(data):
	data = _args(data)
	if data.get("name"):
		doc = frappe.get_doc(MAPPING, data.name)
		doc.update({k: data[k] for k in ("marketplace", "marketplace_sku", "item_code", "primary_rate") if k in data})
		doc.save()
	else:
		doc = frappe.get_doc({"doctype": MAPPING, **{k: data.get(k) for k in ("marketplace", "marketplace_sku", "item_code", "primary_rate")}})
		doc.insert()
	return doc.name


@frappe.whitelist(methods=["POST"])
def delete_record(doctype, name):
	if doctype not in (MAPPING, "OR Marketplace"):
		frappe.throw(_("Not allowed."))
	frappe.delete_doc(doctype, name)


# ---------------------------------------------------------------- setup


@frappe.whitelist()
def setup_data():
	frappe.has_permission("OR Marketplace", "read", throw=True)
	settings = frappe.get_doc(SETTINGS)
	return {
		"marketplaces": frappe.get_all("OR Marketplace", fields=["name", "marketplace_name", "abbreviation"], order_by="name"),
		"settings": settings.as_dict(convert_dates_to_str=True) if frappe.has_permission(SETTINGS, "read") else None,
		"options": {
			"group_notes_by": (frappe.get_meta(SETTINGS).get_field("group_notes_by").options or "").split("\n"),
		},
	}


@frappe.whitelist(methods=["POST"])
def save_marketplace(data):
	data = _args(data)
	if data.get("name") and frappe.db.exists("OR Marketplace", data.name):
		doc = frappe.get_doc("OR Marketplace", data.name)
		doc.abbreviation = data.abbreviation
		doc.save()
	else:
		doc = frappe.get_doc({"doctype": "OR Marketplace", "marketplace_name": data.marketplace_name, "abbreviation": data.abbreviation}).insert()
	return doc.name


IMPORT_FORMAT_FIELDS = (
	"header_row", "order_id_column", "sale_date_column", "sku_column", "qty_column", "price_column",
	"price_type", "date_format", "po_column", "filter_column", "filter_values",
	"payout_column", "type_column", "return_values", "return_date_column",
)


def _import_formats():
	"""Every marketplace's secondary-sales import format (the standard columns when none is set)."""
	from or_model.marketplace_or.sales import get_import_format

	return {mp: get_import_format(mp) for mp in frappe.get_all("OR Marketplace", pluck="name", order_by="name")}


@frappe.whitelist(methods=["POST"])
def save_import_format(marketplace, data=None, reset=0):
	"""Set (or with reset=1 remove) one marketplace's import format in Marketplace OR Settings."""
	data = _args(data)
	doc = frappe.get_doc(SETTINGS)
	doc.check_permission("write")
	if not frappe.db.exists("OR Marketplace", marketplace):
		frappe.throw(_("Marketplace {0} not found.").format(marketplace))
	rows = [r for r in doc.import_formats if r.marketplace != marketplace]
	doc.set("import_formats", [])
	for r in rows:
		doc.append("import_formats", {f: r.get(f) for f in ("marketplace", *IMPORT_FORMAT_FIELDS)})
	if not cint(reset):
		row = {"marketplace": marketplace, **{f: data.get(f) for f in IMPORT_FORMAT_FIELDS}}
		for f in ("order_id_column", "sale_date_column", "sku_column", "qty_column", "price_column"):
			row[f] = (row.get(f) or "").strip()
			if not row[f]:
				frappe.throw(_("Enter the column heading for every required column."))
		row["header_row"] = max(cint(row.get("header_row")), 1)
		doc.append("import_formats", row)
	doc.save()
	return _import_formats()


@frappe.whitelist(methods=["POST"])
def import_marketplace_sales(marketplace, file_url=None, csv_text=None):
	"""Secondary Sales page: import one marketplace's sales report across its open Primary Sales records."""
	from or_model.marketplace_or import sales

	return sales.import_marketplace_sales(marketplace, csv_text=csv_text, file_url=file_url)


ACCOUNT_FIELDS = (
	"marketplace", "customer", "provision_account", "variance_account", "debit_note_series", "credit_note_series", "cost_center",
)


@frappe.whitelist(methods=["POST"])
def save_settings(data):
	data = _args(data)
	doc = frappe.get_doc(SETTINGS)
	doc.check_permission("write")
	for field in ("group_notes_by", "approver_role", "auto_create_notes", "auto_submit_notes"):
		if field in data:
			doc.set(field, data[field])
	for table, fields in {
		"customer_marketplaces": ("customer", "marketplace"),
		"commissions": ("marketplace", "commission_percent"),
		"accounts": ACCOUNT_FIELDS,
	}.items():
		if table in data:
			doc.set(table, [{f: row.get(f) for f in fields} for row in data[table] if any(row.get(f) for f in fields)])
	doc.save()
	return doc.as_dict(convert_dates_to_str=True)


# ---------------------------------------------------------------- report


@frappe.whitelist()
def report(filters=None):
	frappe.has_permission(TRACKER, "read", throw=True)
	from or_model.marketplace_or.report.marketplace_or_dashboard.marketplace_or_dashboard import execute

	filters = _args(filters)
	result = execute(filters)
	columns, data = result[0], result[1]
	summary = result[4] if len(result) > 4 else None
	message = result[2] if len(result) > 2 else None
	return {"columns": columns, "data": data, "summary": summary, "message": message}


# ---------------------------------------------------------------- draft OR orders (created on the Sales Order page)


@frappe.whitelist(methods=["POST"])
def submit_order(name):
	so = frappe.get_doc("Sales Order", name)
	so.check_permission("submit")
	so.submit()
	return {"name": so.name, "tracker": frappe.db.get_value(TRACKER, {"sales_order": so.name})}


# ---------------------------------------------------------------- search helpers


@frappe.whitelist()
def link_search(doctype, txt="", filters=None):
	if doctype not in LINK_DOCTYPES:
		frappe.throw(_("Not allowed."))
	frappe.has_permission(doctype, "read", throw=True)
	conditions = _args(filters)
	meta = frappe.get_meta(doctype)
	if meta.has_field("disabled"):
		conditions.setdefault("disabled", 0)
	if meta.has_field("is_group") and doctype != "Account":
		conditions.setdefault("is_group", 0)
	if doctype == "Account":
		conditions.setdefault("is_group", 0)
		conditions.setdefault("company", default_company())
	if doctype == "Item":
		conditions.setdefault("is_sales_item", 1)
		conditions.setdefault("has_variants", 0)  # templates can't go on a Sales Order
	extra = LINK_DOCTYPES[doctype]
	or_filters = {"name": ("like", f"%{txt}%")}
	for field in extra:
		or_filters[field] = ("like", f"%{txt}%")
	rows = frappe.get_list(
		doctype, filters=conditions, or_filters=or_filters, fields=["name", *extra], limit_page_length=20, order_by="modified desc"
	)
	return [{"value": r.name, "label": (r.get(extra[0]) if extra else None) or ""} for r in rows]


@frappe.whitelist()
def global_search(txt):
	txt = (txt or "").strip()
	if len(txt) < 2:
		return []
	like = f"%{txt}%"
	out = []
	if frappe.has_permission(TRACKER, "read"):
		for r in frappe.get_list(
			TRACKER,
			or_filters={"name": ("like", like), "marketplace_po_no": ("like", like), "sales_order": ("like", like)},
			fields=["name", "marketplace", "marketplace_po_no", "status"],
			limit_page_length=8,
		):
			out.append({"type": "tracker", "name": r.name, "title": r.name, "subtitle": f"{r.marketplace} · PO {r.marketplace_po_no} · {r.status}"})
	if frappe.has_permission(SECONDARY, "read"):
		for r in frappe.get_list(
			SECONDARY,
			or_filters={"name": ("like", like), "marketplace_order_id": ("like", like), "item_code": ("like", like)},
			fields=["name", "marketplace_order_id", "marketplace", "item_code", "sale_date"],
			limit_page_length=8,
		):
			out.append({"type": "secondary", "name": r.name, "title": r.marketplace_order_id or r.name, "subtitle": f"{r.marketplace} · {r.item_code} · {r.sale_date}"})
	return out
