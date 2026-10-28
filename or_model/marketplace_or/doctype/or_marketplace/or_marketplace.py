import frappe
from frappe import _
from frappe.model.document import Document


class ORMarketplace(Document):
	def validate(self):
		self.abbreviation = (self.abbreviation or "").strip().upper()
		if not self.abbreviation.isalnum() or len(self.abbreviation) > 4:
			frappe.throw(_("Abbreviation must be 1 to 4 letters or digits."))
