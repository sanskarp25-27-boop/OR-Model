// Marketplace OR uses its own full-screen app (/desk/or-app). Send the module's standard routes there before
// they render. Opt out (to reach the classic forms) with localStorage "or_classic" = "1".
(function () {
	if (!window.frappe || !frappe.router || frappe.router.__or_patched) return;

	const LISTS = {
		"or-primary-sales-tracker": ["trackers", "tracker"],
		"or-secondary-sales-order": ["secondary", "order"],
		"or-item-mapping": ["mapping", null],
		"marketplace-or-settings": ["setup", null],
		"or-marketplace": ["setup", null],
	};

	function target(sub_path) {
		if (localStorage.getItem("or_classic") === "1") return null;
		const parts = decodeURIComponent(sub_path || "").replace(/^\/+|\/+$/g, "").split("/");
		const [a, b] = parts;
		if (a === "marketplace-or" && !b) return "or-app";
		if (a === "query-report" && b === "Marketplace OR Dashboard") return "or-app/reports";
		const map = LISTS[a];
		if (!map) return null;
		const [list, form] = map;
		if (!b || ["view", "new"].includes(b) || b.startsWith("new-") || !form) return "or-app/" + list;
		return "or-app/" + form + "/" + encodeURIComponent(b);
	}

	// SOR Model patches re_route too: chain onto whatever is there, so both apps' routes work
	const original = frappe.router.re_route.bind(frappe.router);
	frappe.router.re_route = function (sub_path) {
		const to = target(sub_path);
		if (to) {
			frappe.route_flags.replace_route = true;
			frappe.set_route(to);
			return true;
		}
		return original(sub_path);
	};
	frappe.router.__or_patched = true;
})();
