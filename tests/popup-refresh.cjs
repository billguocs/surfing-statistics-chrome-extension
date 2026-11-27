const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function load(file, globals, expression = "") {
  return vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8") + "\n" + expression,
    globals, { filename: file });
}
const stats = load("stats.js", {}, "StatsStore");

// Keep the VM DOM mock independent so this suite also runs on its own.
function element() {
  return {
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    children: [], style: {}, dataset: {}, textContent: "", value: "",
    classList: { add() {}, remove() {}, toggle() {} },
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

const now = new Date(2026, 2, 31, 10).getTime();
function snapshot(host = "recorded.test", isRunning = false) {
  return {
    stats: { daily: { [stats.dateKey(new Date(now))]: { [host]: { seconds: 60 } } }, weekly: {} },
    session: isRunning ? { id: "live", hostname: "active.test", startedAt: now - 60000, isRunning: true } : null,
  };
}

function popup() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const document = {
    ...element(), getElementById: get, querySelector: get,
    createElement: element, createTextNode: (textContent) => ({ textContent }),
  };
  const window = { addEventListener() {} };
  const onChanged = { addListener(callback) { this.emit = callback; } };
  const requests = [];
  const intervals = [];
  const warnings = [];
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  load("llm.js", { window });
  load("popup.js", {
    window, document, Date: Clock,
    console: { warn(...args) { warnings.push(args); } },
    setInterval(callback, milliseconds) { intervals.push({ callback, milliseconds }); },
    chrome: { runtime: {}, storage: {
      local: { get(keys, callback) { callback({}); } }, onChanged,
    } },
    echarts: { init: () => ({ setOption() {} }), dispose() {} },
    StatsStore: { ...stats, withActiveSession: (data, session) => stats.withActiveSession(data, session, now), request(type) {
      assert.equal(type, "GET_STATS");
      return new Promise((resolve, reject) => requests.push({ resolve, reject }));
    } },
  });
  return {
    requests, intervals, warnings,
    init: () => document.listeners.get("DOMContentLoaded")(),
    sessionChanged: () => onChanged.emit({ activeSession: { newValue: { isRunning: true } } }, "session"),
    click: (id) => get(id).listeners.get("click")(),
    rows: () => JSON.stringify(get("reportTableBody").children),
    error: () => get("emptyState").textContent,
  };
}

async function initializedPopup() {
  const app = popup();
  const ready = app.init();
  app.requests[0].resolve(snapshot());
  await ready;
  return app;
}

test("session started during an old inactive snapshot triggers a refresh and keeps polling", async () => {
  const app = popup();
  const ready = app.init();
  await app.sessionChanged();
  assert.equal(app.requests.length, 1);
  app.requests[0].resolve(snapshot("old.test"));
  await tick();
  assert.equal(app.requests.length, 2);
  app.requests[1].resolve(snapshot("new.test", true));
  await ready;
  assert.match(app.rows(), /active\.test/);
  assert.doesNotMatch(app.rows(), /old\.test/);
  assert.equal(app.intervals.length, 1);
  assert.equal(app.intervals[0].milliseconds, 5000);

  app.intervals[0].callback();
  assert.equal(app.requests.length, 3);
  app.intervals[0].callback();
  assert.equal(app.requests.length, 3, "polling must not overlap a pending request");
  app.requests[2].resolve(snapshot("poll.test", true));
  await tick();
  assert.match(app.rows(), /poll\.test/);
  app.intervals[0].callback();
  assert.equal(app.requests.length, 4, "polling continues after the catch-up request");
  app.requests[3].resolve(snapshot());
  await tick();
  app.intervals[0].callback();
  assert.equal(app.requests.length, 4, "polling stops after the session stops");
});

test("pending session events coalesce, including events during the catch-up, then become quiet", async () => {
  const app = popup();
  const ready = app.init();
  for (let i = 0; i < 5; i++) await app.sessionChanged();
  app.requests[0].resolve(snapshot());
  await tick();
  assert.equal(app.requests.length, 2);
  for (let i = 0; i < 5; i++) await app.sessionChanged();
  app.requests[1].resolve(snapshot());
  await tick();
  assert.equal(app.requests.length, 3);
  app.requests[2].resolve(snapshot("final.test"));
  await ready;
  await tick();
  assert.equal(app.requests.length, 3, "a consumed dirty flag must not create a refresh loop");
  assert.match(app.rows(), /final\.test/);

  const change = app.sessionChanged();
  assert.equal(app.requests.length, 4, "an event while idle still refreshes immediately");
  app.requests[3].resolve(snapshot());
  await change;
  await tick();
  assert.equal(app.requests.length, 4);
});

for (const staleFails of [false, true]) {
  test(`a superseded ${staleFails ? "failed" : "successful"} request cannot consume the latest pending refresh`, async () => {
    const app = await initializedPopup();
    const older = app.click("todayBtn");
    const latest = app.click("siteViewBtn");
    await app.sessionChanged();
    if (staleFails) app.requests[1].reject(new Error("stale failure"));
    else app.requests[1].resolve(snapshot("stale.test"));
    await older;
    assert.equal(app.requests.length, 3, "stale completion cannot start the catch-up");
    assert.equal(app.warnings.length, 0);
    await app.sessionChanged();
    assert.equal(app.requests.length, 3, "stale completion cannot clear the latest pending state");
    app.requests[2].resolve(snapshot());
    await tick();
    assert.equal(app.requests.length, 4);
    app.requests[3].resolve(snapshot("latest.test", true));
    await latest;
    assert.match(app.rows(), /latest\.test/);
    assert.doesNotMatch(app.rows(), /stale\.test/);
    await tick();
    assert.equal(app.requests.length, 4);
  });
}

test("a newer request covers earlier events and a late stale response cannot overwrite it", async () => {
  const app = await initializedPopup();
  const older = app.click("todayBtn");
  await app.sessionChanged();
  const latest = app.click("siteViewBtn");
  app.requests[2].resolve(snapshot("latest.test", true));
  await latest;
  assert.equal(app.requests.length, 3, "the newer request already covers earlier session events");
  app.requests[1].resolve(snapshot("stale.test"));
  await older;
  assert.match(app.rows(), /latest\.test/);
  assert.doesNotMatch(app.rows(), /stale\.test/);
  app.intervals[0].callback();
  assert.equal(app.requests.length, 4, "stale inactive response must not disable polling");
  app.requests[3].resolve(snapshot());
  await tick();
});

for (const failCatchUp of [false, true]) {
  test(`${failCatchUp ? "catch-up" : "initial"} failure drops pending refresh without retrying and permits recovery`, async () => {
    const app = popup();
    const ready = app.init();
    await app.sessionChanged();
    if (failCatchUp) {
      app.requests[0].resolve(snapshot());
      await tick();
      await app.sessionChanged();
    }
    app.requests.at(-1).reject(new Error("report unavailable"));
    await ready;
    await tick();
    const count = failCatchUp ? 2 : 1;
    assert.equal(app.requests.length, count, "failure must not automatically retry a pending refresh");
    assert.equal(app.warnings.length, 1);
    assert.match(app.error(), /读取统计失败/);
    const recovery = app.sessionChanged();
    assert.equal(app.requests.length, count + 1);
    app.requests.at(-1).resolve(snapshot("recovered.test", true));
    await recovery;
    await tick();
    assert.equal(app.requests.length, count + 1, "recovery must not retain the old dirty flag");
    assert.match(app.rows(), /recovered\.test/);
  });
}
