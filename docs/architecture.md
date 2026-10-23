# Architecture

Three layers, each plain TypeScript with no UI dependencies, plus the app around them.

```
 inputs                        model                         outputs
 ───────────────────────       ───────────────────────       ───────────────────────────
 transactions export (ZIP) ─┐                                ┌─ universal package (+ reader)
 receipts export (ZIP)     ─┼─▶  buildBooks(): merge,     ───┼─ PDF report pack
 Wave API snapshot         ─┘    classify, open items,       ├─ Excel workbook
                                 aging, receipts, checks      ├─ general ledger CSV
                                                              └─ bank statement files
```

## packages/core

| Folder | What it does |
|---|---|
| `src/input/` | Files, ZIPs (fflate) and CSV tables (csv-parse). Columns are addressed by header name, never by position. |
| `src/readers/` | One reader per input. `transactions-export.ts` and `receipts-export.ts` read Wave's Data Export files. `wave-api/` is a read-only GraphQL client (it refuses mutations, paces itself and retries) that turns Wave's API into a JSON snapshot. Both a Full Access key and OAuth work through `WaveCredentials`. |
| `src/model/` | `buildBooks()` makes the merged `Books`: the chart (identical Wave system accounts merged; ambiguous duplicates become Review questions), contacts, entries, classification (`rules.ts`, a data table), transfer pairing, invoices and bills with payments linked, aging, receipt links, tie-out checks and the opening-balances ledger. Pure and deterministic: the same inputs and answers always give the same books. |
| `src/outputs/` | Output plug-ins. Each implements `OutputPlugin`: `describe()` says what it keeps and loses, `validate()` raises Review cards, `produce()` makes files. `catalog.ts` lists them and refuses to run while Review has red items. |

Money is a `bigint` count of minor units; there is no floating point in the ledger.

Rules the tests enforce:
- Readers never import the model, and the model imports readers only for their types.
- Neither imports outputs.
- Nothing in `packages/core` depends on Node, a UI or the file system.

### Tests

- A synthetic business (`test/fixtures/synthetic.ts`) covers every awkward case. It is
  committed as Wave-format ZIPs plus a fake Wave API that behaves like the real one.
- Golden files cover every file output.
- Each output's keeps/loses claims are checked against what it actually produces.
- Property tests: random ledgers keep every line and cent, and package → books → package is
  byte-identical.
- The OFX files were also validated with an independent parser.

## packages/app

| Folder | What it does |
|---|---|
| `src/platform/` | One `Platform` interface: storage, keychain, file pickers, drag and drop, saving outputs, Wave requests. `tauri.ts` is the desktop build; `web.ts` is a browser build for development and tests. |
| `src/store/` | Projects encrypted at rest (AES-256-GCM via WebCrypto). The storage key is in the keychain. Inputs are kept exactly as given; the books are rebuilt from them whenever a project opens, so nothing derived goes stale. |
| `src/engine/` | Building the books and making outputs runs in a Web Worker (`handler.ts`), so the window stays responsive. Tests run the same handler in-process. |
| `src/ui/` | Home, Inputs (with the Wave connection), Review and Outputs. |
| `src-tauri/` | The native side (Rust, Tauri 2): private storage, OS keychain (`keyring`), and file access limited to paths the user picked or dropped. Capabilities limit the window to Wave's API and help pages. |

## Adding an output

1. Write a module in `packages/core/src/outputs/` that implements `OutputPlugin`.
2. Add it to `OUTPUTS` in `catalog.ts`.
3. Add golden-file tests and a keeps/loses check.

The Outputs screen picks it up from the catalog.
