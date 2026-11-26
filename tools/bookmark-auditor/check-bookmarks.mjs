#!/usr/bin/env node
/**
 * 扫描 Chrome 书签链接状态，输出 CSV 报告和失效清单。
 *
 * 用法（需要 Node 18+）：
 *   node check-bookmarks.mjs
 *   node check-bookmarks.mjs --file "D:\backup\Bookmarks" --out .\report
 *   node check-bookmarks.mjs --profile "Profile 1" --conc 8 --timeout 10000
 *
 * 说明：
 * - 只读 Bookmarks 文件，不会修改书签；写入只发生在 --out 目录。
 * - Node 的 fetch 默认不走系统代理；Node 24 可加环境变量 NODE_USE_ENV_PROXY=1。
 * - dead-urls.txt 可以直接导入扩展的「粘贴 / 导入清单」里。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const LABEL = {
  dead: "失效",
  unreachable: "无法连接",
  warn: "待确认",
  ok: "正常",
  pending: "未检测",
};

const DEFAULTS = { conc: 8, timeout: 10000, retries: 1, out: process.cwd() };

const HELP = `用法: node check-bookmarks.mjs [选项]

  --file <path>      指定 Bookmarks 文件（默认读取本机 Chrome Default 配置）
  --profile <name>   配置目录名，如 "Default"、"Profile 1"
  --out <dir>        输出目录（默认当前目录）
  --conc <n>         并发数（默认 8）
  --timeout <ms>     单请求超时（默认 10000）
  -h, --help         显示帮助

输出: bookmark-report.csv（全部结果）、dead-urls.txt（仅失效网址）、moved-urls.csv（跳转后可更新的网址）`;

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") opts.file = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--profile") opts.profile = argv[++i];
    else if (arg === "--conc") opts.conc = Math.max(1, Number(argv[++i]) || DEFAULTS.conc);
    else if (arg === "--timeout") opts.timeout = Math.max(1000, Number(argv[++i]) || DEFAULTS.timeout);
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (!arg.startsWith("-")) opts.file = arg;
  }
  return opts;
}

function defaultBookmarksPath(profile = "Default") {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Google", "Chrome", "User Data", profile, "Bookmarks");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(), "Library", "Application Support", "Google", "Chrome", profile, "Bookmarks",
    );
  }
  return path.join(os.homedir(), ".config", "google-chrome", profile, "Bookmarks");
}

/** 展开 Chrome 的 roots 树，返回 [{title, url, folderPath}] */
function collectBookmarks(data) {
  const roots = (data && data.roots) || {};
  const out = [];
  const walk = (node, folderPath) => {
    for (const child of node.children || []) {
      if (child.type === "url" || child.url) {
        out.push({
          title: child.name || child.title || "",
          url: child.url,
          folderPath,
        });
      } else {
        const name = child.name || "";
        walk(child, folderPath ? `${folderPath}/${name}` : name);
      }
    }
  };
  const sections = [
    ["bookmark_bar", "书签栏"],
    ["other", "其他书签"],
    ["synced", "移动设备书签"],
  ];
  for (const [key, label] of sections) {
    if (roots[key]) walk(roots[key], label);
  }
  return out;
}

/** 尽量从 fetch 的异常里取出有用的错误码（undici 常把真实原因藏在 cause 里）。 */
function describeFetchError(err) {
  if (!err) return "网络错误";
  if (err.name === "AbortError") return "超时";
  const cause = err.cause;
  if (cause) {
    if (cause.code) return cause.code;
    if (Array.isArray(cause.errors) && cause.errors.length) {
      const codes = [...new Set(cause.errors.map((item) => item.code).filter(Boolean))];
      if (codes.length) return codes.join(" / ");
    }
    if (cause.message) return cause.message;
  }
  return err.message || "网络错误";
}

async function probe(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    const finalUrl = res.url;
    try {
      if (res.body) await res.body.cancel();
    } catch {
      /* 忽略取消响应体的异常 */
    }
    return { status: res.status, finalUrl };
  } catch (err) {
    return { status: 0, error: describeFetchError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function judge(result) {
  const code = result.status;
  if (!code) return { status: "unreachable", code: result.error || "网络错误" };
  if (code === 404 || code === 410) return { status: "dead", code: String(code) };
  if (code >= 200 && code < 300) return { status: "ok", code: String(code) };
  return { status: "warn", code: String(code) };
}

/** 比较“跳转后是否算换了地址”：忽略末尾斜杠和 #fragment。 */
function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname === "/") url.pathname = "";
    return url.href;
  } catch {
    return String(value == null ? "" : value);
  }
}

/** 只有目标页能正常返回（ok / warn）时才建议更新，避免把书签改到死链上。 */
function isMoved(url, verdict) {
  const usable = verdict.status === "ok" || verdict.status === "warn";
  return Boolean(verdict.finalUrl) && usable && normalizeUrl(verdict.finalUrl) !== normalizeUrl(url);
}

async function runChecks(urls, opts) {
  const verdicts = new Map();
  const queue = urls.slice();
  let done = 0;

  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      let result = await probe(url, opts);
      // 网络错误重试一次；超时不重试，避免等待时间翻倍。
      for (let attempt = 0; attempt < opts.retries && result.status === 0 && result.error !== "超时"; attempt += 1) {
        result = await probe(url, opts);
      }
      const verdict = judge(result);
      verdicts.set(url, { ...verdict, finalUrl: result.finalUrl || "", error: result.error || "" });
      done += 1;
      if (done % 10 === 0 || done === urls.length) {
        process.stderr.write(`\r检测进度 ${done} / ${urls.length}`);
      }
    }
  };

  const workers = Array.from({ length: Math.min(opts.conc, urls.length) }, () => worker());
  await Promise.all(workers);
  if (urls.length) process.stderr.write("\n");
  return verdicts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const file = opts.file ? path.resolve(opts.file) : defaultBookmarksPath(opts.profile);
  let data;
  try {
    const raw = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`读取书签失败：${file}`);
    console.error(`  ${err.message}`);
    console.error("提示：Chrome 正在运行时文件仍可读取；如果路径不对，用 --file 指定，或先用 chrome://bookmarks → ⋮ → 导出书签。");
    process.exitCode = 1;
    return;
  }

  const all = collectBookmarks(data);
  const web = all.filter((b) => /^https?:\/\//i.test(b.url));
  const uniqueUrls = [...new Set(web.map((b) => b.url))];
  console.log(`书签 ${all.length} 条，其中网页 ${web.length} 条（去重后 ${uniqueUrls.length} 个 URL）`);

  if (!uniqueUrls.length) {
    console.log("没有可检测的网页书签。");
    return;
  }

  const verdicts = await runChecks(uniqueUrls, opts);
  const rows = web.map((bm) => {
    const verdict = verdicts.get(bm.url) || { status: "pending", code: "未检测", finalUrl: "" };
    return { ...bm, ...verdict, moved: isMoved(bm.url, verdict) };
  });

  const counts = { dead: 0, unreachable: 0, warn: 0, ok: 0, pending: 0, moved: 0 };
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  counts.moved = rows.filter((row) => row.moved).length;

  const outDir = path.resolve(opts.out);
  await mkdir(outDir, { recursive: true });

  const cell = (value) => {
    const text = String(value ?? "");
    const safe = /^[\s\uFEFF]*[=+\-@\t\r\n]/u.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const lines = [["状态", "状态码", "可更新", "标题", "网址", "跳转后网址", "文件夹"].map(cell).join(",")];
  for (const row of rows) {
    lines.push(
      [LABEL[row.status], row.code, row.moved ? "是" : "", row.title, row.url, row.finalUrl, row.folderPath]
        .map(cell)
        .join(","),
    );
  }

  const csvPath = path.join(outDir, "bookmark-report.csv");
  await writeFile(csvPath, "\ufeff" + lines.join("\r\n"), "utf8");

  const dead = rows.filter((row) => row.status === "dead").map((row) => row.url);
  const deadPath = path.join(outDir, "dead-urls.txt");
  await writeFile(deadPath, dead.length ? `${dead.join("\n")}\n` : "", "utf8");

  const movedRows = rows.filter((row) => row.moved);
  const movedPath = path.join(outDir, "moved-urls.csv");
  const movedLines = [["标题", "旧网址", "建议新网址", "文件夹"].map(cell).join(",")];
  for (const row of movedRows) {
    movedLines.push([row.title, row.url, row.finalUrl, row.folderPath].map(cell).join(","));
  }
  await writeFile(movedPath, "\ufeff" + movedLines.join("\r\n"), "utf8");

  console.log(
    `结果：失效 ${counts.dead}，无法连接 ${counts.unreachable}，待确认 ${counts.warn}，正常 ${counts.ok}` +
      (counts.moved ? `，可更新 ${counts.moved}` : "") +
      (counts.pending ? `，未检测 ${counts.pending}` : ""),
  );
  console.log(`CSV 报告：${csvPath}`);
  console.log(`失效清单：${deadPath}`);
  if (counts.moved) console.log(`可更新清单：${movedPath}`);
  console.log(`把 dead-urls.txt 导入扩展的「粘贴 / 导入清单」，即可预览并批量删除对应书签。`);
  if (counts.moved) {
    console.log(`跳转类网址只能在扩展里一键更新（chrome.bookmarks.update 不能在脚本里用）：打开「扫描全部书签」重新检测后，用「可更新」筛选。`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
