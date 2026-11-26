"use strict";

/* ------------------------------------------------------------------ *
 * 书签体检：扫描 / 匹配 → 预览 → 删除 → 撤销
 * 只使用 chrome.bookmarks / chrome.storage 和网页 fetch，
 * 不注入任何内容脚本，也不上传任何数据。
 * ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);

const STATUS = {
  dead: { label: "失效", cls: "dead" },
  unreachable: { label: "无法连接", cls: "unreachable" },
  warn: { label: "待确认", cls: "warn" },
  ok: { label: "正常", cls: "ok" },
  pending: { label: "未检测", cls: "pending" },
};
const RANK = { dead: 0, unreachable: 1, warn: 2, pending: 3, ok: 4 };

const FILTERS = [
  ["all", "全部"],
  ["dead", "失效"],
  ["unreachable", "无法连接"],
  ["moved", "可更新"],
  ["warn", "待确认"],
  ["ok", "正常"],
  ["pending", "未检测"],
];

const state = {
  mode: "scan",
  rows: [],
  unmatched: [],
  selected: new Set(),
  filter: "all",
  running: false,
  mutating: false,
  stop: false,
};

let bmCache = null;

/* ------------------------------ 工具 ------------------------------ */

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function shorten(text, max) {
  const s = String(text == null ? "" : text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 用于比较“跳转后是否算换了地址”：忽略末尾斜杠和 #fragment。 */
function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname === "/") url.pathname = "";
    return url.href;
  } catch (_) {
    return String(value == null ? "" : value);
  }
}

/** 只有目标页能正常返回（ok / warn）时才建议更新，避免把书签改到死链上。 */
function buildRow(bm, verdict) {
  const finalUrl = verdict.finalUrl || "";
  const usable = verdict.status === "ok" || verdict.status === "warn";
  const moved = Boolean(finalUrl) && usable && normalizeUrl(finalUrl) !== normalizeUrl(bm.url);
  return { bm, status: verdict.status, code: verdict.code, finalUrl, moved };
}

let toastTimer = 0;
function toast(message, ms = 2800) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

/* --------------------------- 书签读取 ----------------------------- */

async function getBookmarks(force = false) {
  if (bmCache && !force) return bmCache;
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (node, path) => {
    for (const child of node.children || []) {
      if (child.url) {
        out.push({
          id: child.id,
          title: child.title || "",
          url: child.url,
          folderPath: path,
          parentId: child.parentId,
        });
      } else {
        walk(child, path ? `${path}/${child.title}` : child.title);
      }
    }
  };
  walk(tree[0], "");
  bmCache = out;
  updateBookmarkStat(out);
  return out;
}

function updateBookmarkStat(all) {
  const web = all.filter((b) => /^https?:\/\//i.test(b.url)).length;
  $("#bookmarkStat").textContent = `共 ${all.length} 条书签 · 网页 ${web} 条 · 其它 ${all.length - web} 条`;
}

/* ---------------------------- 链接检测 ---------------------------- */

async function probe(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      credentials: opts.cred ? "include" : "omit",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const finalUrl = res.url;
    try {
      if (res.body) await res.body.cancel();
    } catch (_) { /* 忽略取消响应体的异常 */ }
    return { status: res.status, finalUrl };
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return { status: 0, error: aborted ? "超时" : "网络错误" };
  } finally {
    clearTimeout(timer);
  }
}

function judge(result) {
  const code = result.status;
  if (!code) return { status: "unreachable", code: result.error || "网络错误" };
  if (code === 404 || code === 410) return { status: "dead", code: String(code) };
  if (code >= 200 && code < 300) return { status: "ok", code: String(code) };
  if (code === 401 || code === 403 || code === 429 || code === 451 || code >= 500) {
    return { status: "warn", code: String(code) };
  }
  return { status: "warn", code: String(code) };
}

function detectOpts() {
  return {
    conc: clamp(Number($("#optConc").value) || 8, 1, 32),
    timeout: clamp(Number($("#optTimeout").value) || 10000, 1000, 60000),
    cred: $("#optCred").checked,
  };
}

async function runChecks(urls, opts, onProgress) {
  const verdicts = new Map();
  const queue = urls.slice();
  let done = 0;

  const worker = async () => {
    while (queue.length && !state.stop) {
      const url = queue.shift();
      const result = await probe(url, opts);
      const verdict = judge(result);
      verdicts.set(url, {
        status: verdict.status,
        code: verdict.code,
        finalUrl: result.finalUrl || "",
      });
      done += 1;
      if (onProgress) onProgress(done, urls.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(opts.conc, urls.length) }, () => worker()));
  return verdicts;
}

/* ---------------------------- 扫描全部 ---------------------------- */

async function startScan() {
  const all = await getBookmarks(true);
  const web = all.filter((b) => /^https?:\/\//i.test(b.url));
  if (!web.length) {
    toast("没有可检测的网页书签");
    return;
  }

  const opts = detectOpts();
  const urls = [...new Set(web.map((b) => b.url))];

  $("#scanStat").textContent = `0 / ${urls.length}`;

  const verdicts = await runChecks(urls, opts, (done, total) => {
    $("#scanStat").textContent = `${done} / ${total}`;
  });

  const rows = web.map((bm) => buildRow(
    bm,
    verdicts.get(bm.url) || { status: "pending", code: "未检测", finalUrl: "" },
  ));

  state.rows = rows;
  state.unmatched = [];
  state.selected = new Set(rows.filter((r) => r.status === "dead").map((r) => r.bm.id));
  state.filter = "dead";

  renderAll();
  toast(state.stop ? "已停止，只统计已检测的部分" : `扫描完成：${rows.length} 条`);
}

/* --------------------------- 清单匹配 ----------------------------- */

/** 解析一行 CSV（支持双引号包裹和 "" 转义）。 */
function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/** 去掉句末标点和不成对的右括号；成对的括号要保留（如维基百科的 ..._(bar)）。 */
function trimUrlPunctuation(value) {
  let url = String(value || "").trim();
  const pairs = { ")": "(", "]": "[", "}": "{", "】": "【", "》": "《" };
  for (;;) {
    const last = url[url.length - 1];
    if (!last) break;
    if (/[.,;:!?。，、；：！？"'”’]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (pairs[last]) {
      const opens = url.split(pairs[last]).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return url;
}

function parseUrlList(text) {
  const urls = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let url = "";
    if (trimmed.startsWith('"') && trimmed.includes(",")) {
      // 导出的 CSV：第 5 列才是书签网址，避免把标题里的链接当成书签。
      const cells = parseCsvLine(trimmed);
      url = cells[4] || cells.find((cell) => /^https?:\/\//i.test(cell.trim())) || "";
    } else {
      const match = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
      url = match ? match[0] : "";
    }

    url = trimUrlPunctuation(url);
    if (/^https?:\/\//i.test(url) && url.length > 8) urls.add(url);
  }
  return [...urls];
}

async function matchList(recheck) {
  const urls = parseUrlList($("#listInput").value);
  if (!urls.length) {
    toast("没解析出网址，检查一下粘贴的内容");
    return;
  }

  const all = await getBookmarks(true);
  const byUrl = new Map();
  for (const bookmark of all) {
    if (!byUrl.has(bookmark.url)) byUrl.set(bookmark.url, []);
    byUrl.get(bookmark.url).push(bookmark);
  }

  const rows = [];
  const unmatched = [];
  for (const url of urls) {
    const hits = byUrl.get(url);
    if (!hits || !hits.length) {
      unmatched.push(url);
      continue;
    }
    const initial = recheck
      ? { status: "pending", code: "未检测", finalUrl: "" }
      : { status: "dead", code: "清单", finalUrl: "" };
    for (const bm of hits) rows.push(buildRow(bm, initial));
  }

  if (recheck && rows.length) {
    const opts = detectOpts();
    const checkUrls = [...new Set(rows.map((r) => r.bm.url))];
    $("#scanStat").textContent = `0 / ${checkUrls.length}`;
    const verdicts = await runChecks(checkUrls, opts, (done, total) => {
      $("#scanStat").textContent = `${done} / ${total}`;
    });
    for (const row of rows) {
      const verdict = verdicts.get(row.bm.url);
      if (verdict) Object.assign(row, buildRow(row.bm, verdict));
    }
  }

  state.rows = rows;
  state.unmatched = unmatched;
  state.selected = new Set(rows.filter((r) => r.status === "dead").map((r) => r.bm.id));
  state.filter = "all";
  renderAll();

  const extra = unmatched.length ? `，${unmatched.length} 个网址没匹配到书签` : "";
  const stopped = recheck && state.stop ? "，未检测项未勾选" : "";
  toast(`清单 ${urls.length} 个网址，命中 ${rows.length} 条书签${extra}${stopped}`);
}

/* ---------------------------- 结果渲染 ---------------------------- */

function countByStatus() {
  const counts = { dead: 0, unreachable: 0, warn: 0, ok: 0, pending: 0, moved: 0 };
  for (const row of state.rows) counts[row.status] = (counts[row.status] || 0) + 1;
  counts.moved = state.rows.filter((row) => row.moved).length;
  return counts;
}

function visibleRows() {
  let rows;
  if (state.filter === "all") rows = state.rows.slice();
  else if (state.filter === "moved") rows = state.rows.filter((r) => r.moved);
  else rows = state.rows.filter((r) => r.status === state.filter);
  rows.sort((a, b) => {
    const rank = RANK[a.status] - RANK[b.status];
    if (rank) return rank;
    return String(a.bm.folderPath || "").localeCompare(String(b.bm.folderPath || ""), "zh-CN");
  });
  return rows;
}

function renderSummary() {
  const counts = countByStatus();
  const parts = [
    `<span class="total">共 ${state.rows.length} 条</span>`,
    `<span class="dot dead">失效 ${counts.dead}</span>`,
    `<span class="dot unreachable">无法连接 ${counts.unreachable}</span>`,
    `<span class="dot warn">待确认 ${counts.warn}</span>`,
    `<span class="dot ok">正常 ${counts.ok}</span>`,
  ];
  if (counts.pending) parts.push(`<span class="dot pending">未检测 ${counts.pending}</span>`);
  if (counts.moved) parts.push(`<span class="dot moved">可更新 ${counts.moved}</span>`);
  if (state.unmatched.length) parts.push(`<span class="dot muted">清单未匹配 ${state.unmatched.length}</span>`);
  $("#summary").innerHTML = parts.join("");
}

function renderFilters() {
  const counts = countByStatus();
  const buttons = FILTERS.map(([key, label]) => {
    const count = key === "all" ? state.rows.length : counts[key] || 0;
    if (key !== "all" && count === 0) return "";
    const active = state.filter === key ? " active" : "";
    return `<button type="button" class="filter${active}" data-filter="${key}">${label} <b>${count}</b></button>`;
  });
  $("#filters").innerHTML = buttons.join("");
}

function renderTable() {
  const rows = visibleRows();
  const html = rows.map((row) => {
    const meta = STATUS[row.status];
    const movedBadge = row.moved ? ' <span class="badge moved">可更新</span>' : "";
    const redirect = row.finalUrl && row.finalUrl !== row.bm.url
      ? `<small class="muted">跳转 → <a href="${esc(row.finalUrl)}" target="_blank" rel="noreferrer">${esc(shorten(row.finalUrl, 70))}</a></small>`
      : "";
    const updateBtn = row.moved
      ? `<button type="button" class="mini" data-update="${esc(row.bm.id)}">用新网址</button>`
      : "";
    const checked = state.selected.has(row.bm.id) ? " checked" : "";
    return `<tr class="st-${row.status}">
      <td class="colChk"><input type="checkbox" data-id="${esc(row.bm.id)}"${checked}></td>
      <td class="colStatus"><span class="badge ${meta.cls}">${meta.label}</span> <small class="code">${esc(row.code)}</small>${movedBadge}</td>
      <td class="colTitle" title="${esc(row.bm.title)}">${esc(row.bm.title || "（无标题）")}</td>
      <td class="colUrl"><a href="${esc(row.bm.url)}" target="_blank" rel="noreferrer">${esc(shorten(row.bm.url, 90))}</a>${redirect}${updateBtn}</td>
      <td class="colFolder" title="${esc(row.bm.folderPath)}">${esc(row.bm.folderPath || "—")}</td>
    </tr>`;
  }).join("");
  $("#rows").innerHTML = html || `<tr><td colspan="5" class="empty">这个分类下没有条目</td></tr>`;
  updateBulkUI();
}

function renderUnmatched() {
  const wrap = $("#unmatchedWrap");
  if (!state.unmatched.length) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  $("#unmatchedSummary").textContent =
    `清单里有 ${state.unmatched.length} 个网址没匹配到书签（可能已被删、或不在当前浏览器配置文件里）`;
  const head = state.unmatched.slice(0, 300).join("\n");
  $("#unmatchedList").textContent = state.unmatched.length > 300 ? `${head}\n…` : head;
}

function renderAll() {
  const counts = countByStatus();
  if (state.filter !== "all" && !counts[state.filter]) state.filter = "all";
  $("#resultCard").classList.remove("hidden");
  renderSummary();
  renderFilters();
  renderTable();
  renderUnmatched();
}

function updateBulkUI() {
  const selected = state.selected.size;
  $("#btnDelete").disabled = state.running || state.mutating || selected === 0;
  $("#btnDelete").textContent = `删除选中 (${selected})`;
  const movable = state.rows.filter((row) => row.moved && state.selected.has(row.bm.id)).length;
  $("#btnUpdate").disabled = state.running || state.mutating || movable === 0;
  $("#btnUpdate").textContent = `更新网址 (${movable})`;
  const rows = visibleRows();
  const everyChecked = rows.length > 0 && rows.every((r) => state.selected.has(r.bm.id));
  const someChecked = rows.some((r) => state.selected.has(r.bm.id));
  $("#chkAll").checked = everyChecked;
  $("#chkAll").indeterminate = someChecked && !everyChecked;
}

/* ---------------------------- 更新网址 ---------------------------- */

function selectedRows() {
  return state.rows.filter((row) => state.selected.has(row.bm.id));
}

async function finalizeMutation(mutation, items) {
  const changes = { pendingMutation: null };
  if (items.length) changes.lastMutation = { ...mutation, items };
  await chrome.storage.local.set(changes);
}

async function recoverPendingMutation() {
  const { pendingMutation } = await chrome.storage.local.get("pendingMutation");
  if (!pendingMutation) return;
  const bookmarks = new Map((await getBookmarks(true)).map((bookmark) => [bookmark.id, bookmark]));
  const completed = pendingMutation.items.filter((item) => pendingMutation.kind === "delete"
    ? !bookmarks.has(item.id)
    : bookmarks.get(item.id)?.url === item.newUrl);
  await finalizeMutation(pendingMutation, completed);
}

async function runMutation(task) {
  if (state.running || state.mutating) return;
  state.mutating = true;
  syncRunning();
  try {
    await navigator.locks.request("bookmark-auditor-mutation", async () => {
      await recoverPendingMutation();
      await task();
    });
  } finally {
    state.mutating = false;
    syncRunning();
  }
}

async function updateUrls(inputRows) {
  const all = await getBookmarks(true);
  const byId = new Map(all.map((bookmark) => [bookmark.id, bookmark]));
  const targets = (inputRows || []).filter((row) =>
    row.moved && row.finalUrl && byId.get(row.bm.id)?.url === row.bm.url);
  if (!targets.length) {
    toast("没有可更新的网址");
    return;
  }

  const existing = new Set(all.map((bookmark) => bookmark.url));
  const seen = new Set();
  let duplicates = 0;
  for (const row of targets) {
    if (existing.has(row.finalUrl) || seen.has(row.finalUrl)) duplicates += 1;
    seen.add(row.finalUrl);
  }

  const confirmed = confirm(
    `将 ${targets.length} 条书签的网址改为跳转后的地址？\n\n` +
    "标题和文件夹保持不变；旧网址会备份，可用「撤销」恢复。\n" +
    "如果开启了 Chrome 同步，其它设备上的书签也会更新。" +
    (duplicates ? `\n\n注意：其中 ${duplicates} 条的新网址已经存在于书签中，更新后会出现重复条目。` : "")
  );
  if (!confirmed) return;

  const items = targets.map((row) => ({
    id: row.bm.id,
    oldUrl: row.bm.url,
    newUrl: row.finalUrl,
  }));
  const mutation = { kind: "update", at: Date.now(), items };
  await chrome.storage.local.set({ pendingMutation: mutation });

  const completed = [];
  let failed = 0;
  for (const [index, row] of targets.entries()) {
    try {
      await chrome.bookmarks.update(row.bm.id, { url: row.finalUrl });
      row.bm.url = row.finalUrl;
      row.moved = false;
      state.selected.delete(row.bm.id);
      completed.push(items[index]);
    } catch (_) {
      failed += 1;
    }
  }
  await finalizeMutation(mutation, completed);

  bmCache = null;
  await getBookmarks(true);
  renderAll();
  await showUndoCard();

  const parts = [`已更新 ${completed.length} 条网址`];
  if (failed) parts.push(`${failed} 条失败`);
  toast(parts.join("，"));
}

/* ---------------------------- 删除流程 ---------------------------- */

async function pruneEmptyFolders() {
  const tree = await chrome.bookmarks.getTree();
  const protectedIds = new Set([tree[0].id, ...(tree[0].children || []).map((c) => c.id)]);
  let pruned = 0;

  for (let pass = 0; pass < 10; pass += 1) {
    const snapshot = await chrome.bookmarks.getTree();
    const empties = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.url || child.unmodifiable) continue;
        walk(child);
        if (!child.children || child.children.length === 0) empties.push(child);
      }
    };
    walk(snapshot[0]);

    const targets = empties.filter((folder) => !protectedIds.has(folder.id));
    if (!targets.length) break;

    for (const folder of targets) {
      try {
        await chrome.bookmarks.remove(folder.id);
        pruned += 1;
      } catch (_) { /* 已被删除或受保护 */ }
    }
  }
  return pruned;
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;

  const rowsById = new Map(state.rows.map((row) => [row.bm.id, row]));
  const targets = ids.filter((id) => rowsById.has(id));
  if (!targets.length) return;

  const healthy = targets.filter((id) => rowsById.get(id).status === "ok").length;
  const warning = healthy ? `\n\n注意：其中 ${healthy} 条状态为「正常」。` : "";
  const confirmed = confirm(
    `确定删除 ${targets.length} 条书签？\n\n` +
    "删除前会把条目备份到扩展本地存储，可用「撤销上一次删除」恢复。\n" +
    "如果开启了 Chrome 同步，删除也会同步到同一账号的其它设备。" + warning
  );
  if (!confirmed) return;

  const items = [];
  for (const id of targets) {
    try {
      const [node] = await chrome.bookmarks.get(id);
      if (node?.url && node.url === rowsById.get(id).bm.url) {
        items.push({ id, title: node.title || "", url: node.url, parentId: node.parentId });
      }
    } catch (_) { /* 已不存在 */ }
  }
  if (!items.length) {
    toast("选中的书签已变更或不存在，请重新扫描。");
    return;
  }

  const mutation = { kind: "delete", at: Date.now(), items };
  await chrome.storage.local.set({ pendingMutation: mutation });

  const removed = new Set();
  const stat = $("#deleteStat");
  let failed = targets.length - items.length;
  for (const [index, { id }] of items.entries()) {
    if (items.length > 20) stat.textContent = `正在删除 ${index + 1} / ${items.length}`;
    try {
      await chrome.bookmarks.remove(id);
      removed.add(id);
    } catch (_) {
      failed += 1;
    }
  }
  stat.textContent = "";
  await finalizeMutation(mutation, items.filter(({ id }) => removed.has(id)));

  let pruned = 0;
  if (removed.size && $("#optPrune").checked) pruned = await pruneEmptyFolders();

  state.rows = state.rows.filter((row) => !removed.has(row.bm.id));
  state.selected.clear();
  bmCache = null;
  await getBookmarks(true);
  renderAll();
  await showUndoCard();

  const parts = [`已删除 ${removed.size} 条`];
  if (failed) parts.push(`${failed} 条失败`);
  if (pruned) parts.push(`清理空文件夹 ${pruned} 个`);
  toast(parts.join("，"));
}

/* ---------------------------- 撤销 ---------------------------- */

async function showUndoCard() {
  const { lastMutation } = await chrome.storage.local.get("lastMutation");
  const card = $("#undoCard");
  if (!lastMutation || !Array.isArray(lastMutation.items) || !lastMutation.items.length) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const verb = lastMutation.kind === "update" ? "更新" : "删除";
  $("#undoInfo").textContent =
    `上次${verb} ${lastMutation.items.length} 条 · ${new Date(lastMutation.at).toLocaleString("zh-CN")}`;
  $("#btnUndo").textContent =
    lastMutation.kind === "update" ? "撤销上一次网址更新" : "撤销上一次删除";
}

async function undoLast() {
  const { lastMutation } = await chrome.storage.local.get("lastMutation");
  if (!lastMutation || !Array.isArray(lastMutation.items) || !lastMutation.items.length) {
    toast("没有可撤销的操作");
    return;
  }
  if (lastMutation.kind === "update") {
    await undoUrlUpdate(lastMutation);
    return;
  }

  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0].children || [];
  const fallbackId = (roots.find((c) => c.id === "2") || roots[0] || { id: "0" }).id;

  let restored = 0;
  let failed = 0;
  for (const item of [...lastMutation.items]) {
    let parentId = item.parentId || fallbackId;
    try {
      await chrome.bookmarks.get(parentId);
    } catch (_) {
      parentId = fallbackId;
    }
    try {
      const children = await chrome.bookmarks.getChildren(parentId);
      const matches = children.filter((node) => node.title === item.title && node.url === item.url).length;
      const originalStillExists = item.id && children.some((node) => node.id === item.id);
      const alreadyRestored = item.restoring?.parentId === parentId && matches > item.restoring.matches;
      if (!originalStillExists && !alreadyRestored && (item.id || !matches)) {
        item.restoring = { parentId, matches };
        await chrome.storage.local.set({ lastMutation });
        await chrome.bookmarks.create({ parentId, title: item.title, url: item.url });
        restored += 1;
      }
    } catch (_) {
      failed += 1;
      continue;
    }
    await consumeUndoItem(lastMutation, item);
  }

  bmCache = null;
  await getBookmarks(true);
  await showUndoCard();
  resetResults();

  toast(`已恢复 ${restored} 条${failed ? `，失败 ${failed} 条` : ""}`);
}

async function consumeUndoItem(mutation, item) {
  mutation.items = mutation.items.filter((candidate) => candidate !== item);
  if (mutation.items.length) await chrome.storage.local.set({ lastMutation: mutation });
  else await chrome.storage.local.remove("lastMutation");
}

async function undoUrlUpdate(mutation) {
  let restored = 0;
  let failed = 0;
  for (const item of [...mutation.items]) {
    try {
      const [node] = await chrome.bookmarks.get(item.id);
      if (node?.url === item.newUrl) {
        await chrome.bookmarks.update(item.id, { url: item.oldUrl });
        restored += 1;
      } else if (node?.url !== item.oldUrl) {
        failed += 1;
        continue;
      }
      const row = state.rows.find((candidate) => candidate.bm.id === item.id);
      if (row) {
        row.bm.url = item.oldUrl;
        row.finalUrl = item.newUrl;
        row.moved = true;
      }
    } catch (_) {
      failed += 1;
      continue;
    }
    await consumeUndoItem(mutation, item);
  }

  bmCache = null;
  await getBookmarks(true);
  renderAll();
  await showUndoCard();

  toast(`已还原 ${restored} 条网址${failed ? `，失败 ${failed} 条` : ""}`);
}

function resetResults() {
  state.rows = [];
  state.unmatched = [];
  state.selected.clear();
  $("#resultCard").classList.add("hidden");
}

/* ----------------------------- 导出 ------------------------------- */

function exportCsv() {
  const rows = visibleRows();
  if (!rows.length) {
    toast("没有可导出的内容");
    return;
  }
  const cell = (value) => {
    const text = String(value ?? "");
    const safe = /^[\s\uFEFF]*[=+\-@\t\r\n]/u.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const lines = [["状态", "状态码", "可更新", "标题", "网址", "跳转后网址", "文件夹"].join(",")];
  for (const row of rows) {
    lines.push([
      STATUS[row.status].label, row.code, row.moved ? "是" : "",
      row.bm.title, row.bm.url, row.finalUrl, row.bm.folderPath,
    ].map(cell).join(","));
  }
  for (const url of state.unmatched) {
    lines.push(["未匹配", "", "", "", url, "", ""].map(cell).join(","));
  }

  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `bookmark-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

/* ----------------------------- 交互 ------------------------------- */

function setMode(mode) {
  state.mode = mode;
  for (const button of document.querySelectorAll(".mode")) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  $("#scanPane").classList.toggle("hidden", mode !== "scan");
  $("#listPane").classList.toggle("hidden", mode !== "list");
}

function syncRunning() {
  const busy = state.running || state.mutating;
  $("#btnScan").disabled = busy;
  $("#btnStop").disabled = !state.running;
  $("#btnMatch").disabled = busy;
  $("#btnRecheck").disabled = busy;
  $("#btnUndo").disabled = busy;
  updateBulkUI();
  if (!state.running) $("#scanStat").textContent = "";
}

async function runScan(task) {
  if (state.running || state.mutating) return;
  state.running = true;
  state.stop = false;
  syncRunning();
  try {
    await task();
  } finally {
    state.running = false;
    syncRunning();
  }
}

function bind() {
  for (const button of document.querySelectorAll(".mode")) {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  }

  $("#btnScan").addEventListener("click", () => {
    runScan(startScan).catch((err) => toast(`扫描失败：${err.message || err}`));
  });

  $("#btnStop").addEventListener("click", () => {
    state.stop = true;
    toast("正在停止，等待进行中的请求结束…");
  });

  $("#btnMatch").addEventListener("click", () => {
    runScan(() => matchList(false)).catch((err) => toast(`匹配失败：${err.message || err}`));
  });

  $("#btnRecheck").addEventListener("click", () => {
    runScan(() => matchList(true)).catch((err) => toast(`检测失败：${err.message || err}`));
  });

  $("#fileInput").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    $("#listInput").value = await file.text();
    toast(`已载入 ${file.name}`);
    event.target.value = "";
  });

  $("#filters").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    renderFilters();
    renderTable();
  });

  $("#rows").addEventListener("change", (event) => {
    const box = event.target.closest('input[type="checkbox"]');
    if (!box) return;
    if (box.checked) state.selected.add(box.dataset.id);
    else state.selected.delete(box.dataset.id);
    updateBulkUI();
  });

  $("#chkAll").addEventListener("change", () => {
    const rows = visibleRows();
    if ($("#chkAll").checked) rows.forEach((row) => state.selected.add(row.bm.id));
    else rows.forEach((row) => state.selected.delete(row.bm.id));
    renderTable();
  });

  $("#btnDelete").addEventListener("click", () => {
    runMutation(deleteSelected).catch((err) => toast(`删除失败：${err.message || err}`));
  });

  $("#btnUpdate").addEventListener("click", () => {
    runMutation(() => updateUrls(selectedRows())).catch((err) => toast(`更新失败：${err.message || err}`));
  });

  $("#rows").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-update]");
    if (!button) return;
    const row = state.rows.find((candidate) => candidate.bm.id === button.dataset.update);
    if (row) runMutation(() => updateUrls([row])).catch((err) => toast(`更新失败：${err.message || err}`));
  });

  $("#btnExport").addEventListener("click", exportCsv);

  $("#btnUndo").addEventListener("click", () => {
    runMutation(undoLast).catch((err) => toast(`撤销失败：${err.message || err}`));
  });
}

async function init() {
  bind();
  await runMutation(async () => {
    try {
      await getBookmarks(true);
    } catch (err) {
      $("#bookmarkStat").textContent = "读取书签失败";
      toast(`读取书签失败：${err.message || err}`, 4000);
    }
    await showUndoCard();
  });
}

init().catch((err) => toast(`初始化失败：${err.message || err}`));
