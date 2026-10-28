"""Flow = OR on the Sales Order, and its automatic OR Primary Sales Tracker.

Only orders with Flow = OR are governed here (SOR Model, when installed, handles its own flows):
- the Customer Purchase Order Number is required and kept in sync with ERPNext's own po_no
  ("Customer's Purchase Order"), which the OR module reads;
- the order needs an OR Marketplace to be submitted (filled from the customer);
- the Customer PO Number is unique per channel (else marketplace), and the order is submitted only when
  its warehouses hold enough free stock;
- submitting the order creates its OR Primary Sales Tracker; if that cannot be created, the order is
  not submitted.
"""

import frappe
from frappe import _

from or_model.marketplace_or.doctype.marketplace_or_settings.marketplace_or_settings import (
	customers_of,
	get_account,
	get_customer_marketplace,
)

OR = "OR Primary Sales Tracker"
CONTROLLED_FLOWS = ("OR",)


def validate(doc, method=None):
	if doc.get("sales_flow") != "OR":
		if doc.meta.has_field("or_marketplace"):
			doc.or_marketplace = None
		return

	# either field may have been filled (e.g. the standard one by an import); keep them equal
	doc.customer_po_number = (doc.get("customer_po_number") or doc.po_no or "").strip()
	if not doc.customer_po_number:
		frappe.throw(_("Customer Purchase Order Number is required for Flow OR."))
	doc.po_no = doc.customer_po_number
	doc.customer_po_date = doc.get("customer_po_date") or doc.po_date
	if doc.customer_po_date:
		doc.po_date = doc.customer_po_date
	# filled from the customer; required on submit, when the tracker is made
	doc.or_marketplace = doc.or_marketplace or get_customer_marketplace(doc.customer)
	check_unique_po(doc)


def po_scope(doc):
	"""Where a PO number must be unique: the Channel (when SOR Model adds it); else the OR Marketplace.

	Returns (label, filters) for finding other orders in the same scope.
	"""
	has_channel = doc.meta.has_field("sales_channel")
	if has_channel and doc.get("sales_channel"):
		return _("Channel {0}").format(doc.sales_channel), {"sales_channel": doc.sales_channel}
	blank_channel = {"sales_channel": ("is", "not set")} if has_channel else {}
	if doc.get("or_marketplace"):
		return _("Marketplace {0}").format(doc.or_marketplace), {**blank_channel, "or_marketplace": doc.or_marketplace}
	return _("Customer {0}").format(doc.customer), {**blank_channel, "customer": doc.customer}


def check_unique_po(doc):
	"""Block a second (not cancelled) OR order with the same Customer PO Number in one channel."""
	po = (doc.get("customer_po_number") or "").strip()
	if not po:
		return
	label, filters = po_scope(doc)
	others = frappe.get_all(
		"Sales Order",
		filters={
			**filters,
			"customer_po_number": po,
			"sales_flow": ("in", CONTROLLED_FLOWS),
			"docstatus": ("<", 2),
			"name": ("!=", doc.name or ""),
		},
		pluck="name",
		limit=3,
	)
	if others:
		frappe.throw(
			_("Customer Purchase Order Number {0} is already used for {1} on {2}. A PO number can be used only once per channel.").format(
				frappe.bold(po), label, ", ".join(frappe.utils.get_link_to_form("Sales Order", n) for n in others)
			),
			title=_("Duplicate Purchase Order Number"),
		)


def check_stock(doc):
	"""Block submitting an OR order when a warehouse does not have the stock for it.

	Free stock = qty in the warehouse - qty reserved by other open Sales Orders. Product bundles are
	checked by their packed items; non-stock items and supplier-delivered lines are not checked.
	"""
	needed, labels = {}, {}
	stock_items = set(
		frappe.get_all("Item", filters={"name": ("in", [d.item_code for d in doc.items] or [""]), "is_stock_item": 1}, pluck="name")
	)
	lines = [
		(d.item_code, d.warehouse or doc.get("set_warehouse"), d.stock_qty or d.qty * (d.conversion_factor or 1))
		for d in doc.items
		if d.item_code in stock_items and not d.get("delivered_by_supplier")
	]
	lines += [(p.item_code, p.warehouse, p.qty) for p in doc.get("packed_items") or []]
	missing_wh = sorted({code for code, wh, _q in lines if not wh})
	if missing_wh:
		frappe.throw(_("Set the Warehouse for {0} so its stock can be checked.").format(", ".join(missing_wh)))
	for code, wh, qty in lines:
		needed[(code, wh)] = needed.get((code, wh), 0) + frappe.utils.flt(qty)

	short = []
	for (code, wh), qty in needed.items():
		actual, reserved = frappe.db.get_value("Bin", {"item_code": code, "warehouse": wh}, ["actual_qty", "reserved_qty"]) or (0, 0)
		free = frappe.utils.flt(actual) - frappe.utils.flt(reserved)
		if qty > free + 1e-9:
			short.append(
				_("<b>{0}</b> in {1}: needs {2}, free {3} (in stock {4}, reserved for other orders {5})").format(
					code, wh, f"{qty:g}", f"{max(free, 0):g}", f"{frappe.utils.flt(actual):g}", f"{frappe.utils.flt(reserved):g}"
				)
			)
	if short:
		frappe.throw(
			_("Not enough stock to submit this {0} order:").format(doc.sales_flow) + "<br>" + "<br>".join(short),
			title=_("Stock not available"),
		)


def before_submit(doc, method=None):
	if doc.get("sales_flow") in CONTROLLED_FLOWS:
		check_unique_po(doc)
		check_stock(doc)
	if doc.get("sales_flow") != "OR":
		return
	if not doc.or_marketplace:
		frappe.throw(
			_("Select the OR Marketplace for an OR order, or link {0} to a marketplace in Marketplace OR Settings.").format(
				doc.customer
			)
		)
	get_account(doc.or_marketplace)  # explains how to set the marketplace up if missing
	allowed = customers_of(doc.or_marketplace)
	if doc.customer not in allowed:
		frappe.throw(
			_("{0} is not a customer of {1}. Map it under Customer ↔ Marketplace in Marketplace OR Settings (now: {2}).").format(
				doc.customer, doc.or_marketplace, ", ".join(sorted(allowed))
			),
			title=_("Wrong customer for this marketplace"),
		)


def on_submit(doc, method=None):
	if doc.get("sales_flow") != "OR" or frappe.db.exists(OR, {"sales_order": doc.name}):
		return
	ort = frappe.get_doc({"doctype": OR, "marketplace": doc.or_marketplace, "sales_order": doc.name})
	ort.insert(ignore_permissions=True)
	doc.db_set("or_record", ort.name)
	frappe.msgprint(
		_("OR Primary Sales Tracker {0} created.").format(frappe.utils.get_link_to_form(OR, ort.name)),
		alert=True,
		indicator="green",
	)


def on_change(doc, method=None):
	"""The tracker's Status is the Sales Order's status. ERPNext changes it on submit, on delivery and
	billing (Delivery Note / Sales Invoice), on Close / Hold / Reopen and on cancel, always through a
	save or db_set, both of which end in on_change."""
	if doc.get("sales_flow") != "OR" or doc.docstatus == 0:
		return
	name = doc.get("or_record") or frappe.db.get_value(OR, {"sales_order": doc.name})
	if name and frappe.db.get_value(OR, name, "order_status") != doc.status:
		frappe.db.set_value(OR, name, "order_status", doc.status, update_modified=False)


def before_cancel(doc, method=None):
	name = frappe.db.get_value(OR, {"sales_order": doc.name})
	if not name:
		return
	ort = frappe.get_doc(OR, name)
	in_use = ort.stock_movements or ort.price_notes or frappe.db.exists("OR Secondary Sales Order", {"or_reference": name})
	if in_use:
		frappe.throw(
			_("OR Primary Sales Tracker {0} already has dispatches or sales, so this Sales Order cannot be cancelled.").format(
				frappe.utils.get_link_to_form(OR, name)
			)
		)


def on_cancel(doc, method=None):
	# an untouched OR Primary Sales Tracker has no meaning without its order
	name = frappe.db.get_value(OR, {"sales_order": doc.name})
	if name:
		frappe.delete_doc(OR, name, ignore_permissions=True, force=True)
		doc.db_set("or_record", None)
