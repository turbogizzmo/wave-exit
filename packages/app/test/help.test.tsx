import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { helpHtml } from "../scripts/build-help.ts";
import { ALL_TOPICS } from "../src/help/content.ts";
import { renderApp, testPlatform } from "./helpers.tsx";

afterEach(cleanup);

describe("help", () => {
  it("opens from the top bar, shows a topic, and closes", async () => {
    const user = userEvent.setup();
    renderApp(testPlatform());
    await user.click(await screen.findByRole("button", { name: "Help" }));
    const dialog = await screen.findByRole("dialog", { name: "Help" });
    await user.click(screen.getByRole("button", { name: /Getting the transactions export/ }));
    expect(dialog.textContent).toContain("Export all transactions as CSV");
    await user.click(screen.getByRole("button", { name: /All help/ }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
  });

  it("every topic has content, and help avoids technical words", () => {
    const banned = /\b(API|JSON|GraphQL|schema|parse|endpoint|null|token)\b/;
    for (const t of ALL_TOPICS) {
      expect(t.blocks.length, t.id).toBeGreaterThan(0);
      // "Create token" is Wave's own button label, quoted so users can find it.
      expect(JSON.stringify(t).replaceAll("Create token", ""), t.id).not.toMatch(banned);
    }
  });

  it("the website's help page is current (run `npm run help -w @wave-exit/app` after editing help)", () => {
    expect(readFileSync(join(import.meta.dirname, "../../../site/help.html"), "utf8")).toBe(helpHtml());
  });
});
