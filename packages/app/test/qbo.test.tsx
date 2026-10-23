import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { qbo, type Fetch } from "@wave-exit/core";
import { fakeQbo } from "../../core/test/fixtures/fake-qbo.ts";
import { renderApp, sampleFile, testPlatform } from "./helpers.tsx";

/** The QuickBooks load screens end to end: the real load code against an in-memory QuickBooks. */

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase("wave-exit");
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
});
afterEach(cleanup);

function qboPlatform() {
  const fake = fakeQbo();
  const base = testPlatform();
  const tokenCalls: string[] = [];
  const fetch = (async (url: string, init: Parameters<Fetch>[1]) => {
    if (url === qbo.INTUIT_TOKEN_URL) {
      tokenCalls.push(String(init.body));
      const body = JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: 8640000, token_type: "bearer" });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
    }
    const r = await fake.fetch(url, init);
    return { ...r, ok: r.status < 400 };
  }) as unknown as Fetch;
  const platform = {
    ...base,
    qbo: {
      available: true, fetch, redirectUri: "http://localhost:53682/callback",
      // Intuit's page, approved: reply with the same state and the sandbox company.
      signIn: async (authorizeUrl: string) => `http://localhost:53682/callback?code=c1&state=${new URL(authorizeUrl).searchParams.get("state")}&realmId=9130000000000001`,
    },
  };
  // CompanyInfo isn't part of the fake's routes: answer it here.
  const withInfo = (async (url: string, init: Parameters<Fetch>[1]) =>
    /\/companyinfo\//.test(url) ? { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ CompanyInfo: { CompanyName: "Sandbox Company_US_1" } }) } : fetch(url, init)) as unknown as Fetch;
  platform.qbo.fetch = withInfo;
  return { platform, fake, tokenCalls };
}

/** A new export-file-only project with the sample export loaded, opened at the QuickBooks load screen. */
async function exportOnlyProject(user: ReturnType<typeof userEvent.setup>, platform: ReturnType<typeof testPlatform>, name: string) {
  await user.click(await screen.findByRole("button", { name: "New project" }));
  await user.type(screen.getByLabelText(/Client business name/), name);
  await user.click(screen.getByRole("button", { name: "Create project" }));
  await user.click(await screen.findByRole("radio", { name: /A client's, and I don't/ }));
  platform.picks.push([sampleFile("transactions-export.zip")]);
  await user.click(screen.getAllByRole("button", { name: "Choose the ZIP file" })[0]!);
  expect(await screen.findByText(/Loaded: 33 transactions/, {}, { timeout: 5000 })).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: /Outputs/ }));
  await user.click(await screen.findByRole("button", { name: "Set up loading into QuickBooks" }));
}

describe("loading into QuickBooks Online", () => {
  it("connects, previews, loads, checks and undoes", async () => {
    const { platform, fake, tokenCalls } = qboPlatform();
    const user = userEvent.setup();
    renderApp(platform);
    await exportOnlyProject(user, platform, "Sample Client");

    // One-time setup: the user's own Intuit developer keys (test values here).
    await user.type(await screen.findByLabelText("Client ID"), "test-client-id");
    await user.type(screen.getByLabelText("Client Secret"), "test-client-secret");
    await user.click(screen.getByRole("button", { name: /Save in this computer's keychain/ }));
    await user.click(await screen.findByRole("button", { name: "Connect to QuickBooks" }));
    expect(await screen.findByText(/Connected to Sandbox Company_US_1/, {}, { timeout: 5000 })).toBeTruthy();
    expect(tokenCalls[0]).toContain("grant_type=authorization_code");
    expect(await screen.findByText(/The company has no transactions yet/, {}, { timeout: 5000 })).toBeTruthy();

    // Mapping and preview.
    expect(screen.getByRole("combobox", { name: /QuickBooks account for Business Checking/ })).toBeTruthy();
    expect(screen.getByText(/adds up to the books, account by account/)).toBeTruthy();
    expect(screen.getByText(/won't email them/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Load into Sandbox Company_US_1/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/sandbox \(test\) company/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Load now" }));
    expect(await screen.findByText(/trial balance and aging at .* match the converted books/, {}, { timeout: 15000 })).toBeTruthy();
    expect(screen.getByText("Loaded")).toBeTruthy();
    expect(fake.count("Invoice")).toBe(5);

    // Undo, with a confirmation naming the company and the count.
    await user.click(screen.getByRole("button", { name: "Remove everything Wave Exit loaded" }));
    const undo = await screen.findByRole("dialog");
    expect(within(undo).getAllByText(/Sandbox Company_US_1/).length).toBeGreaterThan(0);
    await user.click(within(undo).getByRole("button", { name: /^Remove \d+ records$/ }));
    expect(await screen.findByText("Removed", {}, { timeout: 15000 })).toBeTruthy();
    for (const t of ["Invoice", "Payment", "Purchase", "Deposit", "JournalEntry", "Transfer"]) expect(fake.count(t), t).toBe(0);
  }, 60000);

  it("explains that the browser build can't load", async () => {
    const platform = testPlatform();
    const user = userEvent.setup();
    renderApp(platform);
    await exportOnlyProject(user, platform, "Browser Client");
    expect(await screen.findByText(/works in the desktop app/)).toBeTruthy();
  }, 30000);
});
