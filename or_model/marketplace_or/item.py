"""Marketplace SKU Codes on the Item master (custom fields from setup.py)."""

import frappe
from frappe import _

# lower-cased marketplace name -> Item field holding its SKU code
SKU_FIELDS = {
	"myntra": "myntra_sku_code",
	"ajio": "ajio_sku_code",
	"blinkit": "blinkit_sku_code",
	"zepto": "zepto_sku_code",
}


def sku_field(marketplace):
	return SKU_FIELDS.get((marketplace or "").strip().lower())


def validate(doc, method=None):
	"""One Item per SKU Code for each marketplace."""
	for marketplace, fieldname in SKU_FIELDS.items():
		sku = (doc.get(fieldname) or "").strip()
		doc.set(fieldname, sku or None)
		if not sku:
			continue
		duplicate = frappe.db.exists("Item", {fieldname: sku, "name": ("!=", doc.name)})
		if duplicate:
			frappe.throw(
				_("{0} SKU Code {1} is already set on Item {2}.").format(marketplace.title(), sku, duplicate)
			)


def get_item_skus(marketplace):
	"""{sku: item_code} from the Item master for one marketplace."""
	fieldname = sku_field(marketplace)
	if not fieldname:
		return {}
	return {
		row[fieldname]: row.name
		for row in frappe.get_all("Item", filters={fieldname: ("is", "set")}, fields=["name", fieldname])
	}
