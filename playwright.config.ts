import { defineConfig } from "@playwright/test";

const port = 4174;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  reporter: "list",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
  use: {
    baseURL,
    colorScheme: "light",
    screenshot: "only-on-failure",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
    url: baseURL,
  },
});
