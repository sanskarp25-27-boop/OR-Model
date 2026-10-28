frappe.ui.form.on("Marketplace OR Settings", {
	setup(frm) {
		frm.set_query("cost_center", "accounts", () => ({ filters: { is_group: 0 } }));
	},
});
