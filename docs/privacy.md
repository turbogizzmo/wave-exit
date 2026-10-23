# Privacy and security

Wave Exit handles other people's financial records, so it is built to keep them on the
accountant's computer.

## Where data goes

| Data | Where it goes |
|---|---|
| Wave's export files and the books built from them | Stay on your computer, in the app's private folder, encrypted. |
| Reads from Wave | Wave's API server only (`gql.waveapps.com`). Wave Exit only reads: it never sends changes to Wave. |
| Outputs | Only into the folder you choose. Existing files are never overwritten. |
| Anything else | Nowhere. There is no Wave Exit server, no analytics and no upload. |

Later outputs that load books into QuickBooks Online or Xero will also talk to the system you
choose, after a preview you confirm.

## How it is stored

- **Projects are encrypted at rest** with AES-256-GCM (the browser engine's standard
  cryptography, not home-made code). Every file has its own random nonce.
- **The encryption key and each Wave access key are kept in the operating system's keychain.**
  Each project has its own Wave key; deleting a project removes it.
- **Deleting a project** removes its files and its stored key from the computer. Outputs you
  saved elsewhere are yours to keep or delete.

## What the app is allowed to do

The desktop app's native side is deliberately narrow:
- It reads only files you picked in its open dialog or dropped on its window.
- It writes outputs only into a folder you picked in its save dialog.
- Its window may contact only Wave's API server, and open only Wave's help pages.

## Wave access keys

A Wave access key opens everything the Wave login can see, read and write. Wave Exit only reads
with it, but please:
- create the key yourself, in Wave's Developer Portal;
- never send a key by email or ask a client to send theirs;
- revoke the key in Wave when you've finished with a business.

## Reporting a problem

If you find a security problem, please report it privately to the maintainers through
GitHub's "Report a vulnerability" (Security tab) rather than in a public issue.
