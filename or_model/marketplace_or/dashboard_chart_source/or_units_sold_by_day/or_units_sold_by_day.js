frappe.provide("frappe.dashboards.chart_sources");

frappe.dashboards.chart_sources["OR Units Sold by Day"] = {
	method: "or_model.marketplace_or.dashboard_chart_source.or_units_sold_by_day.or_units_sold_by_day.get",
	filters: [],
};
