/* Execution lab: benches artifacts that run in the browser (frontend side).
   Rendered through the shared paint()/route() machinery from app.js, which is
   loaded after this file, so nothing here reads app.js globals at top level. */

const LAB_FIELDS = ['ui', 'coding', 'extras'];
const LAB_FIELD_LABELS = { ui: 'UI', coding: 'Coding', extras: 'Extras' };
const LAB_STATES = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
const LAB_NOTE = 'Lab checks run generated web artifacts in your browser with limited coverage, and human verdicts come from a single reviewer looking at one attempt. These results are not a validated benchmark.';
const LAB_TASK_TITLES = [
  { field: 'ui', key: 'landing', title: 'Product landing page' },
  { field: 'ui', key: 'widget', title: 'Interactive widget' },
  { field: 'coding', key: 'game', title: 'Playable game' },
  { field: 'coding', key: 'dashboard', title: 'Sort dashboard' },
  { field: 'extras', key: 'json', title: 'JSON aggregation' },
];
const labTasksFor = fields => LAB_TASK_TITLES.filter(task => fields.includes(task.field));

const labState = {
  ready: false,
  fields: [...LAB_FIELDS],
  models: [],
  startError: '',
  starting: false,
  runs: [],
  runsError: '',
  runsLoading: false,
  runsLoaded: false,
  setupLoading: false,
  watchError: '',
  active: null,
  activeId: '',
  activeError: '',
  attempt: null,
  preview: null,
  previewState: {},
  previewOpenedAt: {},
  pendingChecks: new Map(),
  checksSaved: new Set(),
  checksInFlight: new Set(),
  checksTries: new Map(),
  checksErrors: {},
};

/* ------------------------------- Data ------------------------------- */

async function labApi(path, options = {}) {
  const response = await fetch('/api/lab' + path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({ detail: response.statusText }));
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
    throw Error(detail || data.error || `Request failed (${response.status})`);
  }
  return data;
}

async function loadLabSetup() {
  labState.setupLoading = true;
  try {
    const setup = await labApi('/setup');
    labState.fields = Array.isArray(setup.fields) ? setup.fields.filter(field => LAB_FIELDS.includes(field)) : [...LAB_FIELDS];
    labState.models = (setup.models || []).filter(entry => entry && entry.name && entry.url && Array.isArray(entry.models));
    labState.ready = true;
  } catch { /* defaults stay */ } finally {
    labState.setupLoading = false;
  }
}

async function saveLabSetup() {
  try {
    await labApi('/setup', { method: 'PUT', body: JSON.stringify({ models: labState.models, fields: labState.fields }) });
  } catch { /* the next change retries the save */ }
}

async function loadLabRuns() {
  labState.runsLoading = true;
  try {
    labState.runs = await labApi('/runs');
    labState.runsError = '';
  } catch (error) {
    labState.runsError = error.message;
  } finally {
    labState.runsLoading = false;
    labState.runsLoaded = true;
  }
}

/* ------------------------------ Watching ----------------------------- */

let labWatcher = null;

function labStopWatching() {
  if (!labWatcher) return;
  labWatcher.events?.close();
  clearInterval(labWatcher.timer);
  labWatcher = null;
}

function labRefresh(id) {
  return async () => {
    if (labWatcher?.id !== id) return;
    try {
      const run = await labApi('/runs/' + id);
      if (labWatcher?.id !== id && labState.activeId !== id) return;
      labState.active = run;
      labState.activeError = '';
      labState.watchError = '';
      if (LAB_STATES.has(run.state)) {
        labStopWatching();
        await loadLabRuns();
      }
    } catch (error) {
      if (labWatcher?.id !== id && labState.activeId !== id) return;
      labState.activeError = error.message;
      labState.watchError = error.message;
    }
    if (route().view === 'labrun') render();
  };
}

function labWatchRun(id) {
  if (labWatcher?.id === id) return;
  labStopWatching();
  labWatcher = { id, busy: false };
  const refresh = labRefresh(id);
  const bindRefresh = (source) => () => {
    const watcher = labWatcher;
    if (!watcher || watcher.busy) return;
    watcher.busy = true;
    refresh().finally(() => { watcher.busy = false; });
  };
  labWatcher.events = new EventSource(`/api/lab/runs/${encodeURIComponent(id)}/events`);
  labWatcher.events.addEventListener('progress', bindRefresh('progress'));
  labWatcher.events.onerror = () => {};
  labWatcher.timer = setInterval(bindRefresh('timer'), 2500);
  refresh();
}

/* Reopen a saved run the user navigates to from the lab list. */
async function labOpenForReview(id) {
  try {
    const run = await labApi('/runs/' + id);
    if (labState.activeId !== id) return;
    labState.active = run;
    labState.activeId = id;
    labState.activeError = '';
    run.attempts.forEach(item => {
      if (item.auto && typeof item.auto.collected === 'boolean') labState.checksSaved.add(`${id}:${item.attempt}`);
    });
  } catch (error) {
    labState.activeError = error.message;
    labState.active = null;
  }
}

/* ------------------------------ Route hook --------------------------- */

async function labSyncRoute(view, id) {
  if (view === 'labrun') {
    if (labState.activeId !== id) {
      labState.activeId = id;
      labState.active = null;
      labState.attempt = null;
      labState.preview = null;
      labState.previewState = {};
      labState.previewNonce = '';
      labState.pendingChecks.clear();
      labState.checksErrors = {};
      labState.activeError = '';
      labState.watchError = '';
      render();
      await labOpenForReview(id);
    }
    labWatchRun(id);
    render();
    return;
  }
  // #lab: paint the loading state at once, then fill in the saved setup and runs.
  labStopWatching();
  labState.runsLoading = true;
  labState.setupLoading = !labState.ready;
  render();
  if (!labState.ready) await loadLabSetup();
  await loadLabRuns();
  render();
}

/* Recently finished lab runs, listed under the setup pane. */
function labList() {
  let body;
  if (labState.runsError) body = `<div class="empty"><p class="error" role="alert">${esc(labState.runsError)}</p></div>`;
  else if (labState.runsLoading && !labState.runsLoaded) body = '<div class="empty"><p class="lab-loading" role="status"><i class="spin" aria-hidden="true"></i>Loading past lab runs…</p></div>';
  else if (!labState.runs.length) body = '<div class="empty"><p>No lab runs yet. Start one above to build artifacts with your models.</p></div>';
  else {
    const rows = labState.runs.map(run => {
      const live = !LAB_STATES.has(run.state);
      const share = run.total ? Math.round(run.progress * 100 / run.total) : 0;
      return `<tr>
        <td><a href="#labrun/${esc(run.id)}">${esc(when(run.created))}</a></td>
        <td><span class="run-state ${live ? 'is-live' : ''} ${run.state === 'failed' ? 'is-failed' : ''}">${esc(run.state)}</span></td>
        <td style="width:40%"><span class="meter" role="img" aria-label="${share}% finished"><i style="width:${share}%"></i></span></td>
        <td class="num">${run.progress.toLocaleString()} of ${run.total.toLocaleString()}</td>
      </tr>`;
    }).join('');
    body = `<div class="table-wrap"><table class="run-table">
      <thead><tr><th>Started</th><th>State</th><th>Progress</th><th class="num">Attempts</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }
  return `<section class="lab-history" aria-label="Lab run history">
    <div class="block-head"><h2>Past lab runs</h2><span>Artifacts and reviews are kept on this server</span></div>
    ${body}
  </section>`;
}

/* ------------------------------- Setup view -------------------------- */

function labSelectionFor(url) {
  return labState.models.find(entry => entry.url === url) || null;
}

function labHasModel(url, modelId) {
  const entry = labSelectionFor(url);
  return Boolean(entry && entry.models.includes(modelId));
}

function labToggleModel(url, name, modelId, checked) {
  let entry = labSelectionFor(url);
  if (checked) {
    if (!entry) {
      entry = { name, url, models: [] };
      labState.models.push(entry);
    }
    if (!entry.models.includes(modelId)) entry.models.push(modelId);
  } else if (entry) {
    entry.models = entry.models.filter(id => id !== modelId);
    if (!entry.models.length) labState.models = labState.models.filter(item => item !== entry);
  }
}

function labCount() {
  return labState.models.reduce((sum, entry) => sum + entry.models.length, 0);
}

function labAttemptsCount() {
  return labTasksFor(labState.fields).length * labCount();
}

function labBlocker() {
  if (!labCount()) return 'Choose one or more models here to begin, using the endpoints connected on Bench.';
  if (!labState.fields.length) return 'Choose at least one field.';
  return '';
}

function labEndpointSection(endpoint) {
  const rows = endpoint.found.map(model => {
    const checked = labHasModel(endpoint.url, model.id);
    return `<li><label class="check">
      <input type="checkbox" data-lab-model data-url="${esc(endpoint.url)}" data-name="${esc(endpoint.name)}" value="${esc(model.id)}" ${checked ? 'checked' : ''} ${labState.setupLoading ? 'disabled' : ''}>
      <code>${esc(model.id)}</code>
      <small>${esc(model.owned_by || '')}</small>
    </label></li>`;
  }).join('');
  const entry = labSelectionFor(endpoint.url);
  const ticked = entry ? entry.models.length : 0;
  return `<section class="endpoint" aria-label="${esc(endpoint.name)} in the lab">
    <header class="endpoint-head">
      <strong>${esc(endpoint.name)}</strong>
      <code>${esc(endpoint.url)}</code>
      <span>${ticked} of ${endpoint.found.length} ticked</span>
    </header>
    ${rows ? `<ul class="model-rows">${rows}</ul>` : '<p class="start-hint">This endpoint lists no models.</p>'}
  </section>`;
}

function labView() {
  const connected = state.endpoints.length > 0;
  const sections = connected && state.endpoints.some(endpoint => endpoint.found.length)
    ? state.endpoints.map(labEndpointSection).join('') : '';
  return {
    head: `<div class="pane compact">
      <h1>Execution lab.</h1>
      <p class="lead">Bench models on tasks whose output runs in your browser: build a page, build a game, and keep what loads clean. Uses the endpoints discovered on <a class="text-link" href="#bench">Bench</a>.</p>
      ${!connected ? '<div class="empty"><p>No endpoints connected yet.</p><a class="button" href="#bench">Connect on Bench</a></div>' :
        !sections ? '<p class="start-hint">Your endpoints list no lab-able models.</p>' : ''}
    </div>`,
    endpoints: sections ? `<div class="pane">${sections}</div>` : '',
    sheet: `<aside class="sheet" aria-label="Lab setup">
      <div class="sheet-block">
        <h2>Fields</h2>
        <div class="category-grid">${LAB_FIELDS.map(field => `<label class="check"><input type="checkbox" data-lab-field value="${field}" ${labState.fields.includes(field) ? 'checked' : ''} ${labState.setupLoading ? 'disabled' : ''}>${LAB_FIELD_LABELS[field]}</label>`).join('')}</div>
        <p>UI builds pages and checks every button. Coding builds a playable game and a sort dashboard. Extras adds a deterministic JSON task graded without a browser.</p>
      </div>
      <div class="sheet-block">
        <h2>Tasks per model</h2>
        ${labTasksFor(labState.fields).length ? `<ul class="lab-task-list">${labTasksFor(labState.fields).map(task => `<li><span>${esc(task.title)}</span><small>${LAB_FIELD_LABELS[task.field]}</small></li>`).join('')}</ul>` : '<p class="start-hint">No fields chosen.</p>'}
      </div>
      <p class="note">Artifacts execute inside a sandboxed preview on this page and in a sandboxed new tab. Nothing runs on the server. The full preview shows the generated document exactly as the model wrote it.</p>
      <div class="sheet-foot">
        <div class="tally"><span>${labCount() ? plural(labCount(), 'model') : 'No models chosen'}</span><span><b>${labAttemptsCount().toLocaleString()}</b> attempts</span></div>
        ${labState.startError ? `<p class="error" role="alert">${esc(labState.startError)}</p>` : ''}
        ${labState.setupLoading ? '<p class="note lab-loading" role="status"><i class="spin" aria-hidden="true"></i>Loading saved selection…</p>' : ''}
        <button id="lab-start" class="button primary" data-lab-start ${labBlocker() || labState.starting || labState.setupLoading ? 'disabled' : ''}>${labState.starting ? '<i class="spin"></i>Starting' : 'Start lab run'}</button>
        ${labBlocker() ? `<p class="note">${esc(labBlocker())}</p>` : ''}
      </div>
    </aside>`,
    history: labList(),
  };
}

/* ------------------------------- Run view ---------------------------- */

/* One toggle keeps its data-key across running, pausing and paused, so keyboard focus
   survives the change instead of falling back to the page. Pausing is shown but inert. */
function labToggle(run) {
  if (run.state === 'running') return '<button class="button quiet" data-key="lab-toggle" data-lab-pause>Pause</button>';
  if (run.state === 'pausing') return '<button class="button quiet" data-key="lab-toggle" data-lab-pausing aria-disabled="true">Pausing…</button>';
  if (run.state === 'paused') return '<button class="button" data-key="lab-toggle" data-lab-resume>Resume</button>';
  return '';
}

function labHead(run) {
  const live = !LAB_STATES.has(run.state);
  return `<header class="page-head">
    <div>
      <h1>${esc(HEADINGS[run.state] || run.state)}</h1>
      <div class="run-meta"><span>Lab run</span><span>${esc(when(run.created))}</span><span>${plural(run.config.models.length, 'model')}</span><span>${esc((run.config.fields || []).map(field => LAB_FIELD_LABELS[field] || field).join(' + ') || 'no fields')}</span></div>
      ${run.error ? `<p class="error" role="alert">${esc(run.error)}</p>` : ''}
      ${labState.activeError ? `<p class="error" role="alert">${esc(labState.activeError)}</p>` : ''}
    </div>
    <div class="run-count">
      <b aria-label="${run.progress} of ${run.total} attempts">${run.progress.toLocaleString()}<span>/${run.total.toLocaleString()}</span></b>
      ${live ? `${labToggle(run)}<button class="button" data-key="lab-cancel" data-lab-cancel>Cancel lab run</button>` : '<a class="button" href="#lab">New lab run</a>'}
    </div>
  </header>`;
}

function labVerdictOf(item) {
  if (item.status === 'error') return { label: 'Error', bad: true };
  if (item.status !== 'ok') return { label: 'Running', live: true };
  if ((item.autoChecks || []).some(check => check.pass === false)) return { label: 'Check failed', bad: true };
  return { label: 'Checks ok' };
}

function labReviewText(item) {
  const review = item.review || {};
  const parts = [];
  if (review.visuals) parts.push(`${review.visuals}/5`);
  if (review.buttons) parts.push(review.buttons === 'yes' ? 'buttons ok' : 'buttons broken');
  if (review.playable) parts.push(review.playable === 'yes' ? 'playable' : 'not playable');
  return parts.join(' · ') || '—';
}

/* The backend runs attempts in a fixed order: endpoint, then model, then task.
   The attempt in flight is therefore the next one after the stored progress. */
function labInFlight(run) {
  const total = Number(run.total) || 0;
  const progress = Number(run.progress) || 0;
  const fields = Array.isArray(run.config?.fields) ? run.config.fields : [];
  const tasks = labTasksFor(fields);
  if (!tasks.length || progress >= total) return null;
  const models = [];
  (Array.isArray(run.config?.endpoints) ? run.config.endpoints : []).forEach(endpoint => {
    (Array.isArray(endpoint?.models) ? endpoint.models : []).forEach(model => models.push({ endpointName: endpoint?.name || '', model }));
  });
  const slot = models[Math.floor(progress / tasks.length)];
  return {
    number: progress + 1,
    total,
    task: tasks[progress % tasks.length],
    model: slot ? String(slot.model) : '',
    endpointName: slot ? String(slot.endpointName) : '',
  };
}

function labStatus(run) {
  if (LAB_STATES.has(run.state)) return '';
  const total = Number(run.total) || 0;
  const progress = Number(run.progress) || 0;
  const share = total ? Math.min(100, Math.round(progress * 100 / total)) : 0;
  const next = labInFlight(run);
  const where = next ? [next.task.title, next.model, next.endpointName].filter(Boolean).map(esc).join(' · ') : '';
  let headline;
  let detail = where;
  let spinning = true;
  if (run.state === 'queued') {
    headline = 'Queued — starting the first attempt';
    detail = '';
  } else if (run.state === 'paused') {
    spinning = false;
    headline = `Paused after ${progress} of ${total}`;
    detail = next ? `Resume to continue with attempt ${next.number}${where ? ` (${where})` : ''}` : 'Resume to continue';
  } else if (run.state === 'pausing') {
    headline = next ? `Pausing after attempt ${next.number} finishes` : 'Pausing after the current attempt finishes';
  } else if (total && progress >= total) {
    headline = 'Finishing up';
    detail = '';
  } else if (next) {
    headline = `Generating attempt ${next.number} of ${total}`;
  } else {
    headline = total ? `Generating attempt ${progress + 1} of ${total}` : 'Working…';
  }
  const retry = labState.watchError ? '<span class="lab-status-retry">Lost contact with the server. Retrying every few seconds.</span>' : '';
  const meter = total ? `<span class="meter" role="img" aria-label="${progress} of ${total} attempts finished"><i style="width:${share}%"></i></span>` : '';
  return `<section class="lab-status" aria-label="Lab run status">
    <div class="lab-status-line">
      ${spinning ? '<i class="spin" aria-hidden="true"></i>' : ''}
      <div class="lab-status-text" role="status">
        <b>${esc(headline)}</b>
        ${detail ? `<span>${detail}</span>` : ''}
        ${retry}
      </div>
    </div>
    ${meter}
  </section>`;
}

/* The in-flight attempt gets a non-selectable row while it runs. */
function labPendingAttempt(run) {
  if (!['queued', 'running', 'pausing'].includes(run.state)) return null;
  return labInFlight(run);
}

function labTape(run) {
  const rows = run.attempts.map(item => {
    const verdict = labVerdictOf(item);
    const model = item.model.split('/').pop();
    return `<tr>
      <th scope="row"><button type="button" class="text-link lab-row-open" data-lab-select="${item.attempt}">#${item.attempt}</button></th>
      <td class="col-depth">${esc(LAB_FIELD_LABELS[item.field] || item.field)}</td>
      <td>${esc(item.title)}<small> · ${esc(model)}</small></td>
      <td><span class="run-state ${verdict.bad ? 'is-failed' : ''} ${verdict.live ? 'is-live' : ''}">${esc(verdict.label)}</span></td>
      <td class="num">${typeof item.autoScore === 'number' ? Math.round(item.autoScore) : '—'}${typeof item.autoScore === 'number' ? '<small>/100</small>' : ''}</td>
      <td class="num lab-review-cell">${esc(labReviewText(item))}</td>
      <td class="num">${item.field === 'extras' ? '—' : `<button type="button" class="button quiet" data-lab-preview="${item.attempt}" ${item.status === 'ok' ? '' : 'disabled'}>Preview</button>`}</td>
    </tr>`;
  }).join('');
  const pending = labPendingAttempt(run);
  const pendingRow = pending ? `<tr class="lab-tape-pending">
      <th scope="row"><span class="lab-row-pending">#${pending.number}</span></th>
      <td class="col-depth">${esc(LAB_FIELD_LABELS[pending.task.field] || pending.task.field)}</td>
      <td>${esc(pending.task.title)}${pending.model ? `<small> · ${esc(pending.model.split('/').pop())}</small>` : ''}</td>
      <td><span class="run-state is-live">${run.state === 'queued' ? 'Queued' : 'Generating'}</span></td>
      <td class="num">—</td>
      <td class="num lab-review-cell">—</td>
      <td class="num">—</td>
    </tr>` : '';
  const live = !LAB_STATES.has(run.state);
  let body = '';
  if (rows || pendingRow) {
    body = `<div class="table-wrap"><table class="run-table lab-tape">
    <thead><tr><th>#</th><th class="col-depth">Field</th><th>Task</th><th>Status</th><th class="num">Auto</th><th>Your review</th><th>Preview</th></tr></thead>
    <tbody>${rows}${pendingRow}</tbody></table></div>`;
  } else if (!live) {
    body = '<p class="empty">This run ended before any artifact was produced.</p>';
  }
  let helper = '';
  if (run.attempts.length) helper = 'Select a row to review the artifact';
  else if (live) helper = 'Artifacts appear here as each attempt finishes';
  return `<section aria-label="Lab attempts">
    <div class="block-head"><h2>Attempts</h2><span>${helper}</span></div>
    ${body}
  </section>`;
}

function labCheckList(item) {
  const checks = item.autoChecks || [];
  if (!checks.length) {
    if (item.status !== 'ok') return '<li class="lab-check is-skip">No checks ran<small>no artifact to check</small></li>';
    return '<li class="lab-check is-skip">Auto checks not collected<small>open the preview once to run them</small></li>';
  }
  return checks.map(check => `<li class="lab-check ${check.pass === true ? 'is-pass' : check.pass === false ? 'is-fail' : 'is-skip'}">${esc(check.name)}<small>${esc(check.detail || (check.pass === true ? 'passed' : check.pass === false ? 'failed' : 'not measured'))}</small></li>`).join('');
}

function labReviewControls(item) {
  const review = item.review || {};
  if (item.status !== 'ok') return '<p class="note">Nothing to review: this attempt did not produce an artifact.</p>';
  if (item.field === 'extras') return '<p class="note">This deterministic JSON task has no artifact review controls.</p>';
  const visuals = [1, 2, 3, 4, 5].map(n =>
    `<button type="button" class="button quiet lab-rate ${review.visuals === n ? 'is-on' : ''}" data-lab-review-visuals="${n}" aria-pressed="${review.visuals === n}">${n}</button>`).join('');
  const buttonsVerdict = [['yes', 'All buttons work'], ['no', 'Buttons broken']].map(([value, label]) =>
    `<button type="button" class="button quiet lab-rate ${review.buttons === value ? 'is-on' : ''}" data-lab-review-buttons="${value}" aria-pressed="${review.buttons === value}">${label}</button>`).join('');
  const playableVerdict = [['yes', 'Playable'], ['no', 'Not playable']].map(([value, label]) =>
    `<button type="button" class="button quiet lab-rate ${review.playable === value ? 'is-on' : ''}" data-lab-review-playable="${value}" aria-pressed="${review.playable === value}">${label}</button>`).join('');
  return `<div class="lab-review">
    <div class="lab-review-row"><span>Visuals</span><div class="lab-rate-set">${visuals}</div><small>1 = rough, 5 = polished</small></div>
    ${item.field === 'ui' ? `<div class="lab-review-row"><span>Buttons</span><div class="lab-rate-set">${buttonsVerdict}</div></div>` : ''}
    ${item.task === 'game' ? `<div class="lab-review-row"><span>Game</span><div class="lab-rate-set">${playableVerdict}</div></div>` : ''}
    <p class="note">Every verdict is saved to this attempt immediately.</p>
  </div>`;
}

function labPreviewFrame(run, item) {
  if (labState.preview !== item.attempt) return '';
  const nonce = labState.previewNonce;
  const src = `/api/lab/runs/${encodeURIComponent(run.id)}/artifacts/${item.attempt}?labRun=${encodeURIComponent(run.id)}&attempt=${item.attempt}&nonce=${encodeURIComponent(nonce)}`;
  return `<div class="lab-preview">
    <div class="lab-preview-bar">
      <span>Sandboxed preview — click inside once to give it the keyboard</span>
      <span class="lab-preview-links">
        <a class="button" href="/api/lab/artifacts/${esc(run.id)}/${item.attempt}/raw" target="_blank" rel="noopener">Open full preview</a>
        <button type="button" class="button quiet" data-lab-preview="${item.attempt}">Close preview</button>
      </span>
    </div>
    <iframe sandbox="allow-scripts" src="${esc(src)}" title="Sandboxed preview of attempt ${item.attempt}" data-lab-frame="${item.attempt}" data-lab-nonce="${esc(nonce)}" loading="eager"></iframe>
  </div>`;
}

function labInspector(run) {
  const count = run.attempts.length;
  if (!count) {
    const live = !LAB_STATES.has(run.state);
    return `<section class="inspect" aria-label="Attempt detail"><div class="block-head"><h2>Artifact</h2></div>${live ? '<div class="inspect-body"><p class="note">Select an attempt once the first one finishes.</p></div>' : ''}</section>`;
  }
  const index = labState.attempt !== null && labState.attempt <= count ? labState.attempt : count;
  const item = run.attempts[index - 1];
  const outcomeKey = item.status === 'error' ? 'error' : item.status !== 'ok' ? 'ungraded' : 'match';
  const outcome = OUTCOMES[outcomeKey];
  return `<section class="inspect" aria-label="Attempt detail">
    <div class="block-head">
      <h2>Attempt ${index.toLocaleString()} · ${esc(item.title)}</h2>
      <div class="inspect-head">
        <button class="button quiet" data-lab-step="-1" ${index === 1 ? 'disabled' : ''}>Previous</button>
        <button class="button quiet" data-lab-step="1" ${index === count ? 'disabled' : ''}>Next</button>
      </div>
    </div>
    <div class="inspect-body">
      <div class="verdict ${outcome.bad ? 'is-bad' : ''}"><b>${outcome.label}</b><span>${esc(LAB_FIELD_LABELS[item.field] || item.field)}</span><span>${seconds(item.elapsed)}</span><span>${item.tokens ? plural(item.tokens, 'token') : 'Tokens unavailable'}</span></div>
      <p class="inspect-source">${esc(item.endpoint)} / ${esc(item.model)}</p>
      ${item.reason ? `<p class="error">${esc(item.reason)}</p>` : ''}
      ${(item.wrapped || item.truncated) ? `<p class="note">Artifact notes: ${item.wrapped ? 'the model wrote prose or a fragment, so a minimal document wrapper was added' : ''}${item.wrapped && item.truncated ? ', ' : ''}${item.truncated ? 'the response was stopped at the 300 KB artifact limit' : ''}.</p>` : ''}
      <details class="lab-prompt"><summary>Prompt</summary><pre class="prompt">${esc(item.prompt)}</pre></details>
      <div class="block-head small"><h3>Auto checks</h3><span>${typeof item.autoScore === 'number' ? `${Math.round(item.autoScore)}<small>/100</small>` : 'no score yet'}</span></div>
      <ul class="lab-checks">${labCheckList(item)}</ul>
      ${item.field === 'extras' ? '' : `<div class="block-head small"><h3>Preview</h3></div>
      <div class="lab-actions">
      ${labState.preview === item.attempt ? '' : `<button type="button" class="button" data-lab-preview="${item.attempt}" ${item.status === 'ok' ? '' : 'disabled'}>Open preview</button>`}
      ${item.status === 'ok' ? `<a class="button" href="/api/lab/artifacts/${esc(run.id)}/${item.attempt}/raw" target="_blank" rel="noopener">Open full preview</a>` : ''}
      </div>
      ${labState.checksErrors[`${run.id}:${item.attempt}`] ? `<p class="error" role="alert">Checks could not be saved: ${esc(labState.checksErrors[`${run.id}:${item.attempt}`])}</p>${(labState.checksTries.get(`${run.id}:${item.attempt}`) || 0) < 3 ? '<button type="button" class="button quiet" data-lab-check-retry>Retry saving checks</button>' : '<p class="note">Retry limit reached. Reload the artifact preview to collect a fresh result.</p>'}` : ''}
      <div class="block-head small"><h3>Your review</h3></div>`}
      ${labReviewControls(item)}
    </div>
  </section>`;
}

function labRollup(run) {
  const extrasColumn = run.config.fields.includes('extras');
  const head = `<tr><th scope="col">Model</th><th scope="col">Field</th>${extrasColumn ? '<th scope="col" class="num">JSON</th>' : ''}<th scope="col" class="num">Auto</th><th scope="col" class="num">Buttons ok</th><th scope="col" class="num">Playable ok</th><th scope="col" class="num">Visuals</th></tr>`;
  const rows = run.rollup.map(row => {
    const auto = row.field === 'extras'
      ? `${extrasColumn ? `<td class="num">${row.auto_score ?? '—'}</td>` : ''}<td class="num">—</td>`
      : `${extrasColumn ? '<td class="num">—</td>' : ''}<td class="num">${row.auto_collected ? row.auto_score ?? '—' : `${row.ok} awaiting`}</td>`;
    return `<tr>
      <th scope="row">${modelCell(row)}</th>
      <td>${esc(LAB_FIELD_LABELS[row.field] || row.field)}</td>
      ${auto}
      <td class="num">${row.field === 'ui' ? row.buttons_ok : '—'}</td>
      <td class="num">${row.field === 'coding' ? row.playable_ok : '—'}</td>
      <td class="num">${row.visuals ?? '—'}</td>
    </tr>`;
  }).join('');
  return `<section aria-label="Lab rollup">
    <div class="block-head"><h2>Measured here</h2><span>${run.state === 'completed' ? 'Auto and human columns are kept separate on purpose' : 'No complete verdict yet'}</span></div>
    ${rows ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Lab results by model and field"><table class="scores lab-rollup"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`
      : '<p class="empty">Results appear here as artifacts are checked.</p>'}
    <div class="block-foot"><p class="note">${esc(LAB_NOTE)}</p></div>
  </section>`;
}

function labRunView(id) {
  const run = labState.active?.id === id ? labState.active : null;
  if (!run) {
    return {
      head: `<header class="page-head"><div><h1>${labState.activeError ? 'Lab run not available.' : 'Opening lab run.'}</h1>${labState.activeError ? `<p class="lead">${esc(labState.activeError)}</p>` : '<p class="lead lab-loading" role="status"><i class="spin" aria-hidden="true"></i>Loading the run from this server.</p>'}</div></header>`,
      status: '',
      tape: labState.activeError ? '<div class="empty"><a class="button" href="#lab">Back to the lab</a></div>' : '',
      inspect: '',
      preview: '',
      rollup: '',
    };
  }
  const currentAttempt = labSelectedAttemptFor(run);
  const item = currentAttempt ? run.attempts[currentAttempt - 1] : null;
  return { head: labHead(run), status: labStatus(run), tape: labTape(run), inspect: labInspector(run), preview: item ? labPreviewFrame(run, item) : '', rollup: labRollup(run) };
}

function labSelectedAttemptFor(run) {
  return (labState.attempt !== null && labState.attempt <= run.attempts.length ? labState.attempt : run.attempts.length) || null;
}

/* ------------------------------ Harness link ------------------------- */

function labSelectedAttempt() {
  const run = labState.active;
  if (!run) return null;
  return (labState.attempt !== null && labState.attempt <= run.attempts.length ? labState.attempt : run.attempts.length) || null;
}

async function labReview(patch) {
  if (!patch.attempt) return;
  const runId = labState.activeId;
  try {
    const result = await labApi(`/runs/${encodeURIComponent(runId)}/review`, { method: 'POST', body: JSON.stringify(patch) });
    if (labState.activeId !== runId || labState.active?.id !== runId) return;
    const item = labState.active?.attempts.find(entry => entry.attempt === patch.attempt);
    if (item) item.review = result.review;
  } catch (error) {
    labState.activeError = error.message;
  }
  render();
}

/* The harness in the sandboxed frame reports once it has tested the artifact. */
addEventListener('message', event => {
  const data = event.data;
  if (!data || data.source !== 'lab-harness') return;
  const frame = [...app.querySelectorAll('iframe')].find(item => item.contentWindow === event.source);
  if (!frame) return;
  const runId = labState.activeId;
  const attempt = Number(frame.dataset.labFrame);
  if (!runId || !labState.active || labState.active.id !== runId || route().id !== runId ||
      frame.dataset.labNonce !== data.nonce || data.runId !== runId || Number(data.attempt) !== attempt ||
      labState.preview !== attempt) return;
  const key = `${runId}:${attempt}`;
  if (labState.checksSaved.has(key)) return;
  labState.previewState[attempt] = 'ok';
  labState.pendingChecks.set(attempt, {
    attempt,
    collected: data.collected !== false,
    errors: Number.isInteger(data.errors) ? Math.min(Math.max(data.errors, 0), 10_000) : null,
    canvas: data.canvas === true ? true : data.canvas === false ? false : null,
    animation: data.animation === true ? true : data.animation === false ? false : null,
    structure: data.structure === true ? true : data.structure === false ? false : null,
    buttonCount: Number.isInteger(data.buttonCount) ? Math.min(Math.max(data.buttonCount, 0), 10_000) : 0,
    buttons: Array.isArray(data.buttons) ? data.buttons.slice(0, 25) : [],
    controlsTested: Number.isInteger(data.controlsTested) ? Math.min(Math.max(data.controlsTested, 0), 25) : null,
    controlsCapped: data.controlsCapped === true,
    inputFound: data.inputFound === true ? true : data.inputFound === false ? false : null,
    inputTyped: data.inputTyped === true ? true : data.inputTyped === false ? false : null,
    inputValid: data.inputValid === true ? true : data.inputValid === false ? false : null,
    inputValidationMessage: typeof data.inputValidationMessage === 'string' ? data.inputValidationMessage.slice(0, 300) : null,
    rowCount: Number.isInteger(data.rowCount) ? Math.min(Math.max(data.rowCount, 0), 10_000) : null,
  });
  labState.checksErrors[key] = '';
  labPostChecks(runId, attempt);
  if (labState.preview === attempt) render();
});

async function labPostChecks(runId, attempt) {
  const key = `${runId}:${attempt}`;
  const payload = labState.pendingChecks.get(attempt);
  if (!payload || runId !== labState.activeId || labState.checksSaved.has(key) || labState.checksInFlight.has(key)) return;
  const tries = labState.checksTries.get(key) || 0;
  if (tries >= 3) return;
  labState.checksInFlight.add(key);
  labState.checksTries.set(key, tries + 1);
  try {
    await labApi(`/runs/${encodeURIComponent(runId)}/checks`, { method: 'POST', body: JSON.stringify(payload) });
    if (labState.activeId !== runId) return;
    labState.checksSaved.add(key);
    labState.checksErrors[key] = '';
    await labRefresh(runId)();
  } catch (error) {
    if (labState.activeId !== runId) return;
    labState.checksErrors[key] = error.message;
    if (route().view === 'labrun' && route().id === runId) render();
  } finally {
    labState.checksInFlight.delete(key);
  }
}

/* Auto-check timeout: eight seconds, then the attempt shows 'not collected'. */
setInterval(() => {
  const attempt = labState.preview;
  if (!attempt || !labState.active || labState.activeId !== labState.active.id) return;
  const runId = labState.activeId;
  const key = `${runId}:${attempt}`;
  if (labState.previewState[attempt] === 'ok' || labState.checksSaved.has(key) || labState.pendingChecks.has(attempt)) return;
  if (Date.now() - (labState.previewOpenedAt[attempt] || 0) > 8000) {
    labState.previewState[attempt] = 'timeout';
    labState.pendingChecks.set(attempt, { attempt, collected: false, errors: null, buttonCount: 0, buttons: [], canvas: null, animation: null, structure: null,
      controlsTested: null, controlsCapped: false, inputFound: null, inputTyped: null, inputValid: null, inputValidationMessage: null, rowCount: null });
    labPostChecks(runId, attempt);
    render();
  }
}, 2000);

/* ------------------------------- Handlers ---------------------------- */

document.addEventListener('click', async event => {
  const target = event.target;

  const start = target.closest('[data-lab-start]');
  if (start) {
    labState.starting = true;
    labState.startError = '';
    render();
    try {
      const endpoints = labState.models.map(({ name, url, models }) => ({ name, url, models }));
      const result = await labApi('/runs', { method: 'POST', body: JSON.stringify({ endpoints, fields: labState.fields }) });
      labState.active = null;
      labState.activeId = '';
      labState.checksSaved.clear();
      labState.checksTries.clear();
      labState.checksErrors = {};
      labState.pendingChecks.clear();
      labState.previewState = {};
      labState.previewOpenedAt = {};
      labState.previewNonce = '';
      location.hash = `#labrun/${result.id}`;
    } catch (error) {
      labState.startError = error.message;
    } finally {
      labState.starting = false;
      render();
    }
    return;
  }

  const cancel = target.closest('[data-lab-cancel]');
  if (cancel && labState.active) {
    try {
      await labApi(`/runs/${labState.active.id}/cancel`, { method: 'POST' });
      labState.active = await labApi('/runs/' + labState.active.id);
      labState.activeError = '';
    } catch (error) {
      labState.activeError = error.message;
    }
    render();
    return;
  }

  const control = target.closest('[data-lab-pause], [data-lab-resume]');
  if (control && labState.active) {
    const action = control.matches('[data-lab-pause]') ? 'pause' : 'resume';
    const runId = labState.active.id;
    try {
      await labApi(`/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST' });
      if (labState.activeId === runId) labState.active = await labApi('/runs/' + encodeURIComponent(runId));
      labState.activeError = '';
    } catch (error) {
      labState.activeError = error.message;
    }
    render();
    return;
  }

  const preview = target.closest('[data-lab-preview]');
  if (preview && !preview.disabled) {
    const attempt = Number(preview.dataset.labPreview);
    if (labState.preview === attempt) {
      labState.preview = null;
    } else {
      labState.preview = attempt;
      labState.attempt = attempt;
      if (!labState.previewState[attempt]) labState.previewState[attempt] = 'checking';
      labState.previewOpenedAt[attempt] = Date.now();
      labState.previewNonce = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    render();
    return;
  }

  const retryChecks = target.closest('[data-lab-check-retry]');
  if (retryChecks && labState.active) {
    labPostChecks(labState.activeId, labSelectedAttempt());
    return;
  }

  const step = target.closest('[data-lab-step]');
  if (step && labState.active) {
    const count = labState.active.attempts.length;
    labState.attempt = Math.min(count, Math.max(1, (labState.attempt ?? count) + Number(step.dataset.labStep)));
    render();
    return;
  }

  const select = target.closest('[data-lab-select]');
  if (select) {
    labState.attempt = Number(select.dataset.labSelect);
    labState.preview = null;
    render();
    document.querySelector('.inspect')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const visuals = target.closest('[data-lab-review-visuals]');
  if (visuals && labState.active) {
    labReview({ attempt: labSelectedAttempt(), visuals: Number(visuals.dataset.labReviewVisuals) });
    return;
  }
  const buttonsVerdict = target.closest('[data-lab-review-buttons]');
  if (buttonsVerdict && labState.active) {
    labReview({ attempt: labSelectedAttempt(), buttons: buttonsVerdict.dataset.labReviewButtons });
    return;
  }
  const playable = target.closest('[data-lab-review-playable]');
  if (playable && labState.active) {
    labReview({ attempt: labSelectedAttempt(), playable: playable.dataset.labReviewPlayable });
  }
});

document.addEventListener('change', event => {
  const target = event.target;
  if (target.dataset.labField !== undefined) {
    labState.fields = target.checked
      ? LAB_FIELDS.filter(field => labState.fields.includes(field) || field === target.value)
      : labState.fields.filter(field => field !== target.value);
    render();
    saveLabSetup();
    return;
  }
  if (target.dataset.labModel !== undefined) {
    labToggleModel(target.dataset.url, target.dataset.name, target.value, target.checked);
    render();
    saveLabSetup();
  }
});
