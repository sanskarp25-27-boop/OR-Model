"""Roles, Workflow and custom fields for OR Model. Runs after install and every migrate; safe to re-run."""

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

OR_DOCTYPE = "OR Primary Sales Tracker"
OR_USER = "OR User"
STATES = ("Submitted", "Active", "Under Reconciliation", "Reconciled", "Closed")
ACTIONS = ("Approve", "Close", "Reopen")


def after_install():
	after_migrate()


def after_migrate():
	setup_roles()
	setup_custom_fields()
	setup_workflow()
	setup_workspace_block()


DASHBOARD_BLOCK = "OR Dashboard"


def setup_workspace_block():
	"""The dark dashboard on the Marketplace OR workspace; its code lives in marketplace_or/workspace_block/."""
	folder = frappe.get_app_path("or_model", "marketplace_or", "workspace_block")

	def read(ext):
		with open(f"{folder}/or_dashboard.{ext}", encoding="utf-8") as f:
			return f.read()

	values = {"html": read("html"), "style": read("css"), "script": read("js"), "private": 0}
	# Frappe only renders a Custom HTML Block for users who can read the doctype (System Manager by default)
	from frappe.permissions import add_permission

	for role in (OR_USER, "Accounts Manager"):
		if not frappe.db.exists("Custom DocPerm", {"parent": "Custom HTML Block", "role": role, "permlevel": 0}):
			add_permission("Custom HTML Block", role, 0)

	roles = [{"role": r} for r in (OR_USER, "Accounts Manager", "System Manager")]
	if frappe.db.exists("Custom HTML Block", DASHBOARD_BLOCK):
		block = frappe.get_doc("Custom HTML Block", DASHBOARD_BLOCK)
		block.update(values)
		block.set("roles", roles)
		block.save(ignore_permissions=True)
	else:
		frappe.get_doc(
			{"doctype": "Custom HTML Block", "__newname": DASHBOARD_BLOCK, "roles": roles, **values}
		).insert(ignore_permissions=True)


def setup_roles():
	if not frappe.db.exists("Role", OR_USER):
		frappe.get_doc({"doctype": "Role", "role_name": OR_USER, "desk_access": 1}).insert(ignore_permissions=True)


def setup_custom_fields():
	reference = {
		"fieldname": "or_reference",
		"label": "OR Primary Sales Tracker",
		"fieldtype": "Link",
		"options": OR_DOCTYPE,
		"read_only": 1,
		"no_copy": 1,
		"in_standard_filter": 1,
		"search_index": 1,
	}
	create_custom_fields(
		{
			"Sales Invoice": [
				{**reference, "insert_after": "customer_name"},
				{
					"fieldname": "or_document_type",
					"label": "OR Document",
					"fieldtype": "Select",
					# Primary Invoice: bills the marketplace for a dispatch; Return Credit Note: goods came back;
					# Debit / Credit Note: month-end rate-difference settlement
					"options": "\nPrimary Invoice\nReturn Credit Note\nDebit Note\nCredit Note",
					"insert_after": "or_reference",
					"read_only": 1,
					"no_copy": 1,
					"depends_on": "or_reference",
				},
			],
			# dispatch Delivery Notes and the return ones made at Putaway
			"Delivery Note": [{**reference, "insert_after": "customer_name"}],
			"Journal Entry": [
				{**reference, "insert_after": "voucher_type"},
				{
					"fieldname": "or_purpose",
					"label": "OR Step",
					"fieldtype": "Select",
					"options": "\n" + "\n".join(JOURNAL_PURPOSES),
					"insert_after": "or_reference",
					"read_only": 1,
					"no_copy": 1,
					"depends_on": "or_reference",
				},
				{
					"fieldname": "or_against",
					"label": "OR Source Document",
					"fieldtype": "Data",
					"description": "The Sales Invoice or import batch this entry was posted for; cancelled with it.",
					"insert_after": "or_purpose",
					"read_only": 1,
					"no_copy": 1,
					"search_index": 1,
					"depends_on": "or_reference",
				},
			],
			# each note line points at the secondary sale it notes; its sales_order is the primary order
			"Sales Invoice Item": [
				{
					"fieldname": "or_secondary_sales_order",
					"label": "OR Secondary Sales Order",
					"fieldtype": "Link",
					"options": "OR Secondary Sales Order",
					"insert_after": "sales_order",
					"read_only": 1,
					"no_copy": 1,
					"search_index": 1,
				},
			],
			"Sales Order": OR_ORDER_FIELDS,
		},
		update=True,
	)
	# Flow, the customer PO fields and the marketplace SKU codes are shared with SOR Model when it is installed:
	# created here only when missing, so neither app overwrites the other's definition
	create_custom_fields(
		{
			"Sales Order": [f for f in SHARED_ORDER_FIELDS if not _field_exists("Sales Order", f["fieldname"])],
			"Item": [f for f in ITEM_SKU_FIELDS if not _field_exists("Item", f["fieldname"])],
		}
	)
	add_credit_note_status()


def _field_exists(doctype, fieldname):
	return bool(frappe.db.exists("Custom Field", {"dt": doctype, "fieldname": fieldname}))


# the OR steps that post journal entries (marketplace_or/postings.py)
JOURNAL_PURPOSES = ("Sale Provision",)


def add_credit_note_status():
	"""Allow status "Credit Note" on Sales Invoice; set for OR Credit Notes by marketplace_or/sales_invoice.py."""
	from frappe.custom.doctype.property_setter.property_setter import make_property_setter

	options = frappe.db.get_value("DocField", {"parent": "Sales Invoice", "fieldname": "status"}, "options") or ""
	if "Credit Note" not in options.split("\n"):
		options += "\nCredit Note"
	make_property_setter("Sales Invoice", "status", "options", options, "Text", validate_fields_for_doctype=False)


NEEDS_PO ="eval:doc.sales_flow && doc.sales_flow != 'B2C/D2C'"
IS_OR = "eval:doc.sales_flow == 'OR'"
NEEDS_PO_DATE = "eval:['OR', 'B2B'].includes(doc.sales_flow)"  # keep in step with PO_DATE_FLOWS in sales_order.py

# Details tab, under Customer. customer_po_number is kept in sync with the standard po_no field.
SHARED_ORDER_FIELDS = [
	{
		"fieldname": "sales_flow",
		"label": "Flow",
		"fieldtype": "Select",
		"options": "B2C/D2C\nB2B\nSOR\nOR\nFBA",
		"default": "B2C/D2C",
		"reqd": 1,
		"insert_after": "customer_name",
		"in_standard_filter": 1,
		"in_list_view": 1,
	},
	{
		"fieldname": "customer_po_number",
		"label": "Customer Purchase Order Number",
		"fieldtype": "Data",
		"insert_after": "sales_flow",
		"depends_on": NEEDS_PO,
		"mandatory_depends_on": NEEDS_PO,
		"allow_on_submit": 1,
		"no_copy": 1,
		"in_standard_filter": 1,
	},
	{
		"fieldname": "customer_po_date",
		"label": "Customer Purchase Order Date",
		"fieldtype": "Date",
		"insert_after": "customer_po_number",
		"depends_on": NEEDS_PO,
		"mandatory_depends_on": NEEDS_PO_DATE,
		"allow_on_submit": 1,
		"no_copy": 1,
	},
	{
		"fieldname": "customer_po_attachment",
		"label": "Customer Purchase Order",
		"fieldtype": "Attach",
		"insert_after": "customer_po_date",
		"depends_on": NEEDS_PO,
		"allow_on_submit": 1,
		"no_copy": 1,
		"description": "The customer's PO document (PDF / image).",
	},
]

OR_ORDER_FIELDS = [
	{
		"fieldname": "or_marketplace",
		"label": "OR Marketplace",
		"fieldtype": "Link",
		"options": "OR Marketplace",
		"insert_after": "customer_po_attachment",
		"description": "Filled from the Customer (Marketplace OR Settings > Marketplace Accounts).",
		"depends_on": IS_OR,
		"mandatory_depends_on": IS_OR,
		"in_standard_filter": 1,
	},
	{
		"fieldname": "or_record",
		"label": "OR Primary Sales Tracker",
		"fieldtype": "Link",
		"options": OR_DOCTYPE,
		"insert_after": "or_marketplace",
		"read_only": 1,
		"no_copy": 1,
		"allow_on_submit": 1,
		"depends_on": "or_record",
	},
]


# Under Item Name. Secondary-sales imports match marketplace_sku against these (marketplace_or/item.py).
ITEM_SKU_FIELDS = [
	{
		"fieldname": fieldname,
		"label": f"{marketplace} SKU Code",
		"fieldtype": "Data",
		"insert_after": after,
		"search_index": 1,
		"no_copy": 1,
	}
	for marketplace, fieldname, after in (
		("Myntra", "myntra_sku_code", "item_name"),
		("Ajio", "ajio_sku_code", "myntra_sku_code"),
		("Blinkit", "blinkit_sku_code", "ajio_sku_code"),
		("Zepto", "zepto_sku_code", "blinkit_sku_code"),
	)
]


def setup_workflow():
	for state in STATES:
		if not frappe.db.exists("Workflow State", state):
			frappe.get_doc({"doctype": "Workflow State", "workflow_state_name": state}).insert(ignore_permissions=True)
	for action in ACTIONS:
		if not frappe.db.exists("Workflow Action Master", action):
			frappe.get_doc({"doctype": "Workflow Action Master", "workflow_action_name": action}).insert(
				ignore_permissions=True
			)

	approver = approver_role()
	name = frappe.db.get_value("Workflow", {"document_type": OR_DOCTYPE})
	workflow = frappe.get_doc("Workflow", name) if name else frappe.new_doc("Workflow")
	workflow.update(
		{
			"workflow_name": OR_DOCTYPE,
			"document_type": OR_DOCTYPE,
			"workflow_state_field": "status",
			"is_active": 1,
			"send_email_alert": 0,
		}
	)
	workflow.set(
		"states",
		[
			{"state": "Submitted", "doc_status": "0", "allow_edit": OR_USER},
			{"state": "Active", "doc_status": "0", "allow_edit": OR_USER},
			{"state": "Under Reconciliation", "doc_status": "0", "allow_edit": OR_USER},
			{"state": "Reconciled", "doc_status": "0", "allow_edit": approver},
			{"state": "Closed", "doc_status": "0", "allow_edit": approver},
		],
	)
	# Submitted -> Active and Active -> Under Reconciliation happen only automatically (first dispatch / first import),
	# so a record can't be marked Active without a dispatch
	workflow.set(
		"transitions",
		[
			{
				"state": "Under Reconciliation",
				"action": "Approve",
				"next_state": "Reconciled",
				"allowed": approver,
				"allow_self_approval": 1,
				"condition": 'doc.reconciliation_status == "Reconciled"',
			},
			{"state": "Reconciled", "action": "Close", "next_state": "Closed", "allowed": approver, "allow_self_approval": 1},
			{
				"state": "Reconciled",
				"action": "Reopen",
				"next_state": "Under Reconciliation",
				"allowed": approver,
				"allow_self_approval": 1,
			},
		],
	)
	workflow.flags.ignore_permissions = True
	workflow.save()


def approver_role():
	return frappe.db.get_single_value("Marketplace OR Settings", "approver_role") or "Accounts Manager"
