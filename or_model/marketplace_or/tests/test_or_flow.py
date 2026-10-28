"""End-to-end OR (outright) flow: dispatch by Delivery Note, primary invoice, virtual POD and marketplace stock,
secondary sales with the OR Sale Provision, month-end notes, and a primary return put away by a return
Delivery Note.

Everything runs in one transaction that is rolled back in tearDownClass.
Run on a test site: bench --site <site> run-tests --module or_model.marketplace_or.tests.test_or_flow
"""

import unittest

import frappe
from frappe.utils import add_days, flt, nowdate

from or_model.marketplace_or import postings
from or_model.marketplace_or.doctype.marketplace_or_settings.marketplace_or_settings import default_company, get_account

OR = "OR Primary Sales Tracker"
ITEM = "ORTEST-BAG"
MP = "ORTEST Myntra"


def csv(*rows):
	return "marketplace_order_id,sale_date,marketplace_sku,qty,selling_price\n" + "\n".join(",".join(map(str, r)) for r in rows)


def pod():
	"""A freshly uploaded (unattached) POD file, as the receipt dialog sends it."""
	return frappe.get_doc({"doctype": "File", "file_name": "pod.txt", "content": b"signed POD", "is_private": 1}).insert().file_url


def balance(ort_name, account, party=None):
	"""Debit - credit on an account from the invoices and journals of this tracker."""
	vouchers = frappe.get_all("Sales Invoice", filters={"or_reference": ort_name, "docstatus": 1}, pluck="name") + frappe.get_all(
		"Journal Entry", filters={"or_reference": ort_name, "docstatus": 1}, pluck="name"
	)
	filters = {"account": account, "voucher_no": ("in", vouchers or [""]), "is_cancelled": 0}
	if party:
		filters["party"] = party
	rows = frappe.get_all("GL Entry", filters=filters, fields=["debit", "credit"])
	return flt(sum(flt(r.debit) - flt(r.credit) for r in rows), 2)


class TestORFlow(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		# keep every write inside one transaction; tearDownClass rolls it all back
		frappe.db._disable_transaction_control = 1
		cls.company = default_company()
		cls.warehouse = "Stores - " + frappe.get_cached_value("Company", cls.company, "abbr")
		cost_center = frappe.get_cached_value("Company", cls.company, "cost_center")

		frappe.get_doc({"doctype": "Item", "item_code": ITEM, "item_name": "OR test bag", "stock_uom": "Nos", "is_stock_item": 1,
			"item_group": frappe.db.get_value("Item Group", {"is_group": 0})}).insert()
		frappe.get_doc({"doctype": "Stock Entry", "stock_entry_type": "Material Receipt", "company": cls.company,
			"items": [{"item_code": ITEM, "qty": 300, "basic_rate": 60, "t_warehouse": cls.warehouse}]}).insert().submit()

		frappe.get_doc({"doctype": "OR Marketplace", "marketplace_name": MP, "abbreviation": "ORTM"}).insert()
		cls.customer = frappe.get_doc({"doctype": "Customer", "customer_name": MP + " Customer"}).insert().name
		frappe.get_doc({"doctype": "OR Item Mapping", "marketplace": MP, "marketplace_sku": "ORTM-111", "item_code": ITEM, "primary_rate": 100}).insert()
		settings = frappe.get_single("Marketplace OR Settings")
		settings.set("accounts", [{"marketplace": MP, "customer": cls.customer, "debit_note_series": "ACC-SINV-DN-.YYYY.-",
			"credit_note_series": "ACC-SINV-CN-.YYYY.-", "cost_center": cost_center}])
		settings.set("commissions", [])
		settings.update({"group_notes_by": "Month", "approver_role": "Accounts Manager", "auto_create_notes": 0, "auto_submit_notes": 0})
		settings.save()
		frappe.clear_document_cache("Marketplace OR Settings")
		postings.setup_masters(MP)
		cls.cfg = get_account(MP)

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		frappe.db._disable_transaction_control = 0
		frappe.db.rollback()
		frappe.clear_document_cache("Marketplace OR Settings")

	def or_order(self, qty=50, po="PO-1"):
		so = frappe.get_doc({"doctype": "Sales Order", "company": self.company, "customer": self.customer, "sales_flow": "OR",
			"customer_po_number": f"ORTM-{po}", "customer_po_date": nowdate(), "or_marketplace": MP,
			"delivery_date": add_days(nowdate(), 10),
			"items": [{"item_code": ITEM, "qty": qty, "rate": 100, "warehouse": self.warehouse}]}).insert()
		so.submit()
		so.reload()
		return so, frappe.get_doc(OR, so.or_record)

	def stock_ledger(self, voucher_type=None):
		filters = {"item_code": ITEM, "is_cancelled": 0, "voucher_type": ("!=", "Stock Entry")}
		if voucher_type:
			filters["voucher_type"] = voucher_type
		return frappe.get_all("Stock Ledger Entry", filters=filters, fields=["voucher_type", "voucher_no", "actual_qty", "warehouse"])

	def test_outright_flow(self):
		cfg = self.cfg
		so, ort = self.or_order()
		self.assertTrue(ort.name.startswith("OR-ORTM-"))
		self.assertEqual((ort.status, ort.customer, ort.marketplace_po_no), ("Submitted", self.customer, "ORTM-PO-1"))

		# dispatch = a normal Delivery Note: the goods leave your stock
		dn = ort.dispatch([{"so_detail": so.items[0].name, "qty": 30}], "LR-1")
		ort.reload()
		row = ort.stock_movements[0]
		self.assertEqual(ort.status, "Active")
		self.assertEqual((row.movement_type, row.qty, row.delivery_note, row.awb_no, row.status), ("Primary Sale", 30, dn, "LR-1", "Dispatched"))
		self.assertEqual(frappe.db.get_value("Delivery Note", dn, "or_reference"), ort.name)
		self.assertEqual([(s.voucher_no, s.actual_qty) for s in self.stock_ledger()], [(dn, -30)])
		self.assertEqual(frappe.db.get_value("Sales Order Item", so.items[0].name, "delivered_qty"), 30)
		self.assertEqual(ort.stock_in_transit, 30)

		# a return Delivery Note made by hand is refused: returns go through Putaway
		from erpnext.stock.doctype.delivery_note.delivery_note import make_sales_return

		with self.assertRaisesRegex(frappe.ValidationError, "OR order"):
			make_sales_return(dn).insert()

		# primary invoice: a standard Sales Invoice from the Delivery Note, no reversal entry. A site automation may
		# already have made it when the Delivery Note was submitted; it is then the Primary Invoice too.
		made = frappe.get_all("Sales Invoice", filters={"or_reference": ort.name, "docstatus": 1}, pluck="name")
		invoice = frappe.get_doc("Sales Invoice", made[0] if made else ort.make_primary_invoice())
		self.assertEqual((invoice.or_document_type, invoice.update_stock, invoice.customer, invoice.base_net_total), ("Primary Invoice", 0, self.customer, 3000))
		self.assertNotIn(invoice.items[0].income_account, (cfg.provision_account, cfg.variance_account))
		self.assertFalse(frappe.get_all("Journal Entry", filters={"or_reference": ort.name, "docstatus": 1}))
		ort.reload()
		self.assertEqual(ort.stock_movements[0].sales_invoice, invoice.name)
		with self.assertRaisesRegex(frappe.ValidationError, "already invoiced"):
			ort.make_primary_invoice()

		# POD: virtual, nothing in the Stock Ledger; compulsory
		self.assertRaises(frappe.ValidationError, ort.record_receipt, row.name, 20)
		ort.reload()
		ort.record_receipt(row.name, 20, pod())
		ort.reload()
		self.assertEqual((ort.stock_movements[0].status, ort.stock_in_transit, ort.virtual_stock), ("Partially Received", 10, 20))
		self.assertEqual(len(self.stock_ledger()), 1)
		# a received dispatch can't be cancelled
		with self.assertRaisesRegex(frappe.ValidationError, "Primary Return"):
			frappe.get_doc("Delivery Note", dn).cancel()

		# secondary sales: virtual stock only; below-primary variance to the provision (5 x 10 = 50)
		result = ort.import_secondary_sales(csv_text=csv(("ORD-1", nowdate(), "ORTM-111", 5, 90), ("ORD-2", nowdate(), "ORTM-111", 2, 110)))
		ort.reload()
		self.assertEqual(result["imported"], 2)
		self.assertEqual((ort.total_sold_qty, ort.virtual_stock, ort.status), (7, 13, "Under Reconciliation"))
		self.assertEqual(len(self.stock_ledger()), 1)  # still only the Delivery Note
		self.assertEqual(balance(ort.name, cfg.variance_account), 50)
		self.assertEqual(balance(ort.name, cfg.provision_account), -50)
		self.assertEqual(ort.provision_amount, 50)
		below = frappe.get_doc("OR Secondary Sales Order", {"marketplace_order_id": "ORD-1"})
		above = frappe.get_doc("OR Secondary Sales Order", {"marketplace_order_id": "ORD-2"})
		self.assertTrue(below.journal_entry)
		self.assertFalse(above.journal_entry)
		self.assertFalse(hasattr(below, "stock_entry") and below.get("stock_entry"))
		# the provision entry can't be cancelled on its own
		with self.assertRaisesRegex(frappe.ValidationError, "OR Sale Provision"):
			frappe.get_doc("Journal Entry", below.journal_entry).cancel()

		# secondary return of 1 below-primary unit: provision reversed by 10, the unit is held again
		ort.record_secondary_return(below.name, 1)
		ort.reload()
		self.assertEqual((ort.virtual_stock, ort.provision_amount), (14, 40))
		self.assertEqual(balance(ort.name, cfg.provision_account), -40)

		# month end: Credit Note 50 (sale below primary) clears the provision; Debit Note bills the excess (2 x 10)
		# and the returned unit's 10 back to the provision
		ort.create_notes(nowdate())
		ort.reload()
		notes = {n.note_type: n for n in ort.price_notes}
		self.assertEqual((notes["Credit Note"].amount, notes["Debit Note"].amount), (50, 30))
		credit = frappe.get_doc("Sales Invoice", notes["Credit Note"].sales_invoice)
		debit = frappe.get_doc("Sales Invoice", notes["Debit Note"].sales_invoice)
		self.assertEqual({i.income_account for i in credit.items}, {cfg.provision_account})
		self.assertEqual({i.income_account for i in debit.items}, {cfg.provision_account, cfg.variance_account})
		self.assertEqual((credit.return_against, debit.return_against), (invoice.name, invoice.name))
		ort.submit_draft_notes()
		ort.reload()
		self.assertEqual(balance(ort.name, cfg.provision_account), 0)
		self.assertEqual(balance(ort.name, cfg.variance_account), 20)  # 50 - 10 provided, less the 20 billed above primary
		self.assertEqual(balance(ort.name, invoice.debit_to, self.customer), 3000 - 50 + 30)
		self.assertEqual((ort.provision_amount, ort.reconciliation_status), (0, "Reconciled"))

		# primary return: virtual until putaway, then a return Delivery Note brings the stock back
		ret = ort.initiate_return(ITEM, 3, "RET-1")
		ort.mark_dispatched(ret, "RAWB-1")
		ort.reload()
		self.assertEqual((ort.virtual_stock, ort.return_in_transit), (11, 3))
		self.assertEqual(len(self.stock_ledger()), 1)
		out = ort.putaway(ret, 3, self.warehouse)
		ort.reload()
		back = self.stock_ledger("Delivery Note")
		self.assertEqual(sorted(s.actual_qty for s in back), [-30, 3])
		self.assertEqual(frappe.db.get_value("Delivery Note", out["delivery_note"], ["is_return", "return_against"]), (1, dn))
		self.assertEqual(len(out["credit_notes"]), 1)
		self.assertEqual(frappe.db.get_value("Sales Invoice", out["credit_notes"][0], "or_document_type"), "Return Credit Note")
		row = next(r for r in ort.stock_movements if r.name == ret)
		self.assertEqual((row.status, row.delivery_note), ("Return Completed", out["delivery_note"]))
		self.assertEqual(ort.return_in_transit, 0)

	def test_order_rules(self):
		# Flow OR needs the PO number, and an OR Marketplace (filled from the billing customer) to submit
		so = frappe.get_doc({"doctype": "Sales Order", "company": self.company, "customer": self.customer, "sales_flow": "OR",
			"delivery_date": add_days(nowdate(), 10), "items": [{"item_code": ITEM, "qty": 1, "rate": 100, "warehouse": self.warehouse}]})
		with self.assertRaisesRegex(frappe.ValidationError, "Purchase Order Number"):
			so.insert()
		so.update({"customer_po_number": "ORTM-RULES", "customer_po_date": nowdate()})
		so.insert()
		self.assertEqual(so.or_marketplace, MP)
		stranger = frappe.get_doc({"doctype": "Customer", "customer_name": "ORTEST Stranger"}).insert().name
		other = frappe.get_doc({"doctype": "Sales Order", "company": self.company, "customer": stranger, "sales_flow": "OR",
			"customer_po_number": "ORTM-STRANGER", "delivery_date": add_days(nowdate(), 10),
			"items": [{"item_code": ITEM, "qty": 1, "rate": 100, "warehouse": self.warehouse}]}).insert()
		with self.assertRaisesRegex(frappe.ValidationError, "OR Marketplace"):
			other.submit()
		# the PO number is unique per marketplace
		dup = frappe.copy_doc(so)
		dup.customer_po_number = "ORTM-RULES"
		# (ERPNext's own check may answer first, unless Selling Settings allow several orders per PO)
		with self.assertRaisesRegex(frappe.ValidationError, "already used|already exists"):
			dup.insert()
		# a B2C order is left alone
		b2c = frappe.get_doc({"doctype": "Sales Order", "company": self.company, "customer": self.customer, "sales_flow": "B2C/D2C",
			"delivery_date": add_days(nowdate(), 10), "items": [{"item_code": ITEM, "qty": 1, "rate": 100, "warehouse": self.warehouse}]}).insert()
		self.assertFalse(b2c.get("or_marketplace"))
