# LocalModel Bench — implementation prompt

Build a Dockerized, local-first application for evaluating models served by Ollama. Implement the complete workflow below, using this document as the acceptance contract. Choose minor implementation details independently; investigate repository evidence before changing this plan. Do not implement a dashboard that only displays invented scores.

## 1. Goal, evidence, and scope

**Requested:** connect an Ollama endpoint such as `http://100.126.194.51:11434/v1`, discover and select models, benchmark broad text capabilities, measure task time and cost, select larger lab models from Artificial Analysis for reference, and present results in a beautiful minimal UI with live progress.

**Confirmed from inspection:** the repository initially contained only an MIT `LICENSE`, on `main`, with no application, dependencies, database, or existing API. The supplied design is now at `DESIGN.md`. Preserve the license. All application paths below are proposed new files, not existing components.

**Assumptions:** v1 is a private, single-user, English, text-only application. The Docker host can reach the configured Ollama server. All inference, including optional judging, uses user-selected Ollama endpoints. Artificial Analysis is a read-only reference-data integration, not a hosted-model inference provider. Do not contact the example endpoint merely because it appears in documentation.

Deliver one app image for UI/API/orchestration and a Compose deployment with isolated code execution. The app needs no GPU: Ollama runs elsewhere. Do not add model downloads, fine-tuning, cloud inference, account management, a public leaderboard, speech/vision, or unrestricted autonomous agents to v1. Describe these limits clearly rather than claiming to test every form of intelligence.

## 2. Expected user workflow

1. **Connect:** enter a base URL and optional proxy credential. Test connectivity and discover model IDs. Explain Docker networking when necessary.
2. **Choose:** search and multi-select discovered local models. Optionally choose an Ollama judge and select Artificial Analysis reference models. Keep judges, tested models, and published references visibly distinct.
3. **Configure:** choose Quick, Standard, or Rigorous; keep category switches and sampling controls under Advanced. Show the exact task count, repeats, context requirements, output/time limits, grading availability, and a provisional duration range before starting.
4. **Run:** preflight capabilities, warm up, generate answers, verify them, optionally judge writing, and finalize the report. Show real work progress, elapsed time, live answer excerpts, and queued models. Let the user pause, resume, cancel, and reload the page.
5. **Compare:** examine category results, uncertainty, reliability, latency, and cost. Open any failed task to see the prompt, answer, grading evidence, and settings. Switch to a separate Published references view for selected lab models.
6. **Keep:** persist history, rerun a frozen configuration as a new run, and export a reproducibility bundle. A browser refresh must never create another run.

## 3. Architecture and proposed files

Use a small, conventional stack: React + TypeScript + Vite for the client; Python + FastAPI + HTTPX for the backend; SQLite in WAL mode for local persistence. Python supports numeric verification and statistical analysis without loading model weights. Serve the compiled UI from the backend, use one API process with a durable background runner, and stream updates through SSE. Avoid Redis, Kubernetes, a second application framework, or heavyweight local ML dependencies.

Use a maintained chart library such as ECharts for confidence intervals and scatterplots, plus semantic HTML controls and a small icon set. Pin dependencies with lockfiles; use supported releases verified during implementation. Backend schemas should be the source of generated frontend API types. Do not add a second client state library when ordinary React state and a small API layer suffice.

Proposed responsibilities:

- `frontend/src/{components,pages,lib,styles}/`: reusable controls, Bench/Runs/Compare screens, typed requests, SSE client, design tokens, accessible charts.
- `backend/app/main.py`, `api/`, `clients/`: app lifecycle, internal routes, strict Ollama and Artificial Analysis clients.
- `backend/app/runner/`: frozen plans, job leases, attempts, progress, pause/cancel/recovery.
- `backend/app/benchmarks/`, `scoring/`, `storage/`: task-pack adapters, deterministic graders, statistics, rubric grading, SQLite migrations.
- `benchmarks/manifests/`: versioned definitions, source revisions, licenses, checksums, prompts, rubrics, and sampling rules. Keep answer keys out of public static assets.
- `executor/`: integration with an isolated code sandbox; never execute model code inside the API process.
- `tests/{unit,integration,e2e,fixtures}/`: deterministic endpoint simulator, golden grading results, sandbox probes, and Playwright workflows.
- `Dockerfile`, `compose.yaml`, `.env.example`, `README.md`, `docs/METHODOLOGY.md`, `docs/DATA_SOURCES.md`: deployment and honest operational documentation.

Use equivalent names if they make the implementation clearer. Recheck for new repository instructions before building.

## 4. Benchmark content: six objective domains and separate writing

Make every task a versioned record with a primary category, subskill, difficulty, source/license, prompt template, answer/verifier, limits, family ID, and validation status. One item contributes to one primary category; never count duplicated items as independent evidence.

1. **Coding:** function generation, boundary cases, and small bug fixes. Start with pinned, license-checked HumanEval+/MBPP+ adapters from [EvalPlus](https://github.com/evalplus/evalplus) and original verified tasks. Execute hidden tests. A task passes only if all required tests pass. Report pass@1; test-case pass percentages are diagnostics, not partial task credit. Initially support Python standard-library tasks well rather than claiming every language or full software-engineering competence.
2. **Math and engineering:** numerical reasoning, units, circuits, mechanics, estimation, and constraint calculations. Use checked problems with independent reference solvers, explicit assumptions, tolerances, significant-figure rules, and dimensional checks. Separate answer correctness from optional explanatory writing. Never grade engineering correctness from confident prose.
3. **Logic and planning:** scheduling, ordering, deductions, graph constraints, and small optimization problems. Generate solvable, seeded instances with independently checked constraints and optima. Accept every valid solution; do not require a single arbitrary reference wording. Include unsatisfiable cases with verified certificates where feasible.
4. **Knowledge and calibration:** a balanced, pinned [MMLU-Pro](https://github.com/TIGER-AI-Lab/MMLU-Pro) subset plus checked questions and deliberately unanswerable cases. Use exact/strict answer extraction and fixed mappings. Report accuracy, abstention coverage, and error rate among attempted answers. If confidence is collected, score it separately with Brier scores and calibration bins; missing/invalid confidence is visible. Self-reported confidence is not token probability.
5. **Instruction following and structured output:** pinned [IFEval](https://github.com/google-research/google-research/tree/master/instruction_following_eval) tasks and custom JSON-schema, ordering, length, extraction, and format constraints. Use deterministic validators. Show strict whole-task success separately from individual-constraint success. Test natural JSON compliance separately from endpoint-enforced structured output.
6. **Grounded context:** retrieval, multi-evidence questions, document-grounded extraction, conflicting facts, and answerable/unanswerable questions. Use original source packets and [RULER](https://github.com/NVIDIA/RULER)-style seeded tasks. Require evidence IDs where appropriate. Test more than single-needle recall. Use a shared baseline context workload; report longer-context tiers separately so different context limits do not silently change a model's denominator.

**Writing is its own domain:** essays, argumentation, synthesis, and technical explanation using supplied source packets. Implement the rubric in section 6. Do not mix aesthetic judgment into deterministic correctness.

Use established suites through their official grading implementations when practical, but verify that they can run on chat-only endpoints. Never require log-probabilities that the endpoint does not expose. If prompts, sampling, graders, or task subsets differ, name the result `LocalModel Bench <pack/version>`, not an official full benchmark score.

Task packs must be usable offline after installation. Download only from documented sources with checksums; never execute downloaded dataset scripts automatically. Check dataset rights independently of repository code licenses. Ship only data permitted for redistribution. Larger/gated packs can have explicit install/import actions. If a required pack is absent, show the missing content and disable the corresponding complete-suite claim; do not silently replace it with a handful of toy questions.

Validate custom tasks before accepting them: reference answers pass; plausible incorrect answers fail; alternate valid answers pass; seeded generation is reproducible; duplicates and ambiguous wording are checked. LLM-generated questions alone are not validated ground truth. Label unaudited packs provisional. Public benchmark familiarity and parameter randomization do not establish freedom from training contamination.

## 5. Scoring, sampling, and comparison rules

Publish a frozen `Core v1` profile with equal weights across the six objective domains. Within domains, fix subskill and difficulty weights in the manifest. Do not let a larger easy dataset dominate the score. The primary report is the domain breakdown, not a mysterious intelligence number.

For each task, average independent single-attempt correctness across the planned repeats, then aggregate tasks using the frozen within-domain weights. The complete objective score is:

`Core score = 100 × mean(six domain scores on the 0–1 scale)`

This is a defined task-performance index, not IQ, human intelligence, or an Artificial Analysis index. Keep writing, speed, cost, and reliability separate. Custom weights create a visibly named custom profile and never overwrite Core v1.

Implement these default budgets per model, subject to adequate validated pack availability:

- **Quick:** 8 unique tasks per objective domain, one attempt each, plus 4 writing tasks: 52 generations. Label as a smoke test, unsuitable for firm ranking.
- **Standard:** 50 unique tasks per domain, one attempt each, plus 12 writing tasks: 312 generations. This is the normal starting point, not a promise of narrow category intervals.
- **Rigorous:** 150 unique tasks per domain, three predeclared attempts each, plus 30 writing tasks with three attempts each: 2,790 generations. Judging, warmups, and dedicated speed probes are additional work and must appear in the run plan.

Use the same seeded, stratified task IDs for every compared model. Repeats use frozen seeds where supported and a consistent documented sampling profile. Temperature zero and a fixed seed do not guarantee deterministic hardware behavior; repetitions can still measure variability. Never choose the best answer out of repeated attempts or let failed questions trigger answer-repair retries.

Provide 95% uncertainty intervals. Use Wilson intervals only for genuinely independent, equally weighted binary items; use stratified task/family-cluster bootstrap for weighted domains, repeated generations, rubric scores, and the composite. Preserve model pairing in bootstrap differences. Repeated variants from one family do not count as independent questions. State that intervals describe uncertainty over this task distribution, not all real-world competence. At 50 independent questions, near-50% accuracy still has roughly ±13 percentage points of uncertainty.

Show unique items, families, repeats, subskill coverage, and invalid/missing observations. Compare models only under compatible manifests, task sets, budgets, graders, and profiles. Default pairwise comparison uses the paired difference interval and a preregistered practical threshold; call close results inconclusive. Do not infer significance merely from overlap of individual intervals. Exploratory multi-model comparisons must not manufacture a statistically guaranteed winner; use a correction if providing formal multiple-comparison claims.

Malformed answers, task-budget timeouts, truncation, failed assertions, and valid refusals of ordinary answerable tasks are recorded outcomes and do not disappear. Define the primary Core domain score as delivered task success: each planned attempt contributes 1 for a verified correct answer and 0 for an incorrect/invalid answer or terminal timeout/transport failure. Preserve failure reasons: a transport failure is not evidence of a reasoning mistake. Show a secondary semantic score over gradable responses together with its coverage; never rank by that conditional score while hiding failures. Unattempted, cancelled, missing-pack, or unsupported work is missing, not zero, and suppresses the complete-suite composite. A judge failure is ungraded, never zero writing quality. Log every retry, including failed attempts and consumed time/tokens.

## 6. Writing and essay marking

Score five anchored 0–4 dimensions: factual grounding and source fidelity (30%), reasoning and argument (25%), structure and coherence (20%), instruction/audience fit (15%), and clarity/style (10%). Define observable anchors for every score and include poor, adequate, and strong examples. Normalize the weighted rubric to 0–100. Preserve dimension scores and evidence excerpts; do not imply the rubric is an objective truth.

Check mechanical constraints deterministically. Supplied source IDs, dates, and facts support evidence review, but valid citation syntax does not prove that a claim is supported. Avoid BLEU, ROUGE, answer length, or an LLM's praise as a substitute for writing quality.

Provide a compact blind human-review drawer using the same rubric. Without a judge or human review, preserve the essay and show `Ungraded`; do not invent a writing score.

Optional automatic grading uses separately selected Ollama models only. Keep candidate identity and performance metadata out of judge prompts. Ask for schema-validated scores, cited evidence, and brief reasons; treat candidate answers as untrusted quoted material. Include prompt-injection and verbosity-bias probes, informed by [research on LLM judge limitations](https://arxiv.org/abs/2306.05685). Validate a judge against a pinned human-scored calibration set, with reported sample size and agreement; without suitable calibration evidence, label its scores provisional. Do not silently grade a model with itself. Allow a clearly marked, non-independent mode only if the user deliberately selects it.

For stronger grading, allow two independent judges from different families, average dimension scores, and flag disagreements exceeding one rubric point. This is still correlated model judgment, not certainty. Human adjudication becomes a separate recorded revision. For an optional pairwise writing view, use matched prompts, blind names, both answer orders, and reported win/tie rates with task-cluster intervals; a position-dependent verdict is a disagreement. Do not turn a tiny comparison pool into a universal Elo leaderboard.

Run judging after timed generation when it shares the inference hardware. Record judge model identity, rubric/prompt hashes, decoding settings, calibration, and time separately. Never change a rubric after seeing which model wins without creating a new grading version.

## 7. Runtime, latency, reliability, and cost

Run one measured generation at a time by default, including across endpoint aliases that may share a GPU. Let users assign endpoints to shared hardware groups. Use blocked, seeded model ordering across rounds, with model warmup on each loading transition, to reduce order/thermal bias without swapping weights every question. Record background-load disclosures and model switching; an endpoint alone cannot prove isolation.

Separate quality runs from a small dedicated performance pack: fixed prompt texts at short/medium/context tiers, controlled requested output lengths, varied content types, and repeated samples. Freeze its sample count in the manifest and include it in the pre-run total. For example, Standard can use 20 observations at each of three shared input sizes, with the same texts across models and a 256-token output cap. Report actual input/output sizes, not an assumed universal character-to-token conversion. Mark small-sample tail percentiles unstable. Reserve saturation/concurrency tests for an explicitly separate load profile. Save the warmup observations but exclude them from steady-state summaries. Label initial requests first-request latency, not verified cold loading: `/v1` cannot prove a model was unloaded. Never evict user models to manufacture a cold test.

Use a monotonic clock and record request dispatch, first nonempty output, first answer content if distinguishable, final output, and completion. Report end-to-end generation time, TTFT, time to first answer when exposed, p50/p95 with sample counts, and total task time including verification as separate metrics. Do not confuse time to headers or an empty SSE delta with TTFT.

Tokens come from endpoint usage. Chunks are not tokens. If usage is unavailable, tokens/s is unavailable unless an explicitly identified compatible tokenizer is installed; character rate can remain a differently named metric. Define client-observed end-to-end output rate as reported completion tokens divided by request-to-final-output time, and record whether reasoning tokens are included or unknown. Never present this as native GPU decode throughput. Separate visible answer and reasoning metrics when supported. Missing reasoning visibility means unknown, not zero. Explain the different workloads behind any published speed reference; [Artificial Analysis performance methodology](https://artificialanalysis.ai/methodology/performance-benchmarking) is not automatically reproduced by a local timing probe.

Record successful, invalid, timed-out, transport-failed, retried, and cancelled observations. Failed attempts consume time and possibly cost even if no tokens are reported; mark uncertainty. Show total seconds per successfully completed task, not just fast successful responses.

For local cost, show `Not configured` by default. Accept optional user-supplied power, electricity price, currency, hourly hardware cost, and allocation assumptions. Label them estimated. Use `energy kWh = watts × seconds / 3,600,000`; cost is energy times price/kWh plus any explicitly separate hardware-time allocation. Avoid double counting an hourly rate that already includes electricity. State whether power is gross or above idle. Endpoint-only operation cannot measure remote watts, VRAM, GPU utilization, thermal throttling, or amortization. Do not add SSH/host agents just to fill these fields.

For selected lab models, show dated published input/output prices in their source currency. A token-price scenario is `(input_tokens × input_price + output_tokens × output_price) / 1,000,000`, with missing cache/reasoning/billing assumptions disclosed. Applying local token counts is an approximate scenario because tokenizers and answer lengths differ; it is not the actual cost of making that lab model solve the task. No automatic FX lookup is required. Never mix currencies or compare a published whole-index cost with a local task cost as though the workloads match. Keep local and published cost/performance frontiers separate.

## 8. Artificial Analysis integration and honest lab comparisons

Implement a server-side, read-only adapter. The current reference documents `GET https://artificialanalysis.ai/api/v2/language/models/free` with an `x-api-key` header and pagination. Recheck the live schema when implementing. Keep the key server-side, respect quota/retry headers, and do not scrape leaderboard HTML. Never send benchmark prompts, answers, or private hardware details to AA. Allow searching by creator and selecting particular model variants. Use stable source IDs for persisted selections. [Artificial Analysis API reference](https://artificialanalysis.ai/data-api/docs/reference)

Cache successful fetches and refresh on demand with a sensible interval, not on every page render. Keep immutable snapshots with raw-data checksum, retrieval time, source URL, schema adapter version, source metric names/units, and methodology information supplied by the source. Store the exact index version the API reports; do not invent a patch version. Handle schema additions, nulls, tier restrictions, and partial pagination without corrupting the last complete snapshot.

Render absent metrics as unavailable. The documentation currently says the old Coding and Agentic Index fields are always null, so never make them required columns or convert them to zero. Provide visible attribution and honor data-display/redistribution rights. Ship no scraped or unlicensed reference database. Missing keys, stale cache, and service failure must not prevent local benchmarking. Support importing the user's authorized, schema-validated snapshot for offline use. [Artificial Analysis data documentation](https://artificialanalysis.ai/data-api/docs)

Provide three evidence labels:

- **Measured here:** outputs generated by this application's frozen local suite.
- **Published reference:** source scores/prices/performance from Artificial Analysis, with timestamp and methodology.
- **Directly comparable benchmark:** available only after verifying equivalent benchmark version, split/items, prompts, grading, tools, reasoning/output budgets, and aggregation. Similar names are insufficient. A subset run is not a full-suite comparison.

Keep the local Core score and AA Intelligence Index on separate panels/axes. Do not normalize one into the other, calculate a percentage of frontier intelligence, fill missing lab essay scores, or overlay unmatched category bars. AA's current index includes private and tool-using evaluations that this chat-based suite cannot recreate; do not claim to reproduce it. [Artificial Analysis intelligence methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking)

Ollama tags are not reliable proof of an AA model match: quantization, fine-tunes, reasoning mode, and serving conditions matter. Let users confirm a family association as contextual metadata; it must not attach the published full-precision score to the measured local artifact. Meaningful direct lab testing requires a future scope change or access through an allowed Ollama endpoint; AA data alone does not supply responses to this app's tasks.

## 9. UI and charts

Use `DESIGN.md` as the visual authority for colour, type and layout. No proprietary fonts, CDN font requirement, gradients, neon, or decorative dashboard clutter.

Use 4px spacing increments, 8px control corners, 12px card corners, and restrained 24px panel padding. Check readable contrast: low-contrast design tokens are for disabled/decorative uses, not essential labels. Use neutral chart series with labels, marker shapes, line styles, and accessible tables; color alone never identifies a model. Keep errors understandable with icons and text.

Keep top-level navigation to **Bench**, **Runs**, and **Compare**, with Settings in a compact menu. Bench has a progressive setup panel and then the run workspace. Limit the workspace to an overall progress header, a model queue, current task/answer, and collapsible category detail. Put sampling, context, power/cost assumptions, and judge calibration in Advanced or task drawers. Support keyboard selection, visible focus, meaningful empty/error/disabled states, semantic tables, polite rate-limited live regions, and reduced motion.

Use only these principal result visualizations, switched through tabs rather than displayed all at once:

- Category dot/bar charts on a fixed 0–100 scale with 95% intervals and sample counts.
- A quality-versus-time or configured-cost scatterplot for compatible local runs, with uncertainty and no frontier claim if cost is unknown.
- A latency distribution/context-quality view when the corresponding diagnostic tab is selected.

Provide an accessible result table and source/evidence badges. Avoid radar charts, dual axes, truncated score axes, and a wall of gauges. Published references get their own chart/table, not mixed points on a local frontier.

Progress is event-derived: show model and task counts, current stage, completed generation/verification/judging work, and a provisional ETA range. A task's token generation has no known completion percentage: use an indeterminate stage indicator plus elapsed time and observed output. Display `Thinking` only when the endpoint exposes that state. Never count SSE chunks as tokens or animate a fake percentage. Overall progress can use a frozen number of work units; distinguish work completion from accuracy and coverage. Pause stops scheduling; cancelling closes the request best-effort and states that remote execution may take time to stop.

At 1440/1024px use a compact two-column workspace; below 768px stack it, move inspectors to drawers, keep controls at least 44px on touch, and contain wide tables without page overflow. Verify 390px mobile width. Do not make progress announcements fire for every token.

## 10. Endpoint contract, state, and job recovery

Use `GET {base}/models` for discovery and `POST {base}/chat/completions` for inference, with `{base}` ending in `/v1`. Normalize a trailing slash and preserve valid reverse-proxy prefixes; do not accidentally append `/v1/v1`. All requests originate on the server. Support optional bearer credentials without exposing them in logs or exports. The client must handle Ollama's documented subset of the OpenAI-compatible API, not assume every OpenAI feature exists. [Ollama compatibility documentation](https://docs.ollama.com/api/openai-compatibility)

For v1, do not require native `/api/*` endpoints. Record quantization, context settings, hardware, and model digest as user-supplied or unavailable when the compatibility API cannot expose them. Do not guess these from a name. Ollama can serve cloud-backed models too: require clear local-serving provenance if verified, otherwise mark hosting unverified rather than asserting endpoint locality proves local compute.

Use small, explicitly recorded preflight probes to establish supported streaming, usage, seed, schema, and reasoning controls for selected models. Unsupported capabilities disable the associated option or create a clearly labeled profile; never silently change controls halfway through a run. Identical HTTP settings do not guarantee identical reasoning compute. Save effective request settings and unknowns. Benchmark-specific official templates override generic defaults and must be versioned.

Implement run states `queued → preflight → warming → running → grading → completed`, plus `pausing`, `paused`, `cancelling`, `cancelled`, `interrupted`, and `failed`. Keep per-task attempts independently durable. Use transactionally claimed jobs, bounded retries, request IDs, and idempotency keys for run creation. Avoid holding SQLite transactions open during HTTP or execution work. Only one runner may own a job lease.

Persist SSE events with increasing IDs; reconnect with replay or a fresh authoritative snapshot, deduplicate events, and send heartbeats. Store capped/periodically batched output, not one database row per token. Browser disconnection must not cancel the job. On process restart, expire leases and mark in-flight work interrupted. Resume reuses completed attempts and records new attempts for uncertain work; it must not silently double-count outputs or merge measurements from incompatible server/model changes. Keep separate timing segments and disclose wall-clock downtime.

Handle connect/read/total timeouts, malformed/fragmented SSE, usage-only chunks, empty chunks, reasoning-only output, non-streaming fallback, model disappearance, and rate limits. Retries are bounded and visible; no retry may quietly replace a scored wrong answer. Explain `localhost` inside Docker and document `host.docker.internal`/Linux host-gateway routing. A Tailscale endpoint requires the Docker host/container route; do not claim the app establishes that route automatically.

## 11. Persistence, API protection, and execution boundaries

Persist endpoint configuration excluding plaintext UI-managed secrets, frozen run manifests, model selections, task IDs, attempts, output artifacts, verifier evidence, judge revisions, metrics, events, and AA snapshots/selections. Saved outputs must permit deterministic rescoring; rerunning inference is not guaranteed to reproduce identical outputs, especially when model digests or server settings are unavailable. Use `/data` as a named volume, content-hashed bounded artifacts, schema versioning, and additive migrations. Default unknown values to null. No destructive reset on startup. Use environment/file secrets by default; if credentials are edited in the UI, encrypt at rest with a separately supplied key or keep them session-only. Exports exclude credentials and restricted third-party data; provide endpoint/prompt redaction for shareable reports without replacing the private reproducibility record.

There are no pre-existing app APIs to modify. Necessary new internal endpoints for connection/discovery, run creation/control/events, results/export, reference refresh/selection, and review are in scope. Define typed contracts once and freeze them during implementation. Do not modify Ollama or Artificial Analysis APIs, authentication, or external servers, and do not add unrelated API providers. Protect secret-bearing routes from cross-origin requests and use same-origin UI access.

Bind the host UI port to loopback by default. Private/LAN/Tailscale Ollama targets are intentionally allowed, but use a configured endpoint allowlist and exact validated origins/prefixes. Reject arbitrary schemes, URL credentials, redirects to other origins, cloud metadata destinations, and benchmark-supplied URLs. Revalidate DNS/destinations when connecting. Keep AA fetches on its fixed origin. Any broader sharing or public deployment requires a separate access-control design.

Generated code is untrusted. Use a maintained isolated execution runtime, preferably gVisor-backed disposable containers, through a narrow execution service. One Compose command should start the deployment after documented runtime prerequisites. The app container must not receive the host Docker socket. A dedicated broker, if needed, may access only a separately configured rootless sandbox engine and a fixed image/job policy, not arbitrary host Docker control.

Each coding attempt needs fresh isolation: no network, no app/database/secrets mounts, read-only root filesystem, bounded tmpfs, dropped capabilities, no privilege escalation, CPU/memory/PID/output/disk/wall-time limits, and full descendant cleanup. Keep trusted grading outside candidate control; a model printing `PASS` is not evidence. Test file, network, process, and cross-job isolation. Do not use `eval`, `exec`, or an ordinary subprocess in the API container as a sandbox. Numeric/symbolic graders must also avoid evaluating untrusted expressions as Python.

If the sandbox is unavailable, show coding as unavailable and suppress the full-suite score while allowing other categories. Never downgrade to unsafe execution or language-model-only grading. Document the extra sandbox service explicitly; do not disguise it as a single isolated app process. Verify deployment on a supported Docker host and document architecture/runtime limitations.

## 12. Implementation order

1. Reinspect the repository and design; create minimal app skeleton, lockfiles, container healthcheck, volume, and basic responsive shell.
2. Define durable models and contracts; implement the deterministic Ollama simulator and run-plan calculation before real inference.
3. Build connection/discovery and model selection, including failure states.
4. Implement the task manifest, one validated task per domain, sandbox boundary, deterministic graders, and golden scoring tests as a vertical slice. This proves the pipeline; it does not satisfy complete pack coverage.
5. Add persistent runner, SSE, timings, cancellation, pause, and recovery. Prove restart behavior with the simulator.
6. Expand to the declared validated packs, sampling budgets, repeats, statistics, coverage rules, and frozen comparison identities.
7. Add writing generation, manual rubric review, optional judge calibration/grading, and disagreement evidence.
8. Implement the AA adapter, snapshot cache, reference selection, attribution, and comparison gating.
9. Finish charts, history, exports, empty/error/accessibility/mobile states, and practical cost estimates.
10. Run the complete verification sequence; fix directly related failures and document any unavailable external prerequisites honestly.

Do not declare completion after the vertical slice or present unverified benchmark content as a finished accurate suite.

## 13. Relevant edge cases

Cover empty model lists, duplicate/long model names, endpoint path mistakes, stale selections, removed models, missing packs/licenses, insufficient unique task families, insufficient context, unsupported controls, missing token usage, long reasoning before answer text, cancelled/partial runs, repeated Start clicks, server restarts, streaming reconnects, full disk, failed migrations, sandbox timeouts, judge failure/disagreement, no AA key, expired credentials, rate limits, null/new reference fields, stale cache, currency mismatch, missing power inputs, and mobile long-output overflow. Use readable errors and diagnostic IDs, not user-facing stack traces.

## 14. Tests, Playwright workflow, and regression checks

Use pytest for graders/runner/statistics, frontend type checking, and Playwright for real workflows. Build a deterministic Ollama/AA simulator that controls answers, timings, malformed streams, usage, and errors. Use synthetic endpoint data only in explicit test/demo fixtures; never let it populate production results.

Essential automated proof:

- Golden correct/incorrect/ambiguous/alternate answers for each verifier; deliberate wrong solutions and model-generated false `PASS` output must fail.
- Fixed aggregate and interval fixtures, family-cluster resampling, paired comparisons, partial-run suppression, missing-data behavior, rubric weights, energy unit conversion, and currency separation.
- URL normalization/proxy paths, credential redaction, destination restrictions, capability fallback, non-streaming behavior, and SSE event replay/deduplication.
- Idempotent run creation, lease ownership, bounded retries, cancellation, pause/resume, and actual process-restart recovery using persistent storage.
- Sandbox attempts to read app secrets, access a network, fork uncontrollably, exceed resources, or affect a later job; verify cleanup and trusted scoring.
- AA pagination, nulls, 401/403/429, schema additions, interrupted refresh retaining the previous complete snapshot, and restricted exports.

Playwright must:

1. Open a fresh app; connect to the test Ollama endpoint and select two models.
2. Choose Standard and confirm the manifest/counts, grading availability, and reference selection; use a bounded test manifest for the actual CI run.
3. Start once despite a double-click, observe actual streamed output/stage/progress, and verify deterministic expected scores after completion.
4. Refresh mid-run, disconnect/reconnect events, pause/resume, then separately cancel a run; verify persistence and no duplicate attempts.
5. Trigger endpoint failure, missing usage, judge failure, an empty model list, and sandbox unavailability; inspect the resulting states.
6. Select/import AA references and verify they never enter unmatched local score charts or acquire invented metrics.
7. Inspect a failed coding task and a writing rubric; export/reimport an allowed bundle and recompute results from saved evidence.
8. Verify navigation/history, keyboard operation, focused controls, chart-table alternatives, 1440px and 390px layouts, no new console errors, and no unexpected failed requests. Expected injected failures must be asserted explicitly.

Also rebuild and start the production Compose deployment from clean data, run an actual sandboxed coding pass/fail pair, restart while work is active, verify volume persistence and healthchecks, and test the nearest workflows after every shared-component change. Run an opt-in, bounded live Ollama smoke test only against an endpoint explicitly configured for testing; never use production endpoints or AA credentials automatically. If live credentials/routing are unavailable, report the limitation and retain deterministic contract-test evidence rather than claiming live verification.

## 15. Autonomy and things that must not change

Choose naming, component boundaries, equivalent maintained libraries, SQL details, selectors, and directly related fixes independently. Prefer the simplest implementation satisfying the evidence requirements. Adjust proposed paths if repository evidence changes, and record material decisions.

Preserve `LICENSE`, the supplied design, existing user files, external API contracts, authentication behavior, model installations, and all saved runs. Do not publish/deploy publicly, call paid lab inference, install host telemetry, introduce privileged execution, change benchmark weights after observing results, replace missing data with fictional scores, or do unrelated refactoring. Avoid destructive migrations. Escalate only genuine conflicts requiring expanded scope, external access, destructive changes, or materially different architecture; resolve ordinary implementation details yourself.

## 16. Acceptance criteria and definition of complete

The implementation is complete only when:

- A documented Compose command builds/starts the UI, persistence, orchestration, and documented sandbox integration; the app image requires no GPU or local model weights.
- An Ollama `/v1` endpoint works end to end: discovery, selection of multiple models, a frozen run, observable progress, durable results, pause/cancel/recovery, and export.
- All six objective domains have usable, provenance-recorded content at the claimed budget, validated grading, and honest coverage/uncertainty. Writing can be evaluated by the anchored human rubric and optional calibrated local judging.
- Code correctness is established by isolated execution, not model opinion; sandbox failures cannot execute code in the app or produce a complete-suite score.
- The user can select published lab references from authorized AA data; attribution, freshness, nulls, methodology, and comparability labels are correct. No unmatched leaderboard or fabricated lab outputs exist.
- Time, tokens, price scenarios, power estimates, and unknown hardware data use correct units and clear provenance. Errors/retries are not hidden from reliability or cost.
- Results are reproducible from saved task manifests, outputs, scoring versions, settings, and allowed source snapshots; app upgrades do not silently rewrite historical scores.
- The UI follows `DESIGN.md`, remains minimal and keyboard/mobile usable, and provides understandable loading, empty, partial, success, and error states.
- Type checking, targeted unit/integration tests, meaningful Playwright workflows, production Docker checks, and sandbox isolation checks pass. Any unperformed live verification is explicitly identified.
- `README.md`, methodology, task/data licenses, deployment limits, and test evidence explain what was actually built. Temporary debugging code is removed. Do not claim scientific validation, contamination freedom, or universal intelligence measurement that has not been demonstrated.

After this release, prioritize only three additions: private task-pack import with contamination controls; dedicated quantization/context comparisons; and opt-in perturbation robustness tests. Keep them out of the initial interface until the core workflow and scoring evidence are reliable.
