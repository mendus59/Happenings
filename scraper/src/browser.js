import { chromium } from 'playwright';
import { assertPublicUrl, UA } from './net.js';

const SKIP_FRAME_HOSTS =
  /(doubleclick|googlesyndication|googletagmanager|google-analytics|facebook\.com\/plugins|addtoany|youtube\.com|vimeo\.com|recaptcha|hotjar|userway|stripe|paypal|instagram|twitter|tiktok)/i;

export async function launchBrowser() {
  return chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
}

/**
 * Load a page like a real visitor (so JavaScript calendar widgets render),
 * then return the final HTML plus the HTML of any embedded iframes.
 */
export async function renderPage(browser, url, { timeoutMs = 45000 } = {}) {
  await assertPublicUrl(url);
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 2000 } });
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    // Nudge lazy-loaded widgets.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(2500);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const html = await page.content();
    const frames = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const furl = frame.url();
      if (!/^https?:/.test(furl) || SKIP_FRAME_HOSTS.test(furl)) continue;
      const fhtml = await frame.content().catch(() => '');
      frames.push({ url: furl, html: fhtml });
      if (frames.length >= 8) break;
    }
    return { url: page.url(), html, frames };
  } finally {
    await context.close();
  }
}
