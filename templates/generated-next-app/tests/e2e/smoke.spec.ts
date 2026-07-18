import { expect, test } from "@playwright/test";

test("renders the generated product and health endpoint", async ({ page, request }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("requestfailed", (failed) => browserErrors.push(`${failed.method()} ${failed.url()}`));
  page.on("response", (response) => {
    if (new URL(response.url()).origin === "http://127.0.0.1:4173" && response.status() >= 400) {
      browserErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  const document = await page.goto("/");
  expect(document?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /review priority queue/i })).toBeVisible();
  const health = await request.get("/health.json");
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toMatchObject({ status: "ok", runtime: "verified-static" });
  await page.waitForLoadState("networkidle");
  expect(browserErrors).toEqual([]);
});
