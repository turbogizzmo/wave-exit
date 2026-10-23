/**
 * How-to text for each input, using Wave's exact labels (Data Export page as seen in
 * a screenshot, Oct 2026; Wave's help articles "Download your account data" and
 * "Wave's Developer Portal", and the developer portal's "2 - Create an application" and
 * "3 - Authentication", read 2026-10-23). Plain words only: no technical terms.
 */

export const GUIDES = {
  transactions: {
    title: "How do I get the transactions export?",
    steps: [
      "Sign in to Wave at waveapps.com and choose the business at the top right.",
      "Click the business name, then Business settings.",
      "In the Settings menu, scroll down to Other and click Data Export.",
      "Under Accounting, click “Export all transactions as CSV”.",
      "Wave emails a download link to the Wave account's main email address. Click “Download data export” in the email and save the ZIP file.",
      "Drop the ZIP file here (or choose it with the button).",
    ],
    notes: [
      "The email link only works for 24 hours. If it has expired, export again.",
      "Only the owner or an Admin can export. Editors and Viewers can't, and Admin is a Pro-plan role.",
      "Choose “as CSV”, not “for Excel”: Wave Exit reads the CSV version.",
    ],
  },
  receipts: {
    title: "How do I get the receipts export?",
    steps: [
      "On the same Data Export page in Wave, under Receipts, click “Export all receipts as a ZIP file”.",
      "Open Wave's email, click “Download data export”, and save the ZIP file.",
      "Drop the ZIP file here.",
    ],
    notes: ["The email link only works for 24 hours.", "Without it, outputs have no receipt files attached."],
  },
  waveKey: {
    title: "How do I get a Wave access key?",
    steps: [
      "Click “Open Wave's key page” below. It opens Wave's Developer Portal (Manage applications) in your web browser; sign in with the Wave login that can see this business.",
      "Create an application. Any name will do, for example “Wave Exit”. If you've made one before, select it.",
      "Click Create token. Wave shows a long access key.",
      "Copy the key, come back here, paste it into the box and click Check key.",
    ],
    notes: [
      "The key opens everything that Wave login can see, so keep it private. Wave Exit stores it in this computer's keychain and only reads from Wave. Never send a key by email.",
      "When you've finished with this business, revoke the key on the same page in Wave.",
    ],
  },
} as const;

/** Wave's own "Manage applications" link (from its "2 - Create an application" page, 2026-07-10). */
export const WAVE_KEY_PAGE = "https://developer.waveapps.com/hc/en-us/articles/50869865197460-Manage-appliations";

/** What export-file-only mode loses, shown before the user proceeds (brief, "Export-file-only mode"). */
export const EXPORT_ONLY_LOSSES = [
  "Accounts that have never been used (Wave's export lists only accounts with activity).",
  "Wave's own account types. They're worked out from the export instead, which is usually right.",
  "Invoice line items, products and services, sales tax rates and estimates. Invoices are rebuilt from the ledger.",
  "Due dates, so invoices are aged from their invoice date.",
  "The check that each account's balance matches Wave (check 3 is skipped).",
];
