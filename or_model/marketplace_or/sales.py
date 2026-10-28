"""Secondary-sales import: the marketplace's sales to end customers become OR Secondary Sales Orders.

Nothing moves in the Stock Ledger: the units leave the marketplace's virtual stock on the OR Primary Sales
Tracker. Each import batch (and each secondary return) books only the variance of lines sold below the
primary rate to the OR Sale Provision (postings.post_secondary), cleared by the month-end notes (notes.py).
Each line keeps the marketplace's commission % at import time.
"""

import re
from collections import Counter
from datetime import date, datetime

import frappe
from frappe import _
from frappe.utils import cint, flt, now_datetime, nowdate
from frappe.utils.csvutils import read_csv_content

from or_model.marketplace_or import calculations, notes, postings, stock
from or_model.marketplace_or.doctype.or_item_mapping.or_item_mapping import get_sku_map
from or_model.marketplace_or.doctype.marketplace_or_settings.marketplace_or_settings import get_commission_percent

SECONDARY = "OR Secondary Sales Order"
COLUMNS = ("marketplace_order_id", "sale_date", "marketplace_sku", "qty", "selling_price")


TRACKER = "OR Primary Sales Tracker"


def import_sales(ort, csv_text=None, file_url=None):
	"""Import a sales report into one Primary Sales record, read with its marketplace's import format."""
	stock.require_editable(ort)
	fmt = get_import_format(ort.marketplace)
	rows, filtered, errors = apply_format(read_table(csv_text, file_url), fmt)
	if errors:
		frappe.throw("<br>".join(errors[:20]), title=_("Nothing was imported"))
	other_po = 0
	if fmt.po_column:
		# a full marketplace report can hold other POs: keep only this record's lines
		mine = [r for r in rows if str(r.get("po_no") or "").strip() == str(ort.marketplace_po_no or "").strip()]
		other_po = len(rows) - len(mine)
		rows = mine
	rows, returns = _split_returns(rows)
	if not rows and not returns:
		frappe.throw(_("The file has no sales lines for {0}.").format(ort.name) + _skipped_text(filtered, other_po))

	accepted, duplicates = [], []
	if rows:
		positions = calculations.item_positions(ort.stock_movements, ort.get_lines())
		accepted, duplicates, errors = calculations.validate_import_rows(
			rows,
			get_sku_map(ort.marketplace, ort.sales_order),
			_existing_order_ids(rows),
			# held stock plus units dispatched without a POD yet (flagged under Needs attention)
			{code: position["sellable"] for code, position in positions.items()},
			get_commission_percent(ort.marketplace),
		)
		if errors:
			frappe.throw("<br>".join(errors[:20]), title=_("Nothing was imported"))

	batch = "SSR-" + now_datetime().strftime("%Y%m%d%H%M%S")
	result = {"imported": 0, "duplicates": duplicates, "variance_lines": 0, "notes_created": 0, "batch": batch}
	if accepted:
		result = _insert_lines(ort, accepted, batch, duplicates)
	result.update(_apply_returns(returns, ort.marketplace, {ort.name: ort}, only_record=ort.name))
	if not accepted and not result["returns"]:
		frappe.throw(_nothing_new_text(result) + _skipped_text(filtered, other_po), title=_("Nothing to import"))
	result.update({"filtered": filtered, "other_po": other_po})
	return result


def import_marketplace_sales(marketplace, csv_text=None, file_url=None):
	"""Import a marketplace's sales report from the Secondary Sales page.

	Each line is placed on one open Primary Sales record of that marketplace: the record with the line's
	PO number when the format has a PO column, otherwise the oldest record (by PO date) that still holds
	enough of the item. Every check of the per-record import applies; on any error nothing is imported.
	"""
	if not marketplace or not frappe.db.exists("OR Marketplace", marketplace):
		frappe.throw(_("Select the marketplace whose sales report this is."))
	frappe.has_permission(TRACKER, "write", throw=True)
	fmt = get_import_format(marketplace)
	rows, filtered, errors = apply_format(read_table(csv_text, file_url), fmt)
	if errors:
		frappe.throw("<br>".join(errors[:20]), title=_("Nothing was imported"))
	rows, returns = _split_returns(rows)
	if not rows and not returns:
		frappe.throw(_("The file has no sales lines.") + _skipped_text(filtered, 0))

	records = frappe.get_all(
		TRACKER,
		filters={"marketplace": marketplace, "status": ("!=", "Closed")},
		fields=["name", "marketplace_po_no", "sales_order"],
		order_by="po_date asc, creation asc",
	)
	if not records:
		frappe.throw(_("{0} has no open Primary Sales record to import sales into.").format(marketplace))
	docs = {r.name: frappe.get_doc(TRACKER, r.name) for r in records}
	held = {}
	for name, doc in docs.items():
		positions = calculations.item_positions(doc.stock_movements, doc.get_lines())
		held[name] = {code: position["sellable"] for code, position in positions.items()}
	left = {name: dict(items) for name, items in held.items()}
	by_po = {str(r.marketplace_po_no or "").strip(): r.name for r in records if r.marketplace_po_no}
	sku_items = get_sku_map(marketplace)

	seen = set(_existing_order_ids(rows))
	assigned, duplicates = {}, []
	for row in rows:
		number = row["_row"]
		order_id = str(row.get("marketplace_order_id") or "").strip()
		if order_id and order_id in seen:
			duplicates.append(order_id)
			continue
		if order_id:
			seen.add(order_id)
		sku = str(row.get("marketplace_sku") or "").strip()
		mapping = sku_items.get(sku)
		if not mapping:
			errors.append(_("Row {0}: SKU {1} is not set on any Item for {2}").format(number, sku or _("(blank)"), marketplace))
			continue
		item = mapping["item_code"]
		qty = flt(row.get("qty"))
		if fmt.po_column:
			po = str(row.get("po_no") or "").strip()
			record = by_po.get(po)
			if not record:
				errors.append(_("Row {0}: PO {1} has no open Primary Sales record for {2}").format(number, po or _("(blank)"), marketplace))
				continue
		else:
			record = next((r.name for r in records if left[r.name].get(item, 0) >= qty - 1e-9), None)
			if not record:
				errors.append(
					_("Row {0}: {1} x {2}: no open Primary Sales record of {3} still holds that many (held in all: {4})").format(
						number, f"{qty:g}", item, marketplace, f"{sum(max(left[n].get(item, 0), 0) for n in left):g}"
					)
				)
				continue
		left[record][item] = left[record].get(item, 0) - qty
		assigned.setdefault(record, []).append(row)

	checked = {}
	commission = get_commission_percent(marketplace)
	for record, record_rows in assigned.items():
		doc = docs[record]
		doc.check_permission("write")
		accepted, _dups, record_errors = calculations.validate_import_rows(
			record_rows, get_sku_map(marketplace, doc.sales_order), [], held[record], commission
		)
		errors.extend(f"{record}: {e}" for e in record_errors)
		checked[record] = accepted
	if errors:
		frappe.throw("<br>".join(errors[:20]), title=_("Nothing was imported"))

	batch = "SSR-" + now_datetime().strftime("%Y%m%d%H%M%S")
	totals = {"imported": 0, "variance_lines": 0, "notes_created": 0, "records": {}}
	for record, accepted in checked.items():
		if not accepted:
			continue
		result = _insert_lines(docs[record], accepted, batch, [])
		totals["records"][record] = result["imported"]
		for key in ("imported", "variance_lines", "notes_created"):
			totals[key] += result[key]
	totals.update({"duplicates": duplicates, "filtered": filtered, "batch": batch})
	totals.update(_apply_returns(returns, marketplace, docs))
	if not totals["imported"] and not totals["returns"]:
		frappe.throw(_nothing_new_text(totals) + _skipped_text(filtered, 0), title=_("Nothing to import"))
	return totals


def _existing_order_ids(rows):
	order_ids = [str(r.get("marketplace_order_id") or "").strip() for r in rows]
	return frappe.get_all(
		SECONDARY, filters={"marketplace_order_id": ("in", [i for i in order_ids if i] or [""])}, pluck="marketplace_order_id"
	)


def _skipped_text(filtered, other_po):
	parts = []
	if filtered:
		parts.append(_("{0} row(s) left out by the format's row filter").format(filtered))
	if other_po:
		parts.append(_("{0} row(s) belong to other POs").format(other_po))
	return (" " + "; ".join(parts) + ".") if parts else ""


def _nothing_new_text(result):
	parts = [_("Every line in the file was already imported.")]
	if result.get("duplicates"):
		parts.append(_("{0} sale(s) already recorded.").format(len(result["duplicates"])))
	if result.get("return_duplicates"):
		parts.append(_("{0} return(s) already recorded.").format(result["return_duplicates"]))
	if result.get("returns_unmatched"):
		parts.append(_("{0} return(s) have no recorded sale.").format(len(result["returns_unmatched"])))
	return " ".join(parts)


def _split_returns(rows):
	"""(sales, returns): rows the format marked as customer returns are recorded against their sale."""
	return [r for r in rows if not r.get("is_return")], [r for r in rows if r.get("is_return")]


def _apply_returns(returns, marketplace, docs, only_record=None):
	"""Record the file's customer returns as Secondary Returns against the sale with the same order ID.

	A return's ID is "<order ID>-R", so importing the same report again does not record it twice. A
	return whose sale was never imported (sold before this system, or in a report not yet imported) or
	whose Primary Sales record is closed is left out and listed in returns_unmatched; it changes nothing.
	"""
	out = {"returns": 0, "return_duplicates": 0, "returns_unmatched": []}
	if not returns:
		return out
	keys = list({r["marketplace_order_id"] for r in returns if r.get("marketplace_order_id")})
	existing = set(
		frappe.get_all(
			SECONDARY,
			filters={"marketplace": marketplace, "is_return": 1, "marketplace_order_id": ("in", [f"{k}-R" for k in keys] or [""])},
			pluck="marketplace_order_id",
		)
	)
	sales = {
		s.marketplace_order_id: s
		for s in frappe.get_all(
			SECONDARY,
			filters={"marketplace": marketplace, "is_return": 0, "marketplace_order_id": ("in", keys or [""])},
			fields=["name", "marketplace_order_id", "or_reference"],
		)
	}
	for row in returns:
		key = row.get("marketplace_order_id") or ""
		return_id = f"{key}-R"
		if return_id in existing:
			out["return_duplicates"] += 1
			continue
		sale = sales.get(key)
		if not sale or (only_record and sale.or_reference != only_record):
			out["returns_unmatched"].append(_("Row {0}: {1} has no imported sale{2}").format(
				row["_row"], key or _("(blank)"), _(" on {0}").format(only_record) if only_record else ""
			))
			continue
		doc = docs.get(sale.or_reference) or frappe.get_doc(TRACKER, sale.or_reference)
		try:
			record_secondary_return(doc, sale.name, row["qty"], row["sale_date"], return_id)
		except frappe.ValidationError as e:
			_drop_last_message()
			out["returns_unmatched"].append(_("Row {0}: {1}: {2}").format(row["_row"], key, frappe.utils.strip_html(str(e))))
			continue
		docs[sale.or_reference] = doc
		existing.add(return_id)
		out["returns"] += 1
	return out


def _drop_last_message():
	"""A caught frappe.throw still leaves its message for the browser; remove it."""
	log = getattr(frappe.local, "message_log", None)
	if log:
		log.pop()


def _insert_lines(ort, accepted, batch, duplicates):
	"""Create the checked lines as OR Secondary Sales Orders of one record, then update the record."""
	orders = []
	for row in accepted:
		order = frappe.get_doc(
			{
				"doctype": SECONDARY,
				"marketplace": ort.marketplace,
				"or_reference": ort.name,
				"sales_order": ort.sales_order,
				"marketplace_po_no": ort.marketplace_po_no,
				"import_batch": batch,
				**row,
			}
		)
		order.flags.from_sor = True
		order.insert(ignore_permissions=True)
		orders.append(order)
	postings.post_secondary(ort, orders, batch)

	variance_count = sum(1 for o in orders if o.note_status != "No variance")
	ort.add_comment(
		"Info",
		_("Imported {0} secondary sales lines (batch {1}){2}. {3} with price variance.").format(
			len(orders), batch, _(", skipped {0} duplicates").format(len(duplicates)) if duplicates else "", variance_count
		),
	)
	if ort.status in ("Submitted", "Active"):
		stock.set_system_status(ort, "Under Reconciliation", _("first secondary sales import"))

	created = []
	if frappe.get_cached_doc("Marketplace OR Settings").auto_create_notes and variance_count:
		created = notes.create_notes(ort)
	else:
		stock.save(ort)

	return {
		"imported": len(orders),
		"duplicates": duplicates,
		"variance_lines": variance_count,
		"notes_created": len(created),
		"batch": batch,
	}


def record_secondary_return(ort, or_secondary_sales_order, qty, return_date=None, marketplace_return_id=None):
	"""An end customer returned goods to the marketplace.

	Recorded as a OR Secondary Sales Order with negative qty against the sale: the marketplace holds the
	units again, and the sale's price variance is reversed for them (a sale that got a Credit Note
	gets a Debit Note for the returned units, and the other way round).
	"""
	stock.require_editable(ort)
	qty = flt(qty)
	if qty <= 0:
		frappe.throw(_("Return Qty must be greater than zero."))
	sale = frappe.get_doc(SECONDARY, or_secondary_sales_order)
	if sale.or_reference != ort.name:
		frappe.throw(_("{0} does not belong to {1}.").format(sale.name, ort.name))
	if sale.is_return:
		frappe.throw(_("{0} is itself a Secondary Return.").format(sale.name))
	returnable = flt(sale.qty) - flt(sale.returned_qty)
	if qty > returnable + 1e-9:
		frappe.throw(
			_("Only {0} of {1} can still be returned ({2} sold, {3} already returned).").format(
				f"{max(returnable, 0):g}", sale.name, f"{flt(sale.qty):g}", f"{flt(sale.returned_qty):g}"
			)
		)

	return_id = (marketplace_return_id or "").strip()
	if not return_id:
		count = frappe.db.count(SECONDARY, {"return_against": sale.name})
		return_id = f"{sale.marketplace_order_id}-R{count + 1}"
	if frappe.db.exists(SECONDARY, {"marketplace_order_id": return_id}):
		frappe.throw(_("Marketplace Return ID {0} is already recorded.").format(return_id))

	ret = frappe.get_doc(
		{
			"doctype": SECONDARY,
			"marketplace": sale.marketplace,
			"marketplace_order_id": return_id,
			"sale_date": return_date or nowdate(),
			"is_return": 1,
			"return_against": sale.name,
			"or_reference": ort.name,
			"sales_order": sale.sales_order,
			"marketplace_po_no": sale.marketplace_po_no,
			"marketplace_sku": sale.marketplace_sku,
			"item_code": sale.item_code,
			"import_batch": "SRET-" + now_datetime().strftime("%Y%m%d%H%M%S"),
			"qty": -qty,
			# the return reverses the sale at the sale's own rates and commission
			"primary_rate": sale.primary_rate,
			"selling_rate": sale.selling_rate,
			"commission_percent": sale.commission_percent,
		}
	)
	ret.flags.from_sor = True
	ret.insert(ignore_permissions=True)
	frappe.db.set_value(SECONDARY, sale.name, "returned_qty", flt(sale.returned_qty) + qty, update_modified=False)
	postings.post_secondary(ort, [ret], ret.name)

	ort.add_comment(
		"Info",
		_("Secondary Return {0}: {1} x {2} against {3} ({4}).").format(
			ret.name, f"{qty:g}", sale.item_code, sale.name, sale.marketplace_order_id
		),
	)
	if ret.note_status != "No variance" and frappe.get_cached_doc("Marketplace OR Settings").auto_create_notes:
		notes.create_notes(ort)
	else:
		stock.save(ort)
	return ret.name


# ---------------------------------------------------------------- reading marketplace files

FORMAT_FIELDS = {
	# standard key: (format field, default column heading, label shown in messages)
	"marketplace_order_id": ("order_id_column", "marketplace_order_id", "Order ID"),
	"sale_date": ("sale_date_column", "sale_date", "Sale date"),
	"marketplace_sku": ("sku_column", "marketplace_sku", "SKU"),
	"qty": ("qty_column", "qty", "Quantity"),
	"selling_price": ("price_column", "selling_price", "Selling price"),
}
DATE_FORMATS = {
	"YYYY-MM-DD": ["%Y-%m-%d"],
	"DD-MM-YYYY": ["%d-%m-%Y"],
	"DD/MM/YYYY": ["%d/%m/%Y"],
	"MM/DD/YYYY": ["%m/%d/%Y"],
	"DD-MMM-YYYY": ["%d-%b-%Y"],
	"DD MMM YYYY": ["%d %b %Y"],
}
OPTIONAL_FORMAT_FIELDS = (
	"header_row", "price_type", "date_format", "po_column", "filter_column", "filter_values",
	"payout_column", "type_column", "return_values", "return_date_column",
)
AUTO_DATE_FORMATS = ["%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%d %b %Y", "%d-%b-%y", "%Y/%m/%d", "%d.%m.%Y"]


def get_import_format(marketplace):
	"""The marketplace's import format from Marketplace OR Settings, else the standard columns."""
	settings = frappe.get_cached_doc("Marketplace OR Settings")
	row = next((r for r in (settings.get("import_formats") or []) if r.marketplace == marketplace), None)
	fmt = frappe._dict(
		marketplace=marketplace,
		configured=bool(row),
		header_row=1,
		price_type="Unit price",
		date_format="Auto",
		po_column="",
		filter_column="",
		filter_values="",
		payout_column="",
		type_column="",
		return_values="",
		return_date_column="",
	)
	for _key, (field, default, _label) in FORMAT_FIELDS.items():
		fmt[field] = default
	if row:
		for field in (*OPTIONAL_FORMAT_FIELDS, *(f for f, _d, _l in FORMAT_FIELDS.values())):
			value = row.get(field)
			if value not in (None, ""):
				fmt[field] = value
	fmt.header_row = max(cint(fmt.header_row), 1)
	return fmt


def read_table(csv_text=None, file_url=None):
	"""The uploaded CSV / XLSX (or pasted CSV) as a list of rows; blank rows are kept so row numbers match the file."""
	if file_url:
		file = frappe.get_doc("File", {"file_url": file_url})
		content = file.get_content()
		if (file.file_name or file_url).lower().endswith((".xlsx", ".xls")):
			from frappe.utils.xlsxutils import read_xls_file_from_attached_file, read_xlsx_file_from_attached_file

			if (file.file_name or file_url).lower().endswith(".xls"):
				return read_xls_file_from_attached_file(content)
			return read_xlsx_file_from_attached_file(fcontent=content)
		return read_csv_content(content)
	return read_csv_content(csv_text or "")


def apply_format(table, fmt):
	"""Turn a marketplace's file into standard rows.

	Returns (rows, filtered, errors). Each row has the standard keys (marketplace_order_id, sale_date as
	YYYY-MM-DD, marketplace_sku, qty, selling_price as a unit price), plus po_no and _row (its line in the file).
	"""
	blank = lambda row: not any(str(cell if cell is not None else "").strip() for cell in row)  # noqa: E731
	if len(table) < fmt.header_row or blank(table[fmt.header_row - 1]):
		return [], 0, [_("Row {0} of the file should hold the column headings, but it is empty.").format(fmt.header_row)]
	header = [_norm(cell) for cell in table[fmt.header_row - 1]]

	order_parts = order_id_parts(fmt.order_id_column)
	wanted = {key: fmt[field] for key, (field, _d, _l) in FORMAT_FIELDS.items() if key != "marketplace_order_id"}
	for i, part in enumerate(order_parts):
		wanted[f"_oid{i}"] = part
	optional = {
		"po_no": fmt.po_column,
		"_filter": fmt.filter_column,
		"_payout": fmt.payout_column,
		"_type": fmt.type_column,
		"_return_date": fmt.return_date_column,
	}
	wanted.update({key: heading for key, heading in optional.items() if heading})
	index, missing = {}, []
	for key, heading in wanted.items():
		if _norm(heading) in header:
			index[key] = header.index(_norm(heading))
		else:
			missing.append(heading)
	if missing:
		found = ", ".join(str(c) for c in table[fmt.header_row - 1] if str(c if c is not None else "").strip())
		return [], 0, [
			_("{0}'s import format expects the column(s) {1} in row {2}, but the file has: {3}. Check the file, or the format in OR Settings.").format(
				fmt.marketplace, ", ".join(f"“{m}”" for m in missing), fmt.header_row, found or _("nothing")
			)
		]

	allowed = {_norm(v) for v in str(fmt.filter_values or "").split(",") if v.strip()}
	return_types = {_norm(v) for v in str(fmt.return_values or "").split(",") if v.strip()}
	rows, filtered, errors, rounded, seen_keys = [], 0, [], [], Counter()
	for offset, raw in enumerate(table[fmt.header_row :], start=fmt.header_row + 1):
		if blank(raw):
			continue
		cell = lambda key: raw[index[key]] if index[key] < len(raw) else None  # noqa: E731
		parts = [_text(cell(f"_oid{i}")) for i in range(len(order_parts))]
		sku = _text(cell("marketplace_sku"))
		if not any(parts) and not sku and not _text(cell("qty")):
			continue  # a totals / footer line, not a sale
		if fmt.filter_column and allowed and _norm(cell("_filter")) not in allowed:
			filtered += 1
			continue
		shortened = next((p for p in parts if _looks_shortened(p)), None)
		if shortened:
			rounded.append((offset, shortened))
			continue
		qty, price = _to_number(cell("qty")), _to_number(cell("selling_price"))
		if qty is None or price is None:
			errors.append(_("Row {0}: quantity “{1}” or selling price “{2}” is not a number").format(offset, cell("qty"), cell("selling_price")))
			continue
		is_return = qty < 0 or bool(fmt.type_column and return_types and _norm(cell("_type")) in return_types)
		date_cell = cell("_return_date") if is_return and fmt.return_date_column else cell("sale_date")
		sale_date = _to_iso_date(date_cell, fmt.date_format)
		if not sale_date:
			errors.append(_("Row {0}: date “{1}” is not in the {2} format").format(offset, date_cell, fmt.date_format))
			continue
		# a return carries negative amounts in most reports; it is recorded with its own sign later
		qty, price = abs(qty), abs(price)
		commission = None
		if fmt.payout_column:
			payout = _to_number(cell("_payout"))
			if payout is None:
				errors.append(_("Row {0}: net payout “{1}” is not a number").format(offset, cell("_payout")))
				continue
			# payout and selling price are read the same way (both unit or both line total), so the ratio holds
			commission = flt((1 - abs(payout) / price) * 100, 6) if price else None
		if fmt.price_type == "Line total":
			if not qty:
				errors.append(_("Row {0}: quantity is 0, so the line total cannot be turned into a unit price").format(offset))
				continue
			price = price / qty
		key = "-".join(parts) if len(parts) > 1 else parts[0]
		if len(parts) > 1:
			# a key built from several columns can repeat for real (two units of one SKU in one order group):
			# number the repeats. A single order ID column that repeats is a duplicate line and is skipped later.
			seen_keys[(is_return, key)] += 1
			if seen_keys[(is_return, key)] > 1:
				key = f"{key}#{seen_keys[(is_return, key)]}"
		row = {
			"_row": offset,
			"marketplace_order_id": key,
			"sale_date": sale_date,
			"marketplace_sku": sku,
			"qty": qty,
			"selling_price": flt(price, 2),
			"po_no": _text(cell("po_no")) if fmt.po_column else "",
			"is_return": is_return,
		}
		if commission is not None:
			row["commission_percent"] = commission
		rows.append(row)
	if rounded:
		errors.insert(
			0,
			_(
				"{0} row(s) have an Order ID that Excel has shortened (e.g. row {1}: “{2}”), so different orders look the "
				"same. Upload the report as downloaded from {3} (don't open and save it in Excel first), or in OR Settings "
				"set the Order ID column to columns that stay whole, e.g. order_group_id + sku_code."
			).format(len(rounded), rounded[0][0], rounded[0][1], fmt.marketplace),
		)
	return rows, filtered, errors


def order_id_parts(heading):
	"""The Order ID column of a format: one heading, or several joined with + (the key is their values joined by -)."""
	return [p.strip() for p in str(heading or "").split("+") if p.strip()] or [""]


def _looks_shortened(text):
	"""An ID Excel has turned into a rounded number: 1.0026E+11, or 100260000000 read back from it."""
	if re.fullmatch(r"\d+(\.\d+)?[eE]\+?\d+", text):
		return True
	return text.isdigit() and len(text) >= 11 and len(text) - len(text.rstrip("0")) >= 5


def _norm(value):
	return " ".join(str(value if value is not None else "").split()).lower()


def _text(value):
	"""Cell as text; whole numbers read from Excel (12345.0) lose their .0, so IDs and SKUs match."""
	if isinstance(value, float) and value.is_integer():
		value = int(value)
	return str(value if value is not None else "").strip()


def _to_number(value):
	if isinstance(value, (int, float)):
		return float(value)
	text = str(value if value is not None else "").replace("₹", "").replace(",", "").replace("Rs.", "").replace("INR", "").strip()
	if not text:
		return None
	try:
		return float(text)
	except ValueError:
		return None


def _to_iso_date(value, date_format):
	"""A date cell (Excel date, or text in the format's style) as YYYY-MM-DD; None when it can't be read."""
	if isinstance(value, datetime):
		return value.date().isoformat()
	if isinstance(value, date):
		return value.isoformat()
	text = str(value if value is not None else "").strip()
	if not text:
		return None
	# the whole text first, then without a time part ("2026-10-05 13:45:00", "2026-10-05T13:45")
	candidates = dict.fromkeys([text, text.split("T")[0], text.rsplit(" ", 1)[0] if ":" in text else text])
	for candidate in candidates:
		for pattern in DATE_FORMATS.get(date_format) or AUTO_DATE_FORMATS:
			try:
				return datetime.strptime(candidate.strip(), pattern).date().isoformat()
			except ValueError:
				continue
	return None
