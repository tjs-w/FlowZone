import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "../e2e",
  testMatch: /callflow\.spec\.ts/u,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
