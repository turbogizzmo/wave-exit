# Bank statement files: the formats, as verified

What the "Bank statement files" output writes, and where each rule comes from. Read
2026-10-23 from the vendors' own pages and the OFX specification. Built in
`packages/core/src/outputs/statements/`.

## QuickBooks Online

Sources: Intuit, *Manually upload transactions into QuickBooks Online* (updated
2026-08-24) and *Format CSV files in Excel to get bank transactions into QuickBooks*
(US, updated 2026-08-24), *Fix bank upload errors* (updated 2026-08-04).

| Rule (Intuit's words, paraphrased) | What Wave Exit does |
|---|---|
| Upload types: "QBO, QFX, or CSV"; another paragraph of the same page lists ".csv, .txt, .qbo, or .ofx". QBO is the suggested one | CSV always; .qbo when a bank ID is given (below) |
| File "350 KB or less", "up to 1,000 lines per upload" | Each account split into parts that fit both, never splitting a day unless one day is too big |
| CSV: 3 columns (Date, Description, Amount) or 4 (Date, Description, Credit, Debit) | 3 columns |
| 3-column example: payment `-100.00`, deposit `200.00` | Money in positive, money out negative |
| "Leave any cells … that only contain zero (0) blank" | Zero-amount lines are left out (counted in README) |
| "Remove numbers from cells in the Description column" | A description that is only digits is prefixed "Ref " |
| Dates in one format, "We recommend the dd/mm/yyyy format" | dd/mm/yyyy |
| Amounts with "12 or more digits" are refused | Amber card naming them |
| Choose the credit card account (not a bank account) for card files; uploading into a sub-account isn't supported | README instructions |
| The file should start at least one day before the oldest QuickBooks transaction in that account | README instruction |

**Not published by Intuit:** the `INTU.BID` (Intuit bank ID) that .qbo Web Connect files
carry. Third-party guides say QuickBooks checks it against its list of banks and
refuses unknown ones, and that the list is visible only through Quicken's or
QuickBooks Desktop's "Look Up". So Wave Exit makes .qbo/.qfx files **only when the user
enters the bank's ID**, which is in any .qbo file the client's bank gave them. It never
borrows another bank's ID.

## Xero

Sources: Xero Central, *Import an OFX, QFX or QuickBooks bank statement* and *Import a
bank statement in CSV format* (read 2026-10-23); *About manually importing bank
statements* lists "OFX, QFX, QIF, CSV and QuickBooks" formats.

| Rule | What Wave Exit does |
|---|---|
| "If your bank has the option to export statements in OFX format, we recommend using this format" | `Xero/<account>.ofx`, whole history |
| Xero "recognises duplicate transactions already imported in other files and excludes them" | Stable FITIDs (Transaction ID + line) |
| CSV: header in row 1, unique column names; only Date and Amount mandatory; Payee, Description, Reference, Cheque number optional | `Date, Amount, Payee, Description, Reference` (Reference = the FITID) |
| One Amount column, income positive, expenses negative, "Don't use commas"; for cards, payments positive and purchases negative | Same |
| Accepted dates include `YYYY/MM/DD`; Xero asks only when a date is ambiguous | `YYYY/MM/DD` |
| No balance columns, no account number, no empty rows; at most 100,000 rows | None written; amber card above 100,000 |
| The CSV template's exact headings are regional and downloadable only inside Xero | Not copied: Xero asks the user to assign columns on the first import |

## OFX

Source: *Open Financial Exchange Specification 2.3* (10/16/2020, financialdataexchange.org).

- Files are OFX 1.0.2 SGML with the header the spec shows (§2.8.2): `OFXHEADER:100`,
  `DATA:OFXSGML`, `VERSION:102` and so on. Leaf elements have no end tags. Text is
  reduced to ASCII, and `<`, `>` and `&` are replaced.
- `<STMTTRN>` (§11.4.4.1): `TRNTYPE` (CREDIT, DEBIT, XFER; §11.4.4.3), `DTPOSTED`, `TRNAMT`,
  `FITID` (A-255, unique, used to detect duplicates, §3.2.3), `NAME` (A-32), `MEMO`
  (A-255 in V1 message sets), `CHECKNUM` (A-12).
- "Transaction amounts are signed from the perspective of the customer. For example, a
  credit card payment is positive while a credit card purchase is negative."
- Dates: `YYYYMMDD120000`. A date-only value means midnight GMT (§3.2.8.2), which can show
  as the previous day in the Americas, so noon is used.
- Bank accounts use `BANKMSGSRSV1/STMTRS` with `BANKACCTFROM` (`BANKID` A-9, `ACCTID`
  A-22, `ACCTTYPE` CHECKING or SAVINGS). Cards use `CREDITCARDMSGSRSV1/CCSTMTRS` with
  `CCACCTFROM`. Wave has no account or routing numbers, so `ACCTID` is `WAVEEXIT<code>`
  and `BANKID` is `000000000`. The user picks the target account on import in both
  QuickBooks and Xero.
- `LEDGERBAL` is the account's balance at the statement end, customer's side.

## Checked

- **Synthetic business and the real books:** every .ofx/.qfx/.qbo file parses with
  `ofxtools` 0.9.5, a strict parser that checks element types and lengths. Transaction
  IDs are unique.
- **Totals:** OFX, QuickBooks CSV and Xero CSV totals agree, and each statement's balance
  equals the ledger balance.
- **Real books:** 3 accounts, 958 transactions, all within QuickBooks' limits.
- **Unit and property tests:** splitting, scope, formats and golden files.

## Still to verify (needs a QuickBooks sandbox and a Xero demo company)

- That QuickBooks Online accepts the .ofx files too, and which date format its column
  mapping step expects for US companies (Intuit recommends dd/mm/yyyy, but its example
  uses `1/1/2018`).
- The sign QuickBooks expects in a credit card CSV. Intuit's tip only says card files
  "may display transactions in reverse order", and to choose the card account.
- That .qbo files with a real bank's `INTU.BID` import into QuickBooks Online.
- That Xero imports the .ofx and .csv files as described, including duplicate detection
  on a second import.
