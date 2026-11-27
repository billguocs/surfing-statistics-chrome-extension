const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const fakeIndexedDB = require("./fake-indexeddb.cjs");

function store(indexedDB = fakeIndexedDB()) {
  const source = fs.readFileSync(path.join(__dirname, "..", "stats.js"), "utf8");
  return { api: vm.runInNewContext(source + "\nStatsStore", { indexedDB }), indexedDB };
}
const empty = () => ({ daily: {}, weekly: {} });
const host = "example.test";
const seconds = (report, type, key) => report.stats[type][key]?.[host]?.seconds || 0;

test("long gaps are excluded from settlement and live reports, including across worker reloads", async () => {
  const { api, indexedDB } = store();
  await api.migrate(empty);
  const start = new Date(2026, 0, 4, 23, 59, 30).getTime();
  const session = { id: "sleep", hostname: host, url: `https://${host}/`, startedAt: start, isRunning: true };
  await api.settle(session, start + 60000);
  let recorded = await api.read();
  assert.equal(seconds(recorded, "daily", "2026-01-04"), 30);
  assert.equal(seconds(recorded, "daily", "2026-01-05"), 30);
  assert.equal(seconds(recorded, "weekly", "2026-W01"), 30);
  assert.equal(seconds(recorded, "weekly", "2026-W02"), 30);
  const wokeAt = start + 8 * 60 * 60 * 1000;
  const pending = { ...session, startedAt: api.settledThrough(session, recorded.checkpoint) };
  assert.equal(api.withActiveSession(recorded.stats, pending, wokeAt), recorded.stats);
  const reloaded = store(indexedDB).api;
  assert.equal((await reloaded.settle(session, wokeAt)).interrupted, true);
  recorded = await reloaded.read();
  assert.equal(seconds(recorded, "daily", "2026-01-05"), 30);
  assert.equal(recorded.checkpoint.end, wokeAt);
  await reloaded.settle(session, wokeAt); // A retry cannot backfill the skipped gap.
  await reloaded.settle(session, wokeAt - 1); // A delayed event cannot move the checkpoint backward.
  await reloaded.settle(session, wokeAt + 60000);
  recorded = await reloaded.read();
  assert.equal(seconds(recorded, "daily", "2026-01-05"), 90);
  assert.equal(recorded.checkpoint.end, wokeAt + 60000);
});

test("the two-minute boundary is inclusive and confirmed time survives a subsequent interruption", async () => {
  const { api } = store();
  await api.migrate(empty);
  const start = new Date(2026, 10, 26, 10).getTime();
  const session = { id: "boundary", hostname: host, startedAt: start, isRunning: true };
  const day = api.dateKey(new Date(start));
  assert.equal(api.withActiveSession(empty(), session, start + 120000).daily[day][host].seconds, 120);
  assert.equal(api.withActiveSession(empty(), session, start + 120001).daily[day], undefined);
  await api.settle(session, start + 120000);
  await api.settle(session, start + 240001);
  assert.equal(seconds(await api.read(), "daily", day), 120);
});

test("fresh legacy migration rebuilds ISO weeks and preserves records lacking daily detail", async () => {
  const { api, indexedDB } = store();
  await api.migrate(() => ({
    daily: { "2026-01-04": { [host]: { seconds: 60, lastTitle: "Sunday" } }, "2026-01-05": { [host]: { seconds: 20, lastTitle: "Monday" } } },
    weekly: { "2026-W02": { [host]: { seconds: 100, lastTitle: "Weekly" }, "weekly-only.test": { seconds: 45 } } },
  }));
  const report = await api.read();
  assert.equal(seconds(report, "weekly", "2026-W01"), 60);
  assert.equal(seconds(report, "weekly", "2026-W02"), 40);
  assert.equal(report.stats.weekly["2026-W02"]["weekly-only.test"].seconds, 45);
  assert.equal(seconds(report, "daily", "2026-01-04"), 60);
  const before = indexedDB.snapshot();
  assert.equal(before.get("meta").get("weeklyBeforeIsoRepair")[0][1][0][1], 100000);
  await api.migrate(() => { throw new Error("Must not reload legacy data"); });
  assert.deepEqual(indexedDB.snapshot(), before);
  const references = new Map();
  for (const table of ["daily", "weekly"]) {
    for (const rows of before.get(table).values()) {
      for (const [, , reference] of rows) references.set(reference, (references.get(reference) || 0) + 1);
    }
  }
  for (const [id, site] of before.get("sites")) assert.equal(site.references, references.get(id));
});

test("already migrated databases are repaired atomically and can retry after rollback", async () => {
  const indexedDB = fakeIndexedDB();
  indexedDB.seed(new Map([
    ["daily", new Map([["2026-01-04", [[host, 60000, 1]]]])],
    ["weekly", new Map([["2026-W02", [[host, 60000, 1]]]])],
    ["sites", new Map([[1, { host, lastTitle: "Original", lastUrl: "", faviconUrl: "", references: 2 }]])],
    ["meta", new Map([["initialized", true]])],
  ]));
  const { api } = store(indexedDB);
  const original = indexedDB.snapshot();
  indexedDB.failNextCommit = true;
  await assert.rejects(api.migrate(() => { throw new Error("Do not import again"); }), /Simulated transaction failure/);
  assert.deepEqual(indexedDB.snapshot(), original);
  await api.migrate(() => { throw new Error("Do not import again"); });
  const report = await api.read();
  assert.equal(seconds(report, "weekly", "2026-W01"), 60);
  assert.equal(seconds(report, "weekly", "2026-W02"), 0);
  assert.equal(indexedDB.snapshot().get("meta").get("isoWeekRepairVersion"), 1);
  await api.clear(null, Date.now());
  assert.equal(indexedDB.snapshot().get("meta").has("weeklyBeforeIsoRepair"), false);
  assert.equal(indexedDB.snapshot().get("sites").size, 0);
});
