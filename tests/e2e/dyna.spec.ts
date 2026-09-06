import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openDetails(page: Page, title: string): Promise<void> {
  await page
    .getByRole("button", { name: `Open details for ${title}` })
    .first()
    .click();
  const inspector = page.locator(".dyna-inspector");
  const wide = (page.viewportSize()?.width ?? 0) >= 980;
  await expect(inspector.getByRole("heading", { name: title, level: 2 })).toBeVisible();
  await expect(inspector).toHaveAttribute("role", wide ? "region" : "dialog");
  await expect(
    page.getByRole("button", {
      name: wide ? "Close details" : "Back to attention queue",
    }),
  ).toBeFocused();
}

async function openOrganizationMenu(page: Page, title: string): Promise<void> {
  await page
    .locator(`.dyna-more-trigger[aria-label="Manage priority and order for ${title}"]`)
    .click();
}

async function openContextDetails(page: Page): Promise<void> {
  await page.locator(".dyna-context-details > summary").click();
}

async function closeDetails(page: Page): Promise<void> {
  const close = page.getByRole("button", { name: "Close details" });
  const back = page.getByRole("button", { name: "Back to attention queue" });
  if (await close.isVisible()) await close.click();
  else await back.click();
  await expect(page.locator(".dyna-inspector-layer")).toBeHidden();
}

async function openFullDashboard(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open full dashboard" }).click();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "fullscreen");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/dyna");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
});

test("renders a bounded inline executive brief and expands into the full workspace", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  const origin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:43117").origin;
  page.on("request", (request) => {
    if (!request.url().startsWith(origin)) externalRequests.push(request.url());
  });
  await page.goto("/dyna?many-items=1");

  await expect(page.getByText("Review the release merge request")).toBeVisible();
  await expect(page.getByText("critical", { exact: true })).toBeVisible();
  await expect(page.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(page.locator(".dyna-card").first().locator(".dyna-row-time")).toContainText("Due");
  await expect(page.getByRole("region", { name: "Top attention" })).toBeVisible();
  await expect(page.locator('.dyna-card[data-presentation="queue"]')).toHaveCount(3);
  await expect(page.getByText("1 more in the full dashboard")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Priority queue" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Progress pipeline" })).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search dashboard" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New to-do" })).toBeVisible();
  for (const card of await page.locator(".dyna-card").all()) {
    await expect(card.getByRole("button")).toHaveCount(1);
  }
  await expect(
    page.getByText("Confirm the risk posture and either approve the release or name the blocker."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open full dashboard" })).toBeVisible();
  await expect(page.getByText("Immediate next steps", { exact: true })).toBeHidden();
  await openDetails(page, "Review the release merge request");
  await expect(page.getByText("Immediate next steps", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open source" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review in Codex" })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "fullscreen");
  await expect(page.locator(".dyna-inspector")).toBeVisible();
  await expect(page.locator('.dyna-card[data-presentation="queue"]')).toHaveCount(4);
  await expect(page.locator("#dyna-tab-queue")).toBeVisible();
  await expect(page.locator("#dyna-tab-pipeline")).toBeVisible();
  await expect(page.locator('input[aria-label="Search dashboard"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Open full dashboard" })).toBeHidden();
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
  await expect(page.locator("html")).toHaveAttribute("data-dyna-display-mode-request-count", "1");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("adds an annotation and sends only an opaque Codex action request", async ({ page }) => {
  await openDetails(page, "Review the release merge request");
  const addNote = page.getByRole("button", { name: "Add note" });
  await addNote.focus();
  await addNote.click();
  const annotationDialog = page.getByRole("dialog", { name: "Add an executive note" });
  await expect(page.locator(".dyna-inspector")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".dyna-inspector")).toHaveAttribute("inert", "");
  const note = page.getByPlaceholder("Example: Create a new Codex task to review this MR");
  await expect(annotationDialog.getByRole("textbox", { name: "Note" })).toBeFocused();
  const modalAccessibility = await new AxeBuilder({ page }).analyze();
  expect(modalAccessibility.violations).toEqual([]);
  await page.keyboard.press("Shift+Tab");
  await expect(annotationDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(addNote).toBeFocused();
  await expect(page.locator(".dyna-inspector")).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".dyna-inspector")).not.toHaveAttribute("inert", "");
  await addNote.click();
  await note.fill("Create a new Codex task to review this MR.");
  await annotationDialog.getByRole("button", { name: "Save note" }).click();
  await expect(annotationDialog).toBeHidden();
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

test("opens originating records through the opaque action protocol", async ({ page }) => {
  await openDetails(page, "Review the release merge request");
  await page.getByRole("button", { name: "Open source" }).click();
  await expect.poll(() => page.locator("html").getAttribute("data-dyna-message-count")).toBe("1");
  const message = await page.locator("html").getAttribute("data-dyna-last-message");
  expect(message).toMatch(/Handle Dyna action request [0-9a-f-]{36} with \$flowzone:dyna\./);
  expect(message).not.toContain("team/project");
  expect(message).not.toContain("Review the release merge request");
  const prepared = await page.evaluate(() => {
    const host = (
      window as typeof window & {
        __dynaHost?: { toolCalls?: { name?: string; arguments?: Record<string, unknown> }[] };
      }
    ).__dynaHost;
    return host?.toolCalls?.find((call) => call.name === "dyna_prepare_action")?.arguments;
  });
  expect(prepared?.["kind"]).toBe("open_source");
});

test("keeps detail content top-aligned in tall Codex panels", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 1_400 });
  await page.goto("/dyna?many-items=1");
  await openDetails(page, "Review the release merge request");
  const layout = await page.evaluate(() => {
    const attention = document.querySelector<HTMLElement>(".dyna-attention");
    const people = document.querySelector<HTMLElement>(".dyna-people");
    const next = document.querySelector<HTMLElement>(".dyna-next");
    return {
      attentionTop: attention?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
      peopleTop: people?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
      nextTop: next?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
    };
  });
  expect(layout.attentionTop).toBeLessThan(180);
  expect(layout.peopleTop).toBeLessThan(340);
  expect(layout.nextTop).toBeLessThan(500);
});

test("clears cancelled notes and keeps rejected annotations editable", async ({ page }) => {
  await openDetails(page, "Review the release merge request");
  const addNote = page.getByRole("button", { name: "Add note" });
  await addNote.click();
  const note = page.getByRole("textbox", { name: "Note" });
  await note.fill("Draft that should not leak");
  await page.getByRole("button", { name: "Cancel" }).click();
  await addNote.click();
  await expect(note).toHaveValue("");

  await page.goto("/dyna?tool-error=dyna_add_annotation");
  await openDetails(page, "Review the release merge request");
  await page.getByRole("button", { name: "Add note" }).click();
  const rejected = page.getByRole("textbox", { name: "Note" });
  await rejected.fill("Keep this draft after a failed save");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByRole("dialog", { name: "Add an executive note" })).toBeVisible();
  await expect(rejected).toHaveValue("Keep this draft after a failed save");
  await expect(page.getByRole("alert")).toContainText("Could not save the note");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Could not save the note");
  await expect(page.getByText("Note added.")).toHaveCount(0);
});

test("keeps rejected to-dos editable through a successful background refresh", async ({ page }) => {
  await page.goto("/dyna?tool-error=dyna_add_todo");
  await page.getByRole("button", { name: "New to-do" }).click();
  const todoDialog = page.getByRole("dialog", { name: "Add to the priority queue" });
  const title = page.getByRole("textbox", { name: "To-do" });
  const context = page.getByRole("textbox", { name: "Context" });
  await title.fill("Keep this rejected to-do");
  await context.fill("The draft must survive a failed save.");
  await todoDialog.getByRole("button", { name: "Add to-do" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not add the to-do");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Could not add the to-do");
  await expect(todoDialog).toBeVisible();
  await expect(title).toHaveValue("Keep this rejected to-do");
  await expect(context).toHaveValue("The draft must survive a failed save.");
});

test("keeps failed reprioritization visible without mutating the item", async ({ page }) => {
  await page.goto("/dyna?many-items=1&tool-error=dyna_organize_item");
  await openDetails(page, "Review the release merge request");
  await openOrganizationMenu(page, "Review the release merge request");
  await page.getByRole("button", { name: "Lower priority" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not reorganize the item");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Could not reorganize the item");
  await expect(page.locator(".dyna-inspector-eyebrow").getByText("critical")).toBeVisible();
});

test("renders cross-tool signals and only promotes evidence-bearing leadership", async ({
  page,
}) => {
  await page.goto("/dyna?many-items=1");
  await openFullDashboard(page);
  const queue = page.getByRole("tabpanel", { name: "Priority queue" });
  for (const source of ["GitHub", "Outlook", "Discord", "$twg"]) {
    await expect(queue.getByText(source, { exact: true })).toBeVisible();
  }
  await expect(queue.getByText("Avery Chen", { exact: false })).toBeVisible();
  await expect(queue.getByText("Morgan Lee", { exact: false }).first()).toBeVisible();
  await openDetails(page, "Additional priority 1");
  await openContextDetails(page);
  await expect(page.getByText("Raised from normal by verified leadership context")).toHaveCount(1);
  await closeDetails(page);
  await expect(queue.getByText("Architecture council", { exact: false })).toBeVisible();
});

test("uses calm, legible light and dark host themes", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightBackground = await page
    .locator("body")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(lightBackground).not.toBe("");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");

  await page.goto("/dyna?theme=dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBackground = await page
    .locator("body")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(darkBackground).not.toBe(lightBackground);
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("adds, searches, reprioritizes, and sequences queue items", async ({ page }) => {
  await page.goto("/dyna?many-items=1");
  await openFullDashboard(page);
  const search = page.getByRole("searchbox", { name: "Search dashboard" });
  await search.fill("github avery");
  await expect(page.locator('.dyna-card[data-presentation="queue"]')).toHaveCount(1);
  await expect(page.locator('.dyna-visually-hidden[role="status"]')).toHaveText("1 matching item.");
  await openDetails(page, "Review the release merge request");
  await openOrganizationMenu(page, "Review the release merge request");
  await page.getByRole("button", { name: "Lower priority" }).click();
  await expect(page.locator(".dyna-inspector-eyebrow").getByText("high")).toBeVisible();
  await openOrganizationMenu(page, "Review the release merge request");
  await page.getByRole("button", { name: "Raise priority" }).click();
  await expect(page.locator(".dyna-inspector-eyebrow").getByText("critical")).toBeVisible();
  await closeDetails(page);

  await search.fill("Additional priority 1");
  await openDetails(page, "Additional priority 1");
  await openOrganizationMenu(page, "Additional priority 1");
  await page.getByRole("button", { name: "Move later in group" }).click();
  await openOrganizationMenu(page, "Additional priority 1");
  await expect(page.getByRole("button", { name: "Move later in group" })).toBeDisabled();
  await closeDetails(page);

  await search.fill("definitely absent signal");
  await expect(page.getByText("Nothing matched")).toBeVisible();
  await expect(page.locator('.dyna-visually-hidden[role="status"]')).toHaveText(
    "No matching items.",
  );
  await search.fill("");

  await page.getByRole("button", { name: "Add to-do" }).click();
  const todoDialog = page.getByRole("dialog", { name: "Add to the priority queue" });
  await page.getByRole("textbox", { name: "To-do" }).fill("Prepare staff meeting decisions");
  await page.getByRole("textbox", { name: "Context" }).fill("Collect the three open decisions.");
  await page.getByRole("combobox", { name: "Priority" }).selectOption("high");
  await todoDialog.getByRole("button", { name: "Add to-do" }).click();
  await expect(todoDialog).toBeHidden();
  const manualCard = page
    .locator('.dyna-card[data-presentation="queue"]')
    .filter({ hasText: "Prepare staff meeting decisions" });
  await expect(manualCard).toBeVisible();
  await openDetails(page, "Prepare staff meeting decisions");
  await expect(page.locator(".dyna-inspector-eyebrow").getByText("Todo")).toBeVisible();
  await closeDetails(page);

  await openDetails(page, "Review the release merge request");
  await openOrganizationMenu(page, "Review the release merge request");
  await expect(page.getByRole("button", { name: "Raise priority" })).toBeDisabled();
  await page.getByRole("button", { name: "Lower priority" }).click();
  await expect(page.locator(".dyna-inspector-eyebrow").getByText("high")).toBeVisible();
  await openContextDetails(page);
  await expect(page.getByText("Manually moved from critical")).toBeVisible();
  await closeDetails(page);

  const highSection = page
    .getByRole("heading", { name: "Needs your attention" })
    .locator("xpath=../..");
  const before = await highSection.locator(".dyna-row-title").allTextContents();
  const firstCard = highSection.locator('.dyna-card[data-presentation="queue"]').first();
  const firstTitle = (await firstCard.locator(".dyna-row-title").textContent()) ?? "";
  await firstCard
    .getByRole("button", { name: `Open details for ${firstTitle}` })
    .first()
    .click();
  await openOrganizationMenu(page, firstTitle);
  await page.getByRole("button", { name: "Move later in group" }).click();
  await closeDetails(page);
  await expect
    .poll(() => highSection.locator(".dyna-row-title").allTextContents())
    .not.toEqual(before);
});

test("projects the same items through the Codex progress pipeline and creates follow-ups", async ({
  page,
}) => {
  await page.goto("/dyna?pipeline=1");
  await openFullDashboard(page);
  const queueTab = page.getByRole("tab", { name: "Priority queue" });
  await queueTab.focus();
  await queueTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Progress pipeline" })).toBeFocused();
  for (const stage of [
    /To do: 1/,
    /Executing in Codex: 1/,
    /Paused for input: 1/,
    /Needs attention: 0/,
    /Completed: 1/,
  ])
    await expect(page.getByRole("tab", { name: stage })).toBeVisible();

  await page.getByRole("tab", { name: /Executing in Codex: 1/ }).click();
  await openDetails(page, "Additional priority 1");
  const executing = page.locator(".dyna-inspector");
  await expect(executing).toBeVisible();
  await expect(executing.getByText("Running", { exact: true })).toBeVisible();
  await expect(executing.getByText(/^Observed /)).toBeVisible();
  await expect(executing.getByRole("button", { name: "Open task" })).toBeVisible();

  await closeDetails(page);
  await page.getByRole("tab", { name: /Paused for input: 1/ }).click();
  await openDetails(page, "Additional priority 3");
  const paused = page.locator(".dyna-inspector");
  await expect(paused).toBeVisible();
  await expect(paused.getByText("Waiting", { exact: true })).toBeVisible();
  await expect(paused.getByText(/^Observed /)).toBeVisible();

  await closeDetails(page);
  await page.getByRole("tab", { name: /Completed: 1/ }).click();
  await openDetails(page, "Additional priority 2");
  const completed = page.locator(".dyna-inspector");
  await expect(
    completed.getByRole("heading", { name: "Additional priority 2", level: 2 }),
  ).toBeVisible();
  await expect(
    completed
      .locator(".dyna-task-outcome")
      .getByText("Approved the release path and documented the remaining risk."),
  ).toBeVisible();
  await expect(completed.getByRole("button", { name: "Open task" })).toBeVisible();

  await page.getByRole("button", { name: "Create follow-up" }).click();
  const followupDialog = page.getByRole("dialog", { name: "Add to the priority queue" });
  const followupTitle = page.getByRole("textbox", { name: "To-do" });
  await expect(followupTitle).toHaveValue(/Follow up:/);
  await followupDialog.getByRole("button", { name: "Add to-do" }).click();
  await expect(page.getByRole("tab", { name: "Priority queue" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText(/Follow up:/).first()).toBeVisible();
  await page
    .getByRole("button", { name: /Open details for Follow up:/ })
    .first()
    .click();
  await openContextDetails(page);
  await expect(page.getByText("Follow-up to completed work")).toBeVisible();
});

test("keeps the compact queue and forms usable at narrow mobile widths", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dyna?many-items=1&long-content=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.locator('.dyna-card[data-presentation="queue"]')).toHaveCount(3);
  await expect(page.getByText("1 more in the full dashboard")).toBeVisible();
  await expect(page.locator(".dyna-row-title").first()).toBeVisible();
  await expect(page.locator(".dyna-row-attention").first()).toBeVisible();
  await expect(page.locator(".dyna-row-person").first()).toBeVisible();
  const dimensions = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".dyna-card")];
    const first = rows[0]?.getBoundingClientRect();
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      firstTop: first?.top ?? Number.POSITIVE_INFINITY,
      firstHeight: first?.height ?? Number.POSITIVE_INFINITY,
      visibleRows: rows.filter((row) => row.getBoundingClientRect().top < innerHeight).length,
    };
  });
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.firstTop).toBeLessThan(230);
  expect(dimensions.firstHeight).toBeLessThanOrEqual(112);
  expect(dimensions.visibleRows).toBe(3);
  for (const button of await page.getByRole("button").all()) {
    if (!(await button.isVisible())) continue;
    expect(Math.round((await button.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(44);
  }

  await page.setViewportSize({ width: 320, height: 400 });
  await page.getByRole("button", { name: "New to-do" }).click();
  const todoDialog = page.getByRole("dialog", { name: "Add to the priority queue" });
  const dialogLayout = await todoDialog.evaluate((dialog) => {
    const sheet = dialog.querySelector<HTMLElement>(".dyna-sheet");
    const footer = dialog.querySelector<HTMLElement>(".dyna-sheet-actions");
    const sheetBox = sheet?.getBoundingClientRect();
    const footerBox = footer?.getBoundingClientRect();
    return {
      sheetTop: sheetBox?.top ?? -1,
      sheetBottom: sheetBox?.bottom ?? Number.POSITIVE_INFINITY,
      footerBottom: footerBox?.bottom ?? Number.POSITIVE_INFINITY,
      viewportHeight: innerHeight,
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(dialogLayout.sheetTop).toBeGreaterThanOrEqual(0);
  expect(dialogLayout.sheetBottom).toBeLessThanOrEqual(dialogLayout.viewportHeight);
  expect(dialogLayout.footerBottom).toBeLessThanOrEqual(dialogLayout.viewportHeight);
  expect(dialogLayout.pageScrollWidth).toBeLessThanOrEqual(dialogLayout.pageClientWidth);
  await todoDialog.getByRole("button", { name: "Cancel" }).click();

  const firstTitle = (await page.locator(".dyna-row-title").first().textContent()) ?? "";
  await page.locator(".dyna-row-main").first().click();
  const inspector = page.getByRole("dialog", { name: firstTitle });
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".dyna-inspector-layer")).toHaveAttribute("data-presentation", "route");
  await expect(page.locator(".dyna").locator("xpath=..")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Back to attention queue" })).toBeFocused();
  const disclosureHeights = await inspector
    .locator("summary")
    .evaluateAll((summaries) => summaries.map((summary) => summary.getBoundingClientRect().height));
  expect(disclosureHeights.every((height) => Math.round(height) >= 44)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".dyna-more-trigger")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Back to attention queue" })).toBeFocused();
  await page.locator(".dyna-more-trigger").click();
  const priorityMenuLayout = await page.locator(".dyna-overflow-menu").evaluate((menu) => {
    const box = menu.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      viewportWidth: innerWidth,
      actionHeights: [...menu.querySelectorAll("button")].map(
        (button) => button.getBoundingClientRect().height,
      ),
    };
  });
  expect(priorityMenuLayout.left).toBeGreaterThanOrEqual(0);
  expect(priorityMenuLayout.right).toBeLessThanOrEqual(priorityMenuLayout.viewportWidth);
  expect(priorityMenuLayout.actionHeights.every((height) => Math.round(height) >= 44)).toBe(true);
});

test("keeps a failed scheduled source readable at desktop and mobile widths", async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 1_024 });
  await page.goto("/dyna?failed-schedule=1");
  await expect(page.getByText("Source refresh needs attention", { exact: true })).toBeVisible();
  await openFullDashboard(page);

  const schedule = page.locator(".dyna-schedule");
  const title = schedule.locator("strong");
  const metadata = schedule.locator(":scope > .dyna-meta");
  await expect(title).toHaveText("Browser fixture schedule");
  await expect(schedule.getByText("failed", { exact: true })).toBeVisible();
  await expect(metadata).toHaveCount(2);
  await expect(metadata.nth(1)).toContainText("Outlook unavailable");

  const desktop = await schedule.evaluate((element) => {
    const titleElement = element.querySelector("strong");
    const metadataElements = [...element.querySelectorAll(":scope > .dyna-meta")];
    const box = element.getBoundingClientRect();
    return {
      height: box.height,
      width: box.width,
      titleWidth: titleElement?.getBoundingClientRect().width ?? 0,
      metadataWidths: metadataElements.map((entry) => entry.getBoundingClientRect().width),
    };
  });
  expect(desktop.titleWidth).toBeGreaterThan(desktop.width / 2);
  expect(desktop.metadataWidths.every((width) => width > desktop.width * 0.9)).toBe(true);
  expect(desktop.height).toBeLessThan(180);

  await page.setViewportSize({ width: 320, height: 720 });
  expect(
    Math.round((await page.locator(".dyna-source-health > summary").boundingBox())?.height ?? 0),
  ).toBeGreaterThanOrEqual(44);
  const mobile = await schedule.evaluate((element) => {
    const titleElement = element.querySelector("strong");
    const box = element.getBoundingClientRect();
    return {
      height: box.height,
      width: box.width,
      titleWidth: titleElement?.getBoundingClientRect().width ?? 0,
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(mobile.titleWidth).toBeGreaterThan(140);
  expect(mobile.height).toBeLessThan(240);
  expect(mobile.pageScrollWidth).toBeLessThanOrEqual(mobile.pageClientWidth);
});

test("requests the expanded Codex work surface when the host supports it", async ({ page }) => {
  await page.getByRole("button", { name: "Open full dashboard" }).click();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "fullscreen");
  await expect(page.getByRole("button", { name: "Open full dashboard" })).toBeHidden();
  await expect(page.getByRole("tab", { name: "Priority queue" })).toBeFocused();
  await expect(page.locator('.dyna-card[data-selected="true"]')).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-dyna-display-mode-request-count", "1");
});

test("keeps the host-selected panel presentation after connection", async ({ page }) => {
  await page.goto("/dyna?display-mode-delay=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.getByRole("button", { name: "Open full dashboard" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-dyna-display-mode-request-count");
});

test("keeps inline content visible when the host cannot expand", async ({ page }) => {
  await page.goto("/dyna?inline-only=1&many-items=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.getByText("Review the release merge request")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open full dashboard" })).toBeHidden();
  await expect(page.getByRole("tab", { name: "Priority queue" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Progress pipeline" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search dashboard" })).toBeVisible();
  await expect(page.locator('.dyna-card[data-presentation="queue"]')).toHaveCount(4);
  await expect(page.locator(".dyna-inline-more")).toHaveCount(0);
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.locator("html")).not.toHaveAttribute("data-dyna-display-mode-request-count");
});

test("keeps the bounded brief usable when an expanded presentation request fails", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/dyna?display-mode-error=1&many-items=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.locator(".dyna-card")).toHaveCount(3);
  await expect(page.getByText("1 more in the full dashboard")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open full dashboard" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Open full dashboard" }).click();
  await expect(page.locator(".dyna-toast")).toContainText(
    "complete current view remains available",
  );
  await expect(page.getByRole("button", { name: "Open full dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open full dashboard" })).toBeFocused();
  expect(pageErrors).toEqual([]);
});

test("keeps the bounded brief when the host resolves expansion as inline", async ({ page }) => {
  await page.goto("/dyna?display-mode-result=inline&many-items=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.locator(".dyna-card")).toHaveCount(3);
  await expect(page.getByText("1 more in the full dashboard")).toBeVisible();
  const expand = page.getByRole("button", { name: "Open full dashboard" });
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
  await openFullDashboard(page);
  const search = page.getByRole("searchbox", { name: "Search dashboard" });
  await search.fill("buriedneedle");
  await expect(page.getByText("Review the release merge request")).toBeVisible();
  await expect(page.locator('.dyna-visually-hidden[role="status"]')).toHaveText("1 matching item.");
});

test("pauses mutations when snapshot connectivity is lost", async ({ page }) => {
  await page.goto("/dyna?tool-error=dyna_get_snapshot");
  await openFullDashboard(page);
  await page.getByRole("searchbox", { name: "Search dashboard" }).fill("github");
  await expect(page.getByRole("alert")).toContainText("Dashboard updates are disconnected");
  await expect(page.getByRole("button", { name: /^(Add|New) to-do$/ })).toBeDisabled();
  await openDetails(page, "Review the release merge request");
  await expect(page.getByRole("button", { name: "Add note" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review in Codex" })).toBeDisabled();
});

test("retries an uncertain delivery with the same idempotent request", async ({ page }) => {
  await page.goto("/dyna?action-error=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await openDetails(page, "Review the release merge request");
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
