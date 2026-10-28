import frappe
from frappe import _
from frappe.model.document import Document
from frappe.model.naming import make_autoname

from or_model.marketplace_or import calculations, notes, postings, sales, stock
from or_model.marketplace_or.doctype.marketplace_or_settings.marketplace_or_settings import (
	customers_of,
	get_account,
)

LINE_FIELDS = [
	"name",
	"marketplace_order_id",
	"item_code",
	"qty",
	"primary_rate",
	"selling_rate",
	"commission_percent",
	"sale_date",
	"import_batch",
	"price_note",
	"note_status",
	"primary_invoice",
	"is_return",
	"return_against",
]


class ORPrimarySalesTracker(Document):
	def autoname(self):
		abbreviation = frappe.db.get_value("OR Marketplace", self.marketplace, "abbreviation")
		self.name = make_autoname(f"OR-{abbreviation}-.YYYY.-.####", doc=self)

	def onload(self):
		self.set_onload("item_summary", self.item_summary())

	def validate(self):
		self._guard_closed()
		get_account(self.marketplace)  # explains how to set the marketplace up if missing
		self._validate_sales_order()
		self.update_summary()
		self._validate_approval()

	def update_summary(self):
		self.update(calculations.summarize(self.stock_movements, self.get_lines(), self.price_notes))
		for row in self.stock_movements:
			row.pending_qty = calculations.pending_qty(row)

	def get_lines(self):
		if self.is_new():
			return []
		return frappe.get_all(
			"OR Secondary Sales Order", filters={"or_reference": self.name}, fields=LINE_FIELDS, order_by="sale_date, name"
		)

	def item_summary(self):
		skus = {
			row.item_code: row.marketplace_sku
			for row in frappe.get_all(
				"OR Item Mapping", filters={"marketplace": self.marketplace}, fields=["item_code", "marketplace_sku"]
			)
		}
		positions = calculations.item_positions(self.stock_movements, self.get_lines())
		return [{"item_code": code, "marketplace_sku": skus.get(code), **values} for code, values in sorted(positions.items())]

	def _guard_closed(self):
		if self.is_new() or self.flags.or_system:
			return
		if frappe.db.get_value(self.doctype, self.name, "status") == "Closed":
			frappe.throw(_("{0} is Closed and read-only.").format(self.name))

	def _validate_sales_order(self):
		so = frappe.db.get_value(
			"Sales Order", self.sales_order, ["customer", "docstatus", "po_no", "po_date", "status"], as_dict=True
		)
		if not so or so.docstatus != 1:
			frappe.throw(_("Sales Order {0} must be submitted.").format(self.sales_order))
		if so.customer not in customers_of(self.marketplace):
			frappe.throw(
				_("Sales Order {0} is for {1}, which is not a customer of {2} (Marketplace OR Settings).").format(
					self.sales_order, so.customer, self.marketplace
				)
			)
		self.customer = so.customer
		self.order_status = so.status  # kept in step afterwards by the Sales Order's on_change hook
		self.marketplace_po_no = self.marketplace_po_no or so.po_no
		if not self.marketplace_po_no:
			frappe.throw(_("Marketplace PO No is required. Set Customer's Purchase Order on the Sales Order."))
		self.po_date = so.po_date

		duplicate = frappe.db.get_value(
			self.doctype,
			{"marketplace": self.marketplace, "marketplace_po_no": self.marketplace_po_no, "name": ("!=", self.name)},
		)
		if duplicate:
			frappe.throw(_("PO {0} is already linked to {1}.").format(self.marketplace_po_no, duplicate))

	def _validate_approval(self):
		before = self.get_doc_before_save()
		previous = before.status if before else None
		if self.status == "Reconciled" and previous != "Reconciled":
			if self.reconciliation_status != "Reconciled":
				frappe.throw(
					_("Cannot approve: {0}. Every variance line must be in a submitted note.").format(
						_(self.reconciliation_status).lower()
					)
				)
			self.approved_by = frappe.session.user
		elif self.status == "Under Reconciliation" and previous == "Reconciled":
			self.approved_by = None

	# Actions called from the form (frm.call). Each posts its stock / journal entries (postings.py).

	@frappe.whitelist()
	def dispatch(self, items, awb_no=None, posting_date=None):
		return postings.dispatch(self, frappe.parse_json(items), awb_no, posting_date)

	@frappe.whitelist()
	def make_primary_invoice(self, posting_date=None):
		return postings.make_primary_invoice(self, posting_date)

	@frappe.whitelist()
	def putaway(self, row, qty, warehouse=None, posting_date=None):
		return stock.putaway(self, row, qty, warehouse, posting_date)

	@frappe.whitelist()
	def initiate_return(self, item_code, qty, reference, initiation_date=None, awb_no=None):
		return stock.initiate_return(self, item_code, qty, reference, initiation_date, awb_no)

	@frappe.whitelist()
	def mark_dispatched(self, row, awb_no=None, dispatch_date=None):
		return stock.mark_dispatched(self, row, awb_no, dispatch_date)

	@frappe.whitelist()
	def record_receipt(self, row, qty, pod=None, posting_date=None):
		return stock.record_receipt(self, row, qty, pod, posting_date)

	@frappe.whitelist()
	def record_receipts(self, lines, pod=None, posting_date=None):
		return stock.record_receipts(self, lines, pod, posting_date)

	@frappe.whitelist()
	def cancel_movement(self, row):
		return stock.cancel_movement(self, row)

	@frappe.whitelist()
	def import_secondary_sales(self, csv_text=None, file_url=None):
		return sales.import_sales(self, csv_text, file_url)

	@frappe.whitelist()
	def record_secondary_return(self, or_secondary_sales_order, qty, return_date=None, marketplace_return_id=None):
		return sales.record_secondary_return(self, or_secondary_sales_order, qty, return_date, marketplace_return_id)

	@frappe.whitelist()
	def create_notes(self, upto=None):
		return notes.create_notes(self, upto)

	@frappe.whitelist()
	def submit_draft_notes(self):
		return notes.submit_draft_notes(self)
