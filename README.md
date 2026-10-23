# Wave Exit

**Take a business's books out of Wave Accounting, checked and complete, in whatever form the next system needs.**

Wave Exit is a desktop app for accountants and bookkeepers. You give it what Wave can provide
(its export files and, ideally, a read-only connection), it merges and checks the books once,
and you make as many outputs as you need: an archive for the client file, an Excel review
workbook, a PDF report pack, import files for the new system, and more.

> **Status: preview.** The converter and the desktop app work end to end (steps 1–4 of the
> [build plan](docs/converter-app-prompt.md#build-order)). Direct loading into QuickBooks Online
> and Xero, the client collection file and signed installers are still to come. See [Status](#status).

**[Download the preview](https://github.com/turbogizzmo/wave-exit/releases/latest)** for macOS
(Apple silicon and Intel) or Windows · **[Help](https://turbogizzmo.github.io/wave-exit/help.html)** ·
**[Website](https://turbogizzmo.github.io/wave-exit/)**

Preview builds aren't signed by Apple or Microsoft yet. The first time you open one, your
computer asks first: see [Installing the app](https://turbogizzmo.github.io/wave-exit/help.html#install).

Wave Exit is not affiliated with, endorsed by or sponsored by Wave Financial Inc. "Wave" is
used only to describe the books it converts. QuickBooks and Xero are trademarks of their
owners.

## Why it exists

- **Wave can't hand over the whole ledger through its API.** Its public API can't read
  transactions at all; the general ledger only comes out through *Settings → Data Export*.
  Wave Exit combines that export with the API for everything else (the full chart of accounts,
  invoice line items, products, sales taxes).
- **Accountants need several outputs, not one.** Migration tools feed only their own product.
  Wave Exit converts once and produces any number of destinations, now or later.
- **Trust.** Every conversion runs tie-out checks (every entry balances, balances agree with
  Wave, invoices and payments agree, nothing lost in reading) and writes a tie-out report you
  can put in the client file.

## What it makes

| Output | What it's for |
|---|---|
| **Universal package** (always made) | The archive: every record as documented CSV files, with receipts, a manifest and the tie-out report. Every other output can be rebuilt from it. |
| **PDF report pack** | Tie-out summary, trial balance, P&L and balance sheet for each year, AR/AP aging and the general ledger, for the client file. |
| **Excel workbook** | Every table on its own sheet with filters, and a trial balance whose formulas recompute from the journal. |
| **General ledger CSV** | One row per line with debit and credit columns, for any system that imports journals. |
| **Bank statement files** | Each bank and card account as OFX and CSV for QuickBooks Online, Xero and others, so history lands in their banking screens. |
| *Coming:* QuickBooks Online and Xero import files, direct load into QuickBooks Online and Xero, Beancount/hledger | |

Each output says up front what it keeps and what it loses.

## Privacy

Your clients' books stay on your computer. Wave Exit reads from Wave and writes only to the
folders you choose. Nothing is sent to Wave Exit or anyone else, and projects are stored
encrypted (AES-256-GCM, with the key in the operating system's keychain). See
[docs/privacy.md](docs/privacy.md).

## Documentation

- [Help](https://turbogizzmo.github.io/wave-exit/help.html): the same help as the app's Help panel
  (written in `packages/app/src/help/content.ts`; `npm run help -w @wave-exit/app` regenerates `site/help.html`).
- [User guide](docs/user-guide.md): getting the files from Wave, the three screens, the outputs.
- [Privacy and security](docs/privacy.md)
- [Architecture](docs/architecture.md): how the code is organised, for contributors.
- Reference: [Wave export formats](docs/wave-formats.md), [what Wave's API offers](docs/wave-api.md),
  [bank statement formats](docs/bank-statement-formats.md), [product brief and build plan](docs/converter-app-prompt.md).

## Status

| Step | | |
|---|---|---|
| 1 | Verify Wave's schema, export format and target platforms' rules | Done |
| 2 | Input readers and the books model (merge, classify, open items, tie-out checks) | Done |
| 3 | Universal package, Excel workbook, PDF report pack, GL CSV (and bank statement files) | Done |
| 4 | Desktop app: project list, Inputs, Review, Outputs, export-file-only mode | Done |
| 5 | Direct load into QuickBooks Online | Next |
| 6 | QuickBooks Online and Xero import files, Xero direct load, Beancount/hledger | |
| 7 | Collect mode: a client gathers their files into one encrypted file | |
| 8 | Zoho Books, FreshBooks, Sage import files | |
| 9 | Signed installers for macOS and Windows, auto-update | |

**Open question:** Wave's developer docs say apps published for other Wave users must use
OAuth ("Connect to Wave"), which Wave allows only for businesses on its Pro or Advisor plans.
Wave Exit currently connects with an access key the user creates themselves. This is being
raised with Wave before release.

## Development

Requires Node.js 24 or later. The desktop app also needs Rust (stable) and, on macOS, Xcode.

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

Run the app in a browser (development build; storage is the browser's, not the keychain):

```bash
npm run dev -w @wave-exit/app
```

Run the desktop app (from `packages/app`):

```bash
npx tauri dev
```

"Try a sample business" on the home screen loads an invented business, so every screen can be
explored without a Wave login.

```
packages/core/   input readers, the books model and output plug-ins (pure TypeScript)
packages/app/    the desktop app (React + TypeScript, Tauri shell in src-tauri/)
site/            the project website (GitHub Pages); help.html is generated from the app's help
docs/            documentation
```

Real Wave data and access keys never go in this repository: tests use an invented business
(see `packages/core/test/fixtures/`).

## Releasing

Push a version tag (matching `version` in `packages/app/src-tauri/tauri.conf.json`), for example
`v0.4.0`. The Release workflow builds the macOS (universal) and Windows installers, attaches them
to a draft release, and publishes it when every build has passed.

## License

[MIT](LICENSE)
