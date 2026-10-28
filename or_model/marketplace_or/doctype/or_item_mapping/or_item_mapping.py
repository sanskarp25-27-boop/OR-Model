import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class ORItemMapping(Document):
	def validate(self):
		self.marketplace_sku = (self.marketplace_sku or "").strip()
		if flt(self.primary_rate) <= 0:
			frappe.throw(_("Primary Rate must be greater than zero."))

		duplicate = frappe.db.exists(
			"OR Item Mapping",
			{"marketplace": self.marketplace, "marketplace_sku": self.marketplace_sku, "name": ("!=", self.name)},
		)
		if duplicate:
			frappe.throw(_("{0} is already mapped for {1}.").format(self.marketplace_sku, self.marketplace))


def get_sku_map(marketplace, sales_order=None):
	"""{marketplace_sku: {"item_code", "primary_rate"}} for one marketplace.

	The SKU Code on the Item master wins; a mapping still covers SKUs not on any Item. Primary rate
	comes from the mapping for that item, else the item's rate on the OR Sales Order.
	"""
	from or_model.marketplace_or.item import get_item_skus

	mappings = frappe.get_all(
		"OR Item Mapping",
		filters={"marketplace": marketplace},
		fields=["marketplace_sku", "item_code", "primary_rate"],
	)
	sku_map = {row.marketplace_sku: row for row in mappings}
	item_skus = get_item_skus(marketplace)
	if not item_skus:
		return sku_map

	rates = {}
	if sales_order:
		for row in frappe.get_all(
			"Sales Order Item", filters={"parent": sales_order}, fields=["item_code", "rate"], order_by="idx"
		):
			rates.setdefault(row.item_code, row.rate)
	for row in mappings:
		rates[row.item_code] = row.primary_rate
	for sku, item_code in item_skus.items():
		sku_map[sku] = frappe._dict(marketplace_sku=sku, item_code=item_code, primary_rate=rates.get(item_code) or 0)
	return sku_map


def get_primary_rate(marketplace, item_code):
	return flt(
		frappe.db.get_value(
			"OR Item Mapping", {"marketplace": marketplace, "item_code": item_code}, "primary_rate"
		)
	)
