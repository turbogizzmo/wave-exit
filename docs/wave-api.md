# Wave public API: what the converter relies on

Introspected and tested live on 2026-10-23 against
`https://gql.waveapps.com/graphql/public`, read-only, with a Full Access token on an
account holding three businesses. The rendered schema is in
[`wave-api-schema.txt`](wave-api-schema.txt). This note records structure and counts
only, no financial detail.

Each fact is marked **tested** (a live query returned it), **schema** (read from
introspection, not exercised on data), or **docs** (Wave's own pages, with date).

## Reading money transactions: still impossible

- **schema** `Business` has no transactions field. `Transaction` has one field, `id`.
  The only way to obtain one is a `moneyTransaction*Create` mutation. The ledger has to
  come from the Data Export ZIP. This hasn't changed since the September 2026 check.
- **schema** No bill types or bill queries exist. Bills come only from `bill_items.csv`.

## New since the September notes: invoice payments link to the ledger

`Invoice.payments: [InvoicePayment]` exists (and `Business.invoicePayment(id)`).
Each payment has `paymentDate`, `amount`, `account { id name }`, `paymentMethod`,
`active` and **`accountingTransactionId`**.

- **tested** `accountingTransactionId` is a base64 Wave global ID. Decoded, it reads
  `Business:<uuid>;Transaction:<19 digits>`, and the 19 digits are the export's
  `Transaction ID`. In the real business, 10 of 12 payments had one. All 10 pointed to
  a ledger entry carrying the same invoice number and the same date, and in each the
  receivable credit equalled the payment `amount`.
- **tested** The other 2 payments had `accountingTransactionId: null` (methods `OTHER`
  and `BANK_TRANSFER`). Each matched exactly one ledger entry on invoice number + date +
  amount. So link by ID first, then fall back to invoice number + date + amount.
- **tested** Invoice and payment IDs decode the same way (`Invoice:<19 digits>`,
  `InvoicePayment:<19 digits>`), but those numbers are *not* ledger Transaction IDs.
  The invoice's own ledger entry is found by invoice number only.
- **tested** For every invoice, `total − Σ payments.amount = amountDue` and
  `amountPaid = Σ payments.amount`. Statuses seen: `PAID`, `OVERDUE`.
- **tested** `InvoicePayment.amount` is a `String` in plain decimal form (`"150"`,
  `"1234.5"`), not a `Money` object. `transactionId` was always null.

This makes tie-out check 4 and the payment links exact rather than inferred, whenever
a Wave connection exists.

## Gotchas found live

1. **`Money.value` has thousands separators.** **tested** `total.value` came back
   as `"1,234.56"` for amounts of 1,000 or more. Parse `minorUnitValue` (an integer
   count of cents as a Decimal) instead. Verified: `value` with commas removed × 100 =
   `minorUnitValue` for every invoice field read. `Currency.exponent` gives the
   number of minor units.
2. **`Account.balance` is a bare decimal string of variable precision** (`"0"`,
   `"12.5"`, `"-3.25"`). **tested** Its sign follows the account's normal balance,
   the same convention as the export's `Amount (One column)`.
3. **`accounts()` hides archived accounts by default.** **schema** The argument is
   `isArchived: Boolean = false`. **tested** Passing `null` still returned only active
   accounts. Fetch twice, with `isArchived: false` and `isArchived: true`. None of the
   three live businesses had archived accounts, so the `true` call came back empty. The
   same filter on `products(isArchived: true)` did return archived products (631 in one
   business), so the filter works.
4. **`subtype { systemCreated }` errors on account nodes.** **tested** Wave returns
   `INTERNAL_SERVER_ERROR: Cannot return null for non-nullable field
   AccountSubtype.systemCreated` for every account. Don't request it there. It works on
   the top-level `accountSubtypes` query.
5. **The subtype name differs depending on where you read it.** **tested**
   `Account.subtype.name` gives e.g. `Cash & Bank`, `Expense`, `Retained Earnings:
   Profit and Business Owner Drawing`. The top-level `accountSubtypes` list gives
   `Cash and Bank`, `Operating Expense`, `Retained Earnings: Profit`, which is
   **exactly the export's `Account Type` text**. Map the export through `accountSubtypes`
   (see `wave-formats.md`).
6. **`TRANSFERS` exists under both ASSET and EQUITY.** **tested** So the export's
   `Account Type` alone doesn't identify a subtype. Key on `(Account Group, Account Type)`.
7. Unchanged from September: string arguments must be variables; pagination is
   `page`/`pageSize` with `pageInfo.totalPages`/`totalCount`; the default page size is
   45 almost everywhere.

## Other readable data worth importing

| Field | Notes |
|---|---|
| `Business` | `name`, `currency`, `timezone`, `address`, `isPersonal`, `isArchived`, `createdAt`. `businesses(isArchived:)` takes the same filter |
| `accounts` | `id name description displayId currency type subtype normalBalanceType isArchived balance balanceInBusinessCurrency sequence` |
| `customers` | Full address, shipping details, `currency`, `isArchived`, `outstandingAmount`, `overdueAmount`. The query has no `isArchived` filter |
| `vendors` | As customers, without balances |
| `products` | `unitPrice isSold isBought incomeAccount expenseAccount defaultSalesTaxes isArchived` |
| `salesTaxes` | `name abbreviation taxNumber rates { effective rate } isCompound isRecoverable isArchived` |
| `invoices` | Adds `taxTotal discountTotal discounts exchangeRate currency poNumber memo footer source attachments { fileName downloadUrl }` beyond the prompt's list |
| `InvoiceItem` | `quantity unitPrice subtotal total taxes { salesTax amount } account product` |
| `estimates` | Type `AREstimate`, mirrors invoices, has `payments` (deposits) |
| `user` | `id defaultEmail firstName lastName` (for the "key checked" tick) |
| `accountSubtypes` / `accountTypes` | Global catalogue, 39 subtypes, with display names and `systemCreated` |

Invoice attachments (`ARAttachment.downloadUrl`) are a second attachment source next to
the receipts ZIP. Not tested (the live invoices had none).

## Live counts used for planning (structure only)

| Business | Accounts | Archived acc. | Customers | Vendors | Products (+archived) | Sales taxes | Estimates | Invoices |
|---|---|---|---|---|---|---|---|---|
| Business A | 109 | 0 | 4 | 122 | 23 (+0) | 0 | 0 | 13 |
| Business B | 52 | 0 | 0 | 0 | 0 | 0 | 0 | – |
| Business C | 39 | 0 | 628 | 1 | 67 (+631) | 0 | 0 | – |

- All accounts in all three businesses are USD. No multi-currency, sales tax or bills
  anywhere, so those formats remain unverified from live data.
- The chart grew from 103 (Sept) to 109. Wave keeps adding system accounts:
  `Transfer Clearing` now matches 36 accounts (was 32), `Accounts Receivable` 14 (was 12).
  Don't hard-code those counts.
- Wrong-business detection works on names. **tested** The export's 3 customers and 122
  vendors all matched Business A's API lists. Against the other two businesses:
  0/3 and 0–1/122. All 34 ledger account names matched the right business's chart.
- **Tie-out check 3 in practice.** **tested** 32 of 34 accounts matched the API balance
  to the cent. The 2 that didn't, a `Cash and Bank` and an `Uncategorized Expense`
  account, differ by equal and opposite amounts. That is the signature of one bank-feed
  expense imported after the export was made, the exact case the check's message has to
  explain. No account missing from the export carried a non-zero balance.

## Authentication and plan rules (docs, checked 2026-10-23)

- **OAuth needs Pro or Wave Advisor on the business.** Wave's OAuth Guide (updated
  2026-07-10) says users "can only grant access to businesses that have an active Pro or
  Wave Advisor subscription". Token refresh returns 403 once the subscription lapses.
- **Wave OAuth needs a client secret.** The token exchange and refresh both require
  `client_secret`, and there's no PKCE. A desktop app can't ship that secret, so a
  "Connect to Wave" button needs the same stateless token-exchange service the prompt
  proposes for Intuit.
- **Full Access tokens work on the free plan.** "3 – Authentication" (2026-06-29) says
  use Full Access "if you don't have a Pro account". Wave's help article *Wave's
  Developer Portal* (2026-10-06) says you need no Pro or Advisor plan "to test your own
  app … for personal use".
- **⚠ Wave's terms for a published app.** The same page says Full Access is "strictly
  recommended for development purposes or personal applications only. For any
  applications that will be published or sold for other Wave users to access their
  accounts, authentication must be via OAuth 2." Wave Exit's "paste your Wave access key"
  design is exactly that. See the open decision in `converter-app-prompt.md`.
- A Full Access token is created under a registered developer application. **tested**
  `query { oAuthApplication { name } }` returns that app's name when called with a
  Full Access token.
- **Rate limit:** still unpublished. No Wave page found states one. Keep the ~2 req/s
  throttle with backoff on 429.
- Wave's developer portal now also offers **webhooks** and an API Playground. Not
  needed here.
