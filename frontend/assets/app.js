const app = document.querySelector('#app');

const CATEGORIES = ['Coding', 'Engineering', 'Logic', 'Knowledge', 'Instructions', 'Context', 'Writing'];
const DEPTHS = {
  Quick: { count: 8, repeats: 1, writing: 4, hint: '8 attempts per category per model, plus 4 writing tasks. A fast smoke test.' },
  Standard: { count: 50, repeats: 1, writing: 12, hint: '50 attempts per category per model, plus 12 writing tasks. A large run.' },
  Rigorous: { count: 150, repeats: 3, writing: 30, hint: '150 attempts per category and 30 writing tasks, each repeated 3 times.' },
};
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
const HEADINGS = {
  queued: 'Run queued.',
  running: 'Benchmark in progress.',
  pausing: 'Pausing run.',
  paused: 'Run paused.',
  completed: 'Run complete.',
  cancelled: 'Run cancelled.',
  failed: 'Run failed.',
  interrupted: 'Run interrupted.',
};
const OUTCOMES = {
  match: { label: 'Match' },
  miss: { label: 'No match', bad: true },
  error: { label: 'Error', bad: true },
  ungraded: { label: 'Ungraded' },
};
const MAX_TICKS = 240;
const SMOKE_NOTE = 'Early smoke-test pack. Prompts repeat, so scores are provisional and have no uncertainty intervals. Coding output is not executed, essay quality is ungraded, and this custom result is not a validated benchmark.';

const state = {
  endpoints: [],
  depth: 'Quick',
  categories: [...CATEGORIES],
  draft: { name: null, url: '' },
  connecting: false,
  connectError: '',
  starting: false,
  startError: '',
  runs: [],
  runsError: '',
  active: null,
  attempt: null,
  runError: '',
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function route() {
  const [view, id] = location.hash.slice(1).split('/');
  return ['bench', 'runs', 'compare', 'run'].includes(view) && (view !== 'run' || id) ? { view, id } : { view: 'bench' };
}

async function api(path, options = {}) {
  const response = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({ detail: response.statusText }));
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
    throw Error(detail || data.error || `Request failed (${response.status})`);
  }
  return data;
}

/* Rendering: each view is a set of named parts. A part is only replaced when its
   HTML changes, so live updates keep text selection and typed values. Scroll is
   carried across a replacement only when the same content comes back. */
const painted = new Map();

function paint(view, parts) {
  if (app.dataset.view !== view) {
    app.dataset.view = view;
    app.dataset.layout = view.split(':')[0];
    painted.clear();
    app.innerHTML = Object.keys(parts).map(name => `<div class="part-${name}" data-part="${name}"></div>`).join('');
    window.scrollTo(0, 0);
  }
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.key;
  for (const [name, html] of Object.entries(parts)) {
    if (painted.get(name) === html) continue;
    const element = app.querySelector(`[data-part="${name}"]`);
    const answer = element.querySelector('.answer');
    const tables = [...element.querySelectorAll('.table-wrap')].map(table => table.scrollLeft);
    element.innerHTML = html;
    const nextAnswer = element.querySelector('.answer');
    if (answer && nextAnswer && answer.dataset.attempt === nextAnswer.dataset.attempt) nextAnswer.scrollTop = answer.scrollTop;
    element.querySelectorAll('.table-wrap').forEach((table, index) => { table.scrollLeft = tables[index] ?? 0; });
    painted.set(name, html);
  }
  if (focusKey && !app.contains(focused)) {
    [...app.querySelectorAll('[data-key]')].find(element => element.dataset.key === focusKey)?.focus();
  }
}

function render() {
  const { view, id } = route();
  const section = view === 'run' ? 'runs' : view;
  document.querySelectorAll('[data-nav]').forEach(link => {
    const current = link.dataset.nav === section;
    link.classList.toggle('active', current);
    if (current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  if (view === 'runs') paint('runs', runsView());
  else if (view === 'compare') paint('compare', compareView());
  else if (view === 'run') paint('run:' + id, runView(id));
  else paint('bench', benchView());
}

/* Small formatters */
const when = iso => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const seconds = value => {
  const total = Number(value) || 0;
  if (total < 59.95) return `${total.toFixed(1)}s`;
  const whole = Math.round(total);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
};
const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
const sameModel = (a, b) => a.endpoint === b.endpoint && a.model === b.model;
const outcomeOf = result => {
  if (result.status === 'error') return 'error';
  if (result.score === null || result.score === undefined) return 'ungraded';
  return result.score > 0 ? 'match' : 'miss';
};
const modelCell = row => `<small>${esc(row.endpoint)}</small><code>${esc(row.model)}</code>`;

/* Bench */
function selectedModels() {
  return state.endpoints.reduce((sum, endpoint) => sum + endpoint.models.length, 0);
}

function plannedAttempts() {
  const depth = DEPTHS[state.depth];
  const objective = state.categories.filter(name => name !== 'Writing').length;
  const writing = state.categories.includes('Writing') ? depth.writing : 0;
  return (objective * depth.count + writing) * depth.repeats * selectedModels();
}

function startBlocker() {
  const count = selectedModels();
  const chosen = state.endpoints.filter(endpoint => endpoint.models.length);
  if (!count) return 'Choose one or more models to begin.';
  if (count > 8) return 'Choose eight models or fewer for one run.';
  if (chosen.length > 4) return 'Choose models from four endpoints or fewer.';
  if (new Set(chosen.map(endpoint => endpoint.name)).size < chosen.length) return 'Give each endpoint a different name.';
  if (!state.categories.length) return 'Choose at least one category.';
  return '';
}

function defaultEndpointName() {
  const used = new Set(state.endpoints.map(endpoint => endpoint.name));
  let index = 1;
  while (used.has(`Ollama ${index}`)) index += 1;
  return `Ollama ${index}`;
}

function benchView() {
  const connected = state.endpoints.length > 0;
  return {
    connect: `<div class="pane ${connected ? 'compact' : ''}">
      <h1>Test your local models.</h1>
      <p class="lead">Connect an Ollama endpoint, choose models and compare them on one task set. Prompts run on your own endpoints.</p>
      <form id="connect-form" class="connect">
        <label class="field">Name
          <input name="name" data-key="draft-name" data-draft="name" value="${esc(state.draft.name ?? defaultEndpointName())}" required maxlength="80">
        </label>
        <label class="field">Ollama /v1 URL
          <input name="url" data-key="draft-url" data-draft="url" type="url" placeholder="http://localhost:11434/v1" required value="${esc(state.draft.url)}">
        </label>
        <button class="button${connected ? '' : ' primary'}" data-key="connect" ${state.connecting ? 'disabled' : ''}>${state.connecting ? '<i class="spin"></i>Discovering' : 'Discover models'}</button>
      </form>
      ${state.connectError ? `<p class="error" role="alert">${esc(state.connectError)}</p>` : ''}
      ${connected ? '' : '<p class="start-hint">The server connects to this URL, so localhost means the Docker container. Use a host gateway or tailnet address for models elsewhere.</p>'}
      ${state.endpoints.map(endpointSection).join('')}
    </div>`,
    sheet: sheet(),
  };
}

function endpointSection(endpoint, index) {
  const rows = endpoint.found.map(model => `<li><label class="check">
      <input type="checkbox" data-key="model-${index}-${esc(model.id)}" data-endpoint="${index}" value="${esc(model.id)}" ${endpoint.models.includes(model.id) ? 'checked' : ''}>
      <code>${esc(model.id)}</code>
      <small>${esc(model.owned_by || '')}</small>
    </label></li>`).join('');
  return `<section class="endpoint" aria-label="${esc(endpoint.name)}">
    <header class="endpoint-head">
      <strong>${esc(endpoint.name)}</strong>
      <code>${esc(endpoint.url)}</code>
      <span>${endpoint.models.length} of ${endpoint.found.length} selected</span>
      <button class="button quiet remove" data-i="${index}" aria-label="Remove ${esc(endpoint.name)}">Remove</button>
    </header>
    ${rows ? `<ul class="model-rows">${rows}</ul>` : '<p class="start-hint">This endpoint lists no models.</p>'}
  </section>`;
}

function sheet() {
  const blocker = startBlocker();
  const attempts = plannedAttempts();
  return `<aside class="sheet" aria-label="Run setup">
    <div class="sheet-block">
      <h2>Test depth</h2>
      <div class="depths">${Object.keys(DEPTHS).map(name => `<button type="button" data-key="depth-${name}" data-depth="${name}" aria-pressed="${state.depth === name}">${name}</button>`).join('')}</div>
      <p>${DEPTHS[state.depth].hint}</p>
    </div>
    <div class="sheet-block">
      <h2>Categories</h2>
      <div class="category-grid">${CATEGORIES.map(name => `<label class="check"><input type="checkbox" data-key="category-${name}" data-category="${name}" ${state.categories.includes(name) ? 'checked' : ''}>${name}</label>`).join('')}</div>
      <p>Writing needs human review, and coding scores are provisional.</p>
    </div>
    <p class="note">Early smoke-test release. Prompts repeat to exercise the workflow, so scores are provisional. Code is not run, essays are not auto-graded, and lab references are not wired up yet.</p>
    <div class="sheet-foot">
      <div class="tally"><span>${selectedModels() ? plural(selectedModels(), 'model') : 'No models chosen'}</span><span><b>${attempts.toLocaleString()}</b> attempts</span></div>
      ${state.startError ? `<p class="error" role="alert">${esc(state.startError)}</p>` : ''}
      <button id="start" class="button primary" data-key="start" ${blocker || state.starting ? 'disabled' : ''}>${state.starting ? '<i class="spin"></i>Starting' : 'Start benchmark'}</button>
      ${blocker ? `<p class="note">${esc(blocker)}</p>` : ''}
    </div>
  </aside>`;
}

/* Runs */
function runsView() {
  const rows = state.runs.map(run => {
    const live = !TERMINAL.has(run.state);
    const share = run.total ? Math.round(run.progress * 100 / run.total) : 0;
    return `<tr>
      <td><a href="#run/${esc(run.id)}">${esc(when(run.created))}</a></td>
      <td class="col-depth">${esc(run.depth)}</td>
      <td><span class="run-state ${live ? 'is-live' : ''} ${run.state === 'failed' ? 'is-failed' : ''}">${esc(run.state)}</span></td>
      <td style="width:40%"><span class="meter" role="img" aria-label="${share}% finished"><i style="width:${share}%"></i></span></td>
      <td class="num">${run.progress.toLocaleString()} of ${run.total.toLocaleString()}</td>
    </tr>`;
  }).join('');
  let list = `<div class="table-wrap"><table class="run-table">
    <thead><tr><th>Started</th><th class="col-depth">Depth</th><th>State</th><th>Progress</th><th class="num">Attempts</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
  if (state.runsError) list = `<div class="empty"><p class="error" role="alert">${esc(state.runsError)}</p></div>`;
  else if (!rows) list = '<div class="empty"><p>No runs yet. Start a benchmark and it will appear here.</p><a class="button" href="#bench">Set up a benchmark</a></div>';
  return {
    head: `<header class="page-head"><div><h1>Run history</h1><p class="lead">Every benchmark saved on this server.</p></div><a class="button" href="#bench">New benchmark</a></header>`,
    list,
  };
}

/* A single run */
function runView(id) {
  const run = state.active?.id === id ? state.active : null;
  if (!run) {
    return {
      head: `<header class="page-head"><div><h1>${state.runError ? 'Run not available.' : 'Opening run.'}</h1>${state.runError ? `<p class="lead">${esc(state.runError)}</p>` : ''}</div></header>`,
      tape: state.runError ? '<div class="empty"><a class="button" href="#runs">Back to run history</a></div>' : '',
      matrix: '',
      inspect: '',
    };
  }
  return { head: runHead(run), tape: tape(run), matrix: runScores(run), inspect: inspector(run) };
}

function runHead(run) {
  const live = !TERMINAL.has(run.state);
  return `<header class="page-head">
    <div>
      <h1>${esc(HEADINGS[run.state] || run.state)}</h1>
      <div class="run-meta"><span>${esc(run.depth)} run</span><span>${esc(when(run.created))}</span><span>${plural(run.models.length, 'model')}</span></div>
      ${run.error ? `<p class="error" role="alert">${esc(run.error)}</p>` : ''}
      ${state.runError ? `<p class="error" role="alert">${esc(state.runError)}</p>` : ''}
    </div>
    <div class="run-count">
      <b aria-label="${run.progress} of ${run.total} attempts">${run.progress.toLocaleString()}<span>/${run.total.toLocaleString()}</span></b>
      ${live ? `<button class="button cancel-run" data-key="cancel" data-id="${esc(run.id)}">Cancel run</button>` : '<a class="button" href="#bench">New benchmark</a>'}
    </div>
  </header>`;
}

function tickFor(bucket, latest, selected) {
  if (!bucket.length) return '<i class="tick"></i>';
  const severity = ['error', 'miss', 'ungraded', 'match'];
  const outcome = severity.find(name => bucket.some(item => outcomeOf(item.result) === name));
  const shown = bucket.find(item => outcomeOf(item.result) === outcome);
  const classes = [`tick is-${outcome}`];
  if (bucket.some(item => item.index === selected)) classes.push('is-selected');
  if (bucket.some(item => item.index === latest)) classes.push('is-latest');
  return `<i class="${classes.join(' ')}" data-attempt="${shown.index}" title="Attempt ${shown.index + 1}: ${OUTCOMES[outcome].label}"></i>`;
}

function tape(run) {
  const lanePlan = run.models.length ? Math.ceil(run.total / run.models.length) : 0;
  const latest = run.results.length - 1;
  const selected = state.attempt ?? latest;
  const lanes = run.models.map(model => {
    const items = run.results.map((result, index) => ({ result, index })).filter(({ result }) => sameModel(result, model));
    const length = Math.max(lanePlan, items.length);
    const size = Math.max(1, Math.ceil(length / MAX_TICKS));
    const ticks = [];
    for (let start = 0; start < length; start += size) ticks.push(tickFor(items.slice(start, start + size), latest, selected));
    const graded = items.filter(({ result }) => ['match', 'miss'].includes(outcomeOf(result)));
    const matches = graded.filter(({ result }) => outcomeOf(result) === 'match').length;
    return `<div class="lane">
      <div class="lane-name">${modelCell(model)}</div>
      <div class="ticks ${ticks.length > 90 ? 'is-dense' : ''}" style="--n:${ticks.length || 1}" aria-hidden="true">${ticks.join('')}</div>
      <div class="lane-tally" aria-label="${matches} of ${graded.length} graded attempts matched">${graded.length ? `${matches} of ${graded.length}` : 'No grades'}</div>
    </div>`;
  }).join('');
  const legend = Object.entries(OUTCOMES).map(([key, item]) => `<span><i class="tick is-${key}"></i>${item.label}</span>`).join('');
  return `<section aria-label="Attempts by model">
    <div class="tape">${lanes}</div>
    <div class="legend">${legend}<span><i class="tick"></i>Not run</span><span>Each column is the same task across models. Select a mark to read its answer.</span></div>
  </section>`;
}

function inspector(run) {
  const count = run.results.length;
  if (!count) {
    return '<section class="inspect" aria-label="Attempt detail"><div class="block-head"><h2>Answers</h2></div><p class="empty">The first answer appears here as soon as it arrives.</p></section>';
  }
  const index = Math.min(state.attempt ?? count - 1, count - 1);
  const result = run.results[index];
  const outcome = OUTCOMES[outcomeOf(result)];
  const body = result.response;
  return `<section class="inspect" aria-label="Attempt detail">
    <div class="block-head">
      <h2>Attempt ${(index + 1).toLocaleString()}</h2>
      <div class="inspect-head">
        ${state.attempt !== null ? '<button class="button quiet" data-key="latest" data-latest>Latest</button>' : ''}
        <button class="button quiet" data-key="previous" data-step="-1" ${index === 0 ? 'disabled' : ''}>Previous</button>
        <button class="button quiet" data-key="next" data-step="1" ${index === count - 1 ? 'disabled' : ''}>Next</button>
      </div>
    </div>
    <div class="inspect-body">
      <div class="verdict ${outcome.bad ? 'is-bad' : ''}"><b>${outcome.label}</b><span>${esc(result.category)}</span><span>${seconds(result.elapsed)}</span><span>${result.tokens ? plural(result.tokens, 'token') : 'Tokens unavailable'}</span></div>
      <p class="inspect-source">${esc(result.endpoint)} / ${esc(result.model)}</p>
      <p class="prompt">${esc(result.question)}</p>
      ${result.status === 'error' && result.reason ? `<p class="error">${esc(result.reason)}</p>` : ''}
      <pre class="answer ${body ? '' : 'is-blank'}" data-attempt="${index}" tabindex="0" aria-label="Model answer">${esc(body || 'The model returned no text.')}</pre>
    </div>
  </section>`;
}

/* Scores */
function errorCounts(run) {
  const counts = new Map();
  for (const result of run.results) {
    if (result.status !== 'error') continue;
    const key = `${result.endpoint}/${result.model}/${result.category}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return row => counts.get(`${row.endpoint}/${row.model}/${row.category}`) || 0;
}

function scoreTable(run) {
  const errorsIn = errorCounts(run);
  const categories = CATEGORIES.filter(name => run.summary.some(row => row.category === name && row.total));
  if (!categories.length) return '<p class="empty">Scores appear here as answers are graded.</p>';
  const rows = run.models.map(model => {
    const cells = categories.map(category => {
      const row = run.summary.find(item => sameModel(item, model) && item.category === category);
      if (!row || !row.total) return '<td class="score is-blank"><b>Not run</b></td>';
      if (row.score === null && errorsIn(row)) return `<td class="score is-blank is-failed"><b>Failed</b><small>${plural(errorsIn(row), 'error')}</small></td>`;
      if (row.score === null) return `<td class="score is-blank"><b>Ungraded</b><small>${plural(row.total, 'answer')}</small></td>`;
      return `<td class="score ${row.score < 50 ? 'is-low' : ''}"><b>${Math.round(row.score)}<sup>%</sup></b><small>${row.coverage} of ${row.total} graded</small></td>`;
    }).join('');
    const composite = run.composites[`${model.endpoint}/${model.model}`];
    const total = run.complete ? `<td class="score"><b>${composite === undefined ? '' : `${Math.round(composite)}<sup>%</sup>`}</b></td>` : '';
    return `<tr><th scope="row">${modelCell(model)}</th>${cells}${total}</tr>`;
  }).join('');
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Scores by model and category"><table class="scores">
    <thead><tr><th scope="col">Model</th>${categories.map(name => `<th scope="col">${esc(name)}</th>`).join('')}${run.complete ? '<th scope="col">Composite</th>' : ''}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function runScores(run) {
  return `<section aria-label="Scores">
    <div class="block-head"><h2>Measured here</h2><span>${run.complete ? 'Exploratory smoke-test result' : 'No complete composite'}</span></div>
    ${scoreTable(run)}
    <div class="block-foot"><p class="note">${SMOKE_NOTE} <a class="text-link" href="#compare">See timing and tokens</a></p></div>
  </section>`;
}

function compareView() {
  const run = state.active;
  const errorsIn = run ? errorCounts(run) : () => 0;
  const picker = state.runs.length
    ? `<label class="field">Run<select id="compare-run" data-key="compare-run">${state.runs.map(item => `<option value="${esc(item.id)}" ${item.id === run?.id ? 'selected' : ''}>${esc(when(item.created))}, ${esc(item.depth)}, ${esc(item.state)}</option>`).join('')}</select></label>`
    : '';
  const head = `<header class="page-head"><div><h1>Compare</h1><p class="lead">Every model in one run, scored on the same tasks.</p></div>${picker}</header>`;
  const failure = state.runsError ? `<div class="empty"><p class="error" role="alert">${esc(state.runsError)}</p></div>` : '';
  if (!run) {
    return { head, matrix: failure || '<div class="empty"><p>No runs to compare yet. Start a benchmark with two or more models.</p><a class="button" href="#bench">Set up a benchmark</a></div>', detail: '' };
  }
  const rows = run.models.map(model => {
    const lines = run.summary.filter(row => row.total && sameModel(row, model));
    return lines.map((row, index) => `<tr>
      ${index ? '' : `<th scope="rowgroup" rowspan="${lines.length}">${modelCell(model)}</th>`}
      <td>${esc(row.category)}</td>
      <td class="num">${row.score === null ? (errorsIn(row) ? 'Failed' : 'Ungraded') : `${row.score}%`}</td>
      <td class="num">${row.coverage} of ${row.total}</td>
      <td class="num">${seconds(row.elapsed)}</td>
      <td class="num">${row.tokens ? row.tokens.toLocaleString() : 'Unavailable'}</td>
    </tr>`).join('');
  }).join('');
  return {
    head,
    matrix: `${failure}<section aria-label="Scores">
      <div class="block-head"><h2>Measured here</h2><span>${run.complete ? 'Exploratory smoke-test result' : 'No complete composite'}</span></div>
      ${scoreTable(run)}
      <div class="block-foot"><p class="note">${SMOKE_NOTE}</p></div>
    </section>`,
    detail: rows ? `<section aria-label="Timing and tokens">
      <div class="block-head"><h2>Timing and tokens</h2></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Timing and tokens by model and category"><table class="detail">
        <thead><tr><th>Model</th><th>Category</th><th class="num">Matches</th><th class="num">Graded</th><th class="num">Time</th><th class="num">Tokens</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>` : '',
  };
}

/* Data */
async function loadRuns() {
  try {
    state.runs = await api('/runs');
    state.runsError = '';
  } catch (error) {
    state.runsError = error.message;
  }
}

let watcher = null;

function stopWatching() {
  if (!watcher) return;
  watcher.events?.close();
  clearInterval(watcher.timer);
  watcher = null;
}

function watchRun(id) {
  if (watcher?.id === id) return;
  stopWatching();
  const current = watcher = { id, busy: false };
  const refresh = async () => {
    if (watcher !== current || current.busy) return;
    current.busy = true;
    try {
      const run = await api('/runs/' + id);
      if (watcher !== current) return;
      state.active = run;
      state.runError = '';
      if (TERMINAL.has(run.state)) {
        stopWatching();
        await loadRuns();
      }
    } catch (error) {
      if (watcher !== current) return;
      state.runError = error.message;
      if (state.active?.id !== id) stopWatching();
    } finally {
      current.busy = false;
    }
    render();
  };
  current.events = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  current.events.addEventListener('progress', refresh);
  current.events.onerror = () => {};
  current.timer = setInterval(refresh, 2500);
  refresh();
}

let navigation = 0;

async function syncRoute() {
  const current = ++navigation;
  const { view, id } = route();
  if (view === 'run') {
    if (state.active?.id !== id) { state.active = null; state.attempt = null; }
    state.runError = '';
    render();
    watchRun(id);
    return;
  }
  if (view === 'compare' || view === 'runs') {
    await loadRuns();
    if (current !== navigation) return;
    if (view === 'compare' && !state.active && state.runs.length) await openForCompare(state.runs[0].id);
    if (current !== navigation) return;
  }
  if (view === 'compare' && state.active && !TERMINAL.has(state.active.state)) watchRun(state.active.id);
  else stopWatching();
  render();
}

async function openForCompare(id) {
  try {
    state.active = await api('/runs/' + id);
    state.attempt = null;
    state.runsError = '';
  } catch (error) {
    state.runsError = error.message;
  }
}

async function checkHealth() {
  const connection = document.querySelector('#connection');
  try {
    await api('/health');
    connection.textContent = 'Server online';
    connection.classList.remove('offline');
  } catch {
    connection.textContent = 'Server offline';
    connection.classList.add('offline');
  }
}

/* Events */
document.addEventListener('click', async event => {
  const target = event.target;
  const depth = target.closest('[data-depth]');
  if (depth) { state.depth = depth.dataset.depth; render(); return; }

  const remove = target.closest('.remove');
  if (remove) { state.endpoints.splice(Number(remove.dataset.i), 1); render(); return; }

  const attempt = target.closest('[data-attempt]');
  if (attempt) { state.attempt = Number(attempt.dataset.attempt); render(); return; }

  const step = target.closest('[data-step]');
  if (step && state.active) {
    const last = state.active.results.length - 1;
    state.attempt = Math.min(last, Math.max(0, (state.attempt ?? last) + Number(step.dataset.step)));
    render();
    return;
  }

  if (target.closest('[data-latest]')) { state.attempt = null; render(); return; }

  if (target.closest('#start')) {
    state.starting = true;
    state.startError = '';
    render();
    try {
      const endpoints = state.endpoints.filter(item => item.models.length).map(({ name, url, models }) => ({ name, url, models }));
      const result = await api('/runs', { method: 'POST', body: JSON.stringify({ endpoints, depth: state.depth, categories: state.categories }) });
      state.active = null;
      location.hash = `#run/${result.id}`;
    } catch (error) {
      state.startError = error.message;
    } finally {
      state.starting = false;
      render();
    }
    return;
  }

  const cancel = target.closest('.cancel-run');
  if (cancel) {
    try {
      await api(`/runs/${cancel.dataset.id}/cancel`, { method: 'POST' });
      state.active = await api('/runs/' + cancel.dataset.id);
      state.runError = '';
    } catch (error) {
      state.runError = error.message;
    }
    render();
  }
});

document.addEventListener('input', event => {
  const key = event.target.dataset?.draft;
  if (key) state.draft[key] = event.target.value;
});

document.addEventListener('change', async event => {
  const target = event.target;
  if (target.dataset.endpoint !== undefined) {
    const endpoint = state.endpoints[Number(target.dataset.endpoint)];
    endpoint.models = target.checked ? [...new Set([...endpoint.models, target.value])] : endpoint.models.filter(id => id !== target.value);
    render();
  } else if (target.dataset.category) {
    state.categories = target.checked ? CATEGORIES.filter(name => state.categories.includes(name) || name === target.dataset.category) : state.categories.filter(name => name !== target.dataset.category);
    render();
  } else if (target.id === 'compare-run') {
    stopWatching();
    await openForCompare(target.value);
    if (state.active && !TERMINAL.has(state.active.state)) watchRun(state.active.id);
    render();
  }
});

document.addEventListener('submit', async event => {
  if (event.target.id !== 'connect-form') return;
  event.preventDefault();
  const data = new FormData(event.target);
  state.connecting = true;
  state.connectError = '';
  render();
  try {
    const result = await api('/models', { method: 'POST', body: JSON.stringify({ name: data.get('name'), url: data.get('url') }) });
    const existing = state.endpoints.findIndex(item => item.url === result.url);
    if (existing !== -1) state.endpoints.splice(existing, 1);
    state.endpoints.push({ name: result.name, url: result.url, models: result.models.map(model => model.id), found: result.models });
    state.draft = { name: null, url: '' };
  } catch (error) {
    state.connectError = error.message;
  } finally {
    state.connecting = false;
    render();
  }
});

addEventListener('hashchange', syncRoute);

(async () => {
  checkHealth();
  setInterval(checkHealth, 30000);
  setInterval(async () => {
    if (route().view !== 'runs' || !state.runs.some(run => !TERMINAL.has(run.state))) return;
    await loadRuns();
    if (route().view === 'runs') render();
  }, 2500);
  await loadRuns();
  const running = state.runs.find(run => !TERMINAL.has(run.state));
  if (running && route().view === 'bench' && !location.hash) {
    location.hash = `#run/${running.id}`;
    return;
  }
  await syncRoute();
})();
