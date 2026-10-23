# Build prompt: Wave Exit — a Wave Accounting converter for accountants

> Paste everything below the line into a fresh Claude Code session (an empty folder)
> to start the build. Also copy `wave-formats.md` into the new repo as
> `docs/wave-formats.md`. Items marked **VERIFY** are facts the builder must confirm
> before relying on them.

---

## What you are building

A desktop app called **Wave Exit**: a **converter** for **Wave Accounting** books
(waveapps.com, *not* the Wave mobile-money company at wave.com).

```
   INPUTS                         ONE MODEL                    OUTPUTS (any number)
 ┌───────────────────────┐                                   ┌──────────────────────────┐
 │ Wave connection (API)  │──┐                          ┌───▶│ Archive: universal pkg,  │
 │ Transactions ZIP       │──┤   ┌──────────────────┐   │    │   PDF report pack        │
 │ Receipts ZIP           │──┼──▶│ merged, checked, │───┼───▶│ Review: Excel, aging     │
 │ Payroll CSVs           │──┤   │ reviewed books   │   │    │ Import files: QBO, Xero… │
 │ Client collection file │──┘   └──────────────────┘   ├───▶│ Direct load: QBO, Xero   │
 └───────────────────────┘                              └───▶│ Plain-text: Beancount…   │
                                                             └──────────────────────────┘
```

Load whatever Wave data you have, the app merges and checks it once, and the user
picks any number of outputs, now or later. The app is **not** a migration wizard
for one destination. It is a converter with many destinations, and that is the point:

- Every existing option locks you to one target (competitors' "migrate from Wave"
  importers only feed their own product; services do one target per job).
- Accountants want several outputs from one conversion: an archive for the client
  file, a review workbook, and a load into the new system.
- If one target changes its API or pricing (QuickBooks and Xero both did in 2025–26),
  one output card is affected, not the product.

The users are **accountants and bookkeepers**, not developers. They understand debits,
credits, trial balances and AR/AP perfectly. They do not know what an API, token,
GraphQL, JSON or a terminal is, and they should never need to. Every screen must make
sense to someone who is good with QuickBooks and Excel and nothing more technical.
Most conversions will be **a client's** books, not the user's own.

## The app: projects, and three screens

**Home: the project list.** One project per client business. Each shows the client,
which inputs it has, its check status, and which outputs have been produced
(e.g. *Waiting for client file* / *Ready to review* / *Archived, loaded to QBO*).
A project keeps the merged model, so adding an output next month needs no new data
from Wave. Projects are independent: their own keys, files and target connections.

Inside a project, three screens with a tab rail: **Inputs → Review → Outputs.** The user
can move between them freely. Outputs are disabled until Review has no red items.

### Screen 1: Inputs

A slot for each input source. Each slot shows its state: ✓ loaded (with a one-line
summary, e.g. "974 transactions, Dec 2024 – Oct 2026"), or *missing*, with a plain
sentence on what is lost without it and a button to get it.

| Slot | Required? | Without it |
|---|---|---|
| **Transactions export** (ZIP) | **Yes** — the only source of the ledger | Nothing can be converted |
| **Wave connection** | Strongly recommended | No empty accounts or account subtypes, no invoice line items, products or estimates, no balance tie-out (see *Export-file-only mode*) |
| **Receipts export** (ZIP) | Optional | No attachments |
| **Payroll CSVs** | Optional — **Canadian businesses only** (Wave's help, Oct 2026) | No employee or pay stub records. US businesses have no payroll export: say so instead of showing a missing slot |
| **Client collection file** | Alternative to all the above | — it contains them |

Slot behaviour:
- Drop a file anywhere on the window and the app works out which slot it fills. Accept
  a ZIP, an unzipped folder, or the individual files.
- Each slot has an illustrated "How do I get this?" guide using Wave's exact button labels
  (below), including the warning that Wave's emailed download link expires after 24 hours.
- **Wrong-business detection.** Nothing in the ZIP names the business, so compare it with
  the connected business: the share of ledger account names found in its chart, and the
  customer and vendor names. Treat a low match as "This export looks like it's from a
  different business than *Maple & Pine Design LLC*." Also refuse, in plain words, a truncated
  export or a file that isn't a Wave export.
- Re-adding a newer export replaces the old one and re-runs Review. Keep a history.

**The Wave connection slot** first asks *"Whose books are these?"*: **Mine** /
**A client's, and I have access to their Wave** / **A client's, and I don't** (opens the
client request flow, see *Getting a client's data*). Then a "Get your Wave key" button
opens Wave's key page in the browser beside a 4-step illustrated guide. The user pastes
the key into one box; the app checks it and shows a green tick with the Wave account
email. Call it a "Wave access key", never a token. Store it in the OS keychain and offer
"forget this key". Then pick the business from cards (name, currency; searchable).

### Screen 2: Review

Runs automatically whenever inputs change. Done once per project, whatever outputs
are chosen. A progress screen ("Reading 4,812 transactions…"), then:

- **Health summary:** green / amber / red items, one sentence each, expandable. These
  are the *Tie-out checks* below.
- **Issue cards** for anything that needs a human, each with a plain explanation and a
  one-click resolution, e.g. "Two accounts are both named *Office Supplies*. Which one do
  these 14 transactions belong to?" with a dropdown. Sources of cards: ambiguous account
  names, unmatched receipts, invoices whose payments don't add up, unassigned customer
  credits, unpaired transfer legs.
- **Settings that affect every output:** the **cutover date**, and the **scope** — full
  history, or opening balances at the cutover date plus every open invoice and bill.
- **Open items:** AR and AP aging at the cutover date, invoice by invoice.

### Screen 3: Outputs

A catalog of output cards. Tick any number, press **Create**. Each card states up front
**what that destination keeps and what it loses** (e.g. "Xero import files: history
arrives as manual journals, so Xero's bank reports will be empty for that period").
Created outputs are listed with date and location, and can be re-created after a
newer export. The **universal package is always created** with the first output of any
kind, because it is the archive.

| Group | Output | Notes |
|---|---|---|
| Archive | **Universal package** | Always created. The documented format below. |
| Archive | **PDF report pack** | Trial balance, P&L and balance sheet by year, general ledger, AR/AP aging, tie-out report, for the client file. |
| Review | **Excel workbook** | One sheet per package file, frozen headers, filters, a trial balance sheet with formulas that recompute from the journal sheet, aging sheets. |
| Import files | **QuickBooks Online** | CSVs in QBO's *Settings → Import data* templates; history as journal-entry imports. |
| Import files | **Xero** | Xero's import CSVs; history as manual journals. |
| Import files | **Zoho Books, FreshBooks, Sage** | Each target's own import templates (VERIFY each format; ship after QBO and Xero). |
| Import files | **Generic general ledger CSV** | One row per line, debit/credit columns — for any other system. |
| Direct load | **QuickBooks Online** | The premium output: history as proper typed transactions. See *Direct load*. |
| Direct load | **Xero** | Same, for Xero. |
| Plain-text | **Beancount**, **hledger** | One `.beancount` / `.journal` file with open directives, transactions, balance assertions at cutover; receipts linked as `document` entries. |

Every output is a **plug-in** over the merged model with one interface: describe what
it keeps and loses, validate the model for its needs (and raise Review cards if it
can't represent something), and produce its result. A new destination must be one new
module with no changes elsewhere.

## Wave's two data sources

No single Wave channel has everything. This is the most important constraint in the design:

| Data | Wave public API | Wave transactions ZIP |
|---|---|---|
| Businesses, chart of accounts (type, subtype, balance, archived) | **Yes** | **No** — only names of accounts that have activity |
| Customers, vendors | Yes, with IDs | Yes, names only, no IDs |
| Products / services | Yes | No |
| Invoices with line items, payments, status | **Yes** — each payment carries the ledger's Transaction ID (see below) | Invoice number on ledger lines only |
| Estimates, sales taxes | Yes | No (sales tax columns on ledger lines) |
| **Bills** | **No** | **Yes** (`bill_items.csv`) |
| **General ledger / all money transactions** | **No — the public API cannot read transactions at all** | **Yes** (`accounting.csv`) |
| Receipt images | No | Separate receipts ZIP |

### The public API (verified by full schema introspection, Sept 2026; re-introspected and tested live 2026-10-23 — details in `docs/wave-api.md`, schema in `docs/wave-api-schema.txt`)

- Endpoint `https://gql.waveapps.com/graphql/public`, GraphQL, Bearer token auth.
- There is **no** query that reads existing money transactions. `Business` has no
  transactions field; the `Transaction` type has only an `id`. Do not try to build one,
  and do not use Wave's undocumented internal endpoint (outside Wave's terms, breaks
  without notice). The transactions come from the ZIP. Full stop.
- **All string arguments must be passed as GraphQL variables** — Wave rejects inline
  string literals.
- Pagination is `page` / `pageSize`; loop until `pageInfo.totalPages`.
- Money fields are objects. **Read `.minorUnitValue`, not `.value`**: tested live,
  `.value` has thousands separators (`"1,234.56"`). `InvoicePayment.amount` is a plain
  decimal string, and `Account.balance` a bare decimal of variable precision (`"0"`,
  `"12.5"`).
- **`accounts()` defaults to `isArchived: false`** and `null` doesn't include archived
  accounts. Fetch active and archived separately.
- Don't request `subtype { systemCreated }` on an account node. Wave errors on it for
  every account. Read the catalogue from the top-level `accountSubtypes` query, whose
  names are exactly the export's `Account Type` values.
- **Invoice payments link to the ledger.** `Invoice.payments[].accountingTransactionId`
  base64-decodes to `…;Transaction:<19 digits>`, the export's `Transaction ID` (10 of
  10 non-null in the real business). Null ones (2 of 12) matched on invoice number +
  date + amount. Use this for invoice↔payment links and check 4.
- Unpublished rate limit (no Wave page states one, checked Oct 2026); practitioners
  report HTTP 429 above ~4–5 req/s. Throttle to ~2 req/s with exponential backoff.
- Auth, checked against Wave's developer docs (OAuth Guide updated 2026-07-10,
  "3 – Authentication" 2026-06-29, help article 2026-10-06):
  - **Full Access Token**: works on the free plan. The user creates it in Wave's
    developer portal under an application they register. It reaches every business
    that user can see.
  - **OAuth**: confirmed that users "can only grant access to businesses that have an
    active Pro or Wave Advisor subscription", and refresh fails with 403 when it
    lapses. Wave's token exchange **requires the client secret, with no PKCE**, so a
    desktop "Connect to Wave" button also needs the token-exchange service.
  - **⚠ Decision needed before shipping the key path.** Wave says Full Access is "strictly
    recommended for development purposes or personal applications only. For any
    applications that will be published or sold for other Wave users to access their
    accounts, authentication must be via OAuth 2." A distributed app that asks people
    to paste a Full Access key goes against that. And OAuth excludes free-plan
    businesses, which are most of the target users. Options: (a) ask Wave's API team in
    writing whether a local-only tool where each user makes their own key is acceptable;
    (b) ship OAuth for Pro/Advisor businesses and export-file-only mode for everyone
    else; (c) keep the key path as an advanced option, with the user's own developer
    application. Build the readers so either credential works. Don't ship until this is
    decided.

Known-good starting queries (adapt, don't copy blindly):

```graphql
query { businesses(page:1, pageSize:50) { edges { node { id name currency { code } } } } }

query Accounts($businessId: ID!, $page: Int!) {
  business(id: $businessId) {
    accounts(page: $page, pageSize: 200) {
      pageInfo { totalPages }
      edges { node { id name displayId description isArchived balance normalBalanceType
                     type { name value } subtype { name value } currency { code } } }
    }
  }
}
```

Invoices: `business.invoices(page, pageSize, invoiceDateStart, invoiceDateEnd)` with
`invoiceNumber invoiceDate dueDate status total{value} amountPaid{value} amountDue{value}
customer{id name} items{ description quantity unitPrice total{value} product{id name}
account{id name} taxes{...} }`. Introspect the live schema at the start of development
to get exact field names for customers, vendors, products, estimates and sales taxes.

### The Data Export page (confirmed from a screenshot, Oct 2026)

*Settings → Other → Data Export*, titled "Export your data", scoped to the currently
selected business; needs the **Owner or Admin** role. Its cards, with their exact labels
(use these in the in-app guides):
- Accounting: **"Export all transactions for Excel"** and **"Export all transactions as CSV"**
- Receipts: **"Export all receipts as a ZIP file"**
- Payroll: **"Export all employee info as CSV"** and **"Export all pay stubs as CSV"**

### Export contents (verified against a real export, Oct 2026 — full spec in `docs/wave-formats.md`)

Delivered by email, to the Wave account's primary email address, as a download link
that **expires after 24 hours** (confirmed in Wave's help article *Download your
account data*, updated 2026-10-21). Only the owner or an **Admin** can export. Editors
and Viewers can't, and Admin is a Pro-only role.

- *Export all transactions as CSV* → a ZIP named with a bare UUID containing
  `accounting.csv`, `customers.csv`, `vendors.csv`, `bill_items.csv`. **Nothing in the
  ZIP names the business.**
- *Export all receipts* → a separate ZIP of the original receipt files, flat, no index,
  named `YYYY-MM-DD-NNNNNN_<bank description>.<ext>`.
- No date filter: the export is always full history.
- `accounting.csv`: UTF-8, no BOM, one row per ledger line, grouped into entries by a
  19-digit `Transaction ID`; dates `YYYY-MM-DD`; amounts plain 2-dp decimals with no
  separators. Use `Debit Amount (Two Column Approach)` / `Credit Amount (Two Column
  Approach)`; a row never has both. `Amount (One column)` is signed in the account's
  normal-balance direction (Asset/Expense: Dr−Cr; Liability/Income/Equity: Cr−Dr).
  `Account Group` is Asset/Liability/Equity/Income/Expense; `Account Type` holds Wave
  display names (`Cash and Bank`, `Credit Card`, `System Receivable Invoice`, …).
- **`Account ID` exists but is always empty.** Ledger lines link to accounts by name only.
- One header is a single space (`" "`), an empty spacer column. **Parse by header
  name, never by column position**, and fail with a plain-English message naming any
  missing required column.
- Ignore `Other Accounts for this Transaction` (comma-joined names; names can contain
  commas). Derive the other side by grouping on `Transaction ID`.
- `customers.csv` / `vendors.csv` use snake_case headers in what looks like Wave's
  import-template layout, and have no IDs.

Still unverified, so handle them defensively: the Excel variant (Wave's help says "XLS
or CSV", so accept both `.xls` and `.xlsx` with the same headers), and the formats of
bill, sales tax and multi-currency values. As of 2026-10-23 none of the three businesses
on the test account has a bill, sales tax or non-USD account. Settling these needs a
test business with that data, exported.

## Getting a client's data

Wave makes client access harder than it looks, so design for it from day one:

- A Wave access key only reaches businesses its owner can see. Wave puts **collaborator
  access behind its paid Pro plan**. Checked 2026-10-23 in Wave's help article
  *Understanding user types and permission levels* (updated 2026-10-22): "Only Pro Plan
  subscribers can invite Admins, Editors, and Viewers". On all plans only Payroll Manager
  and the Block Advisors tax pro can be invited, and neither can see accounting. So a
  free-plan client can't invite their accountant at all.
- **Data Export is Admin-only** (Editors and Viewers have no access). Even on Pro, the
  accountant needs the Admin role to download the ZIPs themselves.
- On the free plan the **owner** can still create a Full Access key and run Data
  Export. Nothing in Wave's docs restricts either by plan. **OAuth** ("Connect to Wave"),
  by contrast, works only for Pro or Wave Advisor businesses. So for free-plan clients
  the client-collects route below is the only route, and it depends on the key-path
  decision in *The public API*.
- **Never ask a client to email their access key.** It is full read/write access to
  their books.

Three ways a project gets its inputs:

1. **The accountant has access** (collaborator on Pro, or Wave Advisor): the accountant
   fills the Inputs slots with their own key and the exports they download.
2. **The client collects — the main route for free-plan clients.** The accountant clicks
   "Request files from my client", which produces friendly email text and a one-page
   PDF with screenshots to paste into their own email (the app sends nothing itself). The
   client installs Wave Exit and picks "I'm sending my books to my accountant": a
   cut-down Inputs screen (connect key, drop exports) that writes one **encrypted
   collection file** (`<Business> – for <accountant>.waveexit`) containing the API pull
   and the ZIPs — nothing else, and never the key. Encrypt with a passphrase the
   accountant gives the client separately (say so prominently), using a well-reviewed
   library — no home-made crypto. The client's finish screen explains how to delete the
   key in Wave. The accountant drops the file into the project's Inputs screen.
3. **Export file only, no connection** — see below.

### Export-file-only mode

When nobody can or will create a key, everything still works from the ZIPs, with the
losses shown before the user proceeds: no accounts without activity, no Wave account
subtypes (inferred from `Account Type` instead), no invoice line items, products or
estimates (invoices rebuilt from ledger lines as single-line documents), invoice checks
limited to the ledger, and no balance tie-out (check 3 skipped). Output cards that need
API data say so. The universal package's manifest records the mode.

## Merging the inputs

- Build one model from all inputs, keyed by Wave IDs where available.
- The ZIP refers to accounts, customers and vendors **by name only** (its `Account ID`
  column is empty); the API by ID. Match by exact name, then by normalized name (trim,
  case, punctuation). **Duplicate names are real** in two forms:
  - *Wave system accounts.* In the real export, `Transfer Clearing` matched 32 API
    accounts and `Accounts Receivable` matched 12. All had the same subtype and a zero
    balance. Narrow by mapping the export's `Account Type` to the API subtype
    (e.g. `System Receivable Invoice` → `RECEIVABLE_INVOICES`), then merge identical
    leftovers into one account. Don't ask the user about these.
  - *User duplicates.* QuickBooks chart imports can leave identically named user
    accounts (one live business had 43). Narrow by type, then by which one has a
    non-zero balance. If still ambiguous, raise a Review card. Never guess silently.
- Accounts with no activity are absent from the ZIP, so the chart is the API's full chart
  (in the real example, 34 of 103 accounts appeared in the ledger).
- Archived accounts still carry history — include them, flag them as inactive.
- Group ZIP rows into entries by Transaction ID; every entry must balance.
- Receipts link to transactions by date + description. The file name is the date
  plus the full description; the leading number is part of the bank description,
  not the Transaction ID. In the real example **19 of 19** linked uniquely (an
  earlier count of 16 of 19 left the number out). Raise a Review card for the rest,
  showing the candidate transactions.
- **Classify every entry** by the account types of its lines, once, in the model — so
  every output uses the same classification. Each entry gets a type and a human-readable
  "why":

| Entry shape | Type |
|---|---|
| Bank or credit card ↔ expense / cost of goods sold | expense (refund if reversed) |
| Bank ↔ income, no invoice number | deposit / sales receipt (if a customer is set) |
| Bank ↔ bank, incl. two legs meeting in `Transfer Clearing` | transfer (pair legs by date and amount; unpaired legs → Review) |
| Bank → credit card | credit card payment |
| Receivable ↔ income, with invoice number | invoice |
| Bank ↔ receivable, with invoice number | invoice payment |
| Bill / payable ↔ bank | bill / bill payment |
| Anything else (multi-line, equity, adjustments) | journal entry |

  The rules are an editable table in Review (advanced, collapsed by default).

## Open receivables and payables, with payments linked

Outputs are worthless if AR and AP aging is wrong on day one. Treat open items as a
first-class part of the model:

- **Rebuild invoice ↔ payment links from the ledger.** In the real export, invoice entries
  debit `System Receivable Invoice` and credit income; payment entries debit `Cash and
  Bank` and credit `System Receivable Invoice`; both carry `Invoice Number`. Partial
  payments are several entries against one invoice; one deposit may pay several invoices.
  Do the same for bills with `Bill Number` and the payable account. Wave's subtype
  catalogue names it `System Payable Bill` (`PAYABLE_BILLS`), the bill-side twin of
  `System Receivable Invoice`. Not yet seen in an export, so confirm with a bills test
  business.
- When connected, link payments by `accountingTransactionId` first (exact), then by
  invoice number + date + amount.
- **Check every invoice against Wave.** For each invoice from the API:
  `total − Σ linked payments = amountDue`, and `status` agrees. Mismatches become Review
  cards ("Invoice 1042: Wave says $250.00 still owed, but we found payments totalling
  $300.00") with the candidate payments shown.
- **Unlinked money.** Receivable credits with no invoice number (customer credits,
  overpayments, write-offs) are listed for the user to assign or keep as credits —
  never silently dropped.
- **Aging at the cutover date** (current, 1–30, 31–60, 61–90, 90+), shown in Review and
  included in the Excel and PDF outputs.
- **Opening-balances scope** still carries every open invoice and bill individually with
  its original date, number, due date and remaining balance, so aging and customer
  statements work immediately in the new system; the opening journal excludes AR/AP to
  avoid counting them twice.

## The universal package

The archive, and the contract every other output could be rebuilt from. Versioned,
documented, boring. A ZIP called `<Business name> – Wave export – <date>.zip`:

```
manifest.json          format version, app version, business, currency, date range,
                       input mode (connected / export-file-only), source files with
                       SHA-256, row counts, cutover date, scope, tie-out results
README.html            human-readable explanation of every file and column
accounts.csv           code, name, type, subtype, normal balance, active, wave_id, opening balance
contacts.csv           customers and vendors (role column), addresses, email, phone, wave_id
items.csv              products/services, price, income/expense account
tax_rates.csv
journal.csv            THE ledger: one row per line — entry_id, date, account_code,
                       account_name, debit, credit, description, contact, entry_type
                       (from the classification), source_ref, memo
invoices.csv + invoice_lines.csv   incl. amount_paid, amount_due, status at export date
bills.csv + bill_lines.csv         same
payments.csv           payment_id, date, contact, bank_account, amount, applied_to_type,
                       applied_to_number, applied_amount — one row per application
estimates.csv
trial_balance.csv      by account at the end date (and at cutover, if set)
aging_ar.csv, aging_ap.csv         at cutover
attachments/           receipts, with attachments.csv linking file → entry where matched
tie_out_report.pdf     the report below
```

Rules: UTF-8 with BOM (Excel opens it cleanly), ISO dates, plain decimal amounts with
2 places, debit and credit as two positive columns, stable IDs that survive a re-run.
Publish the column spec in the README so other tools can target it.

## Direct load into QuickBooks Online or Xero

The premium output cards. Spreadsheet imports force history in as journal entries,
which leaves the target's banking, vendor and sales reports empty. The targets' own
APIs can create the real transaction types, so these cards do that, using the model's
classification:

| Entry type | QuickBooks Online | Xero |
|---|---|---|
| expense / refund | `Purchase` (Cash / Check / CreditCard; credit flag for refunds) | `BankTransaction` SPEND / RECEIVE |
| deposit / sales receipt | `Deposit` / `SalesReceipt` | `BankTransaction` RECEIVE |
| transfer | `Transfer` | `BankTransfer` |
| credit card payment | `CreditCardPayment` (verified in Intuit's API reference, Oct 2026: `TxnDate`, `Amount`, `BankAccountRef` (Bank), `CreditCardAccountRef` (Credit Card), `PrivateNote`; **home currency only**). Use `Transfer` for foreign-currency cards | `BankTransfer` |
| invoice | `Invoice`, with line items from the Wave API | `Invoice` ACCREC |
| invoice payment | `Payment` with `LinkedTxn` to the invoice | `Payment` against the invoice |
| bill / bill payment | `Bill` / `BillPayment` linked | `Invoice` ACCPAY / `Payment` |
| journal entry | `JournalEntry` | `ManualJournal` |

**Load order:** accounts (mapped to existing target accounts where the company isn't
empty, on an editable mapping screen) → tax rates → customers/vendors → items →
invoices and bills → payments → bank transactions and transfers → journals →
attachments. Then check.

**Rules:**
- **Preview first.** Before writing anything, show counts by type and the total that
  will land in each account; the user confirms. Strongly suggest loading into a
  test/sandbox company first; make that one click.
- **Prefer an empty company.** If it already has transactions, warn, require explicit
  confirmation, and show overlaps (same date, amount, account).
- **Idempotent and resumable.** Record every created target ID against its Wave
  Transaction ID in the project, and write `Wave #<id>` into each record's memo/reference.
  A re-run, or a resume after a crash, skips what already exists — never duplicates.
- **Undo.** "Remove everything Wave Exit loaded" deletes exactly the recorded IDs, in
  reverse order, after a confirmation naming the company and the count.
- **Bank feeds.** The target's bank feed will backfill 90 days to 24 months of history
  and duplicate what was loaded. The finish checklist says to start feeds the day after
  cutover, or to match rather than add feed items for the overlap.
- **Limits** (checked against the providers' own pages, 2026-10-23):
  - *QuickBooks Online* (Intuit "API call limits and throttles"): 500 requests/min per
    company and 10/s per company per app; batch at most 30 payloads, 40 batch requests
    per minute per company per app; 429 means wait 60 s; requests over 120 s time out;
    queries return at most 1,000 rows. App Partner Program ("Platform service fees",
    2025-10-27): writes ("Core") are unmetered on every tier. Reads ("CorePlus") are
    metered, and the free **Builder** tier includes 500,000 per month per workspace,
    after which reads are **blocked**, not billed. Silver is US$300/month with 1M reads.
    Read sparingly: the post-load tie-out should use report endpoints (TrialBalance,
    AR/AP aging), not entity queries.
  - *Xero* ("OAuth 2.0 API limits", "Pricing", tiers since 2026-03-02): new apps start
    on **Starter: free, 5 connections, 1,000 calls/day per organisation**; Core A$35/month,
    50 connections, 5,000/day. All tiers: 60 calls/min and 5 concurrent per organisation,
    10,000/min per app. Each organisation may connect at most 5 uncertified apps. Batch
    ~50 records per request. The **Journals read endpoint is Advanced-tier only**
    (A$1,445/month), so check 8 must use Xero's reports (Trial Balance, aged
    receivables/payables), not Journals. Writes (ingress) are unmetered.
  - *Xero's own subscription plans*: per Xero's limits page, an organisation on the
    "Early"/Starter plan can approve only **20 sales invoices and 5 bills per month** (by
    invoice date). A full-history load into such an organisation will fail. Detect the
    plan and warn on the preview screen, or load history as journals.
  - Plan for it: on Starter, a 5,000-transaction history doesn't fit in a day's 1,000
    calls without batching. Batch and support pause-and-resume the next day.
- **Afterwards, re-read the target's trial balance and aging** and compare them with
  the model (tie-out check 8).

**Signing in to the targets.** Both use OAuth 2.0 and need a registered developer app
(Intuit Developer, Xero Developer). Checked 2026-10-23:
- *Xero* supports PKCE for desktop apps ("Auth Code with PKCE" app type, no client secret
  issued). Redirect URIs must be https **except localhost**, so use a loopback listener.
  The code expires in 5 minutes, the access token after 30 minutes and the refresh
  token after 60 days (with `offline_access`). Refresh tokens rotate, with a 30-minute
  grace period to retry. Store them in the OS keychain.
- *Intuit*'s token exchange sends `Authorization: Basic base64(client_id:client_secret)`,
  and its OAuth page doesn't mention PKCE. So **Intuit needs the secret**. Refresh tokens
  have a rolling 100-day expiry and a 5-year hard expiry.
- *Wave* OAuth also needs the secret (see *The public API*).

So Intuit (and Wave, if OAuth is used) need a minimal stateless token-exchange service
that only swaps codes and refresh tokens for tokens. It never receives accounting data,
and its existence and purpose are stated on the first screen next to the privacy
promise. Xero doesn't need it.

## Tie-out checks (the trust feature — do not skip)

Shown in Review, repeated in the tie-out report, re-run after every input change:

1. Every entry balances (debits = credits).
2. Total debits = total credits for the whole ledger.
3. For every account, the balance computed from the ZIP equals the `balance` the API
   reports. The API only gives the *current* balance, so fetch it when inputs change;
   if transactions were entered in Wave after the ZIP was made, this fails — say that is
   the likely cause, offer "request a fresh export", and show the ZIP's newest
   `Transaction Date Last Modified`. (Skipped in export-file-only mode.)
4. Invoices: count and total from the API match the ledger; every invoice's
   `total − linked payments = amountDue`; AR at end date = sum of unpaid `amountDue` =
   receivable account balance.
5. Bills: AP at end date = sum of open bills = payable account balance.
6. Row counts in vs. rows out for every input file and every output.
7. No transactions dated after the export date or before the business's first entry.
8. After a direct load: the target's trial balance at the end date matches the model
   account by account, and its AR/AP aging totals match. Differences are listed with
   the records that cause them.

`tie_out_report.pdf`: one-page summary (all green / issues listed), then detail. An
accountant should be able to put it in the client file as evidence.

## Known gaps — tell the user honestly, inside the app

Not available from Wave by any supported route, so show them on the Outputs screen:
recurring invoice schedules, bank reconciliation status, bank-feed connections, payroll
detail beyond the payroll CSVs, and receipt links the matching couldn't resolve.
Recommend the PDF report pack for each closed year.

## UX rules

- No jargon: no "API", "JSON", "GraphQL", "schema", "parse", "endpoint", "null".
  Accounting vocabulary is fine and encouraged.
- Every error says what happened, why, and the one thing to do next. Never a stack trace;
  put technical detail behind a "Copy details for support" button.
- Numbers in the business currency with thousands separators; negatives in parentheses.
- Keyboard accessible, readable at 200% zoom, light and dark mode.
- Works offline except for the Wave connection and direct-load outputs.

## Technical direction

- **Desktop app.** Client financial data goes nowhere except Wave (to read it) and a
  target the user chose (to load it). No server of ours holds data, no analytics on
  content, no cloud upload. Say so on the first screen.
- Tauri (Rust shell) + React + TypeScript suggested — small signed installers, native
  keychain, no browser CORS problems. Electron is acceptable if Tauri blocks you.
- Signed, notarized installers for macOS and Windows; auto-update.
- Three layers, each a pure TypeScript library with no UI dependencies: **input
  readers** (one per slot type) → **model** (merge, classify, open items, tie-out) →
  **output plug-ins**. Testable on their own, reusable later (CLI, web).
- Decimal arithmetic for money (no floating point).
- Projects stored locally, encrypted at rest; keys in the OS keychain.
- Logs: local, rotating, with all amounts and names redacted unless the user opts in.

## Testing and acceptance

- A synthetic fixture business (duplicate names, archived accounts, part-paid invoices,
  bills, a multi-line journal, sales tax, a transfer between bank accounts, transfers
  through `Transfer Clearing`, split payments, one deposit paying two invoices, credit
  card refunds, a 21-line entry), as API JSON and ZIPs. Unit test every reader,
  classification rule and output against it.
- Property tests: every entry balances; universal package → model → package round-trips
  identically.
- Golden-file tests for every file-based output.
- Each output plug-in's "keeps / loses" statement is tested against what it actually
  produces.
- Direct-load tests against an Intuit sandbox and a Xero demo company: full load, kill
  midway and resume (no duplicates), run twice (no duplicates), undo (company empty again).
- Collect mode: a collection file made on one machine opens on another only with the
  passphrase, and contains no access key.
- Export-file-only mode produces every output that doesn't need API data.
- Acceptance: one real Wave business end to end; all checks green or explained; a direct
  load into a QBO sandbox reproduces the trial balance and AR/AP aging at cutover to the
  cent, with banking, vendor and sales reports populated.
- Usability: a bookkeeper who has never seen the app goes from Inputs to a finished
  Excel workbook and universal package without help in under 15 minutes (excluding
  Wave's email wait).

## Build order

1. Introspect the live Wave schema; start from `docs/wave-formats.md`. Test the
   remaining VERIFY items and update both docs: Wave OAuth eligibility; whether Wave's
   June 2026 paywall limits API keys or Data Export on the free plan; the Excel variant;
   bill, tax and currency formats; QBO `CreditCardPayment`; Xero PKCE; current QBO and
   Xero limits and pricing. **Done 2026-10-23** (see `docs/wave-api.md`). Still open:
   the Excel variant and bill/tax/currency formats, which need a test-business export,
   and the Full Access key decision.
2. Input readers and the model: merge, classification, open items, tie-out checks.
   **Done 2026-10-23** in `packages/core`. Covers the transactions and receipts ZIPs,
   the Wave API (key or OAuth) and checks 1–7. Not yet: payroll CSVs (format unknown,
   Canada only), the Excel variant, and the collection file (step 7).
3. Outputs that work for everyone: universal package, Excel workbook, PDF report pack,
   generic GL CSV.
4. The three screens and the project list, including export-file-only mode.
5. Direct load into QuickBooks Online (sandbox first) with preview, resume and undo.
6. QBO and Xero import files; Xero direct load; Beancount/hledger.
7. Collect mode.
8. Zoho Books, FreshBooks, Sage import files.
9. Installers, signing, auto-update.

At each step, show me what you built and what you verified before moving on. When a
fact about Wave or a target is uncertain, check it against the live schema, a real file
or the provider's docs, and tell me what you found — don't assume.
