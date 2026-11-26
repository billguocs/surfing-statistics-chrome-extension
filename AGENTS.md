# Repository guidelines

## Development and validation

- The repository root is a Chrome Manifest V3 extension for tracking browsing time. It uses plain JavaScript and bundled ECharts. There is no dependency installation or local build step.
- At `chrome://extensions/`, enable Developer mode and load the repository root as an unpacked extension. After an edit, reload the extension and refresh any tabs used to test the content script. Use the **service worker** link on the extensions page for background logs and **Inspect popup** for popup logs.
- Run `node --check <file>` on each changed JavaScript file and `node --test tests/regressions.test.cjs` for the regression suite. In Chrome, exercise the affected workflow. For tracking changes, switch between two HTTP(S) tabs and a browser settings tab, close a tab, and move focus away from Chrome. Verify that time accrues only on the visible, focused page and appears in the popup reports.
- `.github/workflows/release-extension.yml` runs syntax and regression checks on pull requests and before publishing. It packages an explicit file list and publishes a GitHub release on pushes to `main` or manual dispatch. It reads the version from `manifest.json`. If a change adds a runtime asset, update its script references and the release file list as applicable.

## Extension structure

- `background.js` is the service worker. It handles tab, window, and content-script events, persists browsing time, and evaluates notifications and idle pauses. `content.js` reports visibility and user interaction and responds to media-state queries.
- `activeSession` lives in `chrome.storage.session`. `stats.js` stores elapsed milliseconds in IndexedDB local-date and ISO-week buckets with shared site metadata. The worker serializes session transitions and uses a persisted checkpoint to prevent a retried settlement from counting time twice. Preserve migration from `statsV2` and the older `dailyStats`, `weeklyStats`, and `tabMeta` keys, as well as the JSON and CSV export formats.
- `popup.js` renders daily, weekly, and monthly reports using ECharts. It derives monthly reports from daily buckets. `options.js` manages category mappings, goals, focus settings, scenes, and LLM settings. Keep shared storage keys, category defaults, and scene IDs consistent across the scripts that use them. Write user-facing copy in Chinese to match the existing UI.
- `llm.js` exposes `window.LLMUtils` and is loaded before both page scripts. It uses OpenAI-compatible endpoints for category suggestions and summaries, with defaults for OpenAI, DeepSeek, and Gemini. Preserve the `hostname_only` default. Include page titles and URLs in provider payloads only in `full_context` mode.
- If working in `tools/bookmark-auditor/`, load that directory separately as an unpacked extension and follow its own README. The root release workflow packages the browsing statistics extension.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
