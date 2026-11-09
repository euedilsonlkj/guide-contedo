import type { Page } from "playwright-core";

/**
 * The worker runs TypeScript through tsx, which wraps named functions in a `__name(...)`
 * helper. Callbacks given to page.evaluate run inside Chrome, where that helper does not
 * exist, so any of them with an inner function failed with "__name is not defined" (every
 * Google Maps place did). Defining it as a no-op on every page, before and after each
 * navigation, keeps those callbacks working however the code was compiled.
 */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((fn) => fn);";

export async function installPageShims(page: Page): Promise<void> {
  await page.addInitScript({ content: NAME_SHIM });
  // A frozen or busy tab never answers; the shim is also installed on the next navigation.
  await Promise.race([page.evaluate(NAME_SHIM).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5000))]);
}
