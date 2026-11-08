# LocalModel Bench

A small, self-hosted interface for testing chat models exposed through Ollama's OpenAI-compatible `/v1` endpoint. No model weights or GPU are required in this container.

> **Early release:** the bundled task pack is a smoke-test fixture. Its code prompts are not run in a sandbox, writing requires human review, Artificial Analysis figures are unvalidated published reference data, no statistical confidence intervals are included, and local run scores are not a validated intelligence index. The Lab tab executes model-built pages only in a sandboxed browser preview and never on the server. Do not use these results to select safety-critical models.

## Start

```sh
docker compose up --build -d
```

Open [http://localhost:8080](http://localhost:8080). Compose binds the UI to host loopback. To choose a different port, create `.env` with `BENCH_PORT=8081`. Run `docker compose down` to stop the app; persistent run history remains in the `bench-data` volume.

The app connects from inside Docker. `localhost` therefore means the app container itself. For a model served on the Docker host, use a host gateway address (Docker Desktop: `host.docker.internal`; Linux: configure a host gateway in Compose). For a tailnet endpoint, the Docker host or container must already have a route to that device. The app does not install a VPN or create routes.

## Workflow

1. Add an Ollama OpenAI-compatible `/v1` base URL and discover models.
2. Choose models and the Quick task set.
3. Start a run and follow its persisted progress.
4. Review per-task answers on the attempt tape and compare category scores.
5. Return later: finished runs keep a dataset each, and the saved bench keeps every model's latest scores.

Runs execute sequentially per configured endpoint. Requests stream responses and request reported usage where supported. Missing usage appears as unavailable. Run history is stored locally in SQLite.

Bench setup is also stored locally: endpoints, their model ticks, depth and categories survive a reload, so the model list never resets. Reconnecting an endpoint that is already listed overwrites its entry instead of duplicating it. Every run keeps a copy of its data, browsable per model and category on the Datasets tab. The saved bench at the bottom of Compare keeps the latest data per model across runs; a model benched again overwrites its own entry, and a run that produced no graded answers never overwrites the bench.

The first-release question set deliberately repeats a small smoke-test pool to exercise grading and the UI. Selecting Standard or Rigorous repeats the same tiny pool; those labels indicate request count, not a validated, representative benchmark. Results include no confidence intervals. The hand-built coding responses are checked as text and are not executed; coding scores must not be interpreted as verified executable correctness. Essay results are left ungraded for human review. Endpoint-derived cost, wattage and hardware details are unavailable. Published Artificial Analysis figures appear beside local results and are never mixed into them.

## Lab

The Lab tab is an execution bench: selected models write self-contained HTML documents that run, instead of only answering text questions. Each run asks every chosen model for a product landing page with working buttons, a page with three interactive widgets (counter, temperature slider, picture picker), a playable Snake game, a data dashboard table, and a JSON-only aggregation task.

- **Sandboxed preview:** every artifact is served with `Content-Security-Policy: sandbox allow-scripts`, so it runs in an opaque origin with network requests excluded by the model's prompt and no storage or same-origin access. Previews run inline on the run page and in one sandboxed new tab via "Open full preview". Nothing executes on the server; the server only stores and serves the HTML.
- **Browser checks:** opening a preview injects a small harness element that waits for the page to load, then clicks every visible button, types into an input if present, tracks uncaught errors and DOM changes, and reports one result to the bench page. Results are stored as auto checks alongside each attempt.
- **Human review:** the review tape asks for visuals on a 1–5 scale, whether buttons actually work, and whether the game is playable. Review answers and auto checks both survive reloads with the run.
- **Rollup:** finished runs summarize per endpoint, model and field (UI, coding, extras), separating the automatic browser checks from human review scores; models never inherit each other's numbers.

The harness is a heuristic smoke test, not a verdict on code quality, and the sandbox is a browser containment boundary, not a guarantee about the content. Model-generated pages are untrusted output; close the preview if a page misbehaves.

## Development

```sh
python -m pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload
```

Set `DATA_DIR` to a writable directory when running outside Docker. Run `python -m pytest -q` for backend tests.

## Endpoint and privacy behavior

Discovery uses `GET {base}/models`; inference uses streaming `POST {base}/chat/completions`. Model URLs are entered in the browser and requested by the server. The app does not forward prompts to Artificial Analysis. Keep the UI on a trusted local network. Endpoint URLs and responses are stored in your local database volume.

Discovery checks Ollama's `/api/show` capabilities and excludes models without completion support, including embedding-only models. Run creation repeats this check so stale selections cannot submit those models. If a compatible server does not expose this metadata (404/405 or no capabilities field), its listed models remain available; inference errors include the server's error message when provided.

## Artificial Analysis figures

Optional. Set a key in `.env`, then restart:

```sh
AA_API_KEY=your-key-here
AA_REFRESH_MINUTES=180   # optional, 60 to 1440
```

- **Key handling:** the key stays on the server. The browser never calls Artificial Analysis and never sees the key.
- **What is sent:** only `GET https://artificialanalysis.ai/api/v2/language/models/free` with the key header and a page number. No prompts, answers, model names or endpoint URLs are sent.
- **Refresh and quota:** the server refreshes in the background every `AA_REFRESH_MINUTES`. The free tier allows 100 requests per 24 hours across all keys in the account, and a full refresh uses about one request per 200 models. Restarts do not fetch early. A failed or partial refresh keeps the last complete snapshot.
- **Meaning:** figures are AA's published results for models with the same name. AA did not test your setup, and this project does not validate them.
- **Attribution and licence:** charts that show these figures are labelled with the source. The Artificial Analysis logo is not bundled. AA's Terms of Use and Data Platform Terms govern this data. They limit redistribution, require attribution, and restrict using the data for competing benchmarking products. You are responsible for following them, including whether you may run this app for anyone other than yourself.
- **Deleting stored data:** remove `AA_API_KEY` from `.env` and restart. The stored AA data is deleted at startup.

## Bundled font

The interface ships [Mona Sans](https://github.com/github/mona-sans) in `frontend/assets/fonts`, so it makes no external font requests. The font is licensed under the SIL Open Font License; see `frontend/assets/fonts/OFL.txt`.

## Methodology and limitations

The data pack is labeled *provisional* and is not equivalent to HumanEval+, MBPP+, MMLU-Pro, IFEval, RULER, or the Artificial Analysis Intelligence Index. The app does not download benchmark datasets or third-party datasets automatically. Actual compatible responses, supported model names, and measured timings depend on your selected endpoint and host.

Track each release's task prompts, answer keys, source licenses, held-out suite versions, grader validation, judge calibration, sample sizes, bootstrap intervals, and reproducibility metadata before making scientific or ranking claims.

See [DESIGN.md](DESIGN.md) for interface tokens and `docs/IMPLEMENTATION_PROMPT.md` for the full intended evaluation and security specification.
