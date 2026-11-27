// Minimal asynchronous IndexedDB substitute for storage regression tests.
// Request callbacks, transaction completion, and rollback follow separate turns.
module.exports = function fakeIndexedDB() {
  let tables = new Map();
  let opened = false;
  const api = {
    failNextCommit: false,
    snapshot: () => structuredClone(tables),
    seed(records) {
      tables = structuredClone(records);
      opened = true;
    },
    open() {
      const request = {};
      setImmediate(() => {
        request.result = database;
        if (!opened) {
          opened = true;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
  const database = {
    createObjectStore(name) {
      tables.set(name, new Map());
      return { createIndex() {} };
    },
    transaction(names, mode) {
      const working = mode === "readwrite" ? structuredClone(tables) : tables;
      let pending = 0;
      let ended = false;
      const transaction = {
        error: null,
        abort() {
          if (ended) throw new Error("Transaction already ended");
          ended = true;
          setImmediate(() => transaction.onabort?.());
        },
        objectStore(name) {
          const records = working.get(name);
          const sorted = () => [...records].sort(([a], [b]) => String(a).localeCompare(String(b)));
          const write = (value, key, add = false) => {
            const copy = structuredClone(value);
            return enqueue(() => {
              if (key === undefined) key = Math.max(0, ...records.keys()) + 1;
              if (add && records.has(key)) throw new Error("Duplicate key");
              records.set(key, copy);
              return key;
            });
          };
          return {
            get: (key) => enqueue(() => structuredClone(records.get(key))),
            getAllKeys: () => enqueue(() => sorted().map(([key]) => key)),
            getAll: () => enqueue(() => structuredClone(sorted().map(([, value]) => value))),
            put: (value, key) => write(value, key),
            add: (value, key) => write(value, key, true),
            delete: (key) => enqueue(() => records.delete(key)),
            clear: () => enqueue(() => records.clear()),
            index() {
              return {
                getKey: (content) => enqueue(() => [...records].find(([, entry]) =>
                  JSON.stringify([entry.host, entry.lastTitle, entry.lastUrl, entry.faviconUrl]) === JSON.stringify(content)
                )?.[0]),
              };
            },
          };
        },
      };
      function completeWhenIdle() {
        setImmediate(() => {
          if (ended || pending) return;
          if (mode === "readwrite" && api.failNextCommit) {
            api.failNextCommit = false;
            transaction.error = new Error("Simulated transaction failure");
            transaction.abort();
            return;
          }
          ended = true;
          if (mode === "readwrite") tables = working;
          transaction.oncomplete?.();
        });
      }
      function enqueue(operation) {
        if (ended) throw new Error("Transaction inactive");
        pending++;
        const request = {};
        setImmediate(() => {
          if (ended) return;
          try {
            request.result = operation();
            request.onsuccess?.();
          } catch (error) {
            request.error = transaction.error = error;
            request.onerror?.();
            transaction.abort();
          }
          pending--;
          completeWhenIdle();
        });
        return request;
      }
      completeWhenIdle();
      return transaction;
    },
  };
  return api;
};
