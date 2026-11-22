import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  webServer: { command: "node examples/server.mjs", port: 4174, reuseExistingServer: false },
  use: { baseURL: "http://127.0.0.1:4174" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-hidpi", use: { ...devices["Desktop Chrome HiDPI"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
