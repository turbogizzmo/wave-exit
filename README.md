# Wave Exit

A desktop converter that takes a Wave Accounting business out of Wave: Wave API data
and Data Export ZIPs in, many outputs out (universal archive package, Excel, PDF report
pack, QuickBooks/Xero import files and direct load, Beancount/hledger).

Status: **build steps 1–2 done.** Wave facts are verified (step 1), and the input
readers and the merged, checked books model are built (step 2). There are no outputs
or screens yet.

## Layout

```
packages/core/            pure TypeScript, no UI or Node dependencies
  src/input/              files, ZIPs, CSV tables
  src/readers/            one reader per input slot
    transactions-export.ts  Wave "Export all transactions as CSV" ZIP
    receipts-export.ts      Wave "Export all receipts as a ZIP file"
    wave-api/               read-only Wave API client: access key or OAuth → snapshot
  src/model/              merge, classify, open items, aging, tie-out checks → Books
  test/fixtures/          synthetic business (generator + committed ZIPs and API JSON)
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

After changing `packages/core/test/fixtures/synthetic.ts`, run `npm run fixtures` in
`packages/core` to regenerate the committed fixture files.

## Docs

- [`docs/converter-app-prompt.md`](docs/converter-app-prompt.md): the product brief and build order
- [`docs/wave-formats.md`](docs/wave-formats.md): the Data Export file formats, profiled from a real export
- [`docs/wave-api.md`](docs/wave-api.md): what the Wave public API offers, tested live
- [`docs/wave-api-schema.txt`](docs/wave-api-schema.txt): the full introspected schema

Real Wave data and access keys never go in this repo. Tests use synthetic fixtures only.
