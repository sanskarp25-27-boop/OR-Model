# OR Model

Outright (OR) sales to marketplaces (Myntra, Ajio, ...) against a Sales Order with **Flow = OR** that
carries the marketplace's PO number. ERPNext v16, one module: **Marketplace OR**. Built from SOR Model
and fully independent of it (its own doctypes, settings and workspace); both can be installed together.

**The primary sale is a normal sale.** A Delivery Note takes the goods out of your warehouse and a Sales
Invoice bills the marketplace at the primary rate. There is no sales reversal.

**The secondary sale is virtual.** The marketplace's sales to end customers are imported to track its
stock (shown in the OR app, never in your Stock Ledger) and the price it got. They post no stock and no
sale; only the price variance posts:

| Event | Entry |
| --- | --- |
| Secondary sale below the primary rate | Journal: OR Sales Variance Dr / OR Sale Provision Cr (primary - secondary) |
| Secondary sale above the primary rate | nothing at import |
| Month-end Credit Note (sales below primary) | OR Sale Provision Dr / Billing Customer Cr, against the primary invoice |
| Month-end Debit Note (sales above primary) | Billing Customer Dr / OR Sales Variance Cr, against the primary invoice |
| Secondary return | the sale's provision entry reversed; its note goes the other way |

The secondary rate is net of the marketplace commission (Settings, or the file's payout column).

## Install

```bash
cd ~/frappe-bench
bench get-app <repo-url> or_model      # or copy the folder into apps/
bench --site <site> install-app or_model
bench build --app or_model
bench restart
```

Installing creates the **OR User** role, the tracker workflow, the Sales Order fields **OR Marketplace**
and **OR Primary Sales Tracker** (plus Flow and the Customer PO fields when SOR Model hasn't made them),
and `or_reference` on Delivery Note, Sales Invoice and Journal Entry.

## Set up (once), in the OR app > Settings

1. **Marketplaces**: one per marketplace with an abbreviation (tracker names like `OR-MYN-2026-0001`).
2. **Marketplace Accounts**: per marketplace the billing customer, note series and cost center;
   **Set up masters** creates “<Marketplace> OR Sale Provision” (Current Liabilities) and
   “<Marketplace> OR Sales Variance” (Indirect Expenses).
3. **Customer ↔ Marketplace**, **commission %** and the **import format** of each sales report.
4. **Item Mapping** for SKUs not set as a marketplace SKU Code on the Item.
5. Give users the **OR User** role; note approvers need the role set in Settings (default Accounts Manager).

## Daily use (OR app, /desk/or-app)

1. **Sales Order** with Flow = OR and the Customer PO Number; submitting it creates the OR Primary
   Sales Tracker.
2. **Pick, Pack & Dispatch**: a Delivery Note (an automation's draft one is reused); it adds the Primary
   Sale row. A Delivery Note made directly in ERPNext is tracked the same way.
3. **Create Primary Invoice** (when not already made): a Sales Invoice for each unbilled Delivery Note.
4. **Record POD**: the marketplace's receipt, SKU-wise, with the POD attached (virtual).
5. **Import sales**: the marketplace's report; the provision entry is posted for sales below primary.
6. **Month-end settlement**: Credit / Debit Notes per primary invoice; the approver submits them.
7. **Primary returns**: Initiate, mark dispatched, then **Putaway**: a return Delivery Note brings the
   stock back and a Return Credit Note credits the marketplace on the primary invoice.
8. **Approve** once every variance is in a submitted note, then **Close**.

## Tests

```bash
bench --site <test-site> run-tests --module or_model.marketplace_or.tests.test_calculations
bench --site <test-site> run-tests --module or_model.marketplace_or.tests.test_or_flow
```

`test_or_flow` creates its own marketplace, item, orders and documents inside one transaction and rolls
it back; still, run it on a test site.
