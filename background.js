importScripts("stats.js");

const LEGACY_STATS_KEY = "statsV2";
const SESSION_KEY = "activeSession";
const CATEGORY_CONFIG_KEY = "categoryConfig";
const GOAL_CONFIG_KEY = "goalConfig";
const FOCUS_CONFIG_KEY = "focusConfig";
const PRESENCE_CONFIG_KEY = "presenceConfig";
const BEHAVIOR_RUNTIME_KEY = "behaviorRuntime";
const LEGACY_KEYS = ["dailyStats", "weeklyStats", "tabMeta"];
const BEHAVIOR_ALARM_NAME = "behavior-check";
const DEFAULT_CATEGORIES = [
  { id: "work", name: "工作", system: true },
  { id: "study", name: "学习", system: true },
  { id: "entertainment", name: "娱乐", system: true },
  { id: "social", name: "社交", system: true },
  { id: "tools", name: "工具", system: true },
  { id: "other", name: "其他", system: true },
];

const DEFAULT_GOAL_CONFIG = {
  enabled: false,
  categoryGoals: {},
};

const DEFAULT_FOCUS_CONFIG = {
  enabled: false,
  allowedCategoryIds: ["work", "study", "tools"],
  distractionReminderEnabled: false,
  distractionCategoryIds: ["entertainment", "social"],
  distractionThresholdMinutes: 15,
};

let eventQueue = Promise.resolve();
let initializationPromise = null;

function storageGet(area, keys) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].get(keys, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function storageSet(area, items) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(area, keys) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs);
    });
  });
}

function createEmptyStats() {
  return { version: 2, updatedAt: null, daily: {}, weekly: {} };
}

function createDefaultCategoryConfig(existingConfig = {}) {
  const existingCategories = Array.isArray(existingConfig.categories)
    ? existingConfig.categories
    : [];
  const existingMap = existingConfig.siteCategoryMap || {};
  const categoryMap = new Map(existingCategories.map((category) => [category.id, category]));

  for (const category of DEFAULT_CATEGORIES) {
    if (!categoryMap.has(category.id)) {
      categoryMap.set(category.id, category);
      continue;
    }

    categoryMap.set(category.id, {
      ...categoryMap.get(category.id),
      system: true,
      name: category.name,
    });
  }

  const categories = Array.from(categoryMap.values());
  const validCategoryIds = new Set(categories.map((category) => category.id));
  const siteCategoryMap = Object.create(null);

  for (const [hostname, categoryId] of Object.entries(existingMap)) {
    siteCategoryMap[hostname] = validCategoryIds.has(categoryId) ? categoryId : "other";
  }

  return { categories, siteCategoryMap };
}

function isTrackableUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return Boolean(parsedUrl.hostname) && ["http:", "https:", "ftp:"].includes(parsedUrl.protocol);
  } catch (error) {
    return false;
  }
}

function getHostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return "";
  }
}

function normalizeSession(session) {
  if (
    !session ||
    !session.tabId ||
    !session.url ||
    !session.hostname ||
    !session.startedAt
  ) {
    return null;
  }

  return {
    id: session.id || JSON.stringify([session.tabId, session.startedAt, session.url]),
    tabId: session.tabId,
    documentId: session.documentId,
    url: session.url,
    hostname: session.hostname,
    title: session.title || "",
    faviconUrl: session.faviconUrl || "",
    startedAt: session.startedAt,
    isRunning: Boolean(session.isRunning),
    pauseReason: session.pauseReason,
  };
}

function createSessionFromTab(tab, startedAt, isRunning = true) {
  if (!tab?.id || !tab.url || !isTrackableUrl(tab.url)) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    tabId: tab.id,
    url: tab.url,
    hostname: getHostnameFromUrl(tab.url),
    title: tab.title || "",
    faviconUrl: tab.favIconUrl || "",
    startedAt,
    isRunning,
  };
}

async function getSession() {
  const result = await storageGet("session", SESSION_KEY);
  return normalizeSession(result[SESSION_KEY]);
}

async function setSession(session) {
  if (!session) {
    await storageRemove("session", SESSION_KEY);
    return;
  }

  await storageSet("session", {
    [SESSION_KEY]: {
      ...session,
      hostname: getHostnameFromUrl(session.url),
    },
  });
}

function enqueueEvent(task) {
  const result = eventQueue.then(async () => {
    await ensureInitialized();
    return task();
  });
  eventQueue = result.catch(() => {});
  return result;
}

async function getCategoryConfig() {
  const result = await storageGet("local", CATEGORY_CONFIG_KEY);
  return createDefaultCategoryConfig(result[CATEGORY_CONFIG_KEY] || {});
}

function createDefaultGoalConfig(goalConfig = {}) {
  const categoryGoals = {};

  for (const [categoryId, minutes] of Object.entries(goalConfig.categoryGoals || {})) {
    const normalizedMinutes = Math.max(0, Number(minutes) || 0);
    if (normalizedMinutes > 0) {
      categoryGoals[categoryId] = normalizedMinutes;
    }
  }

  return {
    enabled: Boolean(goalConfig.enabled),
    categoryGoals,
  };
}

function createDefaultFocusConfig(focusConfig = {}) {
  const allowedCategoryIds = Array.isArray(focusConfig.allowedCategoryIds)
    ? Array.from(new Set(focusConfig.allowedCategoryIds))
    : DEFAULT_FOCUS_CONFIG.allowedCategoryIds;
  const distractionCategoryIds = Array.isArray(focusConfig.distractionCategoryIds)
    ? Array.from(new Set(focusConfig.distractionCategoryIds))
    : DEFAULT_FOCUS_CONFIG.distractionCategoryIds;

  return {
    enabled: Boolean(focusConfig.enabled),
    allowedCategoryIds,
    distractionReminderEnabled: Boolean(focusConfig.distractionReminderEnabled),
    distractionCategoryIds,
    distractionThresholdMinutes: Math.max(
      1,
      Number(focusConfig.distractionThresholdMinutes) || DEFAULT_FOCUS_CONFIG.distractionThresholdMinutes
    ),
  };
}

function createDefaultBehaviorRuntime(runtime = {}) {
  return {
    goalNotifications: runtime.goalNotifications || {},
    distractionNotifications: runtime.distractionNotifications || {},
    focusNotifications: runtime.focusNotifications || {},
  };
}

async function getGoalConfig() {
  const result = await storageGet("local", GOAL_CONFIG_KEY);
  return createDefaultGoalConfig(result[GOAL_CONFIG_KEY] || {});
}

async function getFocusConfig() {
  const result = await storageGet("local", FOCUS_CONFIG_KEY);
  return createDefaultFocusConfig(result[FOCUS_CONFIG_KEY] || {});
}

async function getBehaviorRuntime() {
  const result = await storageGet("local", BEHAVIOR_RUNTIME_KEY);
  return createDefaultBehaviorRuntime(result[BEHAVIOR_RUNTIME_KEY] || {});
}

async function setBehaviorRuntime(runtime) {
  await storageSet("local", {
    [BEHAVIOR_RUNTIME_KEY]: createDefaultBehaviorRuntime(runtime),
  });
}

async function changeSession(tab, now, { pause = false, documentId, pauseReason = "hidden" } = {}) {
  const session = await getSession();
  if (pause) {
    if (session?.isRunning) {
      await StatsStore.settle(session, now);
      await setSession({ ...session, isRunning: false, pauseReason });
    }
    return;
  }

  if (session?.isRunning && tab?.id === session.tabId && tab.url === session.url) {
    const title = tab.title || session.title;
    const faviconUrl = tab.favIconUrl || session.faviconUrl;
    const nextDocumentId = documentId || session.documentId;
    if (title !== session.title || faviconUrl !== session.faviconUrl || nextDocumentId !== session.documentId) {
      await setSession({ ...session, title, faviconUrl, documentId: nextDocumentId });
    }
    return;
  }
  await StatsStore.settle(session, now);
  const next = createSessionFromTab(tab, now);
  if (next && documentId) next.documentId = documentId;
  await setSession(next);
}

async function getFocusedWindowId() {
  const window = (await chrome.windows.getAll()).find((item) => item.focused);
  return window?.id;
}

async function getFocusedTab() {
  const windowId = await getFocusedWindowId();
  if (windowId === undefined) return null;
  const [tab] = await tabsQuery({ active: true, windowId });
  return tab || null;
}

async function rebuildSessionFromFocusedWindow(now = Date.now(), { resumePaused = true } = {}) {
  const tab = await getFocusedTab();
  if (tab && !resumePaused) {
    const session = await getSession();
    if (session?.tabId === tab.id && !session.isRunning && session.url === tab.url) return;
  }
  await changeSession(tab, now, { pause: !tab });
}

async function getReport({ days, weeks }) {
  const [{ stats, checkpoint }, session] = await Promise.all([StatsStore.read({ days, weeks }), getSession()]);
  return {
    stats,
    session: session && { ...session, startedAt: StatsStore.settledThrough(session, checkpoint) },
  };
}

async function clearStatistics(now) {
  const session = await getSession();
  await StatsStore.clear(session, now);
  await setSession(session && { ...session, id: crypto.randomUUID(), startedAt: now });
  await storageRemove("local", BEHAVIOR_RUNTIME_KEY);
  return {};
}

function getSessionCategoryId(session, categoryConfig) {
  if (!session?.hostname) {
    return "other";
  }

  return categoryConfig.siteCategoryMap[session.hostname] || "other";
}

function aggregateBucketByCategory(bucket, categoryConfig) {
  const totals = {};

  for (const [hostname, entry] of Object.entries(bucket || {})) {
    const categoryId = categoryConfig.siteCategoryMap[hostname] || "other";
    totals[categoryId] = (totals[categoryId] || 0) + (entry?.seconds || 0);
  }

  return totals;
}

function getSessionRuntimeKey(session) {
  if (!session) {
    return "";
  }

  return `${session.tabId}:${session.url}:${session.startedAt}`;
}

function pruneRuntimeMapByDate(runtimeMap, keepKey) {
  const next = {};
  for (const [key, value] of Object.entries(runtimeMap || {})) {
    if (key === keepKey) {
      next[key] = value;
    }
  }
  return next;
}

function pruneRuntimeMapByPrefix(runtimeMap, prefix) {
  if (!prefix) {
    return {};
  }

  const next = {};
  for (const [key, value] of Object.entries(runtimeMap || {})) {
    if (key.startsWith(prefix)) {
      next[key] = value;
    }
  }
  return next;
}

function createNotification(notificationId, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(notificationId, options, (createdId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(createdId);
    });
  });
}

async function ensureBehaviorAlarm() {
  if (!await chrome.alarms.get(BEHAVIOR_ALARM_NAME)) {
    await chrome.alarms.create(BEHAVIOR_ALARM_NAME, { periodInMinutes: 1 });
  }
}

async function pauseIfIdle(session, now) {
  const result = await storageGet("local", PRESENCE_CONFIG_KEY);
  const config = result[PRESENCE_CONFIG_KEY] || {};
  if (config.enabled !== undefined && !config.enabled) return false;
  const minutes = [1, 3, 5].includes(Number(config.idleThresholdMinutes)) ? Number(config.idleThresholdMinutes) : 3;
  const idleState = await chrome.idle.queryState(minutes * 60);
  if (idleState !== "idle" && idleState !== "locked") return false;

  const media = await chrome.tabs.sendMessage(session.tabId, { type: "GET_MEDIA_STATE" }, { frameId: 0 }).catch(() => null);
  if (media?.hasActiveMedia) return false;

  await changeSession(null, now, { pause: true, pauseReason: "idle" });
  return true;
}

async function checkFocusedSession(now, { checkpoint = false } = {}) {
  const session = await getSession();
  if (!session?.isRunning) return;
  const tab = await getFocusedTab();
  if (tab?.id !== session.tabId || tab.url !== session.url) {
    await changeSession(tab, now, { pause: !tab });
    return;
  }

  if (!await pauseIfIdle(session, now) && checkpoint) await StatsStore.settle(session, now);
}

async function evaluateBehaviorRules(now) {
  const todayKey = StatsStore.dateKey(new Date(now));
  const [session, categoryConfig, goalConfig, focusConfig, runtime] = await Promise.all([
    getSession(),
    getCategoryConfig(),
    getGoalConfig(),
    getFocusConfig(),
    getBehaviorRuntime(),
  ]);
  const previousRuntime = JSON.stringify(runtime);
  const nextRuntime = createDefaultBehaviorRuntime(runtime);
  nextRuntime.goalNotifications = pruneRuntimeMapByDate(nextRuntime.goalNotifications, todayKey);

  if (goalConfig.enabled) {
    const { stats, checkpoint } = await StatsStore.read({ days: [todayKey], weeks: [] });
    const pending = session && { ...session, startedAt: StatsStore.settledThrough(session, checkpoint) };
    const liveStats = StatsStore.withActiveSession(stats, pending, now);
    const totals = aggregateBucketByCategory(liveStats.daily[todayKey], categoryConfig);
    const notifiedGoals = nextRuntime.goalNotifications[todayKey] || {};

    for (const [categoryId, minutes] of Object.entries(goalConfig.categoryGoals)) {
      if ((totals[categoryId] || 0) < minutes * 60 || notifiedGoals[categoryId]) {
        continue;
      }

      await createNotification(`goal-${todayKey}-${categoryId}`, {
        type: "basic",
        iconUrl: "images/icon128.svg",
        title: "今日目标已达成",
        message: `你在该分类上的累计时长已经达到 ${minutes} 分钟。`,
      });

      notifiedGoals[categoryId] = true;
    }

    nextRuntime.goalNotifications[todayKey] = notifiedGoals;
  }

  if (session?.isRunning) {
    const sessionKey = getSessionRuntimeKey(session);
    nextRuntime.focusNotifications = pruneRuntimeMapByPrefix(
      nextRuntime.focusNotifications,
      sessionKey
    );
    nextRuntime.distractionNotifications = pruneRuntimeMapByPrefix(
      nextRuntime.distractionNotifications,
      sessionKey
    );
    const categoryId = getSessionCategoryId(session, categoryConfig);

    if (
      focusConfig.enabled &&
      !focusConfig.allowedCategoryIds.includes(categoryId) &&
      !nextRuntime.focusNotifications[sessionKey]
    ) {
      await createNotification(`focus-${session.tabId}`, {
        type: "basic",
        iconUrl: "images/icon128.svg",
        title: "专注模式提醒",
        message: "当前站点不在专注模式允许列表中，建议切回目标任务。",
      });
      nextRuntime.focusNotifications = { [sessionKey]: now };
    }

    if (
      focusConfig.distractionReminderEnabled &&
      focusConfig.distractionCategoryIds.includes(categoryId)
    ) {
      const elapsedMinutes = Math.floor((now - session.startedAt) / 60000);
      const threshold = focusConfig.distractionThresholdMinutes;
      if (elapsedMinutes >= threshold) {
        const reminderKey = `${sessionKey}:${Math.floor(elapsedMinutes / threshold)}`;
        if (!nextRuntime.distractionNotifications[reminderKey]) {
          await createNotification(`distraction-${session.tabId}`, {
            type: "basic",
            iconUrl: "images/icon128.svg",
            title: "分心提醒",
            message: `你已经在当前分心分类停留约 ${elapsedMinutes} 分钟。`,
          });
          nextRuntime.distractionNotifications = {
            ...nextRuntime.distractionNotifications,
            [reminderKey]: now,
          };
        }
      }
    }
  } else {
    nextRuntime.focusNotifications = {};
    nextRuntime.distractionNotifications = {};
  }

  if (JSON.stringify(nextRuntime) !== previousRuntime) await setBehaviorRuntime(nextRuntime);
}

function migrateLegacyStats(legacyDaily, legacyWeekly, legacyMeta) {
  const stats = createEmptyStats();

  for (const [dateKey, hosts] of Object.entries(legacyDaily || {})) {
    const bucket = Object.create(null);
    for (const [hostname, seconds] of Object.entries(hosts || {})) {
      const meta = legacyMeta?.[hostname] || {};
      bucket[hostname] = {
        seconds: Number(seconds) || 0,
        lastTitle: meta.title || "",
        lastUrl: meta.url || "",
        faviconUrl: meta.faviconUrl || "",
      };
    }
    stats.daily[dateKey] = bucket;
  }

  for (const [weekKey, hosts] of Object.entries(legacyWeekly || {})) {
    const bucket = Object.create(null);
    for (const [hostname, seconds] of Object.entries(hosts || {})) {
      const meta = legacyMeta?.[hostname] || {};
      bucket[hostname] = {
        seconds: Number(seconds) || 0,
        lastTitle: meta.title || "",
        lastUrl: meta.url || "",
        faviconUrl: meta.faviconUrl || "",
      };
    }
    stats.weekly[weekKey] = bucket;
  }

  return stats;
}

async function initializeExtensionState() {
  await StatsStore.migrate(async () => {
    const data = await storageGet("local", [LEGACY_STATS_KEY, ...LEGACY_KEYS]);
    return data[LEGACY_STATS_KEY] || migrateLegacyStats(data.dailyStats, data.weeklyStats, data.tabMeta);
  });
  await storageRemove("local", [LEGACY_STATS_KEY, ...LEGACY_KEYS]);
  await ensureBehaviorAlarm();
  await rebuildSessionFromFocusedWindow(Date.now(), { resumePaused: false });
}

function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = initializeExtensionState().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  return initializationPromise;
}

function scheduleEvent(label, task) {
  const now = Date.now();
  return enqueueEvent(() => task(now)).catch((error) => console.warn(label, error));
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleEvent("Initialization failed on install", rebuildSessionFromFocusedWindow);
});

chrome.runtime.onStartup.addListener(() => {
  scheduleEvent("Initialization failed on startup", rebuildSessionFromFocusedWindow);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" ||
      !(changes[GOAL_CONFIG_KEY] || changes[FOCUS_CONFIG_KEY] || changes[CATEGORY_CONFIG_KEY] || changes[PRESENCE_CONFIG_KEY])) return;
  return scheduleEvent("Failed to evaluate changed behavior rules", async (now) => {
    await checkFocusedSession(now);
    await evaluateBehaviorRules(now);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BEHAVIOR_ALARM_NAME) return;
  return scheduleEvent("Failed to checkpoint or evaluate behavior rules", async (now) => {
    await checkFocusedSession(now, { checkpoint: true });
    await evaluateBehaviorRules(now);
  });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => scheduleEvent("Failed to handle tab activation", async (now) => {
  if (windowId !== await getFocusedWindowId()) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await changeSession(tab?.windowId === windowId ? tab : null, now);
}));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl && changeInfo.status !== "complete") return;
  return scheduleEvent("Failed to handle tab update", async (now) => {
    if (!tab.active || tab.windowId !== await getFocusedWindowId()) return;
    const session = await getSession();
    if (session?.tabId === tabId && !session.isRunning && !changeInfo.url) return;
    await changeSession({ ...tab, url: changeInfo.url || tab.url }, now);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => scheduleEvent("Failed to handle tab removal", async (now) => {
  const session = await getSession();
  if (session?.tabId === tabId) await changeSession(null, now);
}));

chrome.windows.onFocusChanged.addListener((windowId) => scheduleEvent("Failed to handle focus change", async (now) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) await changeSession(null, now, { pause: true });
  else await rebuildSessionFromFocusedWindow(now);
}));

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.url?.startsWith(chrome.runtime.getURL(""))) {
    const now = Date.now();
    if (request?.type === "GET_STATS" || request?.type === "CLEAR_STATS") {
      enqueueEvent(() => request.type === "GET_STATS" ? getReport(request) : clearStatistics(now))
        .then(respond, (error) => respond({ error: error.message }));
      return true;
    }
  }

  if (!sender.tab?.id || sender.frameId !== 0) return;
  if (request?.type === "PAGE_HIDDEN") {
    scheduleEvent("Failed to pause hidden page", async (now) => {
      const session = await getSession();
      if (sender.tab.id === session?.tabId && sender.url === session.url &&
          (!session.documentId || sender.documentId === session.documentId)) {
        await changeSession(null, now, { pause: true });
      }
    });
  } else if (request?.type === "PAGE_VISIBLE" || request?.type === "PAGE_ACTIVE") {
    scheduleEvent("Failed to resume visible page", async (now) => {
      if (request.type === "PAGE_ACTIVE") {
        const session = await getSession();
        if (session?.pauseReason !== "idle" || session.tabId !== sender.tab.id || session.url !== sender.url) return;
      }
      const tab = await getFocusedTab();
      if (tab?.id === sender.tab.id && tab.url === sender.url) {
        await changeSession(tab, now, { documentId: sender.documentId });
      }
    });
  }
});

ensureInitialized().catch((error) => {
  console.error("Initialization failed", error);
});
