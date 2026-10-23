# Wave Data Export: the real file formats

Profiled 2026-10-22 from a real business's export (requested 2026-10-21 via
*Settings → Other → Data Export*). The files are kept outside this repository
and never copied here. Cross-checked against the live API and Wave's help pages on
2026-10-23 (see `wave-api.md`). This note records structure only, no financial detail.

## What the Data Export page produces

| Button | Arrives as | Contents |
|---|---|---|
| Export all transactions as CSV | `<uuid>.zip` | `accounting.csv`, `customers.csv`, `vendors.csv`, `bill_items.csv` |
| Export all transactions for Excel | not yet tested | Wave's help says "four XLS or CSV files". Possibly legacy `.xls`, not `.xlsx`. Accept both until seen |
| Export all receipts as a ZIP file | `<login email>-YYYY-MM-DD-HH-MM-SS.zip` | receipt files, flat, no index |
| Export all employee info / pay stubs as CSV | not tested | Wave's help: **Canadian businesses only** |

From Wave's help article *Download your account data* (updated 2026-10-21, read
2026-10-23):
- "Viewer and Editor user roles do not have access to data export." The collaborator
  permissions table gives Data export to **Admin** only, and Admin is a **Pro Plan**
  role. On the free plan only the owner can export.
- The email goes "to the primary email address of your Wave account", and "The email
  link is active for 24 hours." This confirms the 24-hour expiry.
- The payroll export is "Available for Canadian businesses only". A US business has
  no payroll CSVs to give.
- Alternatives Wave lists: an *Account Transactions* report filtered by date, and the
  *Wave Connect* Google Sheets add-on (chart of accounts, customers, invoices, products).
  Neither is needed while the ZIP and API cover the same ground.
- Nothing on the page restricts Data Export by plan. The free plan's owner can still
  export.

- **The ZIP's name gives no clue to the business.** It's a bare UUID, and nothing inside
  names the business either. A converter can't tell one business's export from
  another's from the file alone. It has to check against the API, for example by
  confirming that the account names and transaction dates match the selected business.
- **The export has no date filter.** It covers the business's whole history.
- **Encoding:** UTF-8, no BOM, comma-delimited, standard CSV quoting, header row present.

## accounting.csv: the general ledger

One row per transaction line. Example business: 2,016 rows, 974 transactions,
2024-12-22 → 2026-10-20.

| Column | Format / behaviour |
|---|---|
| `Transaction ID` | 19-digit integer as text. Groups lines into one entry. Not the API's ID format. |
| `Transaction Date` | `YYYY-MM-DD` |
| `Account Name` | Name only. See **Account matching** |
| `Transaction Description` | Always filled. Bank-feed text or the user's description |
| `Transaction Line Description` | Rarely filled (76/2016) |
| `Amount (One column)` | Signed, **positive in the account's normal-balance direction** (see below) |
| `" "` (a single space) | A spacer column with no values. **Its header is one space, so parse by header name, never by position.** |
| `Debit Amount (Two Column Approach)` | Positive decimal or blank |
| `Credit Amount (Two Column Approach)` | Positive decimal or blank. A row never has both non-zero. A zero-amount transaction does occur (1 in the real export): its rows carry `0.00` rather than blanks. |
| `Other Accounts for this Transaction` | The account names on the other side, comma-joined when there are several. **Don't parse it**: account names can contain commas. Rebuild the other side by grouping on `Transaction ID`. |
| `Customer`, `Vendor` | Name, filled where linked |
| `Invoice Number` | Filled on invoice and invoice-payment lines |
| `Bill Number` | Blank in this export (no bills used). Shape unknown. |
| `Notes / Memo` | Rare |
| `Amount Before Sales Tax` | Equals `Amount (One column)` when there is no tax |
| `Sales Tax Amount`, `Sales Tax Name` | Blank here (no sales tax used). Shape unknown. |
| `Transaction Date Added`, `Transaction Date Last Modified` | `YYYY-MM-DD`, date only |
| `Account Group` | `Asset`, `Liability`, `Equity`, `Income`, `Expense` |
| `Account Type` | Display names, e.g. `Cash and Bank`, `Credit Card`, `Operating Expense`, `Cost of Goods Sold`, `Income`, `Transfers`, `System Receivable Invoice`, `Other Short-Term Asset`, `Retained Earnings: Profit`, `Uncategorized Expense` |
| `Account ID` | **Present but always empty.** |

**Amounts.** Plain decimals with 2 places, `.` as the decimal point, no thousands
separators, no currency symbol. Use the Debit/Credit columns for the ledger. The
one-column amount follows this rule, verified on every row:

- Asset and Expense: `Amount = Debit − Credit`
- Liability, Income and Equity: `Amount = Credit − Debit`

**Integrity.** In the example, every transaction balances (Σ debits = Σ credits per
`Transaction ID`), and the file's debit and credit totals are equal. Lines per transaction:
943 have 2, 25 have 3, and a few have 5, 6, 13 and 21 (split entries / invoices).

**Only accounts with activity appear.** In the example, 34 of the chart's 103 accounts are
in the file. The full chart, including empty and archived accounts, comes from the API.

### Account matching

`Account ID` is empty, so the ledger links to the chart **by name only**. In the
example, 32 of the 34 names matched exactly one account from the API. Two matched many:

- `Transfer Clearing` matches 32 API accounts, all subtype `TRANSFERS`, all zero balance.
- `Accounts Receivable` matches 12 API accounts: 11 `RECEIVABLE_INVOICES` and 1 `RECEIVABLE_OTHER`, all zero balance.

These look like Wave system accounts, not user duplicates. Re-checked 2026-10-23, the
counts had grown to 36 and 14 (13 `RECEIVABLE_INVOICES`, 1 `RECEIVABLE_OTHER`). Wave
keeps adding them, so don't hard-code counts. How to resolve a name that matches more
than one account:

1. Narrow by the export's `Account Type` mapped to the API subtype (e.g.
   `System Receivable Invoice` → `RECEIVABLE_INVOICES`). Use the table below.
2. If several identical system accounts remain (same subtype, all zero balance), merge
   them into one output account.
3. Otherwise ask the user, as the prompt specifies.

### `Account Type` → API subtype

**The export's `Account Type` is the subtype's display name from the API's global
`accountSubtypes` query**, not the `subtype.name` read on an account node, which
differs (e.g. `Cash & Bank`, `Expense`). Tested 2026-10-23: every `Account Type` in the
real export matched an `accountSubtypes` name exactly, and the matched accounts had
that subtype. Key the lookup on `(Account Group, Account Type)`, because `Transfers`
exists under both Asset and Equity.

Seen in a real export (✓) or only in the API catalogue (·):

| Account Group | Account Type (export) | Subtype value | |
|---|---|---|---|
| Asset | Cash and Bank | `CASH_AND_BANK` | ✓ |
| Asset | Other Short-Term Asset | `OTHER_CURRENT_ASSETS` | ✓ |
| Asset | System Receivable Invoice | `RECEIVABLE_INVOICES` | ✓ |
| Asset | System Receivable Non-Invoice | `RECEIVABLE_OTHER` | · |
| Asset | Transfers | `TRANSFERS` | ✓ |
| Asset | Money in Transit | `MONEY_IN_TRANSIT` | · |
| Asset | Inventory / Receivable / Property, Plant, Equipment / Depreciation and Amortization / Other Long-Term Asset / Vendor Prepayments and Vendor Credits / Unknown Account | `INVENTORY` / `RECEIVABLE` / `PROPERTY_PLANT_EQUIPMENT` / `DEPRECIATION_AND_AMORTIZATION` / `OTHER_LONG_TERM_ASSETS` / `VENDOR_PREPAYMENTS_AND_CREDITS` / `UNKNOWN_ACCOUNT` | · |
| Liability | Credit Card | `CREDIT_CARD` | ✓ |
| Liability | **System Payable Bill** | `PAYABLE_BILLS` | · (the bill-side AP account) |
| Liability | System Payable Non-Bill | `PAYABLE_OTHER` | · |
| Liability | Sales Tax on Sales and Purchases | `SALES_TAX` | · |
| Liability | System Customer Credits | `SYSTEM_CUSTOMER_CREDITS` | · |
| Liability | Payable / Loan and Line of Credit / Due For Payroll / Due to You and Other Business Owners / Customer Prepayments and Customer Credits / Other Short-Term Liability / Other Long-Term Liability | `PAYABLE` / `LOANS` / `DUE_FOR_PAYROLL` / `DUE_TO_YOU_AND_OTHER_OWNERS` / `CUSTOMER_PREPAYMENTS_AND_CREDITS` / `OTHER_CURRENT_LIABILITY` / `OTHER_LONG_TERM_LIABILITY` | · |
| Equity | Retained Earnings: Profit | `RETAINED_EARNINGS` | ✓ |
| Equity | Business Owner Contribution and Drawing | `NON_RETAINED_EARNINGS` | · |
| Equity | Transfers | `TRANSFERS` | · |
| Income | Income | `INCOME` | ✓ |
| Income | Other Income / Discount / Gain On Foreign Exchange / Uncategorized Income | `OTHER_INCOME` / `DISCOUNTS` / `GAIN_ON_FOREIGN_EXCHANGE` / `UNCATEGORIZED_INCOME` | · |
| Expense | Operating Expense | `EXPENSE` | ✓ |
| Expense | Cost of Goods Sold | `COST_OF_GOODS_SOLD` | ✓ |
| Expense | Uncategorized Expense | `UNCATEGORIZED_EXPENSE` | ✓ |
| Expense | Payment Processing Fee / Payroll Expense / Loss On Foreign Exchange | `PAYMENT_PROCESSING_FEES` / `PAYROLL_EXPENSES` / `LOSS_ON_FOREIGN_EXCHANGE` | · |

The catalogue rows (·) assume the export uses the same names, which is likely but not
seen. An unknown `(Group, Type)` pair must raise a Review card, not crash. In
export-file-only mode this same table infers the subtype.

### Linking ledger entries to API invoice payments

The API's `InvoicePayment.accountingTransactionId` is a base64 ID that decodes to
`Business:<uuid>;Transaction:<19 digits>`. Those 19 digits are this file's
`Transaction ID` (tested: 10 of 10 non-null IDs found, same invoice number, date and
amount). Payments with a null ID matched uniquely on invoice number + date + amount.
Details in `wave-api.md`.

### Balances

The sum of `Amount (One column)` per account equals the API's `Account.balance` (same
sign convention) when nothing changed after the export. Tested 2026-10-23: 32 of 34
accounts matched to the cent. The other 2 differed by one equal-and-opposite amount,
consistent with a bank-feed transaction added after the export.

## customers.csv / vendors.csv

Snake-case headers that look like Wave's own import-template layout. Not tested
whether Wave will re-import them unchanged.

- **customers.csv:** `customer_name, email, contact_first_name, contact_last_name,
  customer_currency, account_number, phone, fax, mobile, toll_free, website, country,
  province/state, address_line_1, address_line_2, city, postal_code/zip_code,
  shipping_address, ship-to_contact, ship-to_country, ship-to_province/state,
  ship-to_address_line_1, ship-to_address_line_2, ship-to_city,
  ship-to_postal_code/zip_code, ship-to_phone, delivery_instructions`
- **vendors.csv:** the same as customers up to `postal_code/zip_code`, with `vendor_`
  in place of `customer_` and no shipping fields.

Neither file has an ID column. They link to the ledger by name only. Many fields are
sparse: the example's vendors are mostly bank-feed names with only `vendor_name` and
sometimes `vendor_currency`.

## bill_items.csv

Header only in this export: `vendor, description, invoice_num, po_so, account, product,
amount, quantity, bill_date, currency, due_date, taxes`. The value formats are unknown
until we see an export from a business that uses bills.

## Receipts ZIP

- Flat list of the original uploaded files (PDFs here), no manifest.
- Filenames are `YYYY-MM-DD-<description>.<ext>`: the transaction date, then the
  transaction's `Transaction Description` with spaces turned into `_` and some
  characters dropped (`/` disappears, so `1/31/25` becomes `13125`).
- **Correction (2026-10-23).** These notes used to describe the name as
  `YYYY-MM-DD-NNNNNN_<description>`, with `NNNNNN` as a separate serial. In the real
  export, every receipt's description began with a 6-digit bank reference, and the
  ledger's `Transaction Description` begins with the same 6 digits. The number is part
  of the description. It is still not the `Transaction ID`.
- Matching on date + the whole name after the date, ignoring case, spaces and
  punctuation, links **19 of 19** real receipts to exactly one transaction each. The
  earlier figure of 16 of 19 came from leaving the number out.
- When the description was edited after the receipt was uploaded, or a name was cut
  short, the match can fail or find several candidates. Wave Exit then accepts a
  prefix match and otherwise asks the user.

## Still unverified

None of these can be settled from the API or Wave's docs. Each needs a real export
from a business that uses the feature.

- The Excel variant of the transactions export (Wave says "XLS or CSV". XLS vs XLSX
  is unknown)
- Bill, sales tax and multi-currency columns. Live check 2026-10-23: none of the
  three businesses on the test account has a single bill, sales tax or non-USD account,
  so no existing export can show these. It needs a **test business** with one bill
  (part-paid), one taxed invoice and one foreign-currency bank account, exported.
- The payroll exports (Canada only, per Wave's help)
- Whether the export includes transactions from archived accounts (no live business
  has an archived account)
- Whether there is any upper size limit
