import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

export const OPERATOR = { email: "ops@harbour.test", password: "correct-horse-battery", workspace: "Harbour Advisory" };

export const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Fails the test on serious or critical WCAG 2.2 AA violations. */
export async function expectAccessible(page: Page, testInfo: TestInfo, label: string) {
  // Entrance fades lower opacity mid-flight, which axe would misread as low contrast.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const results = await new AxeBuilder({ page })
    .exclude("iframe[sandbox]")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  if (blocking.length) {
    await testInfo.attach(`axe-${label}.json`, { body: JSON.stringify(blocking, null, 2), contentType: "application/json" });
  }
  expect(
    blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`),
    `axe violations on ${label}`
  ).toEqual([]);
}

/** Collects console errors and failed requests so tests can assert a clean run. */
export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

export async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: `e2e/screenshots/${testInfo.project.name}-${name}.png`, fullPage: true, animations: "disabled" });
}
