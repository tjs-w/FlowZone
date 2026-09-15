import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  createCallFlowBrowserHarnessPage,
  createCallFlowLargeBrowserHarnessPage,
  createCallFlowStandaloneHarnessPage,
} from "../harness/callflow-browser-harness";

const consoleOutput = new WeakMap<Page, string[]>();
const benignResizeObserverErrors = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

test.beforeEach(async ({ page }) => {
  const pageErrors: string[] = [];
  const messages: string[] = [];
  consoleOutput.set(page, messages);
  page.on("console", (message) => {
    messages.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (!benignResizeObserverErrors.has(error.message)) {
      pageErrors.push(error.message);
    }
  });
  await page.setContent(await createCallFlowBrowserHarnessPage(), { waitUntil: "load" });
  await page.waitForTimeout(100);
  expect(pageErrors).toEqual([]);
  await expect(page.getByRole("heading", { name: "CallFlow", level: 1 })).toBeVisible();
});

test("renders the coordinated outline, causal canvas, and evidence inspector", async ({ page }) => {
  await expect(page.getByRole("tree", { name: "Workflow outline" })).toBeVisible();
  await expect(page.getByTestId("callflow-canvas")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Evidence inspector" })).toBeVisible();
  await expect(page.getByText(/ELK layout/u)).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="stage-receive"]')).toHaveAttribute(
    "style",
    /translate\(44px, 38px\)/u,
  );
  await expect(page.getByRole("treeitem")).toHaveCount(10);
  await expect(page.getByLabel("Overlay")).toHaveValue("data");
  await expect(page.getByRole("treeitem", { name: /processClaim call/u })).toHaveCount(0);

  const usefulPaintMilliseconds = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __callflowHarness?: { usefulPaintMilliseconds: number | null };
        }
      ).__callflowHarness?.usefulPaintMilliseconds,
  );
  expect(usefulPaintMilliseconds).not.toBeNull();
  expect(usefulPaintMilliseconds ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(250);

  await page.getByRole("treeitem", { name: /Process record/u }).click();
  await expect(
    page.locator(".cf-inspector").getByRole("heading", { name: "Process record" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Callsites" })).toBeVisible();
  await expect(
    page.getByLabel("Evidence inspector").getByText("processClaim call", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Incoming (1)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Outgoing (2)" })).toBeVisible();
});

test("selects a connection and inspects its evidence and endpoints", async ({ page }) => {
  const connection = page.getByTestId("rf__edge-edge-worker-transaction");
  await connection.focus();
  await connection.press("Enter");
  await expect(
    page.locator(".cf-inspector").getByRole("heading", { name: "Direct call" }),
  ).toBeVisible();
  await expect(page.getByLabel("Connection endpoints")).toContainText("Process record");
  await expect(page.getByLabel("Connection endpoints")).toContainText("Commit projection");
  await expect(page.locator(".cf-inspector").getByText("Static possible")).toBeVisible();
  await expect(page.locator(".cf-inspector").getByText("Graft exact")).toBeVisible();
});

test("preserves pins through collapse and supports path, history, overlays, and reset", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: /Route request/u }).click();
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await page
    .getByRole("tree", { name: "Workflow outline" })
    .getByRole("button", { name: "Collapse Receive" })
    .click();
  await expect(page.getByRole("treeitem", { name: /Route request/u })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /Validate input/u })).toHaveCount(0);

  await page.getByRole("button", { name: "Callers", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show all" })).toBeVisible();
  await page.getByRole("button", { name: "Show all" }).click();

  await page.getByRole("treeitem", { name: /Process record/u }).click();
  await page.getByLabel("Path from selected step to").selectOption("index");
  await page.getByRole("button", { name: "Show path" }).click();
  await expect(page.getByRole("treeitem", { name: /Search index/u })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /Route request/u })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Selection breadcrumb" })).toContainText(
    "Process record",
  );

  await page.getByRole("button", { name: "Previous selection" }).click();
  await expect(
    page.locator(".cf-inspector").getByRole("heading", { name: "Route request" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous selection" })).toBeDisabled();
  await page.getByRole("button", { name: "Next selection" }).click();
  await expect(
    page.locator(".cf-inspector").getByRole("heading", { name: "Process record" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show all" }).click();
  await page.getByLabel("Overlay").selectOption("retry");
  await expect(page.locator(".cf-edge--retry.cf-edge--active")).toHaveCount(1);
  await page.getByLabel("Overlay").selectOption("data");
  await expect(page.locator(".cf-edge--state-write.cf-edge--active")).toHaveCount(1);
  await expect(page.locator(".cf-edge--direct-call.cf-edge--muted")).toHaveCount(1);
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(10);
  await expect(page.getByLabel("Overlay")).toHaveValue("data");
});

test("filters nodes with explicit hidden reasons and restores a hidden selection", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: /Process record/u }).click();
  await page.getByLabel("Node type").selectOption("queue");
  await expect(
    page.locator(".cf-inspector").getByRole("heading", { name: "Process" }),
  ).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /Enqueue outbox/u })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /Route request/u })).toHaveCount(0);
  await page.getByText("Why steps are hidden").click();
  await expect(page.getByText(/Node filter: 6/u)).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("treeitem", { name: /Route request/u })).toBeVisible();
});

test("renders a meaningful change-impact overlay", async ({ page }) => {
  await page.getByLabel("Overlay").selectOption("change");
  await expect(page.locator('.cf-node[data-diff-status="changed"]')).toHaveCount(1);
  await expect(page.locator('.cf-node[data-diff-status="broken"]')).toHaveCount(1);
  await expect(page.locator(".cf-edge--changed.cf-edge--active")).toHaveCount(1);
  await expect(page.locator(".cf-edge--broken.cf-edge--active")).toHaveCount(1);
  await expect(page.locator(".cf-edge--current.cf-edge--muted")).toHaveCount(5);
});

test("uses a bounded preview for oversized graphs", async ({ page }) => {
  await page.setContent(await createCallFlowLargeBrowserHarnessPage(), { waitUntil: "load" });
  await expect(
    page.getByText(/Preview mode: this workflow contains 252 steps and 601 connections/u),
  ).toBeVisible();
  await expect(page.getByRole("treeitem")).toHaveCount(30);
  await page.getByText("Why steps are hidden").click();
  await expect(page.getByText(/Unrevealed: 221/u)).toBeVisible();
});

test("previews and reveals stage members in bounded batches without losing state", async ({
  page,
}) => {
  await page.setContent(await createCallFlowLargeBrowserHarnessPage(), { waitUntil: "load" });
  const retainedStep = page.locator('[role="treeitem"][data-node-id="large-node-000"]');
  await retainedStep.click();
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(30);

  await page.getByRole("button", { name: "Expand Receive stage" }).click();
  await expect(page.getByRole("heading", { name: "Stage expansion preview" })).toBeVisible();
  await expect(page.getByText(/Receive has 218 unrevealed workflow steps/u)).toBeVisible();
  await expect(page.getByRole("treeitem")).toHaveCount(30);

  await page.getByRole("button", { name: "Reveal next 25" }).click();
  await expect(page.getByRole("treeitem")).toHaveCount(55);
  await expect(page.getByText(/Receive has 193 unrevealed workflow steps/u)).toBeVisible();
  await expect(
    page.locator(".cf-inspector").getByRole("heading", { name: "Large workflow step 1" }),
  ).toBeVisible();
  await expect(retainedStep).toContainText("PIN");
});

test("loads source only after an explicit action through private metadata", async ({ page }) => {
  await page.getByRole("treeitem", { name: /Process record/u }).click();
  await page.getByRole("button", { name: "Load authorized source" }).click();
  await expect(page.getByLabel("Source excerpt from src/workflow.ts")).toContainText(
    "await writeProjection(record)",
  );

  const sourceCall = await page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __callflowHarness?: { toolCalls: { name?: string; arguments?: Record<string, unknown> }[] };
      }
    ).__callflowHarness;
    return harness?.toolCalls.find((call) => call.name === "callflow_get_source");
  });
  expect(sourceCall?.arguments).toMatchObject({
    sessionId: "callflow-e2e-session",
    graphRevision: "callflow-e2e-graph",
    evidenceId: "e1",
    maxBytes: 24_576,
  });
  const logged = consoleOutput.get(page)?.join("\n") ?? "";
  expect(logged).not.toContain("callflow-e2e-capability-token");
  expect(logged).not.toContain("await writeProjection(record)");
});

test("supports fixed-string search and a keyboard-readable outline", async ({ page }) => {
  const search = page.getByRole("searchbox", { name: "Search workflow" });
  await search.fill("Process [");
  await search.press("Enter");
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __callflowHarness?: { toolCalls: { name?: string }[] };
            }
          ).__callflowHarness?.toolCalls.filter((call) => call.name === "callflow_search").length ??
          0,
      ),
    )
    .toBe(1);

  const first = page.getByRole("treeitem").first();
  await first.focus();
  await first.press("ArrowDown");
  await expect(page.getByRole("treeitem").nth(1)).toBeFocused();
  await page.getByRole("treeitem").nth(1).press("ArrowLeft");
  await expect(first).toBeFocused();
  await first.press("ArrowRight");
  await expect(page.getByRole("treeitem").nth(1)).toBeFocused();
  await page.getByRole("treeitem").nth(1).press("End");
  await expect(page.getByRole("treeitem").last()).toBeFocused();
  await page.getByRole("treeitem").last().press("Home");
  await expect(first).toBeFocused();
  await first.press("Enter");
  await expect(
    page.locator(".cf-inspector").getByRole("heading", { name: "Receive" }),
  ).toBeVisible();
  await first.focus();
  await first.press("ArrowLeft");
  await expect(
    page.locator(".cf-outline").getByRole("button", { name: "Expand Receive" }),
  ).toBeVisible();
  await first.press("ArrowRight");
  await expect(
    page.locator(".cf-outline").getByRole("button", { name: "Collapse Receive" }),
  ).toBeVisible();
});

test("has no automated accessibility violations and reflows at 320px", async ({ page }) => {
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.getByTestId("callflow-canvas")).toBeVisible();
  const width = await page.locator(".callflow").evaluate((element) => element.scrollWidth);
  expect(width).toBeLessThanOrEqual(320);
});

test("uses a strict source-disabled bootstrap for the standalone read-only view", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await page.setContent(await createCallFlowStandaloneHarnessPage(), { waitUntil: "load" });
  await expect(page.getByRole("heading", { name: "CallFlow", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand one hop" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Relayout" })).toBeDisabled();
  await page.getByRole("treeitem", { name: /Process record/u }).click();
  await expect(page.getByRole("button", { name: "Load authorized source" })).toBeDisabled();
  await page.getByRole("searchbox", { name: "Search workflow" }).fill("worker");
  await page.getByRole("searchbox", { name: "Search workflow" }).press("Enter");
  await expect(page.getByText(/Could not connect to the Codex host/u)).toHaveCount(0);
  const transportMessages = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __callflowStandaloneMessages?: string[];
        }
      ).__callflowStandaloneMessages ?? [],
  );
  expect(transportMessages).toEqual([]);
  expect(errors).toEqual([]);
});
