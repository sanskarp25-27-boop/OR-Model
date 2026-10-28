// OR Credit Notes carry status "Credit Note" (or_model.marketplace_or.sales_invoice)
(() => {
	const settings = (frappe.listview_settings["Sales Invoice"] ||= {});
	const get_indicator = settings.get_indicator;
	settings.get_indicator = function (doc) {
		if (doc.status === "Credit Note") {
			return [__("Credit Note"), "purple", "status,=,Credit Note"];
		}
		return get_indicator ? get_indicator(doc) : undefined;
	};
})();
