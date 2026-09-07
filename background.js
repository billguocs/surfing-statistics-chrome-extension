const STORAGE_KEY = "statsV2";
const SESSION_KEY = "activeSession";
const CATEGORY_CONFIG_KEY = "categoryConfig";
const GOAL_CONFIG_KEY = "goalConfig";
const FOCUS_CONFIG_KEY = "focusConfig";
const PRESENCE_CONFIG_KEY = "presenceConfig";
const BEHAVIOR_RUNTIME_KEY = "behaviorRuntime";
const LEGACY_KEYS = ["dailyStats", "weeklyStats", "tabMeta"];
const EXCLUDED_PROTOCOLS = ["about:", "chrome:", "chrome-extension:", "edge:"];
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

const DEFAULT_PRESENCE_CONFIG = {
  enabled: true,
  idleThresholdMinutes: 3,
};

let writeQueue = Promise.resolve();
let initializationPromise = null;

function storageGet(area, keys) {
  return new Promise((resolve) => {
    chrome.storage[area].get(keys, resolve);
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

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
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

function cloneStats(stats) {
  return {
    version: stats?.version || 2,
    updatedAt: stats?.updatedAt || null,
    daily: { ...(stats?.daily || {}) },
    weekly: { ...(stats?.weekly || {}) },
  };
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
  const siteCategoryMap = {};

  for (const [hostname, categoryId] of Object.entries(existingMap)) {
    siteCategoryMap[hostname] = validCategoryIds.has(categoryId) ? categoryId : "other";
  }

  return { categories, siteCategoryMap };
}

function isTrackableUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return !EXCLUDED_PROTOCOLS.includes(parsedUrl.protocol);
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

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getIsoWeekInfo(date) {
  const utcDate = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNumber = Math.ceil(((utcDate - yearStart) / 86400000 + 1) / 7);

  return {
    isoYear,
    weekNumber,
    weekKey: `${isoYear}-W${String(weekNumber).padStart(2, "0")}`,
  };
}

function getNextBoundary(timestamp) {
  const current = new Date(timestamp);
  const nextMidnight = new Date(current);
  nextMidnight.setHours(24, 0, 0, 0);

  const nextWeekStart = new Date(current);
  const day = nextWeekStart.getDay();
  const diffToMonday = day === 0 ? 1 : 8 - day;
  nextWeekStart.setDate(nextWeekStart.getDate() + diffToMonday);
  nextWeekStart.setHours(0, 0, 0, 0);

  return Math.min(nextMidnight.getTime(), nextWeekStart.getTime());
}

function splitRangeByDateAndWeek(startTime, endTime) {
  const segments = [];
  let segmentStart = startTime;

  while (segmentStart < endTime) {
    const boundary = getNextBoundary(segmentStart);
    const segmentEnd = Math.min(boundary, endTime);
    const durationSeconds = Math.round((segmentEnd - segmentStart) / 1000);

    if (durationSeconds > 0) {
      const segmentDate = new Date(segmentStart);
      segments.push({
        dateKey: toDateKey(segmentDate),
        weekKey: getIsoWeekInfo(segmentDate).weekKey,
        seconds: durationSeconds,
      });
    }

    segmentStart = segmentEnd;
  }

  return segments;
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
    tabId: session.tabId,
    url: session.url,
    hostname: session.hostname,
    title: session.title || "",
    faviconUrl: session.faviconUrl || "",
    startedAt: session.startedAt,
    isRunning: Boolean(session.isRunning),
  };
}

function createSessionFromTab(tab, startedAt, isRunning = true) {
  if (!tab?.id || !tab.url || !isTrackableUrl(tab.url)) {
    return null;
  }

  return {
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

function mergeEntry(entry, seconds, session) {
  return {
    seconds: (entry?.seconds || 0) + seconds,
    lastTitle: session.title || entry?.lastTitle || "",
    lastUrl: session.url || entry?.lastUrl || "",
    faviconUrl: session.faviconUrl || entry?.faviconUrl || "",
  };
}

async function withQueuedWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

async function readStats() {
  const result = await storageGet("local", STORAGE_KEY);
  return cloneStats(result[STORAGE_KEY] || createEmptyStats());
}

async function writeStats(stats) {
  await storageSet("local", {
    [STORAGE_KEY]: {
      ...stats,
      version: 2,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function getCategoryConfig() {
  const result = await storageGet("local", CATEGORY_CONFIG_KEY);
  return createDefaultCategoryConfig(result[CATEGORY_CONFIG_KEY] || {});
}

async function setCategoryConfig(categoryConfig) {
  await storageSet("local", {
    [CATEGORY_CONFIG_KEY]: createDefaultCategoryConfig(categoryConfig),
  });
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

function createDefaultPresenceConfig(presenceConfig = {}) {
  const enabled = presenceConfig.enabled === undefined ? DEFAULT_PRESENCE_CONFIG.enabled : Boolean(presenceConfig.enabled);
  let minutes = Math.max(1, Number(presenceConfig.idleThresholdMinutes) || DEFAULT_PRESENCE_CONFIG.idleThresholdMinutes);
  if (![1, 3, 5].includes(minutes)) {
    minutes = DEFAULT_PRESENCE_CONFIG.idleThresholdMinutes;
  }
  return { enabled, idleThresholdMinutes: minutes };
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

async function setGoalConfig(goalConfig) {
  await storageSet("local", {
    [GOAL_CONFIG_KEY]: createDefaultGoalConfig(goalConfig),
  });
}

async function getFocusConfig() {
  const result = await storageGet("local", FOCUS_CONFIG_KEY);
  return createDefaultFocusConfig(result[FOCUS_CONFIG_KEY] || {});
}

async function setFocusConfig(focusConfig) {
  await storageSet("local", {
    [FOCUS_CONFIG_KEY]: createDefaultFocusConfig(focusConfig),
  });
}

async function getPresenceConfig() {
  const result = await storageGet("local", PRESENCE_CONFIG_KEY);
  return createDefaultPresenceConfig(result[PRESENCE_CONFIG_KEY] || {});
}

async function setPresenceConfig(presenceConfig) {
  await storageSet("local", { [PRESENCE_CONFIG_KEY]: createDefaultPresenceConfig(presenceConfig) });
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

async function persistSegments(session, segments) {
  if (!segments.length) {
    return;
  }

  await withQueuedWrite(async () => {
    const stats = await readStats();

    for (const segment of segments) {
      const dailyBucket = stats.daily[segment.dateKey] || {};
      dailyBucket[session.hostname] = mergeEntry(
        dailyBucket[session.hostname],
        segment.seconds,
        session
      );
      stats.daily[segment.dateKey] = dailyBucket;

      const weeklyBucket = stats.weekly[segment.weekKey] || {};
      weeklyBucket[session.hostname] = mergeEntry(
        weeklyBucket[session.hostname],
        segment.seconds,
        session
      );
      stats.weekly[segment.weekKey] = weeklyBucket;
    }

    await writeStats(stats);
  });
}

async function flushSession(endTime) {
  const session = await getSession();
  if (!session?.isRunning) {
    return session;
  }

  if (endTime <= session.startedAt) {
    return session;
  }

  const segments = splitRangeByDateAndWeek(session.startedAt, endTime);
  await persistSegments(session, segments);

  return {
    ...session,
    startedAt: endTime,
  };
}

async function pauseSession(endTime) {
  const updatedSession = await flushSession(endTime);
  if (!updatedSession) {
    return;
  }

  await setSession({
    ...updatedSession,
    isRunning: false,
  });
}

async function startSessionForTab(tab, startedAt) {
  const session = createSessionFromTab(tab, startedAt, true);
  await setSession(session);
}

async function resumeOrReplaceSession(tab, startedAt) {
  const currentSession = await getSession();
  const nextSession = createSessionFromTab(tab, startedAt, true);

  if (!nextSession) {
    await setSession(null);
    return;
  }

  if (
    currentSession &&
    currentSession.tabId === nextSession.tabId &&
    currentSession.url === nextSession.url
  ) {
    await setSession({
      ...currentSession,
      title: nextSession.title,
      faviconUrl: nextSession.faviconUrl,
      isRunning: true,
      startedAt: currentSession.isRunning ? currentSession.startedAt : startedAt,
    });
    return;
  }

  if (currentSession?.isRunning) {
    await flushAndReplace(nextSession, startedAt);
    return;
  }

  await setSession(nextSession);
}

async function flushAndReplace(nextSession, endTime) {
  await flushSession(endTime);
  await setSession(nextSession);
}

async function getActiveTabInWindow(windowId) {
  const tabs = await tabsQuery({ active: true, windowId });
  return tabs[0] || null;
}

async function rebuildSessionFromFocusedWindow(startedAt = Date.now()) {
  try {
    const tabs = await tabsQuery({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab) {
      await setSession(null);
      return;
    }

    await resumeOrReplaceSession(tab, startedAt);
  } catch (error) {
    console.warn("Failed to rebuild session", error);
  }
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

function addRunningSessionTimeToTotals(totals, session, categoryConfig, now) {
  if (!session?.isRunning || !session.startedAt || now <= session.startedAt) {
    return totals;
  }

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const effectiveStart = Math.max(session.startedAt, startOfToday.getTime());
  if (now <= effectiveStart) {
    return totals;
  }

  const categoryId = getSessionCategoryId(session, categoryConfig);
  const nextTotals = { ...totals };
  nextTotals[categoryId] = (nextTotals[categoryId] || 0) + Math.round((now - effectiveStart) / 1000);
  return nextTotals;
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

function tabsSendMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError || response === undefined) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

async function getHasActiveMedia(session) {
  if (!session?.tabId) {
    return false;
  }
  const response = await tabsSendMessage(session.tabId, { type: "GET_MEDIA_STATE" });
  return Boolean(response && response.hasActiveMedia);
}

function querySystemIdle(thresholdSeconds) {
  return new Promise((resolve) => {
    chrome.idle.queryState(thresholdSeconds, (state) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(state === "idle" || state === "locked");
    });
  });
}

async function evaluatePresence() {
  const presenceConfig = await getPresenceConfig();
  if (!presenceConfig.enabled) {
    return;
  }

  const session = await getSession();
  if (!session?.isRunning) {
    return;
  }

  let tab;
  try {
    tab = await tabsGet(session.tabId);
  } catch (error) {
    return;
  }
  if (!tab || !tab.url || tab.url !== session.url) {
    return;
  }

  const hasActiveMedia = await getHasActiveMedia(session);
  if (hasActiveMedia) {
    return;
  }

  const isIdle = await querySystemIdle(presenceConfig.idleThresholdMinutes * 60);
  if (!isIdle) {
    return;
  }

  await pauseSession(Date.now());
}

async function ensureBehaviorAlarm() {
  chrome.alarms.create(BEHAVIOR_ALARM_NAME, { periodInMinutes: 1 });
}

async function evaluateBehaviorRules() {
  await ensureInitialized();

  const now = Date.now();
  const [session, stats, categoryConfig, goalConfig, focusConfig, runtime] = await Promise.all([
    getSession(),
    readStats(),
    getCategoryConfig(),
    getGoalConfig(),
    getFocusConfig(),
    getBehaviorRuntime(),
  ]);

  const nextRuntime = createDefaultBehaviorRuntime(runtime);
  const todayKey = toDateKey(new Date(now));
  nextRuntime.goalNotifications = pruneRuntimeMapByDate(nextRuntime.goalNotifications, todayKey);

  if (goalConfig.enabled) {
    const totals = addRunningSessionTimeToTotals(
      aggregateBucketByCategory(stats.daily[todayKey], categoryConfig),
      session,
      categoryConfig,
      now
    );
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

  await setBehaviorRuntime(nextRuntime);

  await evaluatePresence().catch((error) => {
    console.warn("Failed to evaluate presence", error);
  });
}

function migrateLegacyStats(legacyDaily, legacyWeekly, legacyMeta) {
  const stats = createEmptyStats();

  for (const [dateKey, hosts] of Object.entries(legacyDaily || {})) {
    const bucket = {};
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
    const bucket = {};
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

async function migrateLegacyDataIfNeeded() {
  const result = await storageGet("local", [STORAGE_KEY, ...LEGACY_KEYS]);
  if (result[STORAGE_KEY]) {
    if (!result[STORAGE_KEY].version) {
      await writeStats(cloneStats(result[STORAGE_KEY]));
    }
    return;
  }

  const hasLegacyData = LEGACY_KEYS.some((key) => result[key]);
  if (!hasLegacyData) {
    await writeStats(createEmptyStats());
    return;
  }

  const migratedStats = migrateLegacyStats(
    result.dailyStats,
    result.weeklyStats,
    result.tabMeta
  );
  await storageSet("local", { [STORAGE_KEY]: migratedStats });
  await storageRemove("local", LEGACY_KEYS);
}

async function ensureCategoryConfig() {
  const categoryConfig = await getCategoryConfig();
  await setCategoryConfig(categoryConfig);
}

async function ensureGoalConfig() {
  const goalConfig = await getGoalConfig();
  await setGoalConfig(goalConfig);
}

async function ensureFocusConfig() {
  const focusConfig = await getFocusConfig();
  await setFocusConfig(focusConfig);
}

async function ensureBehaviorRuntime() {
  const runtime = await getBehaviorRuntime();
  await setBehaviorRuntime(runtime);
}

async function ensurePresenceConfig() {
  const presenceConfig = await getPresenceConfig();
  await setPresenceConfig(presenceConfig);
}

async function initializeExtensionState() {
  await migrateLegacyDataIfNeeded();
  await ensureCategoryConfig();
  await ensureGoalConfig();
  await ensureFocusConfig();
  await ensureBehaviorRuntime();
  await ensurePresenceConfig();
  await ensureBehaviorAlarm();
  await rebuildSessionFromFocusedWindow();
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

chrome.runtime.onInstalled.addListener(() => {
  ensureInitialized().catch((error) => {
    console.error("Initialization failed on install", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureInitialized().catch((error) => {
    console.error("Initialization failed on startup", error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName !== "local" ||
    (!changes[GOAL_CONFIG_KEY] && !changes[FOCUS_CONFIG_KEY] && !changes[CATEGORY_CONFIG_KEY])
  ) {
    return;
  }

  evaluateBehaviorRules().catch((error) => {
    console.warn("Failed to re-evaluate behavior rules after config change", error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BEHAVIOR_ALARM_NAME) {
    return;
  }

  evaluateBehaviorRules().catch((error) => {
    console.warn("Failed to evaluate behavior rules", error);
  });
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const now = Date.now();

  try {
    await ensureInitialized();
    const tab = await tabsGet(activeInfo.tabId);
    await resumeOrReplaceSession(tab, now);
  } catch (error) {
    console.warn("Failed to handle tab activation", error);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== "complete") {
    return;
  }

  try {
    await ensureInitialized();
    const session = await getSession();
    if (!session || session.tabId !== tabId) {
      return;
    }

    const now = Date.now();
    const candidateTab = {
      ...tab,
      id: tabId,
      url: changeInfo.url || tab.url || session.url,
      title: changeInfo.title || tab.title || session.title,
    };

    if (!isTrackableUrl(candidateTab.url)) {
      await pauseSession(now);
      await setSession(null);
      return;
    }

    if (candidateTab.url !== session.url) {
      const nextSession = createSessionFromTab(candidateTab, now, true);
      await flushAndReplace(nextSession, now);
      return;
    }

    await setSession({
      ...session,
      title: candidateTab.title || "",
      faviconUrl: candidateTab.favIconUrl || session.faviconUrl || "",
    });
  } catch (error) {
    console.warn("Failed to handle tab update", error);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await ensureInitialized();
    const session = await getSession();
    if (!session || session.tabId !== tabId) {
      return;
    }

    await flushSession(Date.now());
    await setSession(null);
  } catch (error) {
    console.warn("Failed to handle tab removal", error);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const now = Date.now();

  try {
    await ensureInitialized();
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      await pauseSession(now);
      return;
    }

    const tab = await getActiveTabInWindow(windowId);
    if (!tab) {
      await setSession(null);
      return;
    }

    await resumeOrReplaceSession(tab, now);
  } catch (error) {
    console.warn("Failed to handle focus change", error);
  }
});

chrome.runtime.onMessage.addListener((request, sender) => {
  if (!sender.tab?.id) {
    return;
  }

  const tabId = sender.tab.id;
  const now = Date.now();

  if (request.type === "PAGE_HIDDEN") {
    pauseVisibleTab(tabId, now).catch((error) => {
      console.warn("Failed to pause hidden page", error);
    });
  }

  if (request.type === "PAGE_VISIBLE") {
    resumeVisibleTab(tabId, now, sender.tab).catch((error) => {
      console.warn("Failed to resume visible page", error);
    });
  }

  if (request.type === "PAGE_ACTIVE") {
    resumeSessionOnInteraction(tabId, now, sender.tab).catch((error) => {
      console.warn("Failed to resume session on page interaction", error);
    });
  }
});

async function pauseVisibleTab(tabId, now) {
  await ensureInitialized();
  const session = await getSession();
  if (!session || session.tabId !== tabId || !session.isRunning) {
    return;
  }

  await pauseSession(now);
}

async function resumeVisibleTab(tabId, now, senderTab) {
  await ensureInitialized();
  const session = await getSession();

  if (!session) {
    const tab = senderTab.url ? senderTab : await tabsGet(tabId);
    await startSessionForTab(tab, now);
    return;
  }

  if (session.tabId !== tabId) {
    return;
  }

  if (session.isRunning) {
    return;
  }

  const tab = senderTab.url ? senderTab : await tabsGet(tabId);
  if (!isTrackableUrl(tab.url || session.url)) {
    await setSession(null);
    return;
  }

  await setSession({
    ...session,
    url: tab.url || session.url,
    hostname: getHostnameFromUrl(tab.url || session.url),
    title: tab.title || session.title,
    faviconUrl: tab.favIconUrl || session.faviconUrl || "",
    startedAt: now,
    isRunning: true,
  });
}

async function resumeSessionOnInteraction(tabId, now, senderTab) {
  await ensureInitialized();
  const session = await getSession();

  // 只处理"当前正是这个 tab、且因空闲被暂停"的 session——避免把
  // 已在计时的会话或其它 tab 的交互误当成恢复信号。
  if (!session || session.tabId !== tabId || session.isRunning) {
    return;
  }

  const tab = senderTab.url ? senderTab : await tabsGet(tabId);
  if (!isTrackableUrl(tab.url || session.url)) {
    return;
  }

  await setSession({
    ...session,
    url: tab.url || session.url,
    hostname: getHostnameFromUrl(tab.url || session.url),
    title: tab.title || session.title,
    faviconUrl: tab.favIconUrl || session.faviconUrl || "",
    startedAt: now,
    isRunning: true,
  });
}

ensureInitialized().catch((error) => {
  console.error("Initialization failed", error);
});
