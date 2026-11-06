import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Waits for the page's short animations (2 s or less) to finish. axe measures colours as drawn, so a dialog caught
 * mid-fade (`pc-rise`, 240 ms) reads as low contrast; CI caught exactly that on #150. Endless ones (the skeleton's
 * shimmer) are left running. The web app's E2E does the same (apps/web/e2e/fixtures.ts `animationsSettled`).
 */
async function animationsSettled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number(a.effect?.getComputedTiming().endTime ?? Infinity) <= 2_000)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** WCAG 2.2 AA by axe, once the page has settled, and nothing wider than the screen. */
export async function expectAccessible(page: Page): Promise<void> {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}
