"""Sales Invoice extension (hooks.extend_doctype_class): OR Credit Notes show status "Credit Note", not "Return"."""

from or_model.marketplace_or.calculations import CREDIT_NOTE

OR_CREDIT_NOTE_STATUS = "Credit Note"


class ORSalesInvoice:
	def set_status(self, update=False, status=None, update_modified=True):
		super().set_status(update=False, status=status, update_modified=update_modified)
		if self.docstatus == 1 and self.is_return and self.get("or_document_type") == CREDIT_NOTE:
			self.status = OR_CREDIT_NOTE_STATUS
		if update:
			self.db_set("status", self.status, update_modified=update_modified)
