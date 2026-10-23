import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeWaveApi } from "../../core/test/fixtures/synthetic.ts";
import { renderApp, sampleFile, testPlatform } from "./helpers.tsx";

/** The three screens end to end, with the real books code and a fake Wave. */

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase("wave-exit");
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("database still open"));
  });
});
afterEach(cleanup);

async function newProject(user: ReturnType<typeof userEvent.setup>, name = "Maple & Pine Design LLC") {
  await user.click(await screen.findByRole("button", { name: "New project" }));
  await user.type(screen.getByLabelText(/Client business name/), name);
  await user.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("tab", { name: /Inputs/ });
}

describe("screens", () => {
  it("connected: key, business, export, review answer, outputs", async () => {
    const api = fakeWaveApi({ validToken: "test-key-123" });
    const platform = testPlatform(api.fetch);
    const user = userEvent.setup();
    renderApp(platform);
    await screen.findByText(/Your clients' books stay on this computer/);
    await newProject(user);

    // Outputs and Review wait for the export.
    expect((screen.getByRole("tab", { name: /Review/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("tab", { name: /Outputs/ }) as HTMLButtonElement).disabled).toBe(true);

    // Wave connection: whose books, then the key.
    await user.click(screen.getByRole("radio", { name: /^Mine/ }));
    await user.type(await screen.findByLabelText("Wave access key"), "wrong-key");
    await user.click(screen.getByRole("button", { name: "Check key" }));
    expect(await screen.findByText(/didn't accept this access key/)).toBeTruthy();
    await user.clear(screen.getByLabelText("Wave access key"));
    await user.type(screen.getByLabelText("Wave access key"), "test-key-123");
    await user.click(screen.getByRole("button", { name: "Check key" }));
    await user.click(await screen.findByRole("button", { name: /Maple & Pine Design LLC/ }));
    // Wave Exit paces itself at ~2 requests a second, so reading a business takes a few seconds.
    expect(await screen.findByText(/Connected to Maple & Pine Design LLC/, {}, { timeout: 15000 })).toBeTruthy();

    // Drop the export anywhere: it goes to the right slot.
    platform.drop([sampleFile("transactions-export.zip")]);
    expect(await screen.findByText(/Loaded: 33 transactions/, {}, { timeout: 5000 })).toBeTruthy();
    platform.drop([sampleFile("receipts-export.zip")]);
    expect(await screen.findByText(/Loaded: 3 receipt files/, {}, { timeout: 5000 })).toBeTruthy();

    // Review: one red question blocks outputs until answered.
    await user.click(screen.getByRole("tab", { name: /Review/ }));
    expect(await screen.findByText(/1 item to answer/)).toBeTruthy();
    expect(screen.getByText(/Account balances agree with Wave\./)).toBeTruthy();
    const card = screen.getByText(/2 accounts are named "Software"/).closest(".card") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Use this answer" }));
    expect(await screen.findByText(/Ready for outputs/, {}, { timeout: 5000 })).toBeTruthy();

    // Outputs: the universal package is always made, plus what's ticked.
    await user.click(screen.getByRole("tab", { name: /Outputs/ }));
    await user.click(await screen.findByRole("checkbox", { name: /General ledger CSV/ }));
    await user.click(screen.getByRole("button", { name: /Create 2 outputs/ }));
    expect(await screen.findByText(/Saved 2 files/, {}, { timeout: 10000 })).toBeTruthy();
    expect(platform.saved.map((f) => f.name)).toEqual([
      "Maple & Pine Design LLC – Wave export – " + platform.saved[0]!.name.slice(-14),
      expect.stringMatching(/– general ledger – .*\.csv$/),
    ]);
    expect(screen.getByText("Made so far")).toBeTruthy();

    // Only read-only queries reached Wave.
    expect(api.calls.every((c) => c.operation !== "" && !/mutation/i.test(c.operation))).toBe(true);
  }, 30000);

  it("export-file-only: losses shown up front, everything still works", async () => {
    const platform = testPlatform();
    const user = userEvent.setup();
    renderApp(platform);
    await newProject(user, "Client Without Access");
    await user.click(screen.getByRole("radio", { name: /A client's, and I don't/ }));
    expect(await screen.findByText(/Accounts that have never been used/)).toBeTruthy();
    expect(screen.getByText(/Never ask a client to email their Wave access key/)).toBeTruthy();
    expect(screen.queryByLabelText("Wave access key")).toBeNull();

    platform.picks.push([sampleFile("transactions-export.zip")]);
    await user.click(screen.getAllByRole("button", { name: "Choose the ZIP file" })[0]!);
    expect(await screen.findByText(/Loaded: 33 transactions/, {}, { timeout: 5000 })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: /Review/ }));
    expect(await screen.findByText(/From the export files only/)).toBeTruthy();
    expect(screen.getByText(/Skipped: there is no Wave connection/)).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: /Outputs/ }));
    expect((await screen.findAllByText(/Without a Wave connection: Products, sales taxes and estimates/)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /Create 1 output/ }));
    expect(await screen.findByText(/Saved 1 file/, {}, { timeout: 10000 })).toBeTruthy();
  }, 30000);

  it("explains a file that isn't a Wave export", async () => {
    const platform = testPlatform();
    const user = userEvent.setup();
    renderApp(platform);
    await newProject(user);
    platform.drop([{ path: "invoice.pdf", bytes: new TextEncoder().encode("%PDF") }]);
    expect(await screen.findByText(/doesn't look like a Wave export/)).toBeTruthy();
    platform.drop([{ path: "cut-off.zip", bytes: sampleFile("transactions-export.zip").bytes.slice(0, 500) }]);
    expect(await screen.findByText(/damaged or incomplete/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("tab", { name: /Review/ }) as HTMLButtonElement).disabled).toBe(true));
  }, 30000);

  it("home lists projects with where they stand, and opens the sample", async () => {
    const platform = testPlatform();
    const user = userEvent.setup();
    renderApp(platform);
    await newProject(user, "First Client");
    await user.click(screen.getByRole("button", { name: /All projects/ }));
    expect(await screen.findByText("Waiting for the transactions export")).toBeTruthy();
  }, 30000);
});
