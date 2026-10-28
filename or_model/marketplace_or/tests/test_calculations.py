"""Unit tests for the OR formulas. No database needed."""

import unittest
from datetime import date

from or_model.marketplace_or.calculations import (
	CREDIT_NOTE,
	DEBIT_NOTE,
	OUTBOUND,
	RETURN,
	group_lines_for_notes,
	item_positions,
	line_variance,
	net_rate,
	note_type_for,
	summarize,
	validate_import_rows,
)


def out(qty, received, status="Received", item="BAG"):
	return {"movement_type": OUTBOUND, "item_code": item, "qty": qty, "received_qty": received, "status": status}


def ret(qty, received, status, item="BAG"):
	return {"movement_type": RETURN, "item_code": item, "qty": qty, "received_qty": received, "status": status}


def sale(qty, primary, selling, item="BAG", sale_date="2026-10-01", batch="B1", price_note=None, order_id="X", commission=0):
	return {
		"item_code": item,
		"qty": qty,
		"primary_rate": primary,
		"selling_rate": selling,
		"commission_percent": commission,
		"sale_date": sale_date,
		"import_batch": batch,
		"price_note": price_note,
		"marketplace_order_id": order_id,
	}


class TestStockFormulas(unittest.TestCase):
	def test_draft_and_cancelled_dispatches_are_ignored(self):
		p = item_positions([out(10, 0, "Draft"), out(5, 0, "Cancelled"), out(20, 0, "Dispatched")], [])["BAG"]
		self.assertEqual(p["dispatched"], 20)
		self.assertEqual(p["in_transit"], 20)

	def test_stock_in_transit_counts_partial_receipts(self):
		p = item_positions([out(100, 60, "Partially Received"), out(50, 50)], [])["BAG"]
		self.assertEqual(p["in_transit"], 40)
		self.assertEqual(p["received"], 110)

	def test_virtual_stock_is_received_minus_sold_minus_returns_dispatched(self):
		movements = [out(100, 100), ret(10, 0, "Return Dispatched"), ret(5, 0, "Return Initiated")]
		p = item_positions(movements, [sale(30, 100, 100)])["BAG"]
		self.assertEqual(p["virtual_stock"], 100 - 30 - 10)

	def test_initiated_return_does_not_reduce_virtual_stock_but_reduces_available(self):
		p = item_positions([out(50, 50), ret(5, 0, "Return Initiated")], [])["BAG"]
		self.assertEqual(p["virtual_stock"], 50)
		self.assertEqual(p["return_pending"], 5)
		self.assertEqual(p["available"], 45)

	def test_return_in_transit_and_completed_return_are_not_counted_twice(self):
		movements = [out(50, 50), ret(10, 4, "Partially Received"), ret(6, 6, "Return Completed")]
		p = item_positions(movements, [])["BAG"]
		self.assertEqual(p["return_in_transit"], 6)
		self.assertEqual(p["virtual_stock"], 50 - 16)
		self.assertEqual(p["return_received"], 10)

	def test_summary_values_and_variance(self):
		lines = [sale(2, 100, 110), sale(1, 100, 90), sale(3, 100, 100)]
		s = summarize([out(10, 10)], lines, [])
		self.assertEqual(s["total_sold_qty"], 6)
		self.assertEqual(s["primary_sales_value"], 600)
		self.assertEqual(s["secondary_sales_value"], 610)
		self.assertEqual(s["net_price_variance"], 10)
		self.assertEqual(s["variance_not_invoiced"], 30)
		self.assertEqual(s["reconciliation_status"], "Variance not invoiced")

	def test_reconciliation_status_progression(self):
		self.assertEqual(summarize([], [], [])["reconciliation_status"], "Pending")
		noted = [sale(1, 100, 110, price_note="row1")]
		self.assertEqual(
			summarize([], noted, [{"status": "Draft", "note_type": DEBIT_NOTE, "amount": 10}])["reconciliation_status"],
			"Notes awaiting submission",
		)
		done = summarize([], noted, [{"status": "Submitted", "note_type": DEBIT_NOTE, "amount": 10}])
		self.assertEqual(done["reconciliation_status"], "Reconciled")
		self.assertEqual(done["debit_note_amount"], 10)
		self.assertEqual(done["net_adjustment_amount"], 10)


class TestCommission(unittest.TestCase):
	def test_commission_is_deducted_from_the_secondary_rate(self):
		self.assertEqual(net_rate(120, 25), 90)
		self.assertEqual(net_rate(120, 0), 120)

	def test_variance_uses_secondary_rate_without_commission(self):
		# sold to Myntra at 150, Myntra sells at 120 with 25% commission -> 90 without commission
		line = sale(2, 150, 120, commission=25)
		self.assertEqual(line_variance(line), (90 - 150) * 2)
		groups = group_lines_for_notes([line], "Sale Date")
		self.assertEqual((groups[0]["note_type"], groups[0]["amount"]), (CREDIT_NOTE, 120))

	def test_commission_can_turn_a_debit_into_a_credit(self):
		# 120 is above 100, but 120 less 25% = 90 is below it
		self.assertEqual(group_lines_for_notes([sale(1, 100, 120, commission=25)], "Sale Date")[0]["note_type"], CREDIT_NOTE)
		self.assertEqual(group_lines_for_notes([sale(1, 100, 120)], "Sale Date")[0]["note_type"], DEBIT_NOTE)

	def test_summary_shows_commission_and_net_variance(self):
		s = summarize([out(10, 10)], [sale(2, 150, 120, commission=25)], [])
		self.assertEqual(s["secondary_sales_value"], 240)
		self.assertEqual(s["marketplace_commission"], 60)
		self.assertEqual(s["net_price_variance"], -120)
		self.assertEqual(s["variance_not_invoiced"], 120)

	def test_import_stores_the_commission(self):
		rows = [{"marketplace_order_id": "A", "sale_date": "2026-10-01", "marketplace_sku": "MYN-1", "qty": 1, "selling_price": 120}]
		accepted, _dup, errors = validate_import_rows(rows, {"MYN-1": {"item_code": "BAG", "primary_rate": 150}}, [], {"BAG": 5}, 25)
		self.assertEqual(errors, [])
		self.assertEqual((accepted[0]["commission_percent"], accepted[0]["net_secondary_rate"]), (25, 90))


class TestSecondaryReturn(unittest.TestCase):
	def test_return_gives_stock_back_and_nets_values(self):
		lines = [sale(4, 100, 90), sale(-1, 100, 90)]  # a Secondary Return has negative qty
		p = item_positions([out(10, 10)], lines)["BAG"]
		self.assertEqual((p["sold"], p["secondary_returned"], p["virtual_stock"]), (4, 1, 7))
		self.assertEqual((p["primary_value"], p["secondary_value"], p["net_variance"]), (300, 270, -30))

	def test_return_reverses_the_note_direction(self):
		groups = group_lines_for_notes([sale(-1, 100, 90)], "Sale Date")
		self.assertEqual((groups[0]["note_type"], groups[0]["amount"]), (DEBIT_NOTE, 10))
		groups = group_lines_for_notes([sale(-2, 100, 130)], "Sale Date")
		self.assertEqual((groups[0]["note_type"], groups[0]["amount"]), (CREDIT_NOTE, 60))

	def test_summary_counts_secondary_returns(self):
		s = summarize([out(10, 10)], [sale(4, 100, 100), sale(-1, 100, 100)], [])
		self.assertEqual((s["total_sold_qty"], s["secondary_return_qty"], s["virtual_stock"]), (4, 1, 7))


class TestNotes(unittest.TestCase):
	def test_direction(self):
		self.assertEqual(note_type_for(100, 110), DEBIT_NOTE)
		self.assertEqual(note_type_for(100, 90), CREDIT_NOTE)
		self.assertIsNone(note_type_for(100, 100))

	def test_grouping_by_sale_date_splits_debit_and_credit(self):
		lines = [
			sale(2, 100, 110, sale_date="2026-10-01"),
			sale(1, 100, 105, sale_date="2026-10-01"),
			sale(1, 100, 90, sale_date="2026-10-01"),
			sale(1, 100, 120, sale_date="2026-10-02"),
			sale(1, 100, 100, sale_date="2026-10-02"),
		]
		groups = group_lines_for_notes(lines, "Sale Date")
		summary = [(g["group_key"], g["note_type"], len(g["lines"]), g["amount"]) for g in groups]
		self.assertEqual(
			summary,
			[("2026-10-01", CREDIT_NOTE, 1, 10), ("2026-10-01", DEBIT_NOTE, 2, 25), ("2026-10-02", DEBIT_NOTE, 1, 20)],
		)

	def test_grouping_by_import_batch(self):
		lines = [sale(1, 100, 110, sale_date="2026-10-01", batch="A"), sale(1, 100, 130, sale_date="2026-10-05", batch="A")]
		groups = group_lines_for_notes(lines, "Import Batch")
		self.assertEqual(len(groups), 1)
		self.assertEqual(groups[0]["amount"], 40)

	def test_a_line_already_in_a_note_is_never_grouped_again(self):
		lines = [sale(1, 100, 110, price_note="existing"), sale(1, 100, 110)]
		groups = group_lines_for_notes(lines, "Sale Date")
		self.assertEqual(sum(len(g["lines"]) for g in groups), 1)


class TestImportValidation(unittest.TestCase):
	sku_map = {"MYN-1": {"item_code": "BAG", "primary_rate": 100}}

	def row(self, order_id, qty=1, price=110, sku="MYN-1", sale_date="2026-10-01"):
		return {"marketplace_order_id": order_id, "sale_date": sale_date, "marketplace_sku": sku, "qty": qty, "selling_price": price}

	def test_duplicates_are_skipped_and_reported(self):
		rows = [self.row("A"), self.row("B"), self.row("A")]
		accepted, duplicates, errors = validate_import_rows(rows, self.sku_map, ["B"], {"BAG": 10})
		self.assertEqual([r["marketplace_order_id"] for r in accepted], ["A"])
		self.assertEqual(sorted(duplicates), ["A", "B"])
		self.assertEqual(errors, [])

	def test_primary_rate_comes_from_the_mapping(self):
		accepted, _dup, _err = validate_import_rows([self.row("A", price=95)], self.sku_map, [], {"BAG": 10})
		self.assertEqual((accepted[0]["primary_rate"], accepted[0]["selling_rate"]), (100, 95))
		self.assertEqual(accepted[0]["sale_date"], date(2026, 10, 1))

	def test_cannot_sell_more_than_available(self):
		_acc, _dup, errors = validate_import_rows([self.row("A", qty=4), self.row("B", qty=3)], self.sku_map, [], {"BAG": 6})
		self.assertEqual(len(errors), 1)
		self.assertIn("only 6", errors[0])

	def test_unmapped_sku_and_bad_values_are_errors(self):
		rows = [self.row("A", sku="NOPE"), self.row("B", qty="x"), self.row("C", sale_date="01/10/2026"), self.row("", qty=1)]
		_acc, _dup, errors = validate_import_rows(rows, self.sku_map, [], {"BAG": 10})
		self.assertEqual(len(errors), 4)
