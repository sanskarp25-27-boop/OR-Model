import frappe
from frappe import _
from frappe.custom.doctype.property_setter.property_setter import make_property_setter
from frappe.model.document import Document
from frappe.utils import flt


class MarketplaceORSettings(Document):
	def validate(self):
		company = default_company()
		seen = set()
		for row in self.accounts:
			if row.marketplace in seen:
				frappe.throw(_("Row {0}: {1} appears more than once.").format(row.idx, row.marketplace))
			seen.add(row.marketplace)
			if row.cost_center and frappe.db.get_value("Cost Center", row.cost_center, "company") != company:
				frappe.throw(_("Row {0}: {1} is not a cost center of {2}.").format(row.idx, row.cost_center, company))

		with_format = set()
		for row in self.import_formats:
			if row.marketplace in with_format:
				frappe.throw(_("Import format row {0}: {1} appears more than once.").format(row.idx, row.marketplace))
			with_format.add(row.marketplace)

		with_commission = set()
		for row in self.commissions:
			if row.marketplace in with_commission:
				frappe.throw(_("Marketplace Commission row {0}: {1} appears more than once.").format(row.idx, row.marketplace))
			with_commission.add(row.marketplace)
			if not 0 <= flt(row.commission_percent) < 100:
				frappe.throw(_("Marketplace Commission row {0}: Commission % must be from 0 to below 100.").format(row.idx))

		mapped = {}
		for row in self.customer_marketplaces:
			if row.customer in mapped and mapped[row.customer] != row.marketplace:
				frappe.throw(
					_("Customer ↔ Marketplace row {0}: {1} is already mapped to {2}.").format(
						row.idx, row.customer, mapped[row.customer]
					)
				)
			mapped[row.customer] = row.marketplace
		for row in self.accounts:
			if mapped.get(row.customer, row.marketplace) != row.marketplace:
				frappe.throw(
					_("{0} is the Billing Customer of {1} under Marketplace Accounts but is mapped to {2}.").format(
						row.customer, row.marketplace, mapped[row.customer]
					)
				)

	def on_update(self):
		add_naming_series(
			"Sales Invoice",
			[s for row in self.accounts for s in (row.debit_note_series, row.credit_note_series)],
		)
		from or_model.setup import setup_workflow

		setup_workflow()


def get_account(marketplace):
	settings = frappe.get_cached_doc("Marketplace OR Settings")
	for row in settings.accounts:
		if row.marketplace == marketplace:
			return row
	frappe.throw(_("Add {0} under Marketplace Accounts in Marketplace OR Settings.").format(marketplace))


@frappe.whitelist()
def get_marketplace_customer(marketplace):
	"""The marketplace's Billing Customer, else its only mapped customer."""
	settings = frappe.get_cached_doc("Marketplace OR Settings")
	billing = next((row.customer for row in settings.accounts if row.marketplace == marketplace), None)
	if billing:
		return billing
	mapped = list(dict.fromkeys(row.customer for row in settings.customer_marketplaces if row.marketplace == marketplace))
	return mapped[0] if len(mapped) == 1 else None


def get_commission_percent(marketplace):
	"""The marketplace's commission % on secondary sales (0 when it has no row)."""
	settings = frappe.get_cached_doc("Marketplace OR Settings")
	return flt(next((row.commission_percent for row in settings.commissions if row.marketplace == marketplace), 0))


def customers_of(marketplace):
	"""Every customer allowed on this marketplace's OR orders."""
	settings = frappe.get_cached_doc("Marketplace OR Settings")
	return {row.customer for row in settings.customer_marketplaces if row.marketplace == marketplace} | {
		row.customer for row in settings.accounts if row.marketplace == marketplace
	}


@frappe.whitelist()
def get_customer_marketplace(customer):
	"""The customer's marketplace: from Customer ↔ Marketplace, else where it is a Billing Customer."""
	if not customer:
		return None
	settings = frappe.get_cached_doc("Marketplace OR Settings")
	mapped = next((row.marketplace for row in settings.customer_marketplaces if row.customer == customer), None)
	if mapped:
		return mapped
	matches = [row.marketplace for row in settings.accounts if row.customer == customer]
	return matches[0] if len(matches) == 1 else None


def default_company():
	import erpnext

	return erpnext.get_default_company() or frappe.db.get_value("Company", {}, "name")


def add_naming_series(doctype, series_list):
	options = frappe.get_meta(doctype).get_field("naming_series").options or ""
	current = [s for s in options.split("\n") if s.strip()]
	missing = [s for s in dict.fromkeys(series_list) if s and s not in current]
	if missing:
		make_property_setter(
			doctype, "naming_series", "options", "\n".join(current + missing), "Text", validate_fields_for_doctype=False
		)
