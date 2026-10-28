app_name = "or_model"
app_title = "OR Model"
app_publisher = "Miraggio"
app_description = "Outright (OR) marketplace sales: primary and virtual secondary sales, with the price variance provided for"
app_license = "mit"

required_apps = ["erpnext"]

after_install = "or_model.setup.after_install"
after_migrate = "or_model.setup.after_migrate"

doctype_js = {"Sales Order": "public/js/sales_order.js"}
doctype_list_js = {"Sales Invoice": "public/js/sales_invoice_list.js"}

# the Marketplace OR module opens in its own full-screen app (page "or-app")
app_include_js = ["/assets/or_model/js/or_redirect.js"]

# OR Credit Notes get status "Credit Note" instead of "Return"
extend_doctype_class = {"Sales Invoice": ["or_model.marketplace_or.sales_invoice.ORSalesInvoice"]}

doc_events = {
	"Item": {"validate": "or_model.marketplace_or.item.validate"},
	"Sales Order": {
		"validate": "or_model.marketplace_or.sales_order.validate",
		"before_update_after_submit": "or_model.marketplace_or.sales_order.validate",
		"before_submit": "or_model.marketplace_or.sales_order.before_submit",
		"on_submit": "or_model.marketplace_or.sales_order.on_submit",
		"before_cancel": "or_model.marketplace_or.sales_order.before_cancel",
		"on_cancel": "or_model.marketplace_or.sales_order.on_cancel",
		# the tracker's Status follows the Sales Order's status
		"on_change": "or_model.marketplace_or.sales_order.on_change",
	},
	# an OR order is dispatched by a normal Delivery Note (stock out): its submit adds the Primary Sale rows
	"Delivery Note": {
		"validate": "or_model.marketplace_or.postings.delivery_note_validate",
		"on_submit": "or_model.marketplace_or.postings.delivery_note_on_submit",
		"before_cancel": "or_model.marketplace_or.postings.delivery_note_before_cancel",
		"on_cancel": "or_model.marketplace_or.postings.delivery_note_on_cancel",
	},
	"Sales Invoice": {
		"validate": "or_model.marketplace_or.postings.sales_invoice_validate",
		"before_submit": "or_model.marketplace_or.notes.before_invoice_submit",
		"on_submit": [
			"or_model.marketplace_or.notes.on_invoice_submit",
			"or_model.marketplace_or.postings.sales_invoice_on_submit",
		],
		"before_cancel": "or_model.marketplace_or.notes.before_invoice_cancel",
		"on_cancel": [
			"or_model.marketplace_or.notes.on_invoice_cancel",
			"or_model.marketplace_or.postings.sales_invoice_on_cancel",
		],
	},
	# the provision entry of a secondary import is undone with its lines only from the OR app
	"Journal Entry": {"before_cancel": "or_model.marketplace_or.postings.journal_before_cancel"},
}
