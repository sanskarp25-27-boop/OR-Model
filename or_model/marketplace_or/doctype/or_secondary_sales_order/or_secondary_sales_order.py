import frappe
from frappe import _
from frappe.model.document import Document

from or_model.marketplace_or.calculations import line_note_type, net_secondary_rate


class ORSecondarySalesOrder(Document):
	"""One Secondary Sale line, or a Secondary Return (negative qty) against one.

	Created and updated only by the OR import, the Secondary Return action and the note logic.
	"""

	def validate(self):
		if not self.flags.from_sor:
			frappe.throw(
				_("OR Secondary Sales Orders are created only by importing secondary sales on a OR Primary Sales Tracker."),
				frappe.PermissionError,
			)
		self.net_secondary_rate = net_secondary_rate(self)
		self.variance_per_unit = self.net_secondary_rate - (self.primary_rate or 0)
		self.total_variance = self.variance_per_unit * (self.qty or 0)
		if not line_note_type(self):
			self.note_status = "No variance"
		elif not self.note_status or self.note_status == "No variance":
			self.note_status = "Not created"

	def on_trash(self):
		if not self.flags.from_sor:
			frappe.throw(_("OR Secondary Sales Orders cannot be deleted."), frappe.PermissionError)
