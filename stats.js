/* Shared by the service worker and the extension pages. */
const StatsStore = (() => {
  const tables = ["daily", "weekly", "sites", "meta"];
  const MAX_UNVERIFIED_MS = 2 * 60 * 1000;
  let database;

  function openDatabase() {
    if (!database) {
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open("browsing-statistics", 1);
        request.onupgradeneeded = () => {
          for (const table of tables) {
            const store = request.result.createObjectStore(table, { autoIncrement: table === "sites" });
            if (table === "sites") store.createIndex("content", ["host", "lastTitle", "lastUrl", "faviconUrl"], { unique: true });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        database = null;
        throw error;
      });
    }
    return database;
  }

  function readRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transaction(mode, operation) {
    const db = await openDatabase();
    const tx = db.transaction(tables, mode);
    const stores = Object.fromEntries(tables.map((name) => [name, tx.objectStore(name)]));
    const finished = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("Statistics transaction aborted"));
    });
    let result;
    try {
      result = await operation(stores);
    } catch (error) {
      try { tx.abort(); } catch { /* The transaction has already ended. */ }
      await finished.catch(() => {});
      throw error;
    }
    await finished;
    return result;
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function weekKey(date) {
    const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
    const year = utc.getUTCFullYear();
    const first = Date.UTC(year, 0, 1);
    return `${year}-W${String(Math.ceil(((utc - first) / 86400000 + 1) / 7)).padStart(2, "0")}`;
  }

  function shiftMonth(date, difference) {
    return new Date(date.getFullYear(), date.getMonth() + difference, 1);
  }

  function shiftDay(date, difference) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + difference);
  }

  function splitRange(start, end) {
    const segments = [];
    while (start < end) {
      const date = new Date(start);
      const next = new Date(start);
      next.setHours(24, 0, 0, 0);
      const boundary = Math.min(end, next.getTime());
      segments.push({ day: dateKey(date), week: weekKey(date), milliseconds: boundary - start });
      start = boundary;
    }
    return segments;
  }

  function sessionMetadata(session, previous = {}) {
    return {
      lastTitle: session.title || previous.lastTitle || "",
      lastUrl: session.url || previous.lastUrl || "",
      faviconUrl: session.faviconUrl || previous.faviconUrl || "",
    };
  }

  function metadataFromEntry(entry) {
    return {
      lastTitle: String(entry?.lastTitle || ""),
      lastUrl: String(entry?.lastUrl || ""),
      faviconUrl: String(entry?.faviconUrl || ""),
    };
  }

  function metadataWriter(store) {
    const keys = new Map();
    return (host, metadata) => {
      const content = [host, metadata.lastTitle, metadata.lastUrl, metadata.faviconUrl];
      const key = JSON.stringify(content);
      if (!keys.has(key)) {
        keys.set(key, readRequest(store.index("content").getKey(content)).then((existing) =>
          existing ?? readRequest(store.add({ host, ...metadata, references: 0 }))
        ));
      }
      return keys.get(key);
    };
  }

  function changeReferenceCount(deltas, key, delta) {
    deltas.set(key, (deltas.get(key) || 0) + delta);
  }

  async function updateReferences(store, deltas) {
    await Promise.all([...deltas].map(async ([key, delta]) => {
      if (!delta) return;
      const record = await readRequest(store.get(key));
      record.references += delta;
      if (record.references > 0) store.put(record, key);
      else store.delete(key);
    }));
  }

  async function repairIsoWeeks({ daily, weekly, sites, meta }) {
    if (await readRequest(meta.get("isoWeekRepairVersion"))) return;
    const [days, originalWeeks] = await Promise.all([readBuckets(daily), readBuckets(weekly)]);
    const rebuilt = new Map();
    const remaining = new Map(originalWeeks.map(([key, rows]) => [key,
      new Map(rows.map(([host, milliseconds, reference]) => [host, { milliseconds, reference }]))
    ]));
    const unmatched = new Map();

    for (const [day, rows] of days.sort(([a], [b]) => a.localeCompare(b))) {
      const date = new Date(`${day}T12:00:00`);
      if (!Number.isFinite(date.getTime()) || dateKey(date) !== day) continue;
      const key = weekKey(date);
      if (!rebuilt.has(key)) rebuilt.set(key, new Map());
      for (const [host, milliseconds, reference] of rows) {
        const previous = rebuilt.get(key).get(host);
        rebuilt.get(key).set(host, { milliseconds: (previous?.milliseconds || 0) + milliseconds, reference });
      }
    }

    // First consume matching ISO buckets; preserve totals that have no daily records.
    for (const [key, hosts] of rebuilt) {
      for (const [host, entry] of hosts) {
        const original = remaining.get(key)?.get(host);
        const matched = Math.min(entry.milliseconds, original?.milliseconds || 0);
        if (original) original.milliseconds -= matched;
        unmatched.set(host, (unmatched.get(host) || 0) + entry.milliseconds - matched);
      }
    }
    for (const hosts of remaining.values()) {
      for (const [host, entry] of hosts) {
        const matched = Math.min(entry.milliseconds, unmatched.get(host) || 0);
        entry.milliseconds -= matched;
        unmatched.set(host, (unmatched.get(host) || 0) - matched);
      }
    }
    for (const [key, hosts] of remaining) {
      for (const [host, entry] of hosts) {
        if (entry.milliseconds <= 0) continue;
        if (!rebuilt.has(key)) rebuilt.set(key, new Map());
        const previous = rebuilt.get(key).get(host);
        rebuilt.get(key).set(host, { ...entry, milliseconds: entry.milliseconds + (previous?.milliseconds || 0) });
      }
    }

    const references = new Map();
    for (const [, rows] of originalWeeks) {
      for (const [, , reference] of rows) changeReferenceCount(references, reference, -1);
    }
    weekly.clear();
    for (const [key, hosts] of rebuilt) {
      const rows = [...hosts].map(([host, entry]) => [host, entry.milliseconds, entry.reference]);
      for (const [, , reference] of rows) changeReferenceCount(references, reference, 1);
      weekly.put(rows, key);
    }
    // Back up self-contained metadata, so reference-count cleanup cannot invalidate it.
    if (originalWeeks.length) {
      const backup = await Promise.all(originalWeeks.map(async ([key, rows]) => [key,
        await Promise.all(rows.map(async ([host, milliseconds, reference]) =>
          [host, milliseconds, metadataFromEntry(await readRequest(sites.get(reference)))])
        )
      ]));
      meta.put(backup, "weeklyBeforeIsoRepair");
    }
    await updateReferences(sites, references);
    meta.put(1, "isoWeekRepairVersion");
  }

  async function migrate(loadLegacy) {
    const [initialized, repaired] = await transaction("readonly", ({ meta }) =>
      Promise.all([readRequest(meta.get("initialized")), readRequest(meta.get("isoWeekRepairVersion"))])
    );
    if (initialized && repaired) return;
    const legacy = initialized ? null : await loadLegacy();
    await transaction("readwrite", async (stores) => {
      const { daily, weekly, sites, meta } = stores;
      if (!await readRequest(meta.get("initialized"))) {
        const writeMetadata = metadataWriter(sites);
        const references = new Map();
        for (const [name, store] of [["daily", daily], ["weekly", weekly]]) {
          for (const [key, bucket] of Object.entries(legacy[name] || {})) {
            const entries = await Promise.all(Object.entries(bucket || {}).map(async ([host, entry]) => [
              host,
              Math.round((Number(entry?.seconds) || 0) * 1000),
              await writeMetadata(host, metadataFromEntry(entry)),
            ]));
            if (entries.length) {
              for (const [, , reference] of entries) changeReferenceCount(references, reference, 1);
              store.put(entries, key);
            }
          }
        }
        await updateReferences(sites, references);
        meta.put(legacy.updatedAt || null, "updatedAt");
        meta.put(true, "initialized");
      }
      await repairIsoWeeks(stores);
    });
  }

  async function readBuckets(store, keys) {
    if (keys) {
      const unique = [...new Set(keys)];
      const buckets = await Promise.all(unique.map((key) => readRequest(store.get(key))));
      return unique.flatMap((key, index) => buckets[index] ? [[key, buckets[index]]] : []);
    }
    const [allKeys, buckets] = await Promise.all([readRequest(store.getAllKeys()), readRequest(store.getAll())]);
    return allKeys.map((key, index) => [key, buckets[index]]);
  }

  function read({ days, weeks } = {}) {
    return transaction("readonly", async ({ daily, weekly, sites, meta }) => {
      const [dayBuckets, weekBuckets, updatedAt, checkpoint] = await Promise.all([
        readBuckets(daily, days),
        readBuckets(weekly, weeks),
        readRequest(meta.get("updatedAt")),
        readRequest(meta.get("checkpoint")),
      ]);
      const metadata = new Map();
      for (const [, rows] of [...dayBuckets, ...weekBuckets]) {
        for (const [, , key] of rows) {
          if (!metadata.has(key)) metadata.set(key, readRequest(sites.get(key)));
        }
      }
      const hydrate = (buckets) => Promise.all(buckets.map(async ([key, rows]) => [
        key,
        Object.fromEntries(await Promise.all(rows.map(async ([host, milliseconds, reference]) => [
          host, { seconds: milliseconds / 1000, ...metadataFromEntry(await metadata.get(reference)) },
        ]))),
      ]));
      const [daysWithMetadata, weeksWithMetadata] = await Promise.all([hydrate(dayBuckets), hydrate(weekBuckets)]);
      return {
        stats: { version: 2, updatedAt, daily: Object.fromEntries(daysWithMetadata), weekly: Object.fromEntries(weeksWithMetadata) },
        checkpoint,
      };
    });
  }

  function settledThrough(session, checkpoint) {
    return checkpoint?.id === session.id ? Math.max(session.startedAt, checkpoint.end) : session.startedAt;
  }

  function settle(session, end) {
    if (!session?.isRunning) return;
    return transaction("readwrite", async ({ daily, weekly, sites, meta }) => {
      const checkpoint = await readRequest(meta.get("checkpoint"));
      const start = settledThrough(session, checkpoint);
      if (end <= start) return;
      // Alarms do not wake a sleeping device. Never backfill a long unverified gap.
      if (end - start > MAX_UNVERIFIED_MS) {
        meta.put({ id: session.id, end }, "checkpoint");
        return { interrupted: true };
      }
      const segments = splitRange(start, end);
      const writeMetadata = metadataWriter(sites);
      const references = new Map();
      for (const [name, store] of [["day", daily], ["week", weekly]]) {
        const totals = new Map();
        for (const segment of segments) {
          const key = segment[name];
          totals.set(key, (totals.get(key) || 0) + segment.milliseconds);
        }
        for (const [key, milliseconds] of totals) {
          const rows = await readRequest(store.get(key)) || [];
          const index = rows.findIndex(([host]) => host === session.hostname);
          const previous = rows[index];
          const metadata = previous ? await readRequest(sites.get(previous[2])) : undefined;
          const reference = await writeMetadata(session.hostname, sessionMetadata(session, metadata));
          if (previous?.[2] !== reference) {
            changeReferenceCount(references, reference, 1);
            if (previous) changeReferenceCount(references, previous[2], -1);
          }
          const entry = [session.hostname, (previous?.[1] || 0) + milliseconds, reference];
          if (previous) rows[index] = entry;
          else rows.push(entry);
          store.put(rows, key);
        }
      }
      await updateReferences(sites, references);
      meta.put({ id: session.id, end }, "checkpoint");
      meta.put(new Date(end).toISOString(), "updatedAt");
    });
  }

  function clear(session, now) {
    return transaction("readwrite", ({ daily, weekly, sites, meta }) => {
      daily.clear();
      weekly.clear();
      sites.clear();
      meta.delete("weeklyBeforeIsoRepair");
      meta.put(null, "updatedAt");
      if (session) meta.put({ id: session.id, end: now }, "checkpoint");
      else meta.delete("checkpoint");
    });
  }

  function withActiveSession(stats, session, now = Date.now()) {
    if (!session?.isRunning || now - session.startedAt > MAX_UNVERIFIED_MS) return stats;
    const next = { ...stats, daily: { ...stats.daily }, weekly: { ...stats.weekly } };
    for (const segment of splitRange(session.startedAt, now)) {
      for (const [name, key] of [["daily", segment.day], ["weekly", segment.week]]) {
        const bucket = next[name][key];
        const previous = Object.hasOwn(bucket || {}, session.hostname) ? bucket[session.hostname] : undefined;
        next[name][key] = {
          ...bucket,
          [session.hostname]: {
            seconds: (previous?.seconds || 0) + segment.milliseconds / 1000,
            ...sessionMetadata(session, previous),
          },
        };
      }
    }
    return next;
  }

  async function request(type, details = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...details });
    if (result?.error || !result) throw new Error(result?.error || "Statistics service unavailable");
    return result;
  }

  function csvCell(value) {
    const text = String(value);
    const safe = typeof value === "string" && /^[\s\uFEFF]*[=+\-@\t\r\n]/u.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  }

  return { dateKey, weekKey, shiftMonth, shiftDay, splitRange, migrate, read, settle, settledThrough, clear, withActiveSession, request, csvCell };
})();
