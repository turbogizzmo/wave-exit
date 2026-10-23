# Wave Exit

A desktop converter that takes a Wave Accounting business out of Wave: Wave API data
and Data Export ZIPs in, many outputs out (universal archive package, Excel, PDF report
pack, QuickBooks/Xero import files and direct load, Beancount/hledger).

Status: **build step 1 done** (Wave schema introspected, provider facts checked). No app
code yet.

- [`docs/converter-app-prompt.md`](docs/converter-app-prompt.md): the product brief and build order
- [`docs/wave-formats.md`](docs/wave-formats.md): the Data Export file formats, profiled from a real export
- [`docs/wave-api.md`](docs/wave-api.md): what the Wave public API offers, tested live
- [`docs/wave-api-schema.txt`](docs/wave-api-schema.txt): the full introspected schema

Real Wave data and access keys never go in this repo. Tests use synthetic fixtures only.
