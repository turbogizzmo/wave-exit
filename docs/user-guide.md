# Wave Exit user guide

Wave Exit converts one Wave Accounting business at a time. Each business is a **project**.
A project goes through three screens: **Inputs**, **Review** and **Outputs**. You can move
between them freely, come back next month with a newer export, and make more outputs
without asking the client again.

## Before you start: whose books are these?

| Situation | What you can use |
|---|---|
| **Your own business** (you're the owner or an Admin in Wave) | Everything: the export files and a Wave connection. |
| **A client's, and you have access** (Admin on their business, which needs Wave's Pro plan, or Wave Advisors) | Everything, using your own Wave login. |
| **A client's, and you don't** (most clients on Wave's free plan) | The export files the client sends you. Wave Exit works without a connection and tells you what that loses. |

Wave allows only the owner or an Admin to export data. On Wave's free plan a client can't
invite an accountant as an Admin, so the client downloads the files and sends them to you.

**Never ask a client to email you their Wave access key.** It opens their whole Wave account.

## Getting the files from Wave

All exports are in Wave under *Business settings → Other → Data Export*. Wave emails a
download link to the account's main email address. **The link works for 24 hours.**

| Wave's button | What you get | Needed? |
|---|---|---|
| **Export all transactions as CSV** | A ZIP named with a long code, holding the ledger, customers, vendors and bills | **Yes.** It's the only source of the ledger. Choose "as CSV", not "for Excel". |
| **Export all receipts as a ZIP file** | The receipt files you uploaded | Optional. Without it, outputs have no receipts. |
| **Export all employee info / pay stubs as CSV** | Payroll records | Canadian businesses only. Not read yet. |

## Screen 1: Inputs

Drop Wave's files anywhere on the window and Wave Exit puts them in the right place. A ZIP, the
unzipped folder or the individual files all work. Each slot shows what it holds, or what is lost
without it. Adding a newer export replaces the old one and keeps a record of it.

### The Wave connection

The connection adds what the export files don't have: accounts that were never used, Wave's
account types, invoice line items, due dates, products, sales taxes and estimates. It also lets
Wave Exit check every account balance against Wave.

1. Choose **Mine** or **A client's, and I have access**.
2. Click **Open Wave's key page**, sign in to Wave's Developer Portal, create an application
   (any name), and click **Create token**.
3. Paste the key into Wave Exit and click **Check key**. You see a green tick and the Wave login
   it belongs to.
4. Pick the business.

The key is stored in your computer's keychain, for this project only, and Wave Exit only reads
with it. **Forget this key** removes it. When you've finished with a business, revoke the key in
Wave's Developer Portal.

If the export looks like it's from a different business than the one connected, Wave Exit
says so: nothing inside Wave's export names the business, so it compares customers, vendors
and account names.

### Without a connection

Choose **A client's, and I don't**. Wave Exit lists what is lost before you go on:
- accounts that were never used;
- Wave's own account types (worked out from the export instead);
- invoice line items, products, sales taxes and estimates (invoices are rebuilt from the ledger);
- due dates, so invoices are aged from their invoice date;
- the check against Wave's balances.

Everything else works the same.

## Screen 2: Review

Review runs by itself whenever the inputs or settings change.

**Checks.** Each one is green (OK), amber (look at the note) or red (needs an answer).

| Check | What it proves |
|---|---|
| 1. Every entry balances | Debits equal credits in every transaction. |
| 2. Total debits equal total credits | The whole ledger balances. |
| 3. Account balances agree with Wave | Each account adds up to the balance Wave shows today. If it fails, the usual cause is a transaction entered in Wave after the export was made: request a fresh export, or accept the difference. |
| 4. Invoices and payments agree | Each invoice's total minus its payments equals what Wave says is owed, and open invoices add up to accounts receivable. |
| 5. Bills add up to accounts payable | The same for bills. |
| 6. Nothing lost in reading | Every line, contact and receipt that went in was read. |
| 7. Dates are plausible | No transactions dated after the export. |

**Questions and notes.** Anything that needs a person, each with a one-click answer: two
accounts with the same name, a receipt that fits more than one transaction, a transfer whose
other side wasn't found, receivable entries without an invoice number. **Outputs stay locked
until every red item is answered.** Answers are saved with the project and apply again after
a newer export.

**Settings for every output.**
- **Cutover date:** the day the books move to the new system.
- **Full history**, or **opening balances at the cutover date**: balance-sheet accounts at
  their balances, income and expenses for the year to date, earlier years' profit in retained
  earnings, and every open invoice and bill carried separately so aging works on day one.
- **Fiscal year end.** Wave doesn't expose it, so set it here. It defaults to December.

**Open items.** Accounts receivable and payable aging at the cutover date, invoice by invoice.

**How transactions were sorted.** Each transaction is classified once (expense, refund,
deposit, sales receipt, transfer, credit card payment, invoice, invoice payment, bill, bill
payment, or journal entry) and every output uses the same classification. The sorting rules
are listed under *advanced*; you can turn a rule off.

## Screen 3: Outputs

Tick any number of outputs and press **Create**. You choose where to save them. Wave Exit never
overwrites a file. The **universal package** is always made, because it's the archive. Each
card says what that destination keeps and what it loses.

| Output | Use it for |
|---|---|
| Universal package | The client file. Documented CSV files, receipts, a manifest with a fingerprint of every source file, and the tie-out report. |
| PDF report pack | The client file: tie-out summary, trial balances, P&L and balance sheet per year, aging, general ledger. |
| Excel workbook | Reviewing. The trial balance recomputes from the Journal sheet. |
| General ledger CSV | Any system that imports journal entries. Follows the scope setting. |
| Bank statement files | Getting bank and card history into the new system's banking screen. Wave's categories don't come across: categorise there, or set up bank rules. |

### Not available from Wave

These can't be read from Wave by any supported route: recurring invoice schedules, bank
reconciliation status, bank-feed connections, and payroll detail beyond Wave's payroll
exports. Keep the PDF report pack for each closed year.

## Try it without a Wave login

On the home screen, **Try a sample business** opens an invented business, Maple & Pine Design
LLC, with every input already added.
