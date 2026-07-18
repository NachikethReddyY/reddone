import { expect, test, type Page, type Route } from "@playwright/test";

type ObservedBrowserProblems = {
  consoleErrors: string[];
  pageErrors: string[];
  failedResponses: string[];
};

const accountProfile = {
  requestId: "request-account-profile",
  data: {
    user: {
      id: "user-playwright",
      name: "Playwright Owner",
      image: null,
      email: "owner@reddone.test",
      emailVerified: true,
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    workspace: {
      id: "workspace-playwright",
      name: "Playwright Workspace",
      timeZone: "Asia/Singapore",
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
    capabilities: {
      canChangePassword: true,
      emailDeliveryAvailable: true,
    },
  },
};

const accountSessions = {
  requestId: "request-account-sessions",
  data: {
    items: [
      {
        id: "session-playwright",
        current: true,
        ipAddress: "127.0.0.x",
        userAgent: "Playwright Chromium",
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
        expiresAt: "2026-07-24T00:00:00.000Z",
      },
    ],
  },
};

const usageReport = {
  data: {
    source: "actual",
    simulated: false,
    query: {
      from: "2026-07-06T00:00:00.000Z",
      to: "2026-07-20T00:00:00.000Z",
      granularity: "week",
    },
    totals: {
      providerCalls: 0,
      inputTokens: "0",
      outputTokens: "0",
      totalTokens: "0",
      costMicros: "0",
      completedRuns: 0,
      averageCostPerCompletedRunMicros: "0",
    },
    buckets: [],
    breakdowns: [],
    recentRuns: [],
    generatedAt: "2026-07-17T00:00:00.000Z",
  },
};

function observeBrowser(page: Page, baseURL: string): ObservedBrowserProblems {
  const observed: ObservedBrowserProblems = {
    consoleErrors: [],
    pageErrors: [],
    failedResponses: [],
  };
  const expectedOrigin = new URL(baseURL).origin;

  page.on("console", (message) => {
    if (message.type() === "error") observed.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => observed.pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === expectedOrigin && response.status() >= 400) {
      observed.failedResponses.push(`${response.status()} ${url.pathname}${url.search}`);
    }
  });

  return observed;
}

async function expectCleanBrowser(observed: ObservedBrowserProblems) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(observed.consoleErrors, "browser console errors").toEqual([]);
  expect(observed.pageErrors, "uncaught page errors").toEqual([]);
  expect(observed.failedResponses, "same-origin HTTP responses with status >= 400").toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(dimensions.documentClientWidth + 1);
  expect(dimensions.bodyScrollWidth).toBeLessThanOrEqual(dimensions.bodyClientWidth + 1);
}

async function fulfillJson(route: Route, body: unknown, headers: Record<string, string> = {}) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

async function installPublicApiFixtures(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/v1/account/sessions") return fulfillJson(route, accountSessions);
    if (pathname === "/api/v1/account") return fulfillJson(route, accountProfile);
    if (pathname === "/api/v1/usage") return fulfillJson(route, usageReport);
    if (pathname === "/api/v1/approvals" || pathname === "/api/v1/projects") {
      return fulfillJson(route, { data: { items: [] } });
    }
    throw new Error(`Unexpected public API request in Playwright harness: ${pathname}`);
  });
}

test("marketing home and retired pricing route expose private beta access", async ({ page, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("The Playwright project must provide a baseURL.");
  const observed = observeBrowser(page, baseURL);
  const publicMode = testInfo.project.name === "public";

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Build the right product without surrendering the release decision." })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Marketing navigation" })).toContainText("Have an invite?");
  await expect(page.getByRole("link", { name: "Sign in", exact: true }).first()).toHaveAttribute("href", "/sign-in");
  await expect(page.getByRole("link", { name: publicMode ? "Join the private beta" : "Open the product demo" }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto("/pricing", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/beta$/);
  await expect(page.getByRole("heading", { level: 1, name: "Good software starts with the right problem." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Enter your invite code" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Join the waitlist" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectCleanBrowser(observed);
});

for (const width of [1280, 320] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`demo home is usable at ${width}px in ${theme} mode`, async ({ page, context, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== "demo", "Responsive theme coverage runs against the populated demo deployment.");
      if (!baseURL) throw new Error("The Playwright project must provide a baseURL.");
      const observed = observeBrowser(page, baseURL);

      await page.setViewportSize({ width, height: width === 320 ? 720 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await context.addCookies([{ name: "reddone-theme", value: theme, url: baseURL }]);
      await page.goto("/", { waitUntil: "domcontentloaded" });

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("link", { name: "Open the product demo" }).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await testInfo.attach(`home-${width}-${theme}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
      await expectCleanBrowser(observed);
    });
  }
}

test("public auth preserves returnTo, continues after email sign-in, and opens account settings", async ({ page, context, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "public", "The proxy and email sign-in flow apply to the public deployment.");
  if (!baseURL) throw new Error("The Playwright project must provide a baseURL.");
  const observed = observeBrowser(page, baseURL);
  let signInPayload: unknown;

  await installPublicApiFixtures(page);
  await page.route("**/api/auth/sign-in/email", async (route) => {
    signInPayload = route.request().postDataJSON();
    await fulfillJson(
      route,
      { url: "/usage?granularity=week" },
      { "set-cookie": "reddone.session_token=playwright-session; Path=/; HttpOnly; SameSite=Lax" },
    );
  });

  await context.clearCookies();
  await page.goto("/usage?granularity=week", { waitUntil: "domcontentloaded" });
  const redirected = new URL(page.url());
  expect(redirected.pathname).toBe("/sign-in");
  expect(redirected.searchParams.get("returnTo")).toBe("/usage?granularity=week");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to ReDDone." })).toBeVisible();
  await expect(page.getByLabel("Owner email")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();

  await page.getByLabel("Owner email").fill("owner@reddone.test");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
  await page.getByLabel("Keep this browser signed in").check();
  await page.getByRole("button", { name: "Enter control plane" }).click();

  await expect(page).toHaveURL(new URL("/usage?granularity=week", baseURL).toString());
  expect(signInPayload).toEqual({
    email: "owner@reddone.test",
    password: "correct horse battery staple",
    rememberMe: true,
    callbackURL: "/usage?granularity=week",
  });
  expect((await context.cookies()).some((cookie) => cookie.name === "reddone.session_token")).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Usage filters" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/account", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Account and security" })).toBeVisible();
  await expect(page.getByLabel("Owner name")).toHaveValue("Playwright Owner");
  await expect(page.getByLabel("Verified email")).toHaveValue("owner@reddone.test");
  await expect(page.getByLabel("Workspace time zone")).toHaveValue("Asia/Singapore");
  await expect(page.getByRole("heading", { level: 2, name: "Active sessions" })).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toContainText("Playwright Owner");
  await expectNoHorizontalOverflow(page);

  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(new URL("/account", baseURL).toString());
  await expect(page.getByRole("heading", { level: 1, name: "Account and security" })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/account", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open more navigation" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectCleanBrowser(observed);
});
