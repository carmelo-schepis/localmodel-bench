/* Deterministic Lab status and layout checks. Every API call the page makes is
   answered by page.route() fixtures, so no inference starts and no saved setup
   or run on the server is read or written. Run against a local instance:
   LAB_E2E_BASE=http://127.0.0.1:8091 NODE_PATH=/dev/shm/lab-browser-test/node_modules node tests/e2e_lab_status_layout.mjs */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('module').Module._initPaths();
const { chromium } = require('playwright-core');
const base = (process.env.LAB_E2E_BASE || 'http://127.0.0.1:8091').replace(/\/$/, '');
const output = path.resolve('artifacts/lab-status-layout');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync('/dev/shm/lab-status-profile-');
const report = { base, startedAt: new Date().toISOString(), assertions: [], consoleErrors: [], pageErrors: [], failedRequests: [], screenshots: [], forcedOutages: 0, postRequests: [] };
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
  report.assertions.push(message);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const MODELS = ['qwen3.5:4b', 'gemma3:12b', 'qwen2.5-coder:7b'];
const FOUND = ['qwen3.5:4b', 'qwen3:8b', 'qwen2.5-coder:7b', 'gemma3:4b', 'gemma3:12b', 'dolphin3:8b'];
const TASKS = [
  { field: 'ui', key: 'landing', title: 'Product landing page' },
  { field: 'ui', key: 'widget', title: 'Interactive widget' },
  { field: 'coding', key: 'game', title: 'Playable game' },
  { field: 'coding', key: 'dashboard', title: 'Sort dashboard' },
  { field: 'extras', key: 'json', title: 'JSON aggregation' },
];

/* Fixture builders. The run shape matches GET /api/lab/runs/{id}. */
function makeRun({ id = 'fixture-run', state = 'running', progress = 0, models = MODELS, fields = ['ui', 'coding', 'extras'], completed = false } = {}) {
  const planned = TASKS.filter(task => fields.includes(task.field));
  const total = planned.length * models.length;
  const attempts = [];
  for (let index = 0; index < progress; index += 1) {
    const task = planned[index % planned.length];
    attempts.push({
      attempt: index + 1, endpoint: 'Ollama 1', model: models[Math.floor(index / planned.length)], field: task.field, task: task.key,
      title: task.title, prompt: 'Fixture prompt', status: 'ok', reason: null, elapsed: 12.3, tokens: 900, wrapped: false, truncated: false,
      autoScore: null, autoChecks: [], auto: {}, review: {},
    });
  }
  return {
    id, created: '2026-11-09T10:26:00.000Z', state, error: null, progress, total,
    config: { endpoints: [{ name: 'Ollama 1', url: 'http://127.0.0.1:9/v1', models }], fields, models: models.map(model => ({ endpoint: 'Ollama 1', model })) },
    attempts, rollup: [],
    ...(completed ? {} : {}),
  };
}

const benchSetup = (count = 6) => {
  const found = (count === 40 ? Array.from({ length: 40 }, (_, index) => `model-${index + 1}:7b`) : FOUND).map(id => ({ id, owned_by: 'library' }));
  const models = found.map(model => model.id).slice(0, count === 40 ? 40 : 3);
  return { endpoints: [{ name: 'Ollama 1', url: 'http://127.0.0.1:9/v1', models, found }], depth: 'Quick', categories: ['Coding', 'Engineering', 'Logic', 'Knowledge', 'Instructions', 'Context', 'Writing'] };
};
const labSetup = (count = 3) => ({
  models: [{ name: 'Ollama 1', url: 'http://127.0.0.1:9/v1', models: count === 40 ? Array.from({ length: 40 }, (_, index) => `model-${index + 1}:7b`) : MODELS }],
  fields: ['ui', 'coding', 'extras'],
});

/* One scenario per page. The test edits scenario.run between steps. */
function attach(page, scenario) {
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // The aborted watcher stream is logged by the browser as a failed resource; it is expected.
    if (message.text() === 'Failed to load resource: net::ERR_FAILED' && (message.location().url || '').includes('/events')) return;
    // The forced watcher outage (scenario.runFail) answers 500 once per forced poll; allow only those.
    if (message.text().includes('status of 500') && (message.location().url || '').endsWith('/api/lab/runs/fixture-run') && report.forcedOutages > 0) {
      report.forcedOutages -= 1;
      return;
    }
    report.consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('requestfailed', request => {
    if (request.url().includes('/events')) return; // deliberately aborted watcher stream
    report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText });
  });
  page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/api/health') return json({ status: 'ok', version: '0.1.0' });
    if (p === '/api/bench/setup') return request.method() === 'PUT' ? json({}) : json(scenario.bench);
    if (p === '/api/lab/setup') return request.method() === 'PUT' ? json({}) : json(scenario.labSetup);
    if (p === '/api/runs' || p === '/api/datasets') return json([]);
    if (p === '/api/lab/runs' && request.method() === 'GET') {
      if (scenario.runsDelay) await wait(scenario.runsDelay);
      return json(scenario.runs || []);
    }
    if (/^\/api\/lab\/runs\/[^/]+\/events$/.test(p)) return route.abort();
    if (/^\/api\/lab\/runs\/[^/]+\/artifacts\/\d+/.test(p)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><button>Fixture</button></body></html>', headers: { 'Content-Security-Policy': 'sandbox allow-scripts' } });
    if (/^\/api\/lab\/runs\/[^/]+$/.test(p) && request.method() === 'GET') {
      if (scenario.runDelay) await wait(scenario.runDelay);
      if (scenario.runFail) { report.forcedOutages += 1; return json({ detail: 'fixture outage' }, 500); }
      return json(scenario.run);
    }
    if (request.method() !== 'GET') { report.postRequests.push(p); return json({}); }
    return json({ detail: 'not mocked' }, 404);
  });
  return page;
}

async function newScenario(context, scenario) {
  const page = attach(await context.newPage(), scenario);
  return page;
}

const box = async (page, selector) => {
  const handle = page.locator(selector).first();
  const value = await handle.boundingBox();
  return value && { x: value.x, y: value.y, w: value.width, h: value.height, bottom: value.y + value.height, right: value.x + value.width };
};

async function shot(page, name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(file);
}

async function waitStrip(page, text) {
  await page.waitForFunction(expected => document.querySelector('.lab-status')?.textContent.includes(expected), text, { timeout: 8000 });
}

async function main() {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROME_BIN || '/home/linuxpc/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
    viewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    /* 1 and 2: live strip, pending row, meter, and the 8th attempt after 7 done. */
    let scenario = { bench: benchSetup(), labSetup: labSetup(), run: makeRun({ progress: 0 }), runs: [] };
    let page = await newScenario(context, scenario);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/#labrun/fixture-run`, { waitUntil: 'domcontentloaded' });
    await waitStrip(page, 'Generating attempt 1 of 15');
    const strip0 = await page.locator('.lab-status').innerText();
    assert(strip0.includes('Product landing page') && strip0.includes('qwen3.5:4b'), 'attempt 1 strip names the first task and model');
    assert(await page.locator('.lab-status [role="status"]').count() === 1, 'strip text container has role=status');
    assert(await page.locator('.lab-status .spin[aria-hidden="true"]').count() === 1, 'running strip spinner is aria-hidden');
    assert(await page.locator('.lab-tape tbody tr.lab-tape-pending').count() === 1, 'attempts table has exactly one pending row at progress 0');
    assert(await page.locator('.lab-tape-pending [data-lab-select], .lab-tape-pending [data-lab-preview]').count() === 0, 'pending row is not selectable or previewable');
    assert(await page.getByText('The first artifact appears here', { exact: false }).count() <= 1, 'first-artifact message appears at most once');
    await shot(page, 'run-running-0');
    await page.close();

    scenario.run = makeRun({ progress: 7 });
    page = await newScenario(context, scenario);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/#labrun/fixture-run`, { waitUntil: 'domcontentloaded' });
    await waitStrip(page, 'Generating attempt 8 of 15');
    const strip7 = await page.locator('.lab-status').innerText();
    assert(strip7.includes('Playable game') && strip7.includes('gemma3:12b'), 'attempt 8 strip names model 2 and task 3');
    const meter = await page.locator('.lab-status .meter i').getAttribute('style');
    assert(meter && meter.includes('47%'), 'progress meter reflects 7 of 15');
    const lastRow = await page.locator('.lab-tape tbody tr').last().getAttribute('class');
    assert(lastRow && lastRow.includes('lab-tape-pending'), 'pending row is last in the attempts table');
    assert(await page.locator('.lab-tape tbody tr').count() === 8, 'seven finished rows plus one pending row');
    await shot(page, 'run-running-7');

    /* 3: pausing, then paused (no spinner, resume available). */
    await page.locator('[data-lab-pause]').focus();
    scenario.run = makeRun({ state: 'pausing', progress: 7 });
    await waitStrip(page, 'Pausing after attempt 8 finishes');
    assert(await page.locator('.lab-status .spin').count() === 1, 'pausing strip still shows the spinner');
    assert(await page.evaluate(() => document.activeElement?.dataset.key === 'lab-toggle' && document.activeElement.getAttribute('aria-disabled') === 'true'), 'focus moves to the inert Pausing toggle instead of the page');
    scenario.run = makeRun({ state: 'paused', progress: 7 });
    await waitStrip(page, 'Paused after 7 of 15');
    assert(await page.locator('.lab-status .spin').count() === 0, 'paused strip has no spinner');
    assert((await page.locator('.lab-status').innerText()).includes('Resume to continue with attempt 8'), 'paused strip says which attempt resumes');
    assert(await page.locator('[data-lab-resume]').count() === 1, 'Resume button is present while paused');
    assert(await page.evaluate(() => document.activeElement?.dataset.key === 'lab-toggle' && document.activeElement.hasAttribute('data-lab-resume')), 'focus stays on the toggle once it becomes Resume');
    assert(await page.locator('.lab-tape-pending').count() === 0, 'paused run shows no pending row');
    await shot(page, 'run-paused-7');

    /* 6: focus stays on Pause and the strip keeps its node when nothing changes. */
    scenario.run = makeRun({ state: 'running', progress: 7 });
    await waitStrip(page, 'Generating attempt 8 of 15');
    await page.locator('[data-lab-pause]').focus();
    await page.evaluate(() => { window.__strip = document.querySelector('.lab-status'); });
    scenario.run = makeRun({ state: 'running', progress: 7 });
    await wait(3500);
    assert(await page.evaluate(() => document.querySelector('.lab-status') === window.__strip), 'unchanged poll keeps the strip DOM node');
    assert(await page.evaluate(() => document.activeElement?.hasAttribute('data-lab-pause')), 'Pause keeps focus across an unchanged poll');
    scenario.run = makeRun({ state: 'running', progress: 8 });
    await waitStrip(page, 'Generating attempt 9 of 15');
    assert(await page.evaluate(() => document.activeElement?.hasAttribute('data-lab-pause')), 'Pause keeps focus when progress changes');

    /* Cancel posts only to the Lab route; the Bench cancel handler must not fire. */
    await page.locator('[data-lab-cancel]').click();
    await wait(600);
    assert(report.postRequests.includes('/api/lab/runs/fixture-run/cancel'), 'Lab Cancel posts to the Lab cancel route');
    assert(!report.postRequests.some(item => item.startsWith('/api/runs/')), 'Lab Cancel never posts to the Bench cancel route');

    /* 4: completed. The strip and pending row disappear. */
    scenario.run = makeRun({ state: 'completed', progress: 15 });
    await page.waitForFunction(() => !document.querySelector('.lab-status') && !document.querySelector('.lab-tape-pending'), null, { timeout: 8000 });
    assert(await page.locator('.part-status .lab-status').count() === 0, 'completed run removes the status strip');
    assert(await page.locator('.lab-tape-pending').count() === 0, 'completed run removes the pending row');
    await page.close();

    /* 5: watcher outage while live shows the retry line and does not crash. */
    scenario.run = makeRun({ progress: 3 });
    scenario.runFail = false;
    page = await newScenario(context, scenario);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/#labrun/fixture-run`, { waitUntil: 'domcontentloaded' });
    await waitStrip(page, 'Generating attempt 4 of 15');
    scenario.runFail = true;
    await page.waitForSelector('.lab-status-retry', { timeout: 8000 });
    assert((await page.locator('.lab-status-retry').innerText()).includes('Lost contact with the server'), 'watcher outage shows the retry line');
    scenario.runFail = false;
    await page.waitForFunction(() => !document.querySelector('.lab-status-retry'), null, { timeout: 8000 });
    assert(await page.locator('.lab-status-retry').count() === 0, 'retry line clears when the server answers again');
    await page.close();

    /* Empty run: terminal with no attempts gives one clear message. */
    scenario.run = makeRun({ state: 'cancelled', progress: 0 });
    page = await newScenario(context, scenario);
    await page.goto(`${base}/#labrun/fixture-run`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.part-tape .empty');
    assert((await page.locator('.part-tape .empty').innerText()).includes('This run ended before any artifact was produced.'), 'cancelled run with no artifacts says so once');
    assert(await page.locator('.part-status .lab-status').count() === 0, 'cancelled run shows no strip');
    await page.close();

    /* 7 and 8: setup layout at desktop widths, then stacked widths. */
    scenario = { bench: benchSetup(), labSetup: labSetup(), runs: [] };
    for (const width of [2000, 1440]) {
      page = await newScenario(context, scenario);
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}/#lab`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-lab-start]');
      await page.waitForTimeout(300);
      const sheet = await box(page, '.part-sheet');
      const endpoints = await box(page, '.part-endpoints');
      const head = await box(page, '.part-head');
      const h1 = await box(page, '.part-head h1');
      const firstEndpoint = await box(page, '.part-endpoints .endpoint-head');
      const history = await box(page, '.part-history');
      const start = await box(page, '[data-lab-start]');
      assert(sheet.x >= endpoints.right - 1, `${width}px: setup rail sits beside the models`);
      assert(Math.abs(sheet.y - head.y) <= 2, `${width}px: setup rail starts level with the title`);
      assert(firstEndpoint.y - h1.bottom <= 80, `${width}px: title to first endpoint gap is 80px or less (${Math.round(firstEndpoint.y - h1.bottom)}px)`);
      assert(history.y <= Math.max(endpoints.bottom, sheet.bottom) + 2, `${width}px: past runs follow the content`);
      assert(start.y >= 0 && start.bottom <= 1000, `${width}px: Start lab run is visible in the first viewport`);
      if (width === 2000) await shot(page, 'setup-2000');
      await page.close();
    }

    /* 7b: 40 models keep the rail sticky and scrolling inside itself. */
    page = await newScenario(context, { bench: benchSetup(40), labSetup: labSetup(40), runs: [] });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/#lab`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-lab-start]');
    const railOverflow = await page.evaluate(() => {
      const rail = document.querySelector('.part-sheet');
      const style = getComputedStyle(rail);
      return { overflowY: style.overflowY, maxHeight: style.maxHeight, height: rail.getBoundingClientRect().height, position: style.position };
    });
    assert(railOverflow.position === 'sticky' && railOverflow.overflowY === 'auto', '40-model rail is sticky and scrolls internally');
    assert(railOverflow.height <= 1000 - 56 + 1, '40-model rail never exceeds the viewport');
    await shot(page, 'setup-40-models');
    await page.close();

    for (const width of [900, 390]) {
      page = await newScenario(context, { bench: benchSetup(), labSetup: labSetup(), runs: [] });
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/#lab`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-lab-start]');
      const endpoints = await box(page, '.part-endpoints');
      const sheet = await box(page, '.part-sheet');
      const history = await box(page, '.part-history');
      assert(sheet.y >= endpoints.bottom - 1 && history.y >= sheet.bottom - 1, `${width}px: setup stacks models, rail, then history`);
      if (width === 390) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
        assert(overflow, '390px setup has no horizontal scroll');
        await shot(page, 'setup-390');
      } else {
        await shot(page, 'setup-900');
      }
      await page.close();
    }

    /* 9, 10: run layout. */
    const completed = { bench: benchSetup(), labSetup: labSetup(), run: makeRun({ state: 'completed', progress: 15 }), runs: [] };
    completed.run.attempts.forEach(item => { item.autoChecks = [{ name: 'Fixture check', pass: true, detail: 'passed' }]; item.autoScore = 50; });
    completed.run.rollup = [
      { endpoint: 'Ollama 1', model: 'qwen3.5:4b', field: 'ui', total: 2, ok: 2, failed: 0, auto_score: 41.6, auto_collected: 2, buttons_ok: 1, playable_ok: 0, visuals: 3 },
      { endpoint: 'Ollama 1', model: 'qwen3.5:4b', field: 'coding', total: 2, ok: 2, failed: 0, auto_score: 100, auto_collected: 1, buttons_ok: 0, playable_ok: 0, visuals: 3 },
    ];
    page = await newScenario(context, completed);
    await page.setViewportSize({ width: 2000, height: 1000 });
    await page.goto(`${base}/#labrun/fixture-run`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.part-tape table');
    const inspect = await box(page, '.part-inspect');
    let rollup = await box(page, '.part-rollup');
    assert(Math.abs(rollup.y - inspect.bottom) <= 2 && Math.abs(rollup.w - inspect.w) <= 2, '2000px, no preview: measured rollup spans full width below the inspector');
    /* Measure the text, not the cell box: the cell always runs to the table edge, and its padding sits inside it. */
    const lastRollupText = await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.lab-rollup tbody tr:first-child td:last-child'));
      return range.getBoundingClientRect().right;
    });
    assert(2000 - lastRollupText >= 30, `2000px: Measured here last column keeps the page gutter (${Math.round(2000 - lastRollupText)}px)`);
    await shot(page, 'run-complete-2000-closed');
    await page.locator('.lab-tape [data-lab-preview="1"]').click();
    await page.waitForSelector('.part-preview iframe');
    await wait(300);
    const previewBox = await box(page, '.part-preview');
    const inspectOpen = await box(page, '.part-inspect');
    rollup = await box(page, '.part-rollup');
    assert(previewBox.h > 0 && Math.abs(previewBox.y - inspectOpen.bottom) <= 2, '2000px, preview open: preview sits under the inspector');
    assert(rollup.x >= inspectOpen.right - 1 && Math.abs(rollup.y - inspectOpen.y) <= 2, '2000px, preview open: Measured here sits beside the inspector');
    await shot(page, 'run-complete-2000-preview');
    await page.close();

    for (const width of [1320, 390]) {
      page = await newScenario(context, completed);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/#labrun/fixture-run`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.part-tape table');
      const parts = ['.part-head', '.part-tape', '.part-inspect', '.part-rollup'];
      const boxes = [];
      for (const selector of parts) boxes.push(await box(page, selector));
      const singleColumn = boxes.every(item => Math.abs(item.x) <= 1) && boxes.every((item, index) => index === 0 || item.y >= boxes[index - 1].y);
      assert(singleColumn, `${width}px run page stacks in one column`);
      if (width === 390) {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px run page has no horizontal scroll');
        await shot(page, 'run-complete-390');
      } else {
        await shot(page, 'run-complete-1320');
      }
      await page.close();
    }

    /* 11: loading states. */
    scenario = { bench: benchSetup(), labSetup: labSetup(), run: makeRun({ state: 'completed', progress: 15 }), runs: [], runDelay: 1500 };
    page = await newScenario(context, scenario);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/#labrun/fixture-run`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.part-head .spin', { timeout: 3000 });
    assert((await page.locator('.part-head h1').innerText()).includes('Opening lab run.'), 'slow run load shows the opening state');
    await page.waitForSelector('.part-tape table', { timeout: 6000 });
    assert(await page.locator('.part-head .spin').count() === 0, 'opening spinner clears once the run loads');
    await page.close();

    scenario = { bench: benchSetup(), labSetup: labSetup(), runs: [makeRun({ state: 'completed', progress: 15 })], runsDelay: 1500 };
    page = await newScenario(context, scenario);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/#lab`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lab-history .spin', { timeout: 3000 });
    const loadingText = await page.locator('.lab-history').innerText();
    assert(loadingText.includes('Loading past lab runs…') && !loadingText.includes('No lab runs yet'), 'past runs show a loading state, never "No lab runs yet"');
    await page.waitForSelector('.lab-history table', { timeout: 6000 });
    assert(!(await page.locator('.lab-history').innerText()).includes('Loading past lab runs'), 'past runs loading state clears when loaded');
    await page.close();

    report.finishedAt = new Date().toISOString();
    const unexpectedConsole = report.consoleErrors;
    assert(report.pageErrors.length === 0, 'no page errors');
    assert(unexpectedConsole.length === 0, 'no console errors');
    assert(report.failedRequests.length === 0, 'no unexpected failed requests');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`PASS ${report.assertions.length} assertions`);
  } catch (error) {
    report.failure = error.message;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.error('FAIL', error.message);
    process.exitCode = 1;
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main();
