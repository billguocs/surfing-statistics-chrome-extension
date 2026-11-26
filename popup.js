const SESSION_KEY = "activeSession";
const CATEGORY_CONFIG_KEY = "categoryConfig";
const GOAL_CONFIG_KEY = "goalConfig";
const FOCUS_CONFIG_KEY = "focusConfig";
const SCENE_CONFIG_KEY = "sceneConfig";
const { LLM_CONFIG_KEY, LLM_FEATURE_FLAGS_KEY, createDefaultLLMConfig, createDefaultLLMFeatureFlags, requestSmartSummary } = window.LLMUtils;

const REPORT_TYPES = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
};

const VIEW_TYPES = {
  SITE: "site",
  CATEGORY: "category",
};

const DAILY_TOP_LIMIT = 8;
const MONTHLY_TOP_LIMIT = 10;

const DEFAULT_CATEGORIES = [
  { id: "work", name: "工作", color: "#2563eb" },
  { id: "study", name: "学习", color: "#16a34a" },
  { id: "entertainment", name: "娱乐", color: "#f59e0b" },
  { id: "social", name: "社交", color: "#db2777" },
  { id: "tools", name: "工具", color: "#0891b2" },
  { id: "other", name: "其他", color: "#94a3b8" },
];

const SCENE_PRESETS = [
  {
    id: "work",
    name: "工作模式",
    goalConfig: { enabled: true, categoryGoals: { work: 180, tools: 60 } },
    focusConfig: {
      enabled: true,
      allowedCategoryIds: ["work", "tools"],
      distractionReminderEnabled: true,
      distractionCategoryIds: ["entertainment", "social"],
      distractionThresholdMinutes: 10,
    },
  },
  {
    id: "study",
    name: "学习模式",
    goalConfig: { enabled: true, categoryGoals: { study: 120, tools: 30 } },
    focusConfig: {
      enabled: true,
      allowedCategoryIds: ["study", "tools"],
      distractionReminderEnabled: true,
      distractionCategoryIds: ["entertainment", "social"],
      distractionThresholdMinutes: 12,
    },
  },
  {
    id: "relax",
    name: "轻松模式",
    goalConfig: { enabled: false, categoryGoals: {} },
    focusConfig: {
      enabled: false,
      allowedCategoryIds: ["entertainment", "social", "other"],
      distractionReminderEnabled: false,
      distractionCategoryIds: ["work", "study"],
      distractionThresholdMinutes: 20,
    },
  },
];

document.addEventListener("DOMContentLoaded", async () => {
  const $ = (id) => document.getElementById(id);
  const elements = {
    focusStatusPill: $("focusStatusPill"),
    toggleFocusModeBtn: $("toggleFocusModeBtn"),
    openSettingsBtn: $("openSettingsBtn"),
    sceneWorkBtn: $("sceneWorkBtn"),
    sceneStudyBtn: $("sceneStudyBtn"),
    sceneRelaxBtn: $("sceneRelaxBtn"),
    goalPanel: $("goalPanel"),
    goalPanelHint: $("goalPanelHint"),
    goalList: $("goalList"),
    summaryHint: $("summaryHint"),
    summaryList: $("summaryList"),
    todayBtn: $("todayBtn"),
    thisWeekBtn: $("thisWeekBtn"),
    thisMonthBtn: $("thisMonthBtn"),
    siteViewBtn: $("siteViewBtn"),
    categoryViewBtn: $("categoryViewBtn"),
    prevDayBtn: $("prevDayBtn"),
    nextDayBtn: $("nextDayBtn"),
    prevWeekBtn: $("prevWeekBtn"),
    nextWeekBtn: $("nextWeekBtn"),
    prevMonthBtn: $("prevMonthBtn"),
    nextMonthBtn: $("nextMonthBtn"),
    searchInput: $("searchInput"),
    manageCategoriesBtn: $("manageCategoriesBtn"),
    exportJsonBtn: $("exportJsonBtn"),
    exportCsvBtn: $("exportCsvBtn"),
    clearBtn: $("clearBtn"),
    lastUpdated: $("lastUpdated"),
    analysisCard: $("analysisCard"),
    analysisTitle: $("analysisTitle"),
    analysisSubtitle: $("analysisSubtitle"),
    analysisList: $("analysisList"),
    analysisEmptyState: $("analysisEmptyState"),
    reportTitle: $("reportTitle"),
    reportSubtitle: $("reportSubtitle"),
    reportTable: $("reportTable"),
    reportTableHead: $("reportTableHead"),
    reportTableBody: $("reportTableBody"),
    emptyState: $("emptyState"),
    primaryChartCard: $("primaryChartCard"),
    primaryChartTitle: $("primaryChartTitle"),
    primaryChartSubtitle: $("primaryChartSubtitle"),
    primaryChart: $("primaryChart"),
    secondaryChartCard: $("secondaryChartCard"),
    secondaryChartTitle: $("secondaryChartTitle"),
    secondaryChartSubtitle: $("secondaryChartSubtitle"),
    secondaryChart: $("secondaryChart"),
  };

  const state = {
    activeReport: REPORT_TYPES.DAILY,
    activeView: VIEW_TYPES.SITE,
    currentDate: new Date(),
    currentWeekDate: new Date(),
    currentMonthDate: StatsStore.shiftMonth(new Date(), 0),
    filterText: "",
    charts: { primary: null, secondary: null },
    summaryRunId: 0,
    summaryIsLocal: true,
    summaryCache: new Map(),
    reportRunId: 0,
    reportPending: false,
    hasRunningSession: false,
  };

  const storageGet = (area, keys) => new Promise((resolve) => chrome.storage[area].get(keys, resolve));
  const storageSet = (area, payload) => new Promise((resolve, reject) => {
    chrome.storage[area].set(payload, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
  const pad = (value) => String(value).padStart(2, "0");
  const formatDate = StatsStore.dateKey;
  const formatShortDate = (date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const formatMonthKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  const formatMonthLabel = (date) => `${date.getFullYear()} 年 ${pad(date.getMonth() + 1)} 月`;

  const getIsoWeekKey = StatsStore.weekKey;

  function formatUpdatedAt(timestamp) {
    if (!timestamp) return "暂无更新时间";
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? "暂无更新时间" : `最近更新：${date.toLocaleString()}`;
  }

  function formatDuration(seconds) {
    seconds = Math.floor(seconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const parts = [];
    if (hours) parts.push(`${hours}小时`);
    if (minutes) parts.push(`${minutes}分钟`);
    if (rest || !parts.length) parts.push(`${rest}秒`);
    return parts.join("");
  }

  function formatShare(seconds, total) {
    return !total ? "0%" : `${((seconds / total) * 100).toFixed(seconds === total ? 0 : 1)}%`;
  }

  function formatDelta(seconds) {
    if (!seconds) return "持平";
    const prefix = seconds > 0 ? "+" : "-";
    return `${prefix}${formatDuration(Math.abs(seconds))}`;
  }

  function normalizeSiteEntries(bucket) {
    return Object.entries(bucket || {})
      .map(([hostname, value]) => ({
        hostname,
        seconds: value?.seconds || 0,
        lastTitle: value?.lastTitle || "",
        lastUrl: value?.lastUrl || "",
        faviconUrl: value?.faviconUrl || "",
      }))
      .filter((entry) => entry.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds);
  }

  function defaultCategoryConfig(config = {}) {
    const categories = DEFAULT_CATEGORIES.map((item) => ({ ...item, system: true }));
    const customCategories = Array.isArray(config.categories)
      ? config.categories.filter((item) => !DEFAULT_CATEGORIES.some((base) => base.id === item.id))
      : [];
    const mergedCategories = [...categories, ...customCategories];
    const validIds = new Set(mergedCategories.map((item) => item.id));
    const siteCategoryMap = Object.create(null);
    for (const [hostname, categoryId] of Object.entries(config.siteCategoryMap || {})) {
      siteCategoryMap[hostname] = validIds.has(categoryId) ? categoryId : "other";
    }
    return { categories: mergedCategories, siteCategoryMap };
  }

  function defaultGoalConfig(config = {}) {
    const categoryGoals = {};
    for (const [categoryId, minutes] of Object.entries(config.categoryGoals || {})) {
      const normalized = Math.max(0, Number(minutes) || 0);
      if (normalized > 0) categoryGoals[categoryId] = normalized;
    }
    return { enabled: Boolean(config.enabled), categoryGoals };
  }

  function defaultFocusConfig(config = {}) {
    return {
      enabled: Boolean(config.enabled),
      allowedCategoryIds: Array.isArray(config.allowedCategoryIds) ? Array.from(new Set(config.allowedCategoryIds)) : ["work", "study", "tools"],
      distractionReminderEnabled: Boolean(config.distractionReminderEnabled),
      distractionCategoryIds: Array.isArray(config.distractionCategoryIds) ? Array.from(new Set(config.distractionCategoryIds)) : ["entertainment", "social"],
      distractionThresholdMinutes: Math.max(1, Number(config.distractionThresholdMinutes) || 15),
    };
  }

  function defaultSceneConfig(config = {}) {
    const validIds = new Set(SCENE_PRESETS.map((scene) => scene.id));
    return { activeSceneId: validIds.has(config.activeSceneId) ? config.activeSceneId : "work" };
  }

  const defaultLLMConfig = (config = {}) => createDefaultLLMConfig(config);
  const defaultLLMFeatureFlags = (config = {}) => createDefaultLLMFeatureFlags(config);

  function getCategoryById(categoryConfig, categoryId) {
    return categoryConfig.categories.find((item) => item.id === categoryId) || DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1];
  }

  function mergeBuckets(buckets) {
    const merged = Object.create(null);
    for (const bucket of buckets) {
      for (const [hostname, value] of Object.entries(bucket || {})) {
        const current = merged[hostname] || { seconds: 0, lastTitle: "", lastUrl: "", faviconUrl: "" };
        merged[hostname] = {
          seconds: current.seconds + (value?.seconds || 0),
          lastTitle: value?.lastTitle || current.lastTitle,
          lastUrl: value?.lastUrl || current.lastUrl,
          faviconUrl: value?.faviconUrl || current.faviconUrl,
        };
      }
    }
    return merged;
  }

  function aggregateMonthBucket(stats, date) {
    const monthKey = formatMonthKey(date);
    return mergeBuckets(
      Object.entries(stats.daily)
        .filter(([dateKey]) => dateKey.startsWith(monthKey))
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([, bucket]) => bucket)
    );
  }

  function aggregateCategoryEntries(siteEntries, categoryConfig) {
    const totalSeconds = siteEntries.reduce((sum, entry) => sum + entry.seconds, 0);
    const map = new Map();
    for (const entry of siteEntries) {
      const categoryId = categoryConfig.siteCategoryMap[entry.hostname] || "other";
      const category = getCategoryById(categoryConfig, categoryId);
      const current = map.get(categoryId) || {
        categoryId,
        categoryName: category.name,
        color: category.color,
        seconds: 0,
        siteCount: 0,
        topSites: [],
      };
      current.seconds += entry.seconds;
      current.siteCount += 1;
      current.topSites.push(entry);
      map.set(categoryId, current);
    }
    return Array.from(map.values())
      .map((entry) => ({ ...entry, topSites: entry.topSites.sort((a, b) => b.seconds - a.seconds), share: totalSeconds ? entry.seconds / totalSeconds : 0 }))
      .sort((a, b) => b.seconds - a.seconds);
  }

  function aggregateCategoryTotals(siteEntries, categoryConfig) {
    const totals = {};
    for (const entry of siteEntries) {
      const categoryId = categoryConfig.siteCategoryMap[entry.hostname] || "other";
      totals[categoryId] = (totals[categoryId] || 0) + entry.seconds;
    }
    return totals;
  }

  function buildCategoryTrend(stats, categoryConfig, endDate) {
    const dates = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(endDate);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - offset);
      dates.push(date);
    }
    const totals = new Map();
    const rows = dates.map((date) => {
      const bucket = normalizeSiteEntries(stats.daily[formatDate(date)]);
      const categoryEntries = aggregateCategoryEntries(bucket, categoryConfig);
      const row = {};
      for (const entry of categoryEntries) {
        row[entry.categoryId] = entry.seconds;
        totals.set(entry.categoryId, (totals.get(entry.categoryId) || 0) + entry.seconds);
      }
      return { label: formatShortDate(date), row };
    });
    const categories = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).map(([categoryId]) => getCategoryById(categoryConfig, categoryId));
    return {
      labels: rows.map((item) => item.label),
      categories,
      series: categories.map((category) => ({ name: category.name, color: category.color, data: rows.map((item) => item.row[category.id] || 0) })),
    };
  }

  function buildAnalysisEntries(currentSiteEntries, previousSiteEntries, categoryConfig) {
    const currentTotals = aggregateCategoryTotals(currentSiteEntries, categoryConfig);
    const previousTotals = aggregateCategoryTotals(previousSiteEntries, categoryConfig);
    return [...new Set([...Object.keys(currentTotals), ...Object.keys(previousTotals)])]
      .map((categoryId) => {
        const category = getCategoryById(categoryConfig, categoryId);
        const currentSeconds = currentTotals[categoryId] || 0;
        const previousSeconds = previousTotals[categoryId] || 0;
        return {
          categoryId,
          categoryName: category.name,
          color: category.color,
          currentSeconds,
          previousSeconds,
          deltaSeconds: currentSeconds - previousSeconds,
        };
      })
      .sort((a, b) => Math.abs(b.deltaSeconds) - Math.abs(a.deltaSeconds));
  }

  function getAnalysisPeriodLabel() {
    if (state.activeReport === REPORT_TYPES.DAILY) return "较前一天";
    if (state.activeReport === REPORT_TYPES.WEEKLY) return "较上一周";
    return "较上一个自然月";
  }

  function getCurrentBucket(stats) {
    if (state.activeReport === REPORT_TYPES.DAILY) return stats.daily[formatDate(state.currentDate)] || {};
    if (state.activeReport === REPORT_TYPES.WEEKLY) return stats.weekly[getIsoWeekKey(state.currentWeekDate)] || {};
    return aggregateMonthBucket(stats, state.currentMonthDate);
  }

  function getPreviousBucket(stats) {
    if (state.activeReport === REPORT_TYPES.DAILY) {
      const date = new Date(state.currentDate);
      date.setDate(date.getDate() - 1);
      return stats.daily[formatDate(date)] || {};
    }
    if (state.activeReport === REPORT_TYPES.WEEKLY) {
      const date = new Date(state.currentWeekDate);
      date.setDate(date.getDate() - 7);
      return stats.weekly[getIsoWeekKey(date)] || {};
    }
    return aggregateMonthBucket(stats, StatsStore.shiftMonth(state.currentMonthDate, -1));
  }

  function getSummaryBucket(stats, reportType, date) {
    if (reportType === REPORT_TYPES.DAILY) return stats.daily[formatDate(date)] || {};
    if (reportType === REPORT_TYPES.WEEKLY) return stats.weekly[getIsoWeekKey(date)] || {};
    return aggregateMonthBucket(stats, date);
  }

  function filterSiteEntries(entries) {
    const keyword = state.filterText.trim().toLowerCase();
    if (!keyword) return entries;
    return entries.filter((entry) => entry.hostname.toLowerCase().includes(keyword) || entry.lastTitle.toLowerCase().includes(keyword) || entry.lastUrl.toLowerCase().includes(keyword));
  }

  function filterCategoryEntries(entries) {
    const keyword = state.filterText.trim().toLowerCase();
    if (!keyword) return entries;
    return entries.filter((entry) =>
      entry.categoryName.toLowerCase().includes(keyword) ||
      entry.topSites.some((site) => site.hostname.toLowerCase().includes(keyword) || site.lastTitle.toLowerCase().includes(keyword) || site.lastUrl.toLowerCase().includes(keyword))
    );
  }

  function createFallbackFavicon() {
    const node = document.createElement("span");
    node.className = "favicon favicon-fallback";
    node.textContent = "●";
    return node;
  }

  function createFavicon(entry) {
    if (!entry.faviconUrl) return createFallbackFavicon();
    const image = document.createElement("img");
    image.className = "favicon";
    image.src = entry.faviconUrl;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.replaceWith(createFallbackFavicon()));
    return image;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function disposeChart(name) {
    if (state.charts[name]) {
      echarts.dispose(state.charts[name]);
      state.charts[name] = null;
    }
  }

  function setTableHeaders(headers) {
    elements.reportTableHead.innerHTML = headers.map((header) => `<th>${header}</th>`).join("");
  }

  function renderSiteTable(entries) {
    setTableHeaders(["站点", "最近页面标题", "时长"]);
    elements.reportTableBody.innerHTML = "";
    for (const entry of entries) {
      const row = elements.reportTableBody.insertRow();
      const siteCell = row.insertCell();
      const titleCell = row.insertCell();
      const durationCell = row.insertCell();
      const wrapper = document.createElement("div");
      wrapper.className = "site-cell";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "site-link";
      link.textContent = entry.hostname;
      link.title = entry.lastUrl || entry.hostname;
      if (entry.lastUrl) link.addEventListener("click", () => chrome.tabs.create({ url: entry.lastUrl }));
      else link.disabled = true;
      wrapper.appendChild(createFavicon(entry));
      wrapper.appendChild(link);
      siteCell.appendChild(wrapper);
      titleCell.textContent = entry.lastTitle || "-";
      durationCell.textContent = formatDuration(entry.seconds);
    }
  }

  function renderCategoryTable(entries) {
    setTableHeaders(["分类", "包含站点", "时长 / 占比"]);
    elements.reportTableBody.innerHTML = "";
    const totalSeconds = entries.reduce((sum, entry) => sum + entry.seconds, 0);
    for (const entry of entries) {
      const row = elements.reportTableBody.insertRow();
      row.insertCell().innerHTML = `<div class="category-cell"><span class="category-dot" style="background:${escapeHtml(entry.color)}"></span><span>${escapeHtml(entry.categoryName)}</span></div>`;
      row.insertCell().textContent = `${entry.siteCount} 个站点`;
      row.insertCell().innerHTML = `${formatDuration(entry.seconds)}<br><span class="muted">${formatShare(entry.seconds, totalSeconds)}</span>`;
    }
  }

  function renderGoalProgress(goalConfig, categoryConfig, stats) {
    const goalEntries = Object.entries(goalConfig.categoryGoals || {});
    if (!goalConfig.enabled || !goalEntries.length) {
      elements.goalPanel.style.display = "none";
      return;
    }
    const totals = aggregateCategoryTotals(normalizeSiteEntries(stats.daily[formatDate(new Date())]), categoryConfig);
    const completed = goalEntries.filter(([categoryId, minutes]) => (totals[categoryId] || 0) >= minutes * 60).length;
    elements.goalPanel.style.display = "block";
    elements.goalPanelHint.textContent = `已完成 ${completed} / ${goalEntries.length} 个今日目标。`;
    elements.goalList.innerHTML = goalEntries.map(([categoryId, minutes]) => {
      const category = getCategoryById(categoryConfig, categoryId);
      const seconds = totals[categoryId] || 0;
      const width = Math.min(100, (seconds / (minutes * 60)) * 100);
      return `
        <div class="goal-item">
          <div class="goal-top">
            <div class="goal-name">
              <span class="category-dot" style="background:${escapeHtml(category.color)}"></span>
              <span>${escapeHtml(category.name)}</span>
            </div>
            <span class="muted">${Math.floor(seconds / 60)} / ${minutes} 分钟</span>
          </div>
          <div class="goal-bar">
            <div class="goal-progress" style="width:${width}%;background:${escapeHtml(category.color)}"></div>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderSummary(currentSiteEntries, categoryEntries, analysisEntries, sceneConfig) {
    const totalSeconds = currentSiteEntries.reduce((sum, entry) => sum + entry.seconds, 0);
    const topSite = currentSiteEntries[0];
    const topCategory = categoryEntries[0];
    const biggestShift = analysisEntries[0];
    const sceneName = SCENE_PRESETS.find((scene) => scene.id === sceneConfig.activeSceneId)?.name || "工作模式";
    if (!currentSiteEntries.length) {
      elements.summaryHint.textContent = "当前报表为空，先积累一些浏览数据再来复盘。";
      elements.summaryList.innerHTML = `<div class="summary-item">当前时间范围内没有可总结的数据。</div>`;
      return;
    }
    const reportLabel = state.activeReport === REPORT_TYPES.DAILY ? "日报" : state.activeReport === REPORT_TYPES.WEEKLY ? "周报" : "月报";
    elements.summaryHint.textContent = `${sceneName}下的${reportLabel}自动总结。`;
    const items = [
      `本期累计浏览时长为 ${formatDuration(totalSeconds)}。`,
      topCategory ? `投入最多的分类是“${topCategory.categoryName}”，占比 ${formatShare(topCategory.seconds, totalSeconds)}。` : "当前还没有形成明显的分类主导。",
      topSite ? `最耗时的网站是 ${topSite.hostname}，累计 ${formatDuration(topSite.seconds)}。` : "当前还没有形成明显的站点主导。",
      biggestShift ? `变化最明显的分类是“${biggestShift.categoryName}”，相较上一周期 ${formatDelta(biggestShift.deltaSeconds)}。` : "当前缺少上一周期数据，暂时无法生成变化结论。",
    ];
    elements.summaryList.innerHTML = items.map((text) => `<div class="summary-item">${escapeHtml(text)}</div>`).join("");
  }

  function renderSummaryItems(hint, items) {
    elements.summaryHint.textContent = hint;
    elements.summaryList.innerHTML = items.map((text) => `<div class="summary-item">${escapeHtml(text)}</div>`).join("");
  }

  function buildSummaryPayload(currentSiteEntries, categoryEntries, analysisEntries, sceneConfig) {
    const totalSeconds = currentSiteEntries.reduce((sum, entry) => sum + entry.seconds, 0) || 1;
    return {
      reportType: state.activeReport,
      viewType: state.activeView,
      periodLabel: state.activeReport === REPORT_TYPES.DAILY
        ? formatDate(state.currentDate)
        : state.activeReport === REPORT_TYPES.WEEKLY
          ? getIsoWeekKey(state.currentWeekDate)
          : formatMonthKey(state.currentMonthDate),
      sceneName: SCENE_PRESETS.find((scene) => scene.id === sceneConfig.activeSceneId)?.name || "工作模式",
      categories: categoryEntries.slice(0, 6).map((entry) => ({
        id: entry.categoryId,
        name: entry.categoryName,
        seconds: entry.seconds,
        share: Number((entry.seconds / totalSeconds).toFixed(4)),
      })),
      sites: currentSiteEntries.slice(0, 8).map((entry) => ({
        hostname: entry.hostname,
        seconds: entry.seconds,
        title: entry.lastTitle,
        url: entry.lastUrl,
      })),
      analysis: analysisEntries.slice(0, 4).map((entry) => ({
        categoryName: entry.categoryName,
        deltaSeconds: entry.deltaSeconds,
      })),
    };
  }

  async function renderEnhancedSummary(runId, payload, llmConfig) {
    const key = JSON.stringify([llmConfig, payload]);
    let cached = state.summaryCache.get(key);
    if (!cached || cached.retryAt <= Date.now()) {
      cached = { retryAt: Infinity };
      cached.promise = requestSmartSummary(llmConfig, payload).catch((error) => {
        cached.retryAt = Date.now() + 30000;
        throw error;
      });
      state.summaryCache.set(key, cached);
      if (state.summaryCache.size > 16) state.summaryCache.delete(state.summaryCache.keys().next().value);
    }
    const localHint = elements.summaryHint.textContent;
    elements.summaryHint.textContent = `${localHint} LLM 增强生成中...`;
    try {
      const items = await cached.promise;
      if (runId !== state.summaryRunId) return;
      if (items.length) renderSummaryItems(`${localHint} · LLM 增强`, items);
      else elements.summaryHint.textContent = localHint;
    } catch (error) {
      if (runId !== state.summaryRunId) return;
      console.warn("Smart summary enhancement failed", error);
      elements.summaryHint.textContent = `${localHint} · 已回退到本地总结`;
    }
  }

  function renderFocusStatus(focusConfig, sceneConfig) {
    const sceneName = SCENE_PRESETS.find((scene) => scene.id === sceneConfig.activeSceneId)?.name || "工作模式";
    elements.focusStatusPill.textContent = focusConfig.enabled ? `${sceneName} · 专注开启` : `${sceneName} · 专注关闭`;
    elements.focusStatusPill.classList.toggle("off", !focusConfig.enabled);
    elements.toggleFocusModeBtn.textContent = focusConfig.enabled ? "关闭专注模式" : "开启专注模式";
  }

  function renderSceneButtons(sceneConfig) {
    const map = { work: elements.sceneWorkBtn, study: elements.sceneStudyBtn, relax: elements.sceneRelaxBtn };
    for (const [sceneId, button] of Object.entries(map)) {
      button.classList.toggle("selected", sceneConfig.activeSceneId === sceneId);
    }
  }

  function renderAnalysis(entries) {
    const shouldShow = state.activeView === VIEW_TYPES.CATEGORY;
    elements.analysisCard.style.display = shouldShow ? "block" : "none";
    if (!shouldShow) return;
    elements.analysisTitle.textContent = "分类变化分析";
    elements.analysisSubtitle.textContent = `当前周期 ${getAnalysisPeriodLabel()}。`;
    if (!entries.length) {
      elements.analysisList.innerHTML = "";
      elements.analysisEmptyState.style.display = "block";
      return;
    }
    elements.analysisEmptyState.style.display = "none";
    const rising = entries.filter((entry) => entry.deltaSeconds > 0).sort((a, b) => b.deltaSeconds - a.deltaSeconds).slice(0, 2);
    const falling = entries.filter((entry) => entry.deltaSeconds < 0).sort((a, b) => a.deltaSeconds - b.deltaSeconds).slice(0, 2);
    const normalizedEntries = [...rising, ...falling];
    if (!normalizedEntries.length) {
      elements.analysisList.innerHTML = `<div class="analysis-item"><div class="analysis-top"><div class="analysis-name"><span>分类总时长与上一周期基本持平</span></div><span class="delta-neutral">持平</span></div></div>`;
      return;
    }
    elements.analysisList.innerHTML = normalizedEntries.map((entry) => {
      const deltaClass = entry.deltaSeconds > 0 ? "delta-positive" : "delta-negative";
      return `
        <div class="analysis-item">
          <div class="analysis-top">
            <div class="analysis-name">
              <span class="category-dot" style="background:${escapeHtml(entry.color)}"></span>
              <span>${escapeHtml(entry.categoryName)}</span>
            </div>
            <span class="${deltaClass}">${formatDelta(entry.deltaSeconds)}</span>
          </div>
          <p class="muted" style="margin-top:6px;">当前 ${formatDuration(entry.currentSeconds)}，上一周期 ${formatDuration(entry.previousSeconds)}</p>
        </div>
      `;
    }).join("");
  }

  function renderPrimaryChart(entries) {
    if (!entries.length) {
      disposeChart("primary");
      elements.primaryChartCard.style.display = "none";
      return;
    }
    elements.primaryChartCard.style.display = "block";
    state.charts.primary ||= echarts.init(elements.primaryChart);
    const updateChart = (option) => state.charts.primary.setOption(option, { notMerge: true });
    if (state.activeView === VIEW_TYPES.SITE && state.activeReport === REPORT_TYPES.DAILY) {
      const total = entries.reduce((sum, entry) => sum + entry.seconds, 0);
      const chartEntries = entries.length > DAILY_TOP_LIMIT ? [...entries.slice(0, DAILY_TOP_LIMIT), { hostname: "其他", seconds: entries.slice(DAILY_TOP_LIMIT).reduce((sum, entry) => sum + entry.seconds, 0) }] : entries;
      updateChart({
        tooltip: { trigger: "item", formatter: (params) => `${escapeHtml(params.name)}<br>${formatDuration(params.value)}<br>${params.percent}%` },
        series: [{ type: "pie", roseType: "radius", radius: [24, 104], center: ["50%", "56%"], itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 8 }, label: { formatter: (params) => `${params.name}\n${total ? Math.round((params.value / total) * 100) : 0}%` }, data: chartEntries.map((entry) => ({ name: entry.hostname, value: entry.seconds })) }],
      });
      return;
    }
    if (state.activeView === VIEW_TYPES.SITE && state.activeReport === REPORT_TYPES.WEEKLY) {
      updateChart({
        tooltip: { trigger: "item", formatter: (params) => `${escapeHtml(params.name)}: ${formatDuration(params.value)}` },
        series: [{ type: "treemap", data: entries.map((entry) => ({ name: entry.hostname, value: entry.seconds })), breadcrumb: { show: false }, leafDepth: 1, label: { show: true, formatter: (params) => `${params.name}\n${formatDuration(params.value)}` } }],
      });
      return;
    }
    if (state.activeView === VIEW_TYPES.SITE && state.activeReport === REPORT_TYPES.MONTHLY) {
      const ranked = entries.slice(0, MONTHLY_TOP_LIMIT).reverse();
      updateChart({
        grid: { top: 16, right: 18, bottom: 24, left: 96 },
        xAxis: { type: "value", axisLabel: { formatter: (value) => `${Math.round(value / 3600)}h` } },
        yAxis: { type: "category", data: ranked.map((entry) => entry.hostname) },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (params) => `${escapeHtml(params[0].name)}<br>${formatDuration(params[0].value)}` },
        series: [{ type: "bar", data: ranked.map((entry) => entry.seconds), itemStyle: { color: "#2563eb", borderRadius: [0, 8, 8, 0] }, label: { show: true, position: "right", formatter: (params) => formatDuration(params.value) } }],
      });
      return;
    }
    if (state.activeView === VIEW_TYPES.CATEGORY && state.activeReport === REPORT_TYPES.DAILY) {
      updateChart({
        tooltip: { trigger: "item", formatter: (params) => `${escapeHtml(params.name)}<br>${formatDuration(params.value)}<br>${params.percent}%` },
        series: [{ type: "pie", radius: ["42%", "70%"], center: ["50%", "43%"], data: entries.map((entry) => ({ name: entry.categoryName, value: entry.seconds, itemStyle: { color: entry.color } })) }],
      });
      return;
    }
    const ranked = entries.slice(0, 8).reverse();
    updateChart({
      grid: { top: 16, right: 18, bottom: 24, left: 74 },
      xAxis: { type: "value", axisLabel: { formatter: (value) => `${Math.round(value / 60)}分` } },
      yAxis: { type: "category", data: ranked.map((entry) => entry.categoryName) },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (params) => `${escapeHtml(params[0].name)}<br>${formatDuration(params[0].value)}` },
      series: [{ type: "bar", data: ranked.map((entry) => ({ value: entry.seconds, itemStyle: { color: entry.color } })), label: { show: true, position: "right", formatter: (params) => formatDuration(params.value) } }],
    });
  }

  function renderTrendChart(trend) {
    const shouldShow = state.activeView === VIEW_TYPES.CATEGORY;
    if (!shouldShow || !trend.series.length) {
      disposeChart("secondary");
      elements.secondaryChartCard.style.display = "none";
      return;
    }
    elements.secondaryChartCard.style.display = "block";
    state.charts.secondary ||= echarts.init(elements.secondaryChart);
    state.charts.secondary.setOption({
      color: trend.categories.map((category) => category.color),
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (params) => [escapeHtml(params[0]?.axisValue || ""), ...params.map((item) => `${escapeHtml(item.seriesName)}: ${formatDuration(item.value)}`)].join("<br>") },
      legend: { bottom: 0 },
      grid: { top: 20, right: 12, bottom: 42, left: 28 },
      xAxis: { type: "category", data: trend.labels },
      yAxis: { type: "value", axisLabel: { formatter: (value) => `${Math.round(value / 60)}分` } },
      series: trend.series.map((series) => ({ name: series.name, type: "bar", stack: "total", data: series.data })),
    }, { notMerge: true });
  }

  function setSummaryTexts(stats) {
    const dateKey = formatDate(state.currentDate);
    const weekKey = getIsoWeekKey(state.currentWeekDate);
    const monthLabel = formatMonthLabel(state.currentMonthDate);
    if (state.activeReport === REPORT_TYPES.DAILY) {
      elements.reportTitle.textContent = `今日报告 (${dateKey})`;
      elements.reportSubtitle.textContent = state.activeView === VIEW_TYPES.SITE ? "按具体网站查看时长。" : "按工作、学习、娱乐等分类查看。";
      elements.primaryChartTitle.textContent = state.activeView === VIEW_TYPES.SITE ? "站点分布" : "分类占比";
      elements.primaryChartSubtitle.textContent = state.activeView === VIEW_TYPES.SITE ? "展示当前日报中的主要站点。" : "展示当前日报中的分类结构。";
      elements.secondaryChartTitle.textContent = "最近 7 天分类趋势";
      elements.secondaryChartSubtitle.textContent = "把单天结果放回一周节奏里看。";
    } else if (state.activeReport === REPORT_TYPES.WEEKLY) {
      elements.reportTitle.textContent = `本周报告 (${weekKey})`;
      elements.reportSubtitle.textContent = state.activeView === VIEW_TYPES.SITE ? "按网站查看本周累计时长。" : "按分类查看本周时间投入结构。";
      elements.primaryChartTitle.textContent = state.activeView === VIEW_TYPES.SITE ? "站点周报分布" : "分类周排行";
      elements.primaryChartSubtitle.textContent = state.activeView === VIEW_TYPES.SITE ? "识别本周最主要的网站。" : "识别本周投入最多的分类。";
      elements.secondaryChartTitle.textContent = "最近 7 天分类趋势";
      elements.secondaryChartSubtitle.textContent = "先看本周总量，再看每天是怎么组成的。";
    } else {
      elements.reportTitle.textContent = `本月报告 (${monthLabel})`;
      elements.reportSubtitle.textContent = state.activeView === VIEW_TYPES.SITE ? "按网站查看本月累计时长。" : "按分类查看本月时间结构。";
      elements.primaryChartTitle.textContent = state.activeView === VIEW_TYPES.SITE ? "月度站点排行" : "月度分类排行";
      elements.primaryChartSubtitle.textContent = state.activeView === VIEW_TYPES.SITE ? "聚焦本月最耗时的网站。" : "识别本月投入最多的分类。";
      elements.secondaryChartTitle.textContent = "最近 7 天分类趋势";
      elements.secondaryChartSubtitle.textContent = "月报之外，再看最近一周的分类波动。";
    }
    elements.lastUpdated.textContent = formatUpdatedAt(stats.updatedAt);
  }

  function setActiveButtons() {
    elements.todayBtn.classList.toggle("selected", state.activeReport === REPORT_TYPES.DAILY);
    elements.thisWeekBtn.classList.toggle("selected", state.activeReport === REPORT_TYPES.WEEKLY);
    elements.thisMonthBtn.classList.toggle("selected", state.activeReport === REPORT_TYPES.MONTHLY);
    elements.siteViewBtn.classList.toggle("selected", state.activeView === VIEW_TYPES.SITE);
    elements.categoryViewBtn.classList.toggle("selected", state.activeView === VIEW_TYPES.CATEGORY);
    const showDaily = state.activeReport === REPORT_TYPES.DAILY;
    const showWeekly = state.activeReport === REPORT_TYPES.WEEKLY;
    const showMonthly = state.activeReport === REPORT_TYPES.MONTHLY;
    elements.prevDayBtn.style.display = showDaily ? "inline-flex" : "none";
    elements.nextDayBtn.style.display = showDaily ? "inline-flex" : "none";
    elements.prevWeekBtn.style.display = showWeekly ? "inline-flex" : "none";
    elements.nextWeekBtn.style.display = showWeekly ? "inline-flex" : "none";
    elements.prevMonthBtn.style.display = showMonthly ? "inline-flex" : "none";
    elements.nextMonthBtn.style.display = showMonthly ? "inline-flex" : "none";
  }

  async function loadSettings() {
    const result = await storageGet("local", [CATEGORY_CONFIG_KEY, GOAL_CONFIG_KEY, FOCUS_CONFIG_KEY, SCENE_CONFIG_KEY, LLM_CONFIG_KEY, LLM_FEATURE_FLAGS_KEY]);
    return {
      categoryConfig: defaultCategoryConfig(result[CATEGORY_CONFIG_KEY] || {}),
      goalConfig: defaultGoalConfig(result[GOAL_CONFIG_KEY] || {}),
      focusConfig: defaultFocusConfig(result[FOCUS_CONFIG_KEY] || {}),
      sceneConfig: defaultSceneConfig(result[SCENE_CONFIG_KEY] || {}),
      llmConfig: defaultLLMConfig(result[LLM_CONFIG_KEY] || {}),
      llmFeatureFlags: defaultLLMFeatureFlags(result[LLM_FEATURE_FLAGS_KEY] || {}),
    };
  }

  function selectedReportRange() {
    const today = new Date();
    const days = [formatDate(today)];
    const weeks = [];
    let trendEnd = state.currentDate;
    if (state.activeReport === REPORT_TYPES.DAILY) {
      days.push(formatDate(state.currentDate), formatDate(StatsStore.shiftDay(state.currentDate, -1)));
    } else if (state.activeReport === REPORT_TYPES.WEEKLY) {
      const date = state.currentWeekDate;
      weeks.push(getIsoWeekKey(date), getIsoWeekKey(StatsStore.shiftDay(date, -7)));
      trendEnd = StatsStore.shiftDay(date, (7 - date.getDay()) % 7);
    } else {
      const start = StatsStore.shiftMonth(state.currentMonthDate, -1);
      const end = StatsStore.shiftMonth(state.currentMonthDate, 1);
      for (let date = start; date < end; date = StatsStore.shiftDay(date, 1)) days.push(formatDate(date));
      trendEnd = StatsStore.shiftDay(end, -1);
    }
    if (trendEnd > today) trendEnd = today;
    if (state.activeView === VIEW_TYPES.CATEGORY) {
      for (let offset = 0; offset < 7; offset += 1) days.push(formatDate(StatsStore.shiftDay(trendEnd, -offset)));
    }
    return { days, weeks, trendEnd };
  }

  async function statisticsForExport() {
    const { stats, session } = await StatsStore.request("GET_STATS");
    return StatsStore.withActiveSession(stats, session);
  }

  async function applyScene(sceneId) {
    const preset = SCENE_PRESETS.find((item) => item.id === sceneId);
    if (!preset) return;
    await storageSet("local", {
      [SCENE_CONFIG_KEY]: { activeSceneId: sceneId },
      [GOAL_CONFIG_KEY]: preset.goalConfig,
      [FOCUS_CONFIG_KEY]: preset.focusConfig,
    });
  }

  function buildExportSummaries(stats, categoryConfig) {
    const today = normalizeSiteEntries(getSummaryBucket(stats, REPORT_TYPES.DAILY, new Date()));
    const week = normalizeSiteEntries(getSummaryBucket(stats, REPORT_TYPES.WEEKLY, new Date()));
    const month = normalizeSiteEntries(getSummaryBucket(stats, REPORT_TYPES.MONTHLY, new Date()));
    const createSummary = (entries) => {
      const categories = aggregateCategoryEntries(entries, categoryConfig);
      return {
        totalSeconds: entries.reduce((sum, entry) => sum + entry.seconds, 0),
        topSite: entries[0] || null,
        topCategory: categories[0] || null,
      };
    };
    return { today: createSummary(today), thisWeek: createSummary(week), thisMonth: createSummary(month) };
  }

  async function renderActiveReport({ refreshSummary = true } = {}) {
    const runId = ++state.reportRunId;
    const summaryRunId = refreshSummary ? ++state.summaryRunId : state.summaryRunId;
    const { days, weeks, trendEnd } = selectedReportRange();
    state.reportPending = true;
    let report, settings;
    try {
      [report, settings] = await Promise.all([StatsStore.request("GET_STATS", { days, weeks }), loadSettings()]);
    } catch (error) {
      if (runId !== state.reportRunId) return;
      console.warn("Failed to load report", error);
      elements.emptyState.style.display = "block";
      elements.emptyState.textContent = "读取统计失败，请关闭弹窗后重试。";
      return;
    } finally {
      if (runId === state.reportRunId) state.reportPending = false;
    }
    if (runId !== state.reportRunId) return;
    const { categoryConfig, goalConfig, focusConfig, sceneConfig, llmConfig, llmFeatureFlags } = settings;
    const { stats: recordedStats, session } = report;
    state.hasRunningSession = Boolean(session?.isRunning);
    const stats = StatsStore.withActiveSession(recordedStats, session);
    renderFocusStatus(focusConfig, sceneConfig);
    renderSceneButtons(sceneConfig);
    renderGoalProgress(goalConfig, categoryConfig, stats);
    setActiveButtons();
    setSummaryTexts(stats);

    const rawSiteEntries = normalizeSiteEntries(getCurrentBucket(stats));
    const previousSiteEntries = normalizeSiteEntries(getPreviousBucket(stats));
    const siteEntries = filterSiteEntries(rawSiteEntries);
    const rawCategoryEntries = aggregateCategoryEntries(rawSiteEntries, categoryConfig);
    const categoryEntries = filterCategoryEntries(rawCategoryEntries);
    const analysisEntries = buildAnalysisEntries(rawSiteEntries, previousSiteEntries, categoryConfig);
    const recordedSites = refreshSummary && llmConfig.enabled && llmFeatureFlags.smartSummaryEnabled
      ? normalizeSiteEntries(getCurrentBucket(recordedStats))
      : [];
    if (refreshSummary) state.summaryIsLocal = !recordedSites.length;
    if (refreshSummary || state.summaryIsLocal) renderSummary(rawSiteEntries, rawCategoryEntries, analysisEntries, sceneConfig);
    if (recordedSites.length) {
      const recordedCategories = aggregateCategoryEntries(recordedSites, categoryConfig);
      const recordedAnalysis = buildAnalysisEntries(
        recordedSites, normalizeSiteEntries(getPreviousBucket(recordedStats)), categoryConfig
      );
      void renderEnhancedSummary(summaryRunId, buildSummaryPayload(recordedSites, recordedCategories, recordedAnalysis, sceneConfig), llmConfig);
    }

    const viewEntries = state.activeView === VIEW_TYPES.SITE ? siteEntries : categoryEntries;
    elements.emptyState.style.display = viewEntries.length ? "none" : "block";
    elements.reportTable.style.display = viewEntries.length ? "table" : "none";
    if (!viewEntries.length) {
      disposeChart("primary");
      disposeChart("secondary");
      elements.primaryChartCard.style.display = "none";
      elements.secondaryChartCard.style.display = "none";
      elements.emptyState.textContent = state.activeView === VIEW_TYPES.SITE ? "当前时间范围内没有符合筛选条件的站点记录。" : "当前时间范围内没有符合筛选条件的分类记录。";
      renderAnalysis([]);
      return;
    }

    state.activeView === VIEW_TYPES.SITE ? renderSiteTable(siteEntries) : renderCategoryTable(categoryEntries);
    renderAnalysis(analysisEntries);
    renderPrimaryChart(viewEntries);
    renderTrendChart(state.activeView === VIEW_TYPES.CATEGORY ? buildCategoryTrend(stats, categoryConfig, trendEnd) : null);
  }

  function downloadTextFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportJson() {
    const [stats, { categoryConfig, goalConfig, focusConfig, sceneConfig }] = await Promise.all([statisticsForExport(), loadSettings()]);
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 4,
      stats,
      categoryConfig,
      goalConfig,
      focusConfig,
      sceneConfig,
      summaries: buildExportSummaries(stats, categoryConfig),
    };
    downloadTextFile(`surfing-stats-bundle-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), "application/json");
  }

  async function exportCsv() {
    const [stats, { categoryConfig }] = await Promise.all([statisticsForExport(), loadSettings()]);
    const lines = [["date", "category_id", "category_name", "hostname", "title", "url", "seconds", "hours"].join(",")];
    for (const [dateKey, bucket] of Object.entries(stats.daily).sort(([a], [b]) => a.localeCompare(b))) {
      for (const [hostname, entry] of Object.entries(bucket || {}).sort(([a], [b]) => a.localeCompare(b))) {
        const categoryId = categoryConfig.siteCategoryMap[hostname] || "other";
        const category = getCategoryById(categoryConfig, categoryId);
        const cells = [dateKey, categoryId, category.name, hostname, entry?.lastTitle || "", entry?.lastUrl || "", entry?.seconds || 0, ((entry?.seconds || 0) / 3600).toFixed(2)].map(StatsStore.csvCell);
        lines.push(cells.join(","));
      }
    }
    downloadTextFile(`surfing-stats-daily-${new Date().toISOString().slice(0, 10)}.csv`, `\uFEFF${lines.join("\r\n")}`, "text/csv;charset=utf-8");
  }

  async function clearStats() {
    if (!window.confirm("确认清空所有统计数据吗？此操作不可撤销。")) return;
    await StatsStore.request("CLEAR_STATS");
    state.summaryCache.clear();
    state.currentDate = new Date();
    state.currentWeekDate = new Date();
    state.currentMonthDate = StatsStore.shiftMonth(new Date(), 0);
    await renderActiveReport();
  }

  async function toggleFocusMode() {
    const { focusConfig } = await loadSettings();
    await storageSet("local", { [FOCUS_CONFIG_KEY]: { ...focusConfig, enabled: !focusConfig.enabled } });
  }

  function isFutureDate(date) {
    const target = new Date(date);
    const today = new Date();
    target.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return target > today;
  }

  const isFutureWeek = (date) => getIsoWeekKey(date) > getIsoWeekKey(new Date());
  const isFutureMonth = (date) => formatMonthKey(date) > formatMonthKey(new Date());

  elements.toggleFocusModeBtn.addEventListener("click", async () => { await toggleFocusMode(); });
  elements.openSettingsBtn.addEventListener("click", async () => { await chrome.runtime.openOptionsPage(); });
  elements.sceneWorkBtn.addEventListener("click", async () => { await applyScene("work"); });
  elements.sceneStudyBtn.addEventListener("click", async () => { await applyScene("study"); });
  elements.sceneRelaxBtn.addEventListener("click", async () => { await applyScene("relax"); });
  elements.todayBtn.addEventListener("click", async () => { state.activeReport = REPORT_TYPES.DAILY; state.currentDate = new Date(); await renderActiveReport(); });
  elements.thisWeekBtn.addEventListener("click", async () => { state.activeReport = REPORT_TYPES.WEEKLY; state.currentWeekDate = new Date(); await renderActiveReport(); });
  elements.thisMonthBtn.addEventListener("click", async () => { state.activeReport = REPORT_TYPES.MONTHLY; state.currentMonthDate = StatsStore.shiftMonth(new Date(), 0); await renderActiveReport(); });
  elements.siteViewBtn.addEventListener("click", async () => { state.activeView = VIEW_TYPES.SITE; await renderActiveReport(); });
  elements.categoryViewBtn.addEventListener("click", async () => { state.activeView = VIEW_TYPES.CATEGORY; await renderActiveReport(); });
  elements.prevDayBtn.addEventListener("click", async () => { state.currentDate.setDate(state.currentDate.getDate() - 1); await renderActiveReport(); });
  elements.nextDayBtn.addEventListener("click", async () => {
    const nextDate = new Date(state.currentDate);
    nextDate.setDate(nextDate.getDate() + 1);
    if (isFutureDate(nextDate)) return window.alert("不能查看未来日期。");
    state.currentDate = nextDate;
    await renderActiveReport();
  });
  elements.prevWeekBtn.addEventListener("click", async () => { state.currentWeekDate.setDate(state.currentWeekDate.getDate() - 7); await renderActiveReport(); });
  elements.nextWeekBtn.addEventListener("click", async () => {
    const nextDate = new Date(state.currentWeekDate);
    nextDate.setDate(nextDate.getDate() + 7);
    if (isFutureWeek(nextDate)) return window.alert("不能查看未来周报。");
    state.currentWeekDate = nextDate;
    await renderActiveReport();
  });
  elements.prevMonthBtn.addEventListener("click", async () => { state.currentMonthDate = StatsStore.shiftMonth(state.currentMonthDate, -1); await renderActiveReport(); });
  elements.nextMonthBtn.addEventListener("click", async () => {
    const nextDate = StatsStore.shiftMonth(state.currentMonthDate, 1);
    if (isFutureMonth(nextDate)) return window.alert("不能查看未来月报。");
    state.currentMonthDate = nextDate;
    await renderActiveReport();
  });
  elements.searchInput.addEventListener("input", async (event) => { state.filterText = event.target.value || ""; await renderActiveReport(); });
  elements.manageCategoriesBtn.addEventListener("click", async () => { await chrome.runtime.openOptionsPage(); });
  elements.exportJsonBtn.addEventListener("click", async () => { await exportJson(); });
  elements.exportCsvBtn.addEventListener("click", async () => { await exportCsv(); });
  elements.clearBtn.addEventListener("click", async () => { await clearStats(); });

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === "local" && (changes[CATEGORY_CONFIG_KEY] || changes[GOAL_CONFIG_KEY] || changes[FOCUS_CONFIG_KEY] || changes[SCENE_CONFIG_KEY] || changes[LLM_CONFIG_KEY] || changes[LLM_FEATURE_FLAGS_KEY])) {
      await renderActiveReport();
    } else if (areaName === "session" && changes[SESSION_KEY] && !state.reportPending) {
      await renderActiveReport({ refreshSummary: false });
    }
  });

  window.addEventListener("resize", () => {
    if (state.charts.primary) state.charts.primary.resize();
    if (state.charts.secondary) state.charts.secondary.resize();
  });

  await renderActiveReport();
  setInterval(() => {
    if (state.hasRunningSession && !state.reportPending) void renderActiveReport({ refreshSummary: false });
  }, 5000);
});
