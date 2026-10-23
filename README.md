# Wave Exit

A desktop converter that takes a Wave Accounting business out of Wave: Wave API data
and Data Export ZIPs in, many outputs out (universal archive package, Excel, PDF report
pack, QuickBooks/Xero import files and direct load, Beancount/hledger).

Status: **build steps 1–4 done.** Wave facts verified; input readers and the books
model; outputs (universal package, Excel workbook, PDF report pack, GL CSV, bank
statement files); and the desktop app: project list, Inputs, Review and Outputs, including
export-file-only mode. Not yet: direct load, QuickBooks/Xero import files, collect mode,
signed installers.

## Layout

```
packages/app/             the desktop app (React + TypeScript; Tauri shell in src-tauri/)
  src/platform/           desktop (Tauri) and browser implementations of one Platform interface
  src/store/              projects, encrypted at rest (AES-256-GCM, key in the OS keychain)
  src/engine/             builds the books and outputs in a worker
  src/ui/                 Home, Inputs, Review, Outputs
  src-tauri/              native side: storage, keychain, file access limited to what the user picks or drops
packages/core/            pure TypeScript, no UI or Node dependencies
  src/input/              files, ZIPs, CSV tables
  src/readers/            one reader per input slot
    transactions-export.ts  Wave "Export all transactions as CSV" ZIP
    receipts-export.ts      Wave "Export all receipts as a ZIP file"
    wave-api/               read-only Wave API client: access key or OAuth → snapshot
  src/model/              merge, classify, open items, aging, tie-out checks → Books
  src/outputs/            output plug-ins (catalog.ts lists them)
    package/              universal package: tables (the spec), writer, reader, README
    reports/              statements, tie-out report and report pack, PDF renderer
    excel.ts, xlsx.ts     review workbook on a small built-in XLSX writer
    gl-csv.ts             generic general ledger CSV
    statements/           bank statement files (OFX/QFX/QBO, QuickBooks and Xero CSV)
  test/fixtures/          synthetic business (generator + committed ZIPs and API JSON)
  test/golden/            golden output files (update with `npx vitest run -u` after checking the diff)
```

## Develop

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

Run the app in a browser (development build; storage is not the OS keychain):

```bash
npm run dev -w @wave-exit/app
```

Run the desktop app (needs Rust; from `packages/app`):

```bash
npx tauri dev
```

"Try a sample business" on the home screen loads the invented Maple & Pine Design LLC,
so every screen can be seen without a Wave login.

After changing `packages/core/test/fixtures/synthetic.ts`, run `npm run fixtures` in
`packages/core` to regenerate the committed fixture files.

## Docs

- [`docs/converter-app-prompt.md`](docs/converter-app-prompt.md): the product brief and build order
- [`docs/wave-formats.md`](docs/wave-formats.md): the Data Export file formats, profiled from a real export
- [`docs/wave-api.md`](docs/wave-api.md): what the Wave public API offers, tested live
- [`docs/wave-api-schema.txt`](docs/wave-api-schema.txt): the full introspected schema
- [`docs/bank-statement-formats.md`](docs/bank-statement-formats.md): bank statement file formats, with sources

Real Wave data and access keys never go in this repo. Tests use synthetic fixtures only.
