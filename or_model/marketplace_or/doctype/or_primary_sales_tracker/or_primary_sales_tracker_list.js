// Status is the Primary Sales Order's status (order_status), coloured as in the Sales Order list.
frappe.listview_settings["OR Primary Sales Tracker"] = {
	add_fields: ["order_status", "status", "reconciliation_status"],
	get_indicator(doc) {
		const color = {
			Draft: "red",
			"On Hold": "orange",
			"To Deliver and Bill": "orange",
			"To Bill": "orange",
			"To Deliver": "orange",
			Completed: "green",
			Cancelled: "red",
			Closed: "green",
		}[doc.order_status];
		const status = doc.order_status || doc.status;
		return [__(status), color || "gray", `order_status,=,${status}`];
	},
};
