frappe.provide("frappe.dashboards.chart_sources");

frappe.dashboards.chart_sources["OR Stock by Marketplace"] = {
	method: "or_model.marketplace_or.dashboard_chart_source.or_stock_by_marketplace.or_stock_by_marketplace.get",
	filters: [],
};
