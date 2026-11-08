/* Repeatable browser acceptance run. Install playwright-core outside the app
   runtime, then run with LAB_E2E_REAL=1 for a five-task live inference run. */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('module').Module._initPaths();
const { chromium } = require('playwright-core');
const base = (process.env.LAB_E2E_BASE || 'http://100.81.131.14:8090').replace(/\/$/, '');
const endpointUrl = process.env.LAB_E2E_ENDPOINT || 'http://100.84.10.124:11434/v1';
const modelId = process.env.LAB_E2E_MODEL || 'qwen3.5:4b';
const real = process.env.LAB_E2E_REAL === '1';
const output = path.resolve('artifacts/lab-acceptance');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync('/dev/shm/lab-e2e-profile-');
const report = { base, endpointUrl, modelId, real, startedAt: new Date().toISOString(), assertions: [], consoleErrors: [], failedRequests: [], fixtureResults: [] };
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
  report.assertions.push(message);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let context;

async function api(page, route, init) {
  const response = await page.request.fetch(`${base}${route}`, init);
  const value = await response.json().catch(() => ({}));
  return { status: response.status(), value };
}

async function harnessFixtures(page) {
  const cases = [
    { name: 'working button', body: '<button id="b">Do it</button><p id="state"></p><script>document.querySelector("#b").onclick=()=>document.querySelector("#state").textContent="done"</script>', check: r => r.buttons[0]?.changedDom === true },
    { name: 'inert button', body: '<button>Do nothing</button>', check: r => r.buttons[0]?.changedDom === false },
    { name: 'throwing button', body: '<button id="b">Throw</button><script>document.querySelector("#b").onclick=()=>{throw new Error("fixture click")}</script>', check: r => r.buttons[0]?.threwException === true },
    { name: 'early script exception', head: '<script>throw new Error("fixture early")</script>', body: '<p>page</p>', check: r => r.errors >= 1 },
    { name: 'static canvas', body: '<canvas width="40" height="40"></canvas>', check: r => r.canvas === true && r.animation === false },
    { name: 'animated canvas', body: '<canvas id="c" width="40" height="40"></canvas><script>const c=document.querySelector("#c"),x=c.getContext("2d");function tick(t){x.clearRect(0,0,40,40);x.fillRect(t%30,0,10,10);requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>', check: r => r.canvas === true && r.animation === true },
    { name: 'link does not navigate', body: '<a id="link" href="https://example.com">go</a><p id="done"></p><script>document.querySelector("#link").onclick=()=>document.querySelector("#done").textContent="clicked"</script>', check: (r, frameUrl) => r.buttons[0]?.changedDom === true && !frameUrl.includes('example.com') },
    { name: 'input validity', body: '<input id="email" required type="email">', check: r => r.inputFound === true && r.inputValid === false && Boolean(r.inputValidationMessage) },
    { name: 'incorrect dashboard rows', body: '<table><tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody></table>', check: r => r.rowCount === 2 },
  ];
  for (const item of cases) {
    const token = `fixture-${item.name.replace(/\W/g, '-')}`;
    const beforeErrors = report.consoleErrors.length;
    await page.setContent(`<!doctype html><html><body><script>window.__labFixtureResults=[];addEventListener('message',event=>{if(event.data?.source==='lab-harness')window.__labFixtureResults.push(event.data)})</script><iframe id="lab-fixture" sandbox="allow-scripts"></iframe></body></html>`, { waitUntil: 'load' });
    const harnessUrl = `${base}/assets/lab-harness.js?labRun=${encodeURIComponent(token)}&attempt=1&nonce=${encodeURIComponent(token)}`;
    const doc = `<!doctype html><html><head><script src="${harnessUrl}"></script>${item.head || ''}</head><body>${item.body}</body></html>`;
    await page.locator('#lab-fixture').evaluate((frame, html) => { frame.srcdoc = html; }, doc);
    await page.waitForFunction(() => window.__labFixtureResults?.length > 0, null, { timeout: 9000 });
    const result = await page.evaluate(() => window.__labFixtureResults.at(-1));
    const passes = result.runId === token && result.nonce === token && item.check(result, page.frames().at(-1)?.url());
    await page.waitForTimeout(300);
    const oneMessage = await page.evaluate(() => window.__labFixtureResults.length === 1);
    assert(oneMessage, `harness fixture: ${item.name} reports once`);
    const fixtureErrors = report.consoleErrors.splice(beforeErrors);
    report.fixtureResults.push({ name: item.name, passes, frameUrl: page.frames().at(-1)?.url(), errors: fixtureErrors, result });
    assert(passes, `harness fixture: ${item.name}`);
  }
}

async function waitForRun(page, runId, timeoutMs) {
  const started = Date.now();
  let refreshed = false;
  let pauseSent = false;
  while (Date.now() - started < timeoutMs) {
    const { status, value } = await api(page, `/api/lab/runs/${encodeURIComponent(runId)}`);
    if (status !== 200) throw new Error(`run poll returned HTTP ${status}`);
    if (!refreshed && value.progress >= 1) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      refreshed = true;
    }
    if (real && !pauseSent && value.state === 'running' && value.progress === 0) {
      await wait(1000);
      const pauseButton = page.locator('[data-lab-pause]');
      if (await pauseButton.count()) await pauseButton.click();
      else {
        const pause = await api(page, `/api/lab/runs/${encodeURIComponent(runId)}/pause`, { method: 'POST' });
        assert(pause.status === 200, 'live run enters pausing');
      }
      assert(true, 'live run pause control was exercised');
      pauseSent = true;
      // Long generations are normal for local models; keep the pause exercise
      // bounded above the model's known multi-minute response time.
      const pauseDeadline = Date.now() + 12 * 60 * 1000;
      let paused;
      do {
        await wait(1000);
        paused = (await api(page, `/api/lab/runs/${encodeURIComponent(runId)}`)).value;
      } while (paused.state === 'pausing' && Date.now() < pauseDeadline);
      assert(paused.state === 'paused', 'inference boundary persists paused state');
      await page.waitForSelector('[data-lab-resume]', { timeout: 10000 });
      await page.locator('[data-lab-resume]').click();
      const resumed = (await api(page, `/api/lab/runs/${encodeURIComponent(runId)}`)).value;
      assert(resumed.state === 'running', 'paused run resumes through the browser control');
    }
    if (['completed', 'cancelled', 'failed', 'interrupted'].includes(value.state)) return value;
    await wait(2000);
  }
  throw new Error(`run ${runId} did not finish within ${timeoutMs / 1000}s`);
}

async function inspectArtifact(page, run, attempt) {
  await page.locator(`[data-lab-select="${attempt}"]`).click();
  const previewButton = page.locator(`.part-inspect [data-lab-preview="${attempt}"]`).first();
  const frameNavigations = [];
  const onFrameNavigated = frame => {
    if (frame.url().includes(`/api/lab/runs/${run.id}/artifacts/${attempt}`)) frameNavigations.push(frame.url());
  };
  page.on('framenavigated', onFrameNavigated);
  await previewButton.click();
  const frameSelector = `iframe[data-lab-frame="${attempt}"]`;
  await page.locator(frameSelector).waitFor({ state: 'attached', timeout: 10000 });
  const frame = page.frameLocator(frameSelector);
  const loading = await frame.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  const iframeAttrs = await page.locator(frameSelector).evaluate(node => ({ sandbox: node.getAttribute('sandbox'), title: node.title, src: node.src }));
  assert(iframeAttrs.sandbox === 'allow-scripts' && iframeAttrs.title.length > 0, `attempt ${attempt} preview is sandboxed and titled`);
  const previewResponse = await page.request.get(iframeAttrs.src);
  const previewHtml = await previewResponse.text();
  assert(previewResponse.status() === 200 && previewResponse.headers()['content-security-policy'] === 'sandbox allow-scripts', `attempt ${attempt} preview returns isolated HTML`);
  assert((previewHtml.match(/lab-harness\.js/g) || []).length === 1, `attempt ${attempt} preview injects one harness`);
  const storedPreviewHtml = previewHtml.replace(/<script src="\/assets\/lab-harness\.js\?expectedRows=\d+"><\/script>/, '');
  const rawResponse = await page.request.get(`${base}/api/lab/artifacts/${run.id}/${attempt}/raw`);
  const rawHtml = await rawResponse.text();
  assert(rawResponse.status() === 200 && !rawHtml.includes('lab-harness.js') && rawHtml === storedPreviewHtml, `attempt ${attempt} raw preview excludes harness and matches stored body`);
  const settledFrameNavigations = frameNavigations.length;
  await page.waitForFunction(attempt => {
    const row = [...document.querySelectorAll('.lab-tape tr')].find(node => node.querySelector(`[data-lab-select="${attempt}"]`));
    return row && row.textContent;
  }, attempt);
  await page.waitForTimeout(9000);
  const checks = (await api(page, `/api/lab/runs/${run.id}`)).value.attempts.find(row => row.attempt === attempt)?.auto;
  const reportAttempt = { attempt, task: run.attempts.find(row => row.attempt === attempt)?.task, bodySample: loading.slice(0, 500), previewBytes: previewHtml.length, rawBytes: rawHtml.length, checks };
  if (reportAttempt.task === 'dashboard' && await frame.locator('tbody tr').count()) {
    const rowText = () => frame.locator('tbody tr').allTextContents();
    const expectedRows = [
      ['Berlin', 5.9, 7], ['Lisbon', 2.2, 3], ['Oslo', 4.4, 6], ['Athens', 0.8, 1],
    ];
    const observedRows = await frame.locator('tbody tr').evaluateAll(rows => rows.map(row =>
      [...row.querySelectorAll('td')].map(cell => cell.textContent.trim())));
    const matchesTaskData = observedRows.length === expectedRows.length && expectedRows.every(([city, rain, days]) =>
      observedRows.some(row => row[0] === city && Number(row[1]) === rain && Number(row[2]) === days));
    reportAttempt.dashboardData = { expectedRows, observedRows, matchesTaskData };
    assert(matchesTaskData, 'dashboard rows match all four task data records');
    const numericValues = rows => rows.map(text => Number(text.match(/\d+(?:\.\d+)?/g)?.[0]));
    const initialRows = await rowText();
    await frame.getByRole('button', { name: 'Sort by rain' }).click();
    const rainRows = await rowText();
    const rainValues = numericValues(rainRows);
    const rainAscending = rainValues.every((value, index) => index === 0 || rainValues[index - 1] <= value);
    await frame.getByRole('button', { name: 'Sort by days' }).click();
    const dayRows = await rowText();
    const dayValues = dayRows.map(text => Number(text.match(/\d+(?:\.\d+)?/g)?.at(-1)));
    const daysAscending = dayValues.every((value, index) => index === 0 || dayValues[index - 1] <= value);
    await frame.getByRole('button', { name: 'Sort by days' }).click();
    const repeatedDaysRows = await rowText();
    const repeatedDaysReversed = repeatedDaysRows.join('|') === [...dayRows].reverse().join('|');
    reportAttempt.dashboardSort = { initialRows, rainRows, dayRows, repeatedDaysRows, rainAscending, daysAscending, repeatedDaysReversed };
    assert(rainAscending, 'dashboard rain sort orders all four rows ascending');
    assert(daysAscending, 'dashboard days sort orders all four rows ascending');
    assert(!repeatedDaysReversed, 'dashboard limitation recorded: repeated sort does not reverse row order');
  }
  const safeName = `attempt-${attempt}.png`;
  await page.locator(frameSelector).screenshot({ path: path.join(output, safeName), timeout: 3000 }).catch(() => {});
  const popupPromise = page.waitForEvent('popup');
  await page.locator(`.part-inspect a[href$="/${attempt}/raw"]`).first().click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  assert(!await popup.locator('script[src*="lab-harness"]').count(), `attempt ${attempt} full preview is raw`);
  await popup.close();
  const sameFrame = await page.locator(frameSelector).evaluate((node, expectedSrc) => node.isConnected && node.src === expectedSrc, iframeAttrs.src) && frameNavigations.length === settledFrameNavigations;
  assert(sameFrame, `attempt ${attempt} iframe survives refresh/check updates`);
  page.off('framenavigated', onFrameNavigated);
  return reportAttempt;
}

async function main() {
  const browser = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROME_BIN || '/home/linuxpc/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
    viewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  context = browser;
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  const savedBench = (await api(page, '/api/bench/setup')).value;
  const savedLab = (await api(page, '/api/lab/setup')).value;
  const runsBefore = (await api(page, '/api/lab/runs')).value.map(run => run.id);
  report.savedBench = savedBench;
  report.savedLab = savedLab;
  report.runsBefore = runsBefore;
  try {
    await page.goto(`${base}/#lab`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-nav="lab"].active');
    assert(await page.locator('[data-nav="lab"]').getAttribute('aria-current') === 'page', 'Lab navigation is highlighted');
    await page.screenshot({ path: path.join(output, 'lab-desktop.png'), fullPage: true });
    await harnessFixtures(page);
    // setContent replaces the document but keeps its URL. Force a full load so
    // the app scripts are evaluated again before testing the application routes.
    await page.goto(`${base}/?lab-e2e=${Date.now()}#lab`, { waitUntil: 'domcontentloaded' });

    // Existing pages remain routable and display without app-level JS errors.
    for (const route of ['bench', 'runs', 'datasets', 'compare', 'lab']) {
      await page.goto(`${base}/#${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);
      assert(await page.locator(`[data-nav="${route}"]`).getAttribute('aria-current') === 'page', `${route} navigation renders`);
    }
    if (!real) {
      const latest = process.env.LAB_E2E_RUN_ID || runsBefore[0];
      if (latest) {
        await page.goto(`${base}/#labrun/${latest}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.part-head h1');
        const run = (await api(page, `/api/lab/runs/${latest}`)).value;
        report.runId = latest;
        report.runState = run.state;
        report.attempts = run.attempts.map(item => ({ attempt: item.attempt, field: item.field, task: item.task,
          status: item.status, elapsed: item.elapsed, tokens: item.tokens, reason: item.reason,
          wrapped: item.wrapped, truncated: item.truncated, auto: item.auto, review: item.review }));
        await page.screenshot({ path: path.join(output, 'lab-run-desktop.png'), fullPage: true });
        for (const attempt of run.attempts.filter(item => item.status === 'ok' && item.field !== 'extras')) {
          const evidence = await inspectArtifact(page, run, attempt.attempt);
          report.artifacts ||= [];
          report.artifacts.push(evidence);
          const reloaded = (await api(page, `/api/lab/runs/${latest}`)).value;
          const checks = reloaded.attempts.find(item => item.attempt === attempt.attempt);
          if (evidence.checks?.collected === true) {
            assert(checks?.auto?.collected === true, `attempt ${attempt.attempt} harness checks persist`);
          } else {
            assert(checks?.auto?.collected === false && checks.auto.errors === null && checks.autoScore == null,
              `attempt ${attempt.attempt} remains explicitly uncollected with no auto score`);
          }
        }
        const reviewCases = [
          { attempt: 1, visuals: 3, buttons: 'yes' },
          { attempt: 2, visuals: 3, buttons: 'no' },
          { attempt: 3, playable: 'no' },
          { attempt: 4, visuals: 3 },
        ];
        for (const review of reviewCases) {
          await page.locator(`[data-lab-select="${review.attempt}"]`).click();
          if (review.visuals) await page.locator(`[data-lab-review-visuals="${review.visuals}"]`).click();
          if (review.buttons) await page.locator(`[data-lab-review-buttons="${review.buttons}"]`).click();
          if (review.playable) await page.locator(`[data-lab-review-playable="${review.playable}"]`).click();
          await page.waitForFunction(async ({ base, latest, attempt, expected }) => {
            const run = await fetch(`${base}/api/lab/runs/${latest}`).then(response => response.json());
            const item = run.attempts.find(row => row.attempt === attempt);
            return Object.entries(expected).every(([key, value]) => item?.review?.[key] === value);
          }, { base, latest, attempt: review.attempt, expected: review }, { timeout: 8000 });
          assert(true, `human review for attempt ${review.attempt} persists through the UI`);
        }
        // Partial review updates merge and retain existing fields.
        await page.request.post(`${base}/api/lab/runs/${latest}/review`, { data: { attempt: 1, buttons: 'no' } });
        await page.request.post(`${base}/api/lab/runs/${latest}/review`, { data: { attempt: 1, buttons: 'yes' } });
        const mergedReview = (await api(page, `/api/lab/runs/${latest}`)).value.attempts.find(item => item.attempt === 1).review;
        assert(mergedReview.visuals === 3 && mergedReview.buttons === 'yes', 'partial review update preserves other review fields');
        const afterReload = (await api(page, `/api/lab/runs/${latest}`)).value;
        report.checksAfter = afterReload.attempts.map(item => ({ attempt: item.attempt, auto: item.auto, review: item.review }));
        await page.reload({ waitUntil: 'domcontentloaded' });
        assert(await page.locator('[data-nav="lab"].active').count() === 1, 'saved Lab run reconnects after refresh');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(output, 'lab-run-mobile-390.png'), fullPage: true });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Lab run fits 390px viewport');
      }
      return;
    }

    // Connect via Bench's normal discovery form, then use that saved connection in Lab.
    await page.goto(`${base}/#bench`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="name"]').fill('Lab verification');
    await page.locator('input[name="url"]').fill(endpointUrl);
    await page.getByRole('button', { name: 'Discover models' }).click();
    const modelCheckbox = page.locator(`input[data-endpoint][value="${modelId}"]`).first();
    await modelCheckbox.waitFor({ state: 'attached', timeout: 20000 });
    assert(await modelCheckbox.isVisible(), `Bench discovery found ${modelId}`);
    const capabilities = await page.request.post(`${base}/api/models`, { data: { name: 'Lab verification', url: endpointUrl } }).then(r => r.json()).catch(() => []);
    report.discovered = capabilities;
    await modelCheckbox.check();
    await page.waitForFunction(async ({ base, modelId }) => {
      const saved = await fetch(`${base}/api/bench/setup`).then(r => r.json());
      return saved.endpoints?.some(endpoint => endpoint.name === 'Lab verification' && endpoint.models?.includes(modelId));
    }, { base, modelId });
    assert(true, 'Bench connection and selected model persist');

    await page.goto(`${base}/#lab`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-lab-model]').first().waitFor({ state: 'attached', timeout: 15000 });
    assert(await page.locator('[data-lab-start]').isDisabled(), 'Start is blocked before a model is selected');
    const labModel = page.locator(`input[data-lab-model][value="${modelId}"]`);
    await labModel.check();
    const extras = page.locator('input[data-lab-field][value="extras"]');
    await extras.uncheck();
    assert((await page.locator('.sheet-foot .tally').innerText()).includes('4 attempts'), 'field toggle reduces tally to four');
    await extras.check();
    assert((await page.locator('.sheet-foot .tally').innerText()).includes('5 attempts'), 'all fields tally five attempts');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(`input[data-lab-model][value="${modelId}"]`).waitFor({ state: 'attached' });
    assert(await page.locator(`input[data-lab-model][value="${modelId}"]`).isChecked(), 'Lab model selection persists across reload');
    assert((await page.locator('.sheet-foot .tally').innerText()).includes('5 attempts'), 'Lab fields and tally persist across reload');
    await page.screenshot({ path: path.join(output, 'lab-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'lab-mobile-390.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Lab setup fits 390px viewport');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Start lab run' }).click();
    await page.waitForURL(/#labrun\//, { timeout: 20000 });
    const runId = new URL(page.url()).hash.split('/')[1];
    report.runId = runId;
    const created = (await api(page, `/api/lab/runs/${runId}`)).value;
    assert(created.total === 5 && created.state !== 'failed', 'five-task real run is created');
    const conflict = await page.request.post(`${base}/api/lab/runs`, { data: { endpoints: [{ name: 'Lab verification', url: endpointUrl, models: [modelId] }], fields: ['extras'] } });
    assert(conflict.status() === 409 && (await conflict.json()).detail === 'A lab run is already active.', 'second active run is rejected with HTTP 409');
    report.progressEvents = [];
    const finalRun = await waitForRun(page, runId, 60 * 60 * 1000);
    report.progress = `${finalRun.progress}/${finalRun.total}`;
    report.state = finalRun.state;
    report.attempts = finalRun.attempts.map(item => ({ attempt: item.attempt, field: item.field, task: item.task, status: item.status, elapsed: item.elapsed, tokens: item.tokens, reason: item.reason, wrapped: item.wrapped, truncated: item.truncated, auto: item.auto, review: item.review }));
    assert(finalRun.progress === 5 && finalRun.total === 5, 'real run progress completes 5/5');
    assert(finalRun.state === 'completed', `real run reaches completed (state=${finalRun.state})`);
    const invalidPause = await page.request.post(`${base}/api/lab/runs/${runId}/pause`);
    assert(invalidPause.status() === 409, 'completed run rejects an invalid pause transition');
    const runState = await api(page, `/api/lab/runs/${runId}`);
    assert(runState.status === 200, 'run remains persisted after refresh');

    await page.goto(`${base}/#labrun/${runId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lab-tape');
    let latest = (await api(page, `/api/lab/runs/${runId}`)).value;
    for (const attempt of latest.attempts.filter(item => item.status === 'ok' && item.field !== 'extras')) {
      const evidence = await inspectArtifact(page, latest, attempt.attempt);
      report.artifacts ||= [];
      report.artifacts.push(evidence);
      const reloaded = (await api(page, `/api/lab/runs/${runId}`)).value;
      const checkedAttempt = reloaded.attempts.find(item => item.attempt === attempt.attempt);
      if (evidence.checks?.collected === true) {
        assert(checkedAttempt?.auto?.collected === true, `attempt ${attempt.attempt} harness checks persist`);
      } else {
        assert(checkedAttempt?.auto?.collected === false && checkedAttempt.auto.errors === null && checkedAttempt.autoScore == null,
          `attempt ${attempt.attempt} remains explicitly uncollected with no auto score`);
      }
    }

    // Reloaded detail includes the persisted human review/control state.
    latest = (await api(page, `/api/lab/runs/${runId}`)).value;
    report.checksAfter = latest.attempts.map(item => ({ attempt: item.attempt, auto: item.auto }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert(await page.locator('[data-nav="lab"].active').count() === 1, 'refresh reconnects to the same Lab run');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'lab-run-mobile-390.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Lab run fits 390px viewport');

    // One bounded real-model extras attempt exercises cancellation while active.
    const cancelCreate = await page.request.post(`${base}/api/lab/runs`, { data: { endpoints: [{ name: 'Lab verification', url: endpointUrl, models: [modelId] }], fields: ['extras'] } });
    assert(cancelCreate.status() === 202, 'bounded cancellation run is accepted after the main run completes');
    const cancelId = (await cancelCreate.json()).id;
    report.cancelRunId = cancelId;
    let cancelState;
    const cancelDeadline = Date.now() + 20000;
    do {
      cancelState = (await api(page, `/api/lab/runs/${cancelId}`)).value;
      if (cancelState.state === 'running') break;
      await wait(100);
    } while (Date.now() < cancelDeadline);
    assert(cancelState.state === 'running', 'bounded cancel run reaches active inference');
    const cancelled = await page.request.post(`${base}/api/lab/runs/${cancelId}/cancel`);
    const cancelledPayload = await cancelled.json();
    assert(cancelled.status() === 200 && cancelledPayload.state === 'cancelled', 'active inference accepts cancellation');
    let cancelledRun;
    const cancelFinishDeadline = Date.now() + 12 * 60 * 1000;
    do {
      cancelledRun = (await api(page, `/api/lab/runs/${cancelId}`)).value;
      if (cancelledRun.state === 'cancelled' && cancelledRun.progress === 1) break;
      await wait(1000);
    } while (Date.now() < cancelFinishDeadline);
    assert(cancelledRun.state === 'cancelled' && cancelledRun.progress === 1, 'cancel preserves the in-flight attempt result and cancelled state');
  } finally {
    if (report.runId) {
      const current = await api(page, `/api/lab/runs/${report.runId}`).catch(() => null);
      if (current?.value && !['completed', 'cancelled', 'failed', 'interrupted'].includes(current.value.state)) {
        await page.request.post(`${base}/api/lab/runs/${report.runId}/cancel`).catch(() => {});
      }
    }
    // Restore only the setup snapshots; new run data/reviews/artifacts remain.
    await page.request.put(`${base}/api/bench/setup`, { data: savedBench }).catch(() => {});
    await page.request.put(`${base}/api/lab/setup`, { data: savedLab }).catch(() => {});
    report.finishedAt = new Date().toISOString();
    report.expectedAbortRequests = report.failedRequests.filter(item => item.url.includes('/api/lab/runs/') && item.url.endsWith('/events') && item.error === 'net::ERR_ABORTED');
    report.failedRequests = report.failedRequests.filter(item => !report.expectedAbortRequests.includes(item));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  report.failure = error.stack || error.message;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (context) context.close().catch(() => {});
  if (fs.existsSync(profile)) fs.rmSync(profile, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
