import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/index.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "promote-cookie-consent-")),
  runtime = createApp({ dataDir, scheduler: false }),
  server = runtime.app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage(),
    trackedRequests = [],
    origin = `http://127.0.0.1:${server.address().port}`;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/public\/[^/]+\/(metrics|sponsors\/[^/]+\/activity)$/.test(
        new URL(request.url()).pathname,
      )
    )
      trackedRequests.push(request.url());
  });

  await page.goto(`${origin}/p/mchenry`);
  const notice = page.getByRole("dialog", {
    name: "Your cookie and tracking choices",
  });
  await notice.waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Consent notice should not cause horizontal overflow on mobile.",
  );
  await notice.getByRole("button", { name: "What do we use?" }).click();
  await notice.getByText("promote.device.v1").waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("promote.cookie-consent.v1")),
    null,
  );
  await page.waitForTimeout(300);
  assert.deepEqual(trackedRequests, []);

  await notice.getByRole("button", { name: "Reject optional" }).click();
  await notice.waitFor({ state: "hidden" });
  await page.reload();
  await page.getByRole("heading", { name: /Good energy/ }).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(trackedRequests, []);

  await page.getByRole("button", { name: "Cookie settings" }).click();
  await notice.waitFor();
  await notice.getByRole("button", { name: "Accept optional" }).click();
  await page.waitForFunction(
    () => localStorage.getItem("promote.cookie-consent.v1") === "accepted",
  );
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.includes("/api/public/mchenry/metrics")),
  );
  assert.ok(trackedRequests.some((url) => url.includes("/metrics")));
  assert.ok(
    await page.evaluate(() => localStorage.getItem("promote.device.v1")),
  );

  await page.getByRole("button", { name: "Cookie settings" }).click();
  await notice.waitFor();
  await notice.getByRole("button", { name: "Reject optional" }).click();
  await page.waitForFunction(
    () => localStorage.getItem("promote.cookie-consent.v1") === "rejected",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("promote.device.v1")),
    null,
  );
  trackedRequests.length = 0;
  await page.reload();
  await page.getByRole("heading", { name: /Good energy/ }).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(trackedRequests, []);
  await context.close();
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  runtime.close();
  rmSync(dataDir, { recursive: true, force: true });
}
