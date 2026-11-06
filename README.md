# LocalModel Bench

A small, self-hosted interface for testing chat models exposed through Ollama's OpenAI-compatible `/v1` endpoint. No model weights or GPU are required in this container.

> **Early release:** the bundled task pack is a smoke-test fixture. Its code prompts are not run in a sandbox, writing requires human review, no validated Artificial Analysis integration or statistical confidence intervals are included, and local run scores are not a validated intelligence index. Do not use these results to select safety-critical models.

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

Runs execute sequentially per configured endpoint. Requests stream responses and request reported usage where supported. Missing usage appears as unavailable. Run history is stored locally in SQLite.

The first-release question set deliberately repeats a small smoke-test pool to exercise grading and the UI. Selecting Standard or Rigorous repeats the same tiny pool; those labels indicate request count, not a validated, representative benchmark. Results include no confidence intervals. The hand-built coding responses are checked as text and are not executed; coding scores must not be interpreted as verified executable correctness. Essay results are left ungraded for human review. Endpoint-derived cost, wattage, hardware details, and direct head-to-head Artificial Analysis results are unavailable.

## Development

```sh
python -m pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload
```

Set `DATA_DIR` to a writable directory when running outside Docker. Run `python -m pytest -q` for backend tests.

## Endpoint and privacy behavior

Discovery uses `GET {base}/models`; inference uses streaming `POST {base}/chat/completions`. Model URLs are entered in the browser and requested by the server. The app does not forward prompts to Artificial Analysis. Keep the UI on a trusted local network. Endpoint URLs and responses are stored in your local database volume.

## Bundled font

The interface ships [Mona Sans](https://github.com/github/mona-sans) in `frontend/assets/fonts`, so it makes no external font requests. The font is licensed under the SIL Open Font License; see `frontend/assets/fonts/OFL.txt`.

## Methodology and limitations

The data pack is labeled *provisional* and is not equivalent to HumanEval+, MBPP+, MMLU-Pro, IFEval, RULER, or the Artificial Analysis Intelligence Index. The app does not download benchmark datasets or third-party datasets automatically. Actual compatible responses, supported model names, and measured timings depend on your selected endpoint and host.

Track each release's task prompts, answer keys, source licenses, held-out suite versions, grader validation, judge calibration, sample sizes, bootstrap intervals, and reproducibility metadata before making scientific or ranking claims.

See [DESIGN.md](DESIGN.md) for interface tokens and `docs/IMPLEMENTATION_PROMPT.md` for the full intended evaluation and security specification.
