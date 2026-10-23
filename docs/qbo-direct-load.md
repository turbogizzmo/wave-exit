# Direct load into QuickBooks Online

How Wave Exit writes converted books into a QuickBooks Online company, what was checked
against Intuit's documentation, and what still has to be confirmed against a real
sandbox company. Code: `packages/core/src/targets/qbo` (load logic),
`packages/app/src/ui/QboLoad.tsx` (screens), `packages/token-exchange` (sign-in helper).

## Status (2026-10-23)

- **Built and tested against an in-memory QuickBooks** (`packages/core/test/fixtures/fake-qbo.ts`)
  that enforces the rules below: full load with check 8 green, crash mid-load and resume,
  pause, running twice, undo to empty, reload after undo, existing accounts, export-only
  and opening-balances books. The app test drives the screens end to end against it.
- **Sandbox only in the app.** Loading into a real company is shown as "Coming" until a
  sandbox run has confirmed the unverified items below and the token-exchange service is
  deployed with production keys.
- **Not yet run against a real Intuit sandbox.** That needs the user's own Intuit
  Developer account, app and sandbox company (see "Setting up a sandbox" below).

## How a load works

1. **Connect.** Intuit sign-in in the user's browser; the reply comes back to the app on
   `http://localhost:53682/callback` (the native side only opens Intuit's authorize page
   and only listens on that port, for five minutes). Tokens live in the OS keychain, one
   entry per project and company.
2. **Company check.** Wave Exit counts the company's transactions and asks for an explicit
   confirmation before loading into a company that already has some.
3. **Mapping.** Each Wave account gets a QuickBooks account type and detail type from its
   Wave subtype, matched to an existing account where the names and class agree. QuickBooks
   allows one A/R, A/P, retained earnings and opening balance equity account, so those
   reuse the existing ones. The user can change any row.
4. **Preview.** Counts per record type and, per account, what the plan posts against what
   the converted ledger says. Any difference blocks loading.
5. **Load.** In order: accounts, contacts, items, invoices and bills, payments, bank and card
   transactions, journals. Batches of 30 (10 for invoices, bills and payments, chronological,
   as Intuit advises). Every record carries `Wave #<id>` in its memo or private note.
   A load record (what was created, with QuickBooks ids) is saved after every batch.
6. **Resume.** Rerunning skips what the load record says exists. Each batch's `requestid`
   is derived from its content, so a batch QuickBooks accepted but whose answer was lost
   returns the first response instead of creating a copy.
7. **Check 8.** QuickBooks's own TrialBalance (accrual) and aged receivables/payables at the
   end date against the converted books: balance-sheet accounts one by one, profit and
   loss with retained earnings in total.
8. **Undo.** Deletes the transactions newest first and makes accounts, contacts and items
   inactive (QuickBooks can't delete them). A record changed in QuickBooks since the load
   is left alone and listed. The confirmation names the company and the record count.

## Verified against Intuit's documentation (developer.intuit.com, read 2026-10-23)

- Base URLs `https://sandbox-quickbooks.api.intuit.com` and `https://quickbooks.api.intuit.com`,
  `/v3/company/<realmId>/…`, `minorversion=75`.
- `requestid` makes a write idempotent: unique per company, at most 50 characters (36 for batch).
- Batch: at most 30 items, 40 batch requests a minute per company; items are independent.
  Limits: 10 requests a second, 500 a minute; on 429 wait 60 seconds.
- Invoice and SalesReceipt lines need an `ItemRef`, so Wave Exit creates one item per income
  account ("<account> (from Wave)"). Inactive items keep their names, so names are made
  unique over inactive items too.
- US companies can email imported invoices automatically when online payments are on;
  Wave Exit sets `AllowOnlineCreditCardPayment` and `AllowOnlineACHPayment` to false.
- Transfer: both accounts must be assets. Credit card payment uses `CreditCardPayment`.
- Purchase with `Credit=true` (a refund) is valid only for credit cards; bank refunds load
  as a Deposit.
- Journal entry lines on A/R need a customer, on A/P a vendor.
- Account names: at most 100 characters, no `"` or `:`. Accounts can only be made inactive.
- Reports: `TrialBalance?start_date&end_date&accounting_method=Accrual`,
  `AgedReceivables` / `AgedPayables` with `report_date` and `aging_method=Report_Date`.
- OAuth: authorize `https://appcenter.intuit.com/connect/oauth2`, token
  `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` (HTTP Basic with the client
  ID and secret), revoke `https://developer.api.intuit.com/v2/oauth2/tokens/revoke`, all as
  listed in Intuit's discovery document. Access tokens last an hour, refresh tokens 100 days
  (rolling). Localhost redirects are accepted only for development keys, which reach only
  sandbox companies.

## Still to confirm in a real sandbox

- A sales tax collected through an item whose income account is a liability.
- Invoices with negative (discount) lines.
- Deposit lines with no customer or vendor.
- Account types accepted as the names Wave Exit sends (`Bank`, `Other Current Liability`, …).
- How long Intuit remembers a `requestid`.
- Opening-balances scope: items posting to Opening Balance Equity.
- Report column layout (`ColData[0].id` as the account id) on a real company.

## Setting up a sandbox (done by the user, once)

1. Create an account at developer.intuit.com and an app with the Accounting scope.
2. In the app's development settings, add the redirect URI `http://localhost:53682/callback`.
3. A sandbox company comes with the developer account.
4. In Wave Exit: Outputs → Direct load → paste the development Client ID and Client Secret
   (kept in the keychain), then **Connect to QuickBooks** and sign in on Intuit's page.

## The token-exchange service (`packages/token-exchange`)

Production keys need an https redirect and a client secret that can't ship inside a
desktop app. The service is a stateless fetch handler (Cloudflare Workers or similar) with
three routes: `GET /intuit/callback` (redirects to the app on 127.0.0.1), `POST /intuit/token`
and `POST /intuit/refresh`. It stores and logs nothing and never sees accounting data.
Written and tested; **not deployed**.
