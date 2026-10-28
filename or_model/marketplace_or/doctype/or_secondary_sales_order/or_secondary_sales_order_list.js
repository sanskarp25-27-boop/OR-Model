frappe.listview_settings["OR Secondary Sales Order"] = {
	add_fields: ["note_status", "is_return"],
	get_indicator(doc) {
		if (doc.is_return && doc.note_status === "No variance") return [__("Secondary Return"), "orange", "is_return,=,1"];
		const color = { "No variance": "gray", "Not created": "red", Draft: "orange", Submitted: "green" }[doc.note_status];
		return [__(doc.note_status), color || "gray", `note_status,=,${doc.note_status}`];
	},
};
