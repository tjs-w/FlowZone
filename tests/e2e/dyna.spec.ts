import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/dyna");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
});

test("renders the fixed executive catalog without external requests", async ({ page }) => {
  const externalRequests: string[] = [];
  const origin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:43117").origin;
  page.on("request", (request) => {
    if (!request.url().startsWith(origin)) externalRequests.push(request.url());
  });

  await expect(page.getByText("Review the release merge request")).toBeVisible();
  await expect(page.getByText("critical", { exact: true })).toBeVisible();
  await expect(page.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(page.getByText("Immediate next steps", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review in Codex" })).toBeVisible();
  await expect(page.getByText("Browser fixture schedule", { exact: true })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-dyna-advertised-display-modes",
    '["inline","fullscreen"]',
  );
  await expect(page.locator("html")).toHaveAttribute("data-platform", "mobile");
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--d-safe-top"),
    ),
  ).toBe("8px");
  expect(externalRequests).toEqual([]);
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--color-background-primary-solid",
      ),
    ),
  ).not.toBe("");
  await expect(page.locator("html")).not.toHaveAttribute("data-dyna-display-mode-request-count");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("adds an annotation and sends only an opaque Codex action request", async ({ page }) => {
  const addNote = page.getByRole("button", { name: "Add note" });
  await addNote.focus();
  await addNote.click();
  const note = page.getByPlaceholder("Example: Create a new Codex task to review this MR");
  await expect(page.getByRole("textbox", { name: "Note" })).toBeFocused();
  const modalAccessibility = await new AxeBuilder({ page }).analyze();
  expect(modalAccessibility.violations).toEqual([]);
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(addNote).toBeFocused();
  await addNote.click();
  await note.fill("Create a new Codex task to review this MR.");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(addNote).toBeFocused();
  await expect(
    page.locator(".dyna-note-list li").filter({ hasText: "Create a new Codex task" }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Review in Codex" }).click();
  await expect(page.getByRole("button", { name: "Review in Codex" })).toBeFocused();
  await expect.poll(() => page.locator("html").getAttribute("data-dyna-message-count")).toBe("1");
  const message = await page.locator("html").getAttribute("data-dyna-last-message");
  expect(message).toMatch(/Handle Dyna action request [0-9a-f-]{36} with \$flowzone:dyna\./);
  expect(message).not.toContain("release merge request");
  expect(message).not.toContain("Create a new Codex task");
});

test("clears cancelled notes and keeps rejected annotations editable", async ({ page }) => {
  const addNote = page.getByRole("button", { name: "Add note" });
  await addNote.click();
  const note = page.getByRole("textbox", { name: "Note" });
  await note.fill("Draft that should not leak");
  await page.getByRole("button", { name: "Cancel" }).click();
  await addNote.click();
  await expect(note).toHaveValue("");

  await page.goto("/dyna?tool-error=dyna_add_annotation");
  await page.getByRole("button", { name: "Add note" }).click();
  const rejected = page.getByRole("textbox", { name: "Note" });
  await rejected.fill("Keep this draft after a failed save");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(rejected).toHaveValue("Keep this draft after a failed save");
  await expect(page.getByRole("alert")).toContainText("Could not save the note");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Could not save the note");
  await expect(page.getByText("Note added.")).toHaveCount(0);
});

test("keeps rejected to-dos editable through a successful background refresh", async ({ page }) => {
  await page.goto("/dyna?tool-error=dyna_add_todo");
  await page.getByRole("button", { name: "Add to-do" }).click();
  const title = page.getByRole("textbox", { name: "To-do" });
  const context = page.getByRole("textbox", { name: "Context" });
  await title.fill("Keep this rejected to-do");
  await context.fill("The draft must survive a failed save.");
  await page.getByRole("dialog").getByRole("button", { name: "Add to-do" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not add the to-do");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Could not add the to-do");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(title).toHaveValue("Keep this rejected to-do");
  await expect(context).toHaveValue("The draft must survive a failed save.");
});

test("keeps failed reprioritization visible without mutating the item", async ({ page }) => {
  await page.goto("/dyna?many-items=1&tool-error=dyna_organize_item");
  const card = page
    .locator('.dyna-card[data-presentation="queue"]')
    .filter({ hasText: "Review the release merge request" });
  await card.getByRole("button", { name: "Lower" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not reorganize the item");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Could not reorganize the item");
  await expect(card.getByText("critical", { exact: true })).toBeVisible();
});

test("renders cross-tool signals and only promotes evidence-bearing leadership", async ({
  page,
}) => {
  await page.goto("/dyna?many-items=1");
  for (const source of ["GitHub", "Outlook", "Discord", "$twg"]) {
    await expect(page.getByText(source, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("Avery Chen", { exact: false })).toBeVisible();
  await expect(page.getByText("Morgan Lee", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Raised from normal by verified leadership context")).toHaveCount(1);
  await expect(page.getByText("Architecture council", { exact: false })).toBeVisible();
});

test("uses calm, legible light and dark host themes", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe("rgb(245, 247, 248)");

  await page.goto("/dyna?theme=dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe("rgb(14, 20, 23)");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("adds, searches, reprioritizes, and sequences queue items", async ({ page }) => {
  await page.goto("/dyna?many-items=1");
  const search = page.getByRole("searchbox", { name: "Search dashboard" });
  await search.fill("github avery");
  await expect(page.locator('.dyna-card[data-presentation="queue"]')).toHaveCount(1);
  await expect(page.locator('.dyna-visually-hidden[role="status"]')).toHaveText("1 matching item.");
  const filteredCriticalCard = page
    .locator('.dyna-card[data-presentation="queue"]')
    .filter({ hasText: "Review the release merge request" });
  await filteredCriticalCard.getByRole("button", { name: "Lower" }).click();
  await expect(filteredCriticalCard.getByText("high", { exact: true })).toBeVisible();
  await filteredCriticalCard.getByRole("button", { name: "Bump" }).click();
  await expect(filteredCriticalCard.getByText("critical", { exact: true })).toBeVisible();
  await search.fill("Additional priority 1");
  const filteredSequenceCard = page
    .locator('.dyna-card[data-presentation="queue"]')
    .filter({ hasText: "Additional priority 1" });
  await expect(filteredSequenceCard).toBeVisible();
  await filteredSequenceCard.getByRole("button", { name: "Later" }).click();
  await expect(filteredSequenceCard.getByRole("button", { name: "Later" })).toBeDisabled();
  await search.fill("definitely absent signal");
  await expect(page.getByText(/No dashboard items match/)).toBeVisible();
  await expect(page.locator('.dyna-visually-hidden[role="status"]')).toHaveText(
    "No matching items.",
  );
  await search.fill("");

  await page.getByRole("button", { name: "Add to-do" }).click();
  await page.getByRole("textbox", { name: "To-do" }).fill("Prepare staff meeting decisions");
  await page.getByRole("textbox", { name: "Context" }).fill("Collect the three open decisions.");
  await page.getByRole("combobox", { name: "Priority" }).selectOption("high");
  await page.getByRole("dialog").getByRole("button", { name: "Add to-do" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const manualCard = page
    .locator('.dyna-card[data-presentation="queue"]')
    .filter({ hasText: "Prepare staff meeting decisions" });
  await expect(manualCard).toBeVisible();
  await expect(manualCard.getByText("To-do", { exact: true })).toBeVisible();

  const criticalCard = page
    .locator('.dyna-card[data-presentation="queue"]')
    .filter({ hasText: "Review the release merge request" });
  await expect(criticalCard.getByRole("button", { name: "Bump" })).toBeDisabled();
  await criticalCard.getByRole("button", { name: "Lower" }).click();
  await expect(criticalCard.getByText("high", { exact: true })).toBeVisible();
  await expect(criticalCard.getByText("Manually moved from critical")).toBeVisible();

  const highSection = page
    .getByRole("heading", { name: "Needs your attention" })
    .locator("xpath=..");
  const before = await highSection.locator("h3").allTextContents();
  const firstCard = highSection.locator('.dyna-card[data-presentation="queue"]').first();
  await firstCard.getByRole("button", { name: "Later" }).click();
  await expect.poll(() => highSection.locator("h3").allTextContents()).not.toEqual(before);
});

test("projects the same items through the Codex progress pipeline and creates follow-ups", async ({
  page,
}) => {
  await page.goto("/dyna?pipeline=1");
  const queueTab = page.getByRole("tab", { name: "Priority queue" });
  await queueTab.focus();
  await queueTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Progress pipeline" })).toBeFocused();
  for (const column of [
    "To do",
    "Executing in Codex",
    "Paused for input",
    "Needs attention",
    "Completed",
  ]) {
    await expect(page.getByRole("heading", { name: column })).toBeVisible();
  }
  await expect(page.getByText("running · observed", { exact: false })).toBeVisible();
  await expect(page.getByText("waiting · observed", { exact: false })).toBeVisible();
  await expect(
    page
      .locator(".dyna-task-outcome")
      .getByText("Approved the release path and documented the remaining risk."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open task" })).toHaveCount(3);

  await page.getByRole("button", { name: "Create follow-up" }).click();
  const followupTitle = page.getByRole("textbox", { name: "To-do" });
  await expect(followupTitle).toHaveValue(/Follow up:/);
  await page.getByRole("dialog").getByRole("button", { name: "Add to-do" }).click();
  await expect(page.getByRole("tab", { name: "Priority queue" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText(/Follow up:/).first()).toBeVisible();
  await expect(page.getByText("Follow-up to completed work")).toBeVisible();
  await expect(
    page.locator('.dyna-card[data-presentation="queue"]:focus').filter({ hasText: /Follow up:/ }),
  ).toBeVisible();
});

test("reflows at 320 CSS pixels without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/dyna?pipeline=1&long-content=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  for (const button of await page.getByRole("button").all()) {
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("requests the expanded Codex work surface when the host supports it", async ({ page }) => {
  await page.getByRole("button", { name: "Expand dashboard" }).click();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "fullscreen");
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-dyna-display-mode-request-count", "1");
});

test("keeps the host-selected panel presentation after connection", async ({ page }) => {
  await page.goto("/dyna?display-mode-delay=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-dyna-display-mode-request-count");
});

test("keeps inline content visible when the host cannot expand", async ({ page }) => {
  await page.goto("/dyna?inline-only=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.getByText("Review the release merge request")).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeHidden();
  await expect(page.locator(".dyna-inline-more")).toHaveCount(0);
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.locator("html")).not.toHaveAttribute("data-dyna-display-mode-request-count");
});

test("keeps a complete manual fallback when an expanded presentation request fails", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/dyna?display-mode-error=1&many-items=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.locator(".dyna-card")).toHaveCount(4);
  await expect(page.locator(".dyna-inline-more")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand dashboard" }).click();
  await expect(page.locator(".dyna-toast")).toContainText(
    "complete current view remains available",
  );
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeFocused();
  expect(pageErrors).toEqual([]);
});

test("keeps a complete manual fallback when the host resolves expansion as inline", async ({
  page,
}) => {
  await page.goto("/dyna?display-mode-result=inline&many-items=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.locator(".dyna-card")).toHaveCount(4);
  const expand = page.getByRole("button", { name: "Expand dashboard" });
  await expand.click();
  await expect(page.locator(".dyna-toast")).toContainText(
    "complete current view remains available",
  );
  await expect(expand).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-dyna-display-mode-request-count", "1");
});

test("keeps authoritative server matches that fall outside the local search preview", async ({
  page,
}) => {
  await page.goto("/dyna?older-match=1");
  const search = page.getByRole("searchbox", { name: "Search dashboard" });
  await search.fill("buriedneedle");
  await expect(page.getByText("Review the release merge request")).toBeVisible();
  await expect(page.locator('.dyna-visually-hidden[role="status"]')).toHaveText("1 matching item.");
});

test("pauses mutations when snapshot connectivity is lost", async ({ page }) => {
  await page.goto("/dyna?tool-error=dyna_get_snapshot");
  await page.getByRole("searchbox", { name: "Search dashboard" }).fill("github");
  await expect(page.getByRole("alert")).toContainText("Dashboard updates are disconnected");
  await expect(page.getByRole("button", { name: "Add to-do" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review in Codex" })).toBeDisabled();
});

test("retries an uncertain delivery with the same idempotent request", async ({ page }) => {
  await page.goto("/dyna?action-error=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await page.getByRole("button", { name: "Review in Codex" }).click();
  await expect(page.getByRole("alert")).toContainText("delivery is uncertain");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("delivery is uncertain");
  const messages = await page.evaluate(() => {
    const host = (window as typeof window & { __dynaHost?: { messages?: unknown[] } }).__dynaHost;
    return host?.messages?.map((message) => JSON.stringify(message)) ?? [];
  });
  expect(messages).toHaveLength(2);
  expect(messages[0]).toBe(messages[1]);
});
