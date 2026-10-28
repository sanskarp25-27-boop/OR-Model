"""Marketplace OR Dashboard: stock position, sales value and price variance across OR Primary Sales Trackers."""

from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import flt

from or_model.marketplace_or.calculations import item_positions, line_variance, net_secondary_rate

OR = "OR Primary Sales Tracker"
ITEM_VIEW = "Item-wise summary"


def execute(filters=None):
	filters = frappe._dict(filters or {})
	sors = _or_records(filters)
	lines = _lines([s.name for s in sors])
	lines_by_sor = defaultdict(list)
	for line in lines:
		lines_by_sor[line.or_reference].append(line)

	items = _item_rows(sors, lines_by_sor)
	if (filters.view or ITEM_VIEW) == ITEM_VIEW:
		columns, data = _item_columns(), items
	else:
		columns, data = _variance_columns(), _variance_rows(sors, lines)

	return columns, data, None, None, _summary(sors)


def _or_records(filters):
	conditions = {}
	if filters.marketplace:
		conditions["marketplace"] = filters.marketplace
	if filters.sales_order:
		conditions["sales_order"] = filters.sales_order
	if filters.marketplace_po_no:
		conditions["marketplace_po_no"] = filters.marketplace_po_no
	names = frappe.get_list(OR, filters=conditions, pluck="name", order_by="creation desc")
	return [frappe.get_doc(OR, name) for name in names]


def _lines(or_names):
	if not or_names:
		return []
	return frappe.get_all(
		"OR Secondary Sales Order",
		filters={"or_reference": ("in", or_names)},
		fields=[
			"name",
			"or_reference",
			"marketplace",
			"sales_order",
			"marketplace_order_id",
			"sale_date",
			"item_code",
			"qty",
			"primary_rate",
			"selling_rate",
			"commission_percent",
			"price_note",
			"note_status",
		],
		order_by="sale_date desc, name",
	)


def _item_rows(sors, lines_by_sor):
	rows = []
	for ort in sors:
		skus = dict(
			frappe.get_all(
				"OR Item Mapping",
				filters={"marketplace": ort.marketplace},
				fields=["item_code", "marketplace_sku"],
				as_list=True,
			)
		)
		for code, p in sorted(item_positions(ort.stock_movements, lines_by_sor[ort.name]).items()):
			rows.append(
				{
					"or-app": ort.name,
					"marketplace": ort.marketplace,
					"sales_order": ort.sales_order,
					"marketplace_po_no": ort.marketplace_po_no,
					"item_code": code,
					"marketplace_sku": skus.get(code),
					"dispatched": p["dispatched"],
					"received": p["received"],
					"in_transit": p["in_transit"],
					"sold": p["sold"],
					"secondary_returned": p["secondary_returned"],
					"virtual_stock": p["virtual_stock"],
					"return_in_transit": p["return_in_transit"],
					"primary_value": p["primary_value"],
					"secondary_value": p["secondary_value"],
					"commission_value": p["commission_value"],
					"debit_variance": p["debit_variance"],
					"credit_variance": p["credit_variance"],
				}
			)
	return rows


def _variance_rows(sors, lines):
	vouchers = {row.name: row.sales_invoice for ort in sors for row in ort.price_notes}
	rows = []
	for line in lines:
		variance = line_variance(line)
		if not variance:
			continue
		rows.append(
			{
				"or_secondary_sales_order": line.name,
				"marketplace_order_id": line.marketplace_order_id,
				"marketplace": line.marketplace,
				"sales_order": line.sales_order,
				"sale_date": line.sale_date,
				"item_code": line.item_code,
				"qty": line.qty,
				"primary_rate": line.primary_rate,
				"selling_rate": line.selling_rate,
				"commission_percent": line.commission_percent,
				"net_secondary_rate": net_secondary_rate(line),
				"variance_per_unit": net_secondary_rate(line) - flt(line.primary_rate),
				"total_variance": variance,
				"note_status": line.note_status,
				"voucher": vouchers.get(line.price_note),
			}
		)
	return rows


def _item_columns():
	def qty(label, fieldname):
		return {"label": _(label), "fieldname": fieldname, "fieldtype": "Float", "precision": 0, "width": 100}

	def money(label, fieldname):
		return {"label": _(label), "fieldname": fieldname, "fieldtype": "Currency", "width": 130}

	return [
		{"label": _("Marketplace"), "fieldname": "marketplace", "fieldtype": "Link", "options": "OR Marketplace", "width": 120},
		{"label": _("Primary Sales Order"), "fieldname": "sales_order", "fieldtype": "Link", "options": "Sales Order", "width": 160},
		{"label": _("Marketplace PO No"), "fieldname": "marketplace_po_no", "fieldtype": "Data", "width": 150},
		{"label": _("Item Code"), "fieldname": "item_code", "fieldtype": "Link", "options": "Item", "width": 140},
		{"label": _("Marketplace SKU"), "fieldname": "marketplace_sku", "fieldtype": "Data", "width": 130},
		qty("Primary Sale Dispatched", "dispatched"),
		qty("Primary Sale Received", "received"),
		qty("Primary Sale in Transit", "in_transit"),
		qty("Secondary Sold", "sold"),
		qty("Secondary Returned", "secondary_returned"),
		qty("Stock at Marketplace", "virtual_stock"),
		qty("Primary Return in Transit", "return_in_transit"),
		money("Primary Value", "primary_value"),
		money("Secondary Value", "secondary_value"),
		money("Marketplace Commission", "commission_value"),
		money("Debit Variance", "debit_variance"),
		money("Credit Variance", "credit_variance"),
	]


def _variance_columns():
	return [
		{"label": _("OR Secondary Sales Order"), "fieldname": "or_secondary_sales_order", "fieldtype": "Link", "options": "OR Secondary Sales Order", "width": 150},
		{"label": _("Marketplace Order ID"), "fieldname": "marketplace_order_id", "fieldtype": "Data", "width": 140},
		{"label": _("Marketplace"), "fieldname": "marketplace", "fieldtype": "Link", "options": "OR Marketplace", "width": 110},
		{"label": _("Primary Sales Order"), "fieldname": "sales_order", "fieldtype": "Link", "options": "Sales Order", "width": 150},
		{"label": _("Secondary Sale / Return Date"), "fieldname": "sale_date", "fieldtype": "Date", "width": 110},
		{"label": _("Item Code"), "fieldname": "item_code", "fieldtype": "Link", "options": "Item", "width": 130},
		{"label": _("Qty"), "fieldname": "qty", "fieldtype": "Float", "precision": 0, "width": 70},
		{"label": _("Primary Rate"), "fieldname": "primary_rate", "fieldtype": "Currency", "width": 110},
		{"label": _("Secondary Rate"), "fieldname": "selling_rate", "fieldtype": "Currency", "width": 110},
		{"label": _("Commission %"), "fieldname": "commission_percent", "fieldtype": "Percent", "width": 100},
		{"label": _("Secondary Rate w/o Commission"), "fieldname": "net_secondary_rate", "fieldtype": "Currency", "width": 140},
		{"label": _("Variance / Unit"), "fieldname": "variance_per_unit", "fieldtype": "Currency", "width": 110},
		{"label": _("Total Variance"), "fieldname": "total_variance", "fieldtype": "Currency", "width": 120},
		{"label": _("Note Status"), "fieldname": "note_status", "fieldtype": "Data", "width": 110},
		{"label": _("Voucher No"), "fieldname": "voucher", "fieldtype": "Link", "options": "Sales Invoice", "width": 160},
	]


# Dashboard sections, in display order. The report's JS draws one panel per section with the figures
# as tiles (label above value) on a two-column grid; a "wide" tile spans both columns.
PRIMARY, SECONDARY, STOCK_AT_MARKETPLACE, VARIANCE_NOTES = (
	"Primary Sale & Return",
	"Secondary Sale & Return",
	"Stock at Marketplace",
	"Price Variance & Notes",
)


def _summary(sors):
	total = lambda field: sum(flt(s.get(field)) for s in sors)  # noqa: E731
	variance = total("net_price_variance")

	def card(section, label, value, datatype="Float", indicator=None, subsection=None, wide=False):
		card = {"group": section, "label": _(label), "value": value, "datatype": datatype}
		if indicator:
			card["indicator"] = indicator
		if subsection:
			card["subsection"] = _(subsection)
		if wide:
			card["wide"] = 1
		return card

	sign_color = lambda value: "Green" if value > 0 else "Red" if value < 0 else None  # noqa: E731
	return [
		card(PRIMARY, "Dispatched", total("total_dispatched_qty"), subsection="Primary Sale"),
		card(PRIMARY, "Received by marketplace", total("marketplace_received_qty"), subsection="Primary Sale"),
		card(PRIMARY, "In transit", total("stock_in_transit"), subsection="Primary Sale"),
		card(PRIMARY, "Primary sales value", total("primary_sales_value"), "Currency", subsection="Primary Sale"),
		card(PRIMARY, "Initiated", total("return_initiated_qty"), subsection="Primary Return"),
		card(PRIMARY, "Pending dispatch", total("return_pending_qty"), subsection="Primary Return"),
		card(PRIMARY, "In transit", total("return_in_transit"), subsection="Primary Return"),
		card(PRIMARY, "Received back", total("return_received_qty"), subsection="Primary Return"),
		card(SECONDARY, "Sold qty", total("total_sold_qty"), subsection="Secondary Sale"),
		card(SECONDARY, "Secondary sales value", total("secondary_sales_value"), "Currency", subsection="Secondary Sale"),
		card(SECONDARY, "Marketplace commission", total("marketplace_commission"), "Currency", subsection="Secondary Sale"),
		card(SECONDARY, "Value without commission", total("secondary_sales_value") - total("marketplace_commission"), "Currency",
			subsection="Secondary Sale"),
		card(SECONDARY, "Returned qty", total("secondary_return_qty"), subsection="Secondary Return"),
		card(SECONDARY, "Net sold qty", total("total_sold_qty") - total("secondary_return_qty"), subsection="Secondary Return"),
		card(STOCK_AT_MARKETPLACE, "Stock at marketplace", total("virtual_stock"), wide=True),
		card(STOCK_AT_MARKETPLACE, "Received by marketplace", total("marketplace_received_qty")),
		card(STOCK_AT_MARKETPLACE, "Secondary sold", total("total_sold_qty")),
		card(STOCK_AT_MARKETPLACE, "Secondary returned", total("secondary_return_qty")),
		card(STOCK_AT_MARKETPLACE, "Primary returns dispatched", total("return_initiated_qty") - total("return_pending_qty")),
		card(VARIANCE_NOTES, "Net price variance", variance, "Currency", sign_color(variance), wide=True),
		card(VARIANCE_NOTES, "Debit notes submitted", total("debit_note_amount"), "Currency"),
		card(VARIANCE_NOTES, "Credit notes submitted", total("credit_note_amount"), "Currency"),
		card(VARIANCE_NOTES, "Net adjustment", total("net_adjustment_amount"), "Currency", sign_color(total("net_adjustment_amount"))),
	]

