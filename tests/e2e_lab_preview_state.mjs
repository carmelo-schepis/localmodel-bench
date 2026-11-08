/* Focused regression for iframe identity, keyboard input, and state over a
   parent Lab repaint. Playwright remains an external test dependency. */
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
require('module').Module._initPaths();
const { chromium } = require('playwright-core');
const base = (process.env.LAB_E2E_BASE || 'http://100.81.131.14:8090').replace(/\/$/, '');
const runId = process.env.LAB_E2E_RUN_ID || '5bdb0aaf-d036-48ad-afef-fc2f814c3937';
const profile = fs.mkdtempSync('/dev/shm/lab-preview-profile-');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROME_BIN || '/home/linuxpc/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
    viewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await context.newPage();
  await page.goto(`${base}/#labrun/${runId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lab-tape');
  await page.evaluate(() => {
    window.__labHarnessMessages = [];
    window.addEventListener('message', event => {
      if (event.data?.source === 'lab-harness') window.__labHarnessMessages.push(event.data);
    });
  });
  await page.locator('[data-lab-select="2"]').click();
  const iframeSelector = 'iframe[data-lab-frame="2"]';
  await page.locator('[data-lab-preview="2"]').first().click();
  const frame = page.frameLocator(iframeSelector);
  await frame.locator('#count-display').waitFor({ state: 'visible' });
  const nonce = await page.locator(iframeSelector).getAttribute('data-lab-nonce');
  await page.waitForFunction(({ runId, nonce }) => window.__labHarnessMessages.some(message =>
    message.runId === runId && message.attempt === 2 && message.nonce === nonce),
  { runId, nonce }, { timeout: 9000 });

  const originalFrame = await page.locator(iframeSelector).elementHandle();
  const counter = frame.locator('#count-display');
  const before = await counter.innerText();
  const plus = frame.getByRole('button', { name: '+', exact: true });
  await plus.focus();
  const focusedButton = await plus.evaluate(node => document.activeElement === node);
  await page.keyboard.press('Space');
  const afterInput = await counter.innerText();
  await page.evaluate(() => render());
  const sameFrame = await originalFrame.evaluate(node => node === document.querySelector('iframe[data-lab-frame="2"]'));
  const focusedFrame = await page.locator(iframeSelector).evaluate(node => document.activeElement === node);
  const afterPaint = await counter.innerText();
  const evidence = { runId, attempt: 2, before, afterInput, afterPaint, focusedButton, focusedFrame, sameFrame };
  fs.mkdirSync('artifacts/lab-acceptance', { recursive: true });
  fs.writeFileSync('artifacts/lab-acceptance/preview-state.json', JSON.stringify(evidence, null, 2));
  if (afterInput === before || !focusedButton || !focusedFrame || !sameFrame || afterPaint !== afterInput) {
    throw new Error(`preview state regression: ${JSON.stringify(evidence)}`);
  }
  console.log(JSON.stringify(evidence));
} finally {
  if (context) await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
