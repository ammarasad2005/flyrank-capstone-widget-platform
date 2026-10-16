/*
 * Optional browser evidence run: renders the widget on the second-origin page in Chromium,
 * submits it, then opens the owner dashboard and confirms the lead is visible.
 *
 * Playwright is intentionally NOT a project dependency (the app itself needs nothing from it).
 * To reproduce:
 *
 *   npm i --no-save playwright && npx playwright install chromium
 *   npm run demo:page            # in another terminal: http://localhost:5500
 *   node scripts/verify-browser.mjs
 *
 * Environment: PAGE_URL (default http://localhost:5500/), API_URL (default http://localhost:3000),
 * OWNER_EMAIL / OWNER_PASSWORD (defaults: the seeded Tenant A owner).
 * Screenshots are written to evidence/.
 */
import { chromium } from 'playwright';

import { fileURLToPath } from 'node:url';

const screenshotDir = fileURLToPath(new URL('../evidence/', import.meta.url)).replace(/\/$/, '');
const pageUrl = process.env.PAGE_URL ?? 'http://localhost:5500/';
const apiUrl = process.env.API_URL ?? 'http://localhost:3000';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleMessages = [];
const failedRequests = [];
page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`));

const preflightSeen = [];
// Playwright does not surface CORS preflights as page requests, so read them off the CDP
// network log instead: a cross-origin POST with Content-Type/Idempotency-Key must preflight.
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
cdp.on('Network.requestWillBeSent', (event) => {
  if (event.request.method === 'OPTIONS') preflightSeen.push({ phase: 'request', url: event.request.url });
});
cdp.on('Network.responseReceived', (event) => {
  if (event.type === 'Preflight') preflightSeen.push({ phase: 'response', status: event.response.status, url: event.response.url });
});

await page.goto(pageUrl, { waitUntil: 'networkidle' });

// The widget is rendered by the versioned bundle into the page it does not control.
await page.waitForSelector('[data-flyrank-widget]', { timeout: 10_000 });
const widgetTitle = await page.textContent('.flyrank-title');
const renderedFieldNames = await page.$$eval('.flyrank-field input, .flyrank-field textarea', (nodes) => nodes.map((n) => n.name));
const honeypotFacts = await page.evaluate(() => {
  const input = document.querySelector('input[name="website"]');
  if (!input) return null;
  const wrapper = input.closest('div');
  const inputBox = input.getBoundingClientRect();
  const wrapperBox = wrapper.getBoundingClientRect();
  const style = window.getComputedStyle(wrapper);
  return {
    wrapperAriaHidden: wrapper.getAttribute('aria-hidden'),
    wrapperOffScreen: wrapperBox.right <= 0 || wrapperBox.left >= window.innerWidth,
    wrapperOverflow: style.overflow,
    inputTabIndex: input.tabIndex,
    inputAutocomplete: input.autocomplete,
    inputInsideViewport: inputBox.left >= 0 && inputBox.right <= window.innerWidth && inputBox.width > 1,
  };
});

await page.screenshot({ path: `${screenshotDir}/widget-second-origin.png`, fullPage: false });

await page.fill('.flyrank-field input[name="name"]', 'Browser Acceptance Lead');
await page.fill('.flyrank-field input[name="email"]', `browser-${Date.now()}@example.test`);
await page.fill('.flyrank-field textarea[name="message"]', 'Rendered and submitted from http://localhost:5500 inside Chromium.');
await page.click('.flyrank-submit');
await page.waitForFunction(
  () => {
    const status = document.querySelector('.flyrank-status');
    return status && /Thanks/.test(status.textContent);
  },
  undefined,
  { timeout: 10_000 },
);
const successText = await page.textContent('.flyrank-status');
await page.screenshot({ path: `${screenshotDir}/widget-submitted-second-origin.png` });

// Owner dashboard in the same browser: log in and confirm the lead is visible.
const dashboard = await context.newPage();
await dashboard.goto(`${apiUrl}/demo/dashboard.html`, { waitUntil: 'networkidle' });
await dashboard.fill('#email', process.env.OWNER_EMAIL ?? 'owner-a@example.test');
await dashboard.fill('#password', process.env.OWNER_PASSWORD ?? 'demo-owner-a-password');
await dashboard.click('#login');
await dashboard.waitForSelector('#app:not(.hidden)');
await dashboard.waitForFunction(() => document.querySelectorAll('#submissions tr').length > 0, undefined, { timeout: 10_000 });
await dashboard.waitForTimeout(500);
const dashboardRows = await dashboard.$$eval('#submissions tr', (rows) => rows.map((row) => row.innerText.replace(/\s+/g, ' ').trim()));
const metricSubmissions = await dashboard.textContent('#metric-submissions');
const snippet = await dashboard.textContent('#snippet');
await dashboard.screenshot({ path: `${screenshotDir}/dashboard-owner-view.png`, fullPage: true });

const report = {
  generatedAt: new Date().toISOString(),
  pageUrl,
  widgetTitle,
  renderedFieldNames,
  honeypot: honeypotFacts,
  preflightRequests: preflightSeen,
  successText,
  metricSubmissions,
  snippetRendered: snippet.trim(),
  dashboardRowCount: dashboardRows.length,
  newestDashboardRow: dashboardRows[0] ?? null,
  failedRequests,
  consoleMessages,
};

console.log(JSON.stringify(report, null, 2));
await browser.close();
