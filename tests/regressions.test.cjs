const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function load(file, globals, expression = "", omit = /$^/) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(omit, "");
  return vm.runInNewContext(source + "\n" + expression, globals, { filename: file });
}

const stats = load("stats.js", {}, "StatsStore");

function storageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys, callback) {
      const result = structuredClone(Object.fromEntries([keys].flat().map((key) => [key, data[key]])));
      if (callback) callback(result);
      return result;
    },
    async set(items, callback) {
      Object.assign(data, structuredClone(items));
      if (callback) callback();
    },
    async remove(keys, callback) {
      for (const key of [keys].flat()) delete data[key];
      if (callback) callback();
    },
  };
}

function event() {
  return { addListener(callback) { this.emit = callback; } };
}

function element() {
  return {
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    textContent: "",
    value: "",
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); },
    replaceChildren(...nodes) { this.children = nodes; },
    insertCell() { const cell = element(); this.append(cell); return cell; },
    insertRow() { const row = element(); this.append(row); return row; },
    setAttribute() {},
    set innerHTML(value) { this.html = value; this.children = []; },
    get innerHTML() { return this.html; },
  };
}

function ui() {
  const elements = new Map();
  const get = (name) => {
    if (!elements.has(name)) elements.set(name, element());
    return elements.get(name);
  };
  const document = {
    ...element(),
    getElementById: get,
    querySelector: get,
    createElement: element,
    createTextNode: (textContent) => ({ textContent }),
  };
  return { document, get };
}

test("month navigation, midnight/ISO week boundaries and CSV safety", () => {
  assert.equal(stats.dateKey(stats.shiftMonth(new Date(2026, 2, 31), -1)), "2026-02-01");
  assert.equal(stats.dateKey(stats.shiftMonth(new Date(2026, 0, 31), -1)), "2025-12-01");
  const start = new Date(2026, 0, 4, 23, 59, 59, 700).getTime();
  const segments = stats.splitRange(start, start + 1200);
  assert.equal(JSON.stringify(segments), JSON.stringify([
    { day: "2026-01-04", week: "2026-W01", milliseconds: 300 },
    { day: "2026-01-05", week: "2026-W02", milliseconds: 900 },
  ]));
  assert.equal(stats.csvCell(" =1+1"), "\"' =1+1\"");
  assert.equal(stats.csvCell("Title, \"quoted\""), "\"Title, \"\"quoted\"\"\"");
  assert.equal(stats.csvCell(-5), "\"-5\"");
});

test("live reporting adds only the portion after the saved checkpoint", () => {
  const date = new Date(2026, 0, 5, 12);
  const startedAt = date.getTime();
  const day = stats.dateKey(date);
  const week = stats.weekKey(date);
  const host = "active.test";
  const recorded = { daily: { [day]: { [host]: { seconds: 59 } } }, weekly: { [week]: { [host]: { seconds: 59 } } } };
  const session = { id: "active", hostname: host, startedAt, isRunning: true };
  const pending = { ...session, startedAt: stats.settledThrough(session, { id: session.id, end: startedAt + 59000 }) };
  const live = stats.withActiveSession(recorded, pending, startedAt + 60000);
  assert.equal(live.daily[day][host].seconds, 60);
  assert.equal(live.weekly[week][host].seconds, 60);
  assert.equal(recorded.daily[day][host].seconds, 59);
});

test("serialized tracking flushes before internal pages and ignores unfocused tabs", async () => {
  let time = new Date(2026, 0, 5, 12).getTime();
  class Clock extends Date { static now() { return time; } }
  const first = { id: 1, windowId: 10, url: "https://first.test/" };
  const second = { id: 2, windowId: 10, url: "https://second.test/" };
  const internal = { id: 3, windowId: 10, url: "chrome://settings/" };
  const tabs = new Map([first, second, internal].map((tab) => [tab.id, tab]));
  let active = first;
  let focused = true;
  let idleState = "active";
  let hasActiveMedia = false;
  const settled = [];
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), getURL: () => "chrome-extension://test/" },
    storage: { local: storageArea(), session: storageArea(), onChanged: event() },
    alarms: { onAlarm: event(), get: async () => ({}), create: async () => {} },
    idle: { queryState: async () => idleState },
    windows: { onFocusChanged: event(), WINDOW_ID_NONE: -1, getAll: async () => [{ id: 10, focused }] },
    tabs: {
      onActivated: event(), onUpdated: event(), onRemoved: event(),
      get: async (id) => tabs.get(id),
      query: (_, callback) => callback([active]),
      sendMessage: async () => ({ hasActiveMedia }),
    },
  };
  load("background.js", {
    chrome, importScripts() {}, console, Date: Clock, URL, crypto: require("node:crypto").webcrypto,
    StatsStore: {
      ...stats,
      migrate: (read) => read(),
      read: async () => ({ stats: {} }),
      async settle(session, end) {
        if (session?.isRunning) {
          await tick();
          settled.push([session.tabId, end - session.startedAt]);
        }
      },
      async clear() {},
    },
  });
  const get = (type = "GET_STATS") => new Promise((resolve) =>
    chrome.runtime.onMessage.emit({ type }, { url: "chrome-extension://test/popup.html" }, resolve));
  const message = (type, tab) => chrome.runtime.onMessage.emit({ type }, { tab, url: tab.url, frameId: 0 });
  const activate = ({ id: tabId, windowId }) => chrome.tabs.onActivated.emit({ tabId, windowId });
  assert.equal((await get()).session.tabId, first.id);
  time += 30000;
  active = internal;
  await activate(active);
  assert.equal((await get()).session, null);
  assert.deepEqual(settled, [[first.id, 30000]]);

  active = first;
  await activate(first);
  time += 30000;
  active = second;
  message("PAGE_HIDDEN", first);
  await activate(second);
  assert.equal((await get()).session.tabId, second.id);
  assert.deepEqual(settled, [[first.id, 30000], [first.id, 30000]]);

  time += 1000;
  active = first;
  const switching = activate(first);
  time += 2000;
  active = second;
  await activate(second);
  await switching;
  assert.deepEqual(settled.slice(-2), [[second.id, 1000], [first.id, 2000]]);

  await get("CLEAR_STATS");
  assert.equal((await get()).session.startedAt, time);
  focused = false;
  await chrome.windows.onFocusChanged.emit(-1);
  message("PAGE_VISIBLE", second);
  await activate(second);
  assert.equal((await get()).session.isRunning, false);

  focused = true;
  message("PAGE_ACTIVE", second);
  assert.equal((await get()).session.isRunning, false);
  await chrome.windows.onFocusChanged.emit(second.windowId);
  time += 190000;
  idleState = "idle";
  hasActiveMedia = true;
  await chrome.alarms.onAlarm.emit({ name: "behavior-check" });
  assert.equal((await get()).session.isRunning, true);

  time += 60000;
  hasActiveMedia = false;
  await chrome.alarms.onAlarm.emit({ name: "behavior-check" });
  const paused = (await get()).session;
  assert.equal(paused.pauseReason, "idle");
  assert.equal(paused.isRunning, false);
  time += 1000;
  message("PAGE_ACTIVE", second);
  const resumed = (await get()).session;
  assert.equal(resumed.isRunning, true);
  assert.equal(resumed.startedAt, time);
  assert.notEqual(resumed.id, paused.id);
});

test("reports render immediately, reject stale summaries and reuse pending requests", async () => {
  const { document, get } = ui();
  const today = new Date(2026, 2, 31, 10);
  const oldDate = stats.dateKey(stats.shiftDay(today, -1));
  const data = {
    [oldDate]: { "older.test": { seconds: 120 } },
    [stats.dateKey(today)]: { "newer.test": { seconds: 60 } },
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [today.getTime()])); } }
  const window = { addEventListener() {} };
  const pending = [];
  load("llm.js", { window });
  window.LLMUtils.requestSmartSummary = () => new Promise((resolve) => pending.push(resolve));
  load("popup.js", {
    window, document, Date: Clock, console, setInterval() {},
    chrome: {
      runtime: {},
      storage: {
        local: storageArea({ llmConfig: { enabled: true }, llmFeatureFlags: { smartSummaryEnabled: true } }),
        onChanged: event(),
      },
    },
    echarts: { init: () => ({ setOption() {} }), dispose() {} },
    StatsStore: {
      ...stats,
      request: async () => ({ stats: { daily: data, weekly: {} }, session: null }),
    },
  });
  await document.listeners.get("DOMContentLoaded")();
  assert.equal(pending.length, 1);
  const rowText = () => JSON.stringify(get("reportTableBody").children);
  assert.match(rowText(), /newer\.test/);
  await get("prevDayBtn").listeners.get("click")();
  assert.equal(pending.length, 2);
  assert.match(rowText(), /older\.test/);
  await get("searchInput").listeners.get("input")({ target: { value: "older" } });
  assert.equal(pending.length, 2);
  pending[1](["Current summary"]);
  pending[0](["Stale summary"]);
  await tick();
  assert.match(rowText(), /older\.test/);
  assert.match(get("summaryList").innerHTML, /Current summary/);
  await get("thisMonthBtn").listeners.get("click")();
  await get("prevMonthBtn").listeners.get("click")();
  assert.match(get("reportTitle").textContent, /2026 年 02 月/);
});

test("settings keep local suggestions after a provider failure and render titles as text", async () => {
  const { document, get } = ui();
  const window = {};
  load("llm.js", { window });
  window.LLMUtils.requestCategorySuggestions = async () => { throw new Error("429"); };
  const githubTitle = "GitHub <sample>";
  load("options.js", {
    window, document, console: { warn() {} },
    Option: class { constructor(text, value) { Object.assign(this, { text, value }); } },
    chrome: { runtime: {}, storage: { local: storageArea({
      llmConfig: { enabled: true, apiKey: "test-key", model: "mock" },
      llmFeatureFlags: { categorySuggestionEnabled: true },
    }) } },
    StatsStore: { request: async () => ({ stats: { daily: { today: {
      "github.com": { lastTitle: githubTitle }, "unknown.invalid": {},
    } } } }) },
  });
  await document.listeners.get("DOMContentLoaded")();
  assert.match(get("suggestionStatusText").textContent, /额度不足/);
  assert.match(JSON.stringify(get("suggestionList").children), /github\.com/);
  const site = get("siteList").children[0];
  assert.ok(site.children.some((child) => child.children?.some((node) => node.textContent.includes(githubTitle))));
});

test("interrupted bookmark rechecks do not select untested entries", async () => {
  const { document, get } = ui();
  const one = { id: "3", title: "One", url: "https://one.test/", parentId: "2" };
  const two = { id: "4", title: "Two", url: "https://two.test/", parentId: "2" };
  get("#listInput").value = one.url + "\n" + two.url;
  get("#optConc").value = "1";
  const chrome = { bookmarks: { getTree: async () => [{ id: "0", children: [{ id: "2", children: [one, two] }] }] } };
  const globals = {
    document, chrome, console, URL, AbortController, setTimeout() {}, clearTimeout() {},
    async fetch(url) {
      assert.equal(url, one.url);
      api.state.stop = true;
      return { status: 404, url };
    },
  };
  const api = load("tools/bookmark-auditor/checker.js", globals, "({ state, matchList, runScan })", /\ninit\(\)\.catch[^\n]*/);
  await api.runScan(() => api.matchList(true));
  assert.deepEqual([...api.state.selected], [one.id]);
  assert.equal(api.state.rows.find((row) => row.bm.id === two.id).status, "pending");
});

test("undo restores confirmed deletions only and retains failed restores for retry", async () => {
  const { document } = ui();
  const one = { id: "3", title: "One", url: "https://one.test/", parentId: "2" };
  const two = { id: "4", title: "Two", url: "https://two.test/", parentId: "2" };
  const nodes = new Map([[one.id, one], [two.id, two]]);
  let allowRestoration = false;
  const local = storageArea();
  const chrome = {
    storage: { local },
    bookmarks: {
      getTree: async () => [{ id: "0", children: [{ id: "2", children: [...nodes.values()] }] }],
      getChildren: async () => [...nodes.values()],
      async get(id) {
        if (id === "2") return [{ id }];
        if (!nodes.has(id)) throw new Error("Missing");
        return [nodes.get(id)];
      },
      async remove(id) {
        if (id === two.id) throw new Error("Simulated removal failure");
        nodes.delete(id);
      },
      async create(bookmark) {
        if (!allowRestoration) throw new Error("Simulated restoration failure");
        nodes.set("5", { ...bookmark, id: "5" });
      },
    },
  };
  const api = load("tools/bookmark-auditor/checker.js", {
    document, chrome, console, URL, confirm: () => true, setTimeout() {}, clearTimeout() {},
  }, "({ state, deleteSelected, undoLast })", /\ninit\(\)\.catch[^\n]*/);
  api.state.rows = [one, two].map((bm) => ({ bm, status: "dead" }));
  api.state.selected = new Set([one.id, two.id]);
  await api.deleteSelected();
  assert.deepEqual(local.data.lastMutation.items.map((item) => item.id), [one.id]);
  await api.undoLast();
  assert.equal(local.data.lastMutation.items.length, 1);
  allowRestoration = true;
  await api.undoLast();
  assert.equal(local.data.lastMutation, undefined);
  assert.deepEqual([...nodes.values()].map((node) => node.url).sort(), [one.url, two.url]);
});
