import { defineConfig, devices } from "@playwright/test";
import { e2eDatabaseUrl } from "./tests/e2e/e2e-db";

/**
 * End-to-end tests. They use their OWN database (rezonest_workos_e2e), never your working one:
 * before each run it's migrated, emptied and refilled with the full sample set (tests/e2e/global-setup.ts).
 *   createdb rezonest_workos_e2e   (once)
 *   pnpm test:e2e
 * The app is built and started on port 3100 against that database. If you start it yourself and set
 * E2E_BASE_URL, start it with DATABASE_URL pointing at the e2e database too.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const databaseUrl = e2eDatabaseUrl();
// The tests themselves (e.g. creating test logins) use the same database as the app under test.
process.env.DATABASE_URL = databaseUrl;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm build && pnpm start -p 3100",
        // Own build folder, so a test build never overwrites the app you're running on port 3000.
        env: { LOGIN_RATE_LIMIT: "1000", DATABASE_URL: databaseUrl, NEXT_DIST_DIR: ".next-e2e" },
        url: `${baseURL}/login`,
        timeout: 300_000,
        // Never reuse a server already on 3100: it might be using your working database.
        reuseExistingServer: false,
      },
});
