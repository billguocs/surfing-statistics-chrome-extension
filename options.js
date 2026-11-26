const CATEGORY_CONFIG_KEY = "categoryConfig";
const GOAL_CONFIG_KEY = "goalConfig";
const FOCUS_CONFIG_KEY = "focusConfig";
const PRESENCE_CONFIG_KEY = "presenceConfig";
const SCENE_CONFIG_KEY = "sceneConfig";

const {
  LLM_CONFIG_KEY,
  LLM_FEATURE_FLAGS_KEY,
  createDefaultLLMConfig,
  createDefaultLLMFeatureFlags,
  getDefaultBaseUrl,
  requestCategorySuggestions,
} = window.LLMUtils;

const DEFAULT_CATEGORIES = [
  { id: "work", name: "工作", system: true },
  { id: "study", name: "学习", system: true },
  { id: "entertainment", name: "娱乐", system: true },
  { id: "social", name: "社交", system: true },
  { id: "tools", name: "工具", system: true },
  { id: "other", name: "其他", system: true },
];

const SCENE_PRESETS = [
  {
    id: "work",
    name: "工作模式",
    goalConfig: { enabled: true, categoryGoals: { work: 180, tools: 60 } },
    focusConfig: { enabled: true, allowedCategoryIds: ["work", "tools"], distractionReminderEnabled: true, distractionCategoryIds: ["entertainment", "social"], distractionThresholdMinutes: 10 },
  },
  {
    id: "study",
    name: "学习模式",
    goalConfig: { enabled: true, categoryGoals: { study: 120, tools: 30 } },
    focusConfig: { enabled: true, allowedCategoryIds: ["study", "tools"], distractionReminderEnabled: true, distractionCategoryIds: ["entertainment", "social"], distractionThresholdMinutes: 12 },
  },
  {
    id: "relax",
    name: "轻松模式",
    goalConfig: { enabled: false, categoryGoals: {} },
    focusConfig: { enabled: false, allowedCategoryIds: ["entertainment", "social", "other"], distractionReminderEnabled: false, distractionCategoryIds: ["work", "study"], distractionThresholdMinutes: 20 },
  },
];

const LOCAL_SUGGESTION_RULES = [
  { categoryId: "work", keywords: ["jira", "confluence", "slack", "teams", "office", "outlook", "notion", "asana", "trello"] },
  { categoryId: "study", keywords: ["course", "learn", "edx", "coursera", "udemy", "school", "university", "classroom", "docs"] },
  { categoryId: "tools", keywords: ["github", "gitlab", "vercel", "cloudflare", "figma", "openai", "chatgpt", "api", "console"] },
  { categoryId: "entertainment", keywords: ["youtube", "netflix", "bilibili", "spotify", "steam", "movie", "music", "game"] },
  { categoryId: "social", keywords: ["x.com", "twitter", "facebook", "instagram", "reddit", "discord", "wechat", "weibo"] },
];

document.addEventListener("DOMContentLoaded", async () => {
  const $ = (id) => document.getElementById(id);
  const elements = {
    siteSearchInput: $("siteSearchInput"),
    siteList: $("siteList"),
    siteDetails: $("siteDetails"),
    siteDetailsEmpty: $("siteDetailsEmpty"),
    selectedHostname: $("selectedHostname"),
    selectedTitle: $("selectedTitle"),
    selectedUrl: $("selectedUrl"),
    siteCategorySelect: $("siteCategorySelect"),
    saveSiteCategoryBtn: $("saveSiteCategoryBtn"),
    siteStatusText: $("siteStatusText"),
    newCategoryInput: $("newCategoryInput"),
    addCategoryBtn: $("addCategoryBtn"),
    categoryList: $("categoryList"),
    categoryStatusText: $("categoryStatusText"),
    goalEnabledInput: $("goalEnabledInput"),
    goalSettingsList: $("goalSettingsList"),
    distractionEnabledInput: $("distractionEnabledInput"),
    distractionThresholdInput: $("distractionThresholdInput"),
    presenceEnabledInput: $("presenceEnabledInput"),
    presenceThresholdSelect: $("presenceThresholdSelect"),
    distractionCategories: $("distractionCategories"),
    focusAllowedCategories: $("focusAllowedCategories"),
    saveBehaviorBtn: $("saveBehaviorBtn"),
    behaviorStatusText: $("behaviorStatusText"),
    sceneWorkBtn: $("sceneWorkBtn"),
    sceneStudyBtn: $("sceneStudyBtn"),
    sceneRelaxBtn: $("sceneRelaxBtn"),
    sceneStatusText: $("sceneStatusText"),
    llmEnabledInput: $("llmEnabledInput"),
    llmProviderSelect: $("llmProviderSelect"),
    llmApiBaseUrlInput: $("llmApiBaseUrlInput"),
    llmApiKeyInput: $("llmApiKeyInput"),
    llmModelInput: $("llmModelInput"),
    llmTimeoutInput: $("llmTimeoutInput"),
    llmPrivacyModeSelect: $("llmPrivacyModeSelect"),
    llmCategorySuggestionEnabledInput: $("llmCategorySuggestionEnabledInput"),
    llmSmartSummaryEnabledInput: $("llmSmartSummaryEnabledInput"),
    saveLlmConfigBtn: $("saveLlmConfigBtn"),
    llmStatusText: $("llmStatusText"),
    applyAllSuggestionsBtn: $("applyAllSuggestionsBtn"),
    suggestionStatusText: $("suggestionStatusText"),
    suggestionList: $("suggestionList"),
  };

  const state = {
    searchText: "",
    selectedHostname: "",
    sites: [],
    categoryConfig: null,
    goalConfig: null,
    focusConfig: null,
    presenceConfig: null,
    sceneConfig: null,
    llmConfig: null,
    llmFeatureFlags: null,
    suggestionRunId: 0,
    suggestions: [],
  };

  const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const storageSet = (payload) => new Promise((resolve, reject) => {
    chrome.storage.local.set(payload, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });

  const createDefaultSceneConfig = (config = {}) => ({ activeSceneId: SCENE_PRESETS.some((scene) => scene.id === config.activeSceneId) ? config.activeSceneId : "work" });

  function createDefaultCategoryConfig(config = {}) {
    const existing = Array.isArray(config.categories) ? config.categories : [];
    const map = new Map(existing.map((item) => [item.id, item]));
    for (const category of DEFAULT_CATEGORIES) {
      map.set(category.id, { ...map.get(category.id), ...category, system: true });
    }
    const categories = Array.from(map.values());
    const validIds = new Set(categories.map((category) => category.id));
    const siteCategoryMap = Object.create(null);
    for (const [hostname, categoryId] of Object.entries(config.siteCategoryMap || {})) {
      siteCategoryMap[hostname] = validIds.has(categoryId) ? categoryId : "other";
    }
    return { categories, siteCategoryMap };
  }

  function createDefaultGoalConfig(config = {}) {
    const categoryGoals = {};
    for (const [categoryId, minutes] of Object.entries(config.categoryGoals || {})) {
      const normalized = Math.max(0, Number(minutes) || 0);
      if (normalized > 0) categoryGoals[categoryId] = normalized;
    }
    return { enabled: Boolean(config.enabled), categoryGoals };
  }

  function createDefaultFocusConfig(config = {}) {
    return {
      enabled: Boolean(config.enabled),
      allowedCategoryIds: Array.isArray(config.allowedCategoryIds) ? Array.from(new Set(config.allowedCategoryIds)) : ["work", "study", "tools"],
      distractionReminderEnabled: Boolean(config.distractionReminderEnabled),
      distractionCategoryIds: Array.isArray(config.distractionCategoryIds) ? Array.from(new Set(config.distractionCategoryIds)) : ["entertainment", "social"],
      distractionThresholdMinutes: Math.max(1, Number(config.distractionThresholdMinutes) || 15),
    };
  }

  function createDefaultPresenceConfig(config = {}) {
    const minutes = Number(config.idleThresholdMinutes);
    return {
      enabled: config.enabled === undefined ? true : Boolean(config.enabled),
      idleThresholdMinutes: [1, 3, 5].includes(minutes) ? minutes : 3,
    };
  }

  function slugifyCategoryName(name) {
    return name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function buildUniqueCategoryId(name, categories) {
    const base = slugifyCategoryName(name) || "custom-category";
    const usedIds = new Set(categories.map((category) => category.id));
    let candidate = base;
    let suffix = 1;
    while (usedIds.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    return candidate;
  }

  function getCategoryById(categoryId) {
    return state.categoryConfig.categories.find((item) => item.id === categoryId) || DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1];
  }

  function getCategoryName(categoryId) {
    return getCategoryById(categoryId).name;
  }

  function extractSitesFromStats(stats) {
    const siteMap = new Map();
    const mergeBucket = (bucket) => {
      for (const [hostname, entry] of Object.entries(bucket || {})) {
        const existing = siteMap.get(hostname) || { hostname, lastTitle: "", lastUrl: "", faviconUrl: "" };
        siteMap.set(hostname, {
          hostname,
          lastTitle: entry?.lastTitle || existing.lastTitle,
          lastUrl: entry?.lastUrl || existing.lastUrl,
          faviconUrl: entry?.faviconUrl || existing.faviconUrl,
        });
      }
    };
    Object.values(stats.weekly || {}).forEach(mergeBucket);
    Object.values(stats.daily || {}).forEach(mergeBucket);
    return Array.from(siteMap.values()).sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  function filterSites(sites) {
    const keyword = state.searchText.trim().toLowerCase();
    if (!keyword) return sites;
    return sites.filter((site) =>
      site.hostname.toLowerCase().includes(keyword) ||
      site.lastTitle.toLowerCase().includes(keyword) ||
      site.lastUrl.toLowerCase().includes(keyword)
    );
  }

  function createFallbackFavicon() {
    const node = document.createElement("span");
    node.className = "favicon favicon-fallback";
    node.textContent = "●";
    return node;
  }

  function createFavicon(site) {
    if (!site.faviconUrl) return createFallbackFavicon();
    const image = document.createElement("img");
    image.className = "favicon";
    image.src = site.faviconUrl;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.replaceWith(createFallbackFavicon()));
    return image;
  }

  function buildLocalSuggestion(site) {
    const currentCategoryId = state.categoryConfig.siteCategoryMap[site.hostname] || "other";
    const haystack = `${site.hostname} ${site.lastTitle} ${site.lastUrl}`.toLowerCase();
    for (const rule of LOCAL_SUGGESTION_RULES) {
      const keyword = rule.keywords.find((item) => haystack.includes(item));
      if (keyword && currentCategoryId !== rule.categoryId) {
        return {
          hostname: site.hostname,
          suggestedCategoryId: rule.categoryId,
          suggestedCategoryName: getCategoryName(rule.categoryId),
          reason: `命中本地规则关键词：${keyword}`,
          source: "local",
          confidence: 0.82,
        };
      }
    }
    return null;
  }

  function formatLLMError(error) {
    const message = String(error?.message || "");
    if (message.includes("401") || message.includes("403")) return "鉴权失败，请检查 API Key 是否正确。";
    if (message.includes("400")) return "请求参数无效，请检查模型名、地址和 Provider 配置。";
    if (message.includes("404")) return "请求地址不存在，请检查 API Base URL 是否匹配当前 Provider。";
    if (message.includes("429")) return "请求过于频繁或额度不足，请稍后重试。";
    if (message.includes("timeout") || message.includes("abort")) return "请求超时，请检查网络、超时时间或模型响应速度。";
    if (message.includes("JSON")) return "模型返回格式异常，无法解析为结构化结果。";
    return "LLM 请求失败，已自动回退到本地规则。";
  }

  function validateLLMSettings(config) {
    if (!config.enabled) return "";
    if (!config.apiKey) return "已启用 LLM，但尚未填写 API Key。";
    if (!config.model) return "已启用 LLM，但尚未填写模型名称。";
    return "";
  }

  function renderCategorySelect() {
    elements.siteCategorySelect.replaceChildren(...state.categoryConfig.categories.map((category) => new Option(category.name, category.id)));
  }

  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function renderSiteList() {
    const sites = filterSites(state.sites);
    elements.siteList.innerHTML = "";
    if (!sites.length) {
      elements.siteList.innerHTML = `<div class="empty-state">当前没有可分类的站点记录。</div>`;
      return;
    }
    for (const site of sites) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `site-item${state.selectedHostname === site.hostname ? " active" : ""}`;
      const meta = document.createElement("div");
      meta.className = "site-meta";
      const category = getCategoryName(state.categoryConfig.siteCategoryMap[site.hostname] || "other");
      meta.append(
        textElement("div", "site-name", site.hostname),
        textElement("div", "site-subtitle", `${category} · ${site.lastTitle || "暂无标题"}`),
      );
      item.appendChild(createFavicon(site));
      item.appendChild(meta);
      item.addEventListener("click", () => {
        state.selectedHostname = site.hostname;
        elements.siteStatusText.textContent = "";
        renderSiteList();
        renderSiteDetails();
      });
      elements.siteList.appendChild(item);
    }
  }

  function renderSiteDetails() {
    if (!state.selectedHostname) {
      elements.siteDetails.style.display = "none";
      elements.siteDetailsEmpty.style.display = "block";
      return;
    }
    const site = extractSitesFromStats(state.stats).find((item) => item.hostname === state.selectedHostname);
    if (!site) {
      state.selectedHostname = "";
      elements.siteDetails.style.display = "none";
      elements.siteDetailsEmpty.style.display = "block";
      return;
    }
    elements.siteDetails.style.display = "grid";
    elements.siteDetailsEmpty.style.display = "none";
    elements.selectedHostname.textContent = site.hostname;
    elements.selectedTitle.textContent = site.lastTitle || "暂无标题";
    elements.selectedUrl.textContent = site.lastUrl || "暂无 URL";
    elements.siteCategorySelect.value = state.categoryConfig.siteCategoryMap[site.hostname] || "other";
  }

  function renderCategoryList() {
    elements.categoryList.innerHTML = "";
    for (const category of state.categoryConfig.categories) {
      const item = document.createElement("div");
      item.className = "category-item";
      const meta = document.createElement("div");
      meta.className = "site-meta";
      meta.append(
        textElement("div", "category-name", category.name),
        textElement("div", "category-meta", category.system ? "系统分类" : "自定义分类"),
      );
      item.appendChild(meta);
      if (category.system) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "固定";
        item.appendChild(tag);
      } else {
        const actions = document.createElement("div");
        actions.className = "category-actions";
        const renameButton = document.createElement("button");
        renameButton.type = "button";
        renameButton.className = "secondary";
        renameButton.textContent = "重命名";
        renameButton.addEventListener("click", async () => {
          const nextName = window.prompt("输入新的分类名称：", category.name);
          if (!nextName || !nextName.trim()) return;
          state.categoryConfig.categories = state.categoryConfig.categories.map((item) => item.id === category.id ? { ...item, name: nextName.trim(), system: false } : item);
          await persistCategoryConfig("分类名称已更新。");
        });
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "danger";
        deleteButton.textContent = "删除";
        deleteButton.addEventListener("click", async () => {
          if (!window.confirm(`确认删除分类“${category.name}”吗？相关站点将回退到“其他”。`)) return;
          state.categoryConfig.categories = state.categoryConfig.categories.filter((item) => item.id !== category.id);
          for (const [hostname, categoryId] of Object.entries(state.categoryConfig.siteCategoryMap)) {
            if (categoryId === category.id) state.categoryConfig.siteCategoryMap[hostname] = "other";
          }
          await persistCategoryConfig("分类已删除，相关站点已回退到“其他”。");
        });
        actions.appendChild(renameButton);
        actions.appendChild(deleteButton);
        item.appendChild(actions);
      }
      elements.categoryList.appendChild(item);
    }
  }

  function renderBehaviorSettings() {
    elements.goalEnabledInput.checked = state.goalConfig.enabled;
    elements.distractionEnabledInput.checked = state.focusConfig.distractionReminderEnabled;
    elements.distractionThresholdInput.value = String(state.focusConfig.distractionThresholdMinutes);
    elements.presenceEnabledInput.checked = state.presenceConfig.enabled;
    elements.presenceThresholdSelect.value = String(state.presenceConfig.idleThresholdMinutes);
    const categories = state.categoryConfig.categories;
    elements.goalSettingsList.replaceChildren(...categories.map((category) => {
      const row = document.createElement("div");
      row.className = "setting-row";
      const meta = document.createElement("div");
      meta.className = "setting-meta";
      meta.append(
        textElement("div", "category-name", category.name),
        textElement("div", "hint", "设置该分类的每日目标分钟数。"),
      );
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "5";
      input.value = state.goalConfig.categoryGoals[category.id] || "";
      input.dataset.goalCategory = category.id;
      input.placeholder = "分钟";
      row.append(meta, input);
      return row;
    }));
    const checkboxRows = (key, checkedIds) => categories.map((category) => {
      const label = document.createElement("label");
      label.className = "checkbox-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset[key] = category.id;
      input.checked = checkedIds.includes(category.id);
      label.append(input, document.createTextNode(category.name));
      return label;
    });
    elements.distractionCategories.replaceChildren(...checkboxRows("distractionCategory", state.focusConfig.distractionCategoryIds));
    elements.focusAllowedCategories.replaceChildren(...checkboxRows("focusCategory", state.focusConfig.allowedCategoryIds));
  }

  function renderSceneButtons() {
    const map = { work: elements.sceneWorkBtn, study: elements.sceneStudyBtn, relax: elements.sceneRelaxBtn };
    for (const [sceneId, button] of Object.entries(map)) {
      button.classList.toggle("active", state.sceneConfig.activeSceneId === sceneId);
    }
  }

  function renderLLMSettings() {
    elements.llmEnabledInput.checked = state.llmConfig.enabled;
    elements.llmProviderSelect.value = state.llmConfig.provider;
    elements.llmApiBaseUrlInput.value = state.llmConfig.apiBaseUrl;
    elements.llmApiBaseUrlInput.placeholder = getDefaultBaseUrl(state.llmConfig.provider) || "https://api.example.com/v1";
    elements.llmApiKeyInput.value = state.llmConfig.apiKey;
    elements.llmModelInput.value = state.llmConfig.model;
    elements.llmTimeoutInput.value = String(state.llmConfig.timeoutMs);
    elements.llmPrivacyModeSelect.value = state.llmConfig.privacyMode;
    elements.llmCategorySuggestionEnabledInput.checked = state.llmFeatureFlags.categorySuggestionEnabled;
    elements.llmSmartSummaryEnabledInput.checked = state.llmFeatureFlags.smartSummaryEnabled;
  }

  async function buildSuggestionBatch(sites) {
    const localSuggestions = [];
    const llmCandidates = [];

    for (const site of sites) {
      const localSuggestion = buildLocalSuggestion(site);
      if (localSuggestion) {
        localSuggestions.push({ site, suggestion: localSuggestion });
        continue;
      }
      llmCandidates.push(site);
    }

    if (!state.llmConfig.enabled || !state.llmFeatureFlags.categorySuggestionEnabled || !llmCandidates.length) {
      return { suggestions: localSuggestions };
    }

    const validationError = validateLLMSettings(state.llmConfig);
    if (validationError) return { suggestions: localSuggestions, status: validationError };

    try {
      const llmResults = await requestCategorySuggestions(state.llmConfig, {
        categories: state.categoryConfig.categories,
        sites: llmCandidates.map((site) => ({
          id: site.hostname,
          hostname: site.hostname,
          title: site.lastTitle,
          url: site.lastUrl,
        })),
      });

      const llmMap = new Map(llmResults.map((item) => [item.id, item]));
      for (const site of llmCandidates) {
        const result = llmMap.get(site.hostname);
        if (!result) continue;
        const currentCategoryId = state.categoryConfig.siteCategoryMap[site.hostname] || "other";
        if (currentCategoryId === result.categoryId) continue;
        localSuggestions.push({
          site,
          suggestion: {
            hostname: site.hostname,
            suggestedCategoryId: result.categoryId,
            suggestedCategoryName: getCategoryName(result.categoryId),
            reason: result.reason || "LLM 未提供原因",
            source: "llm",
            confidence: result.confidence || 0,
          },
        });
      }
    } catch (error) {
      console.warn("LLM batch suggestion failed", error);
      return { suggestions: localSuggestions, status: formatLLMError(error) };
    }

    return { suggestions: localSuggestions };
  }

  async function renderSuggestions() {
    const runId = ++state.suggestionRunId;
    const sites = filterSites(state.sites);
    state.suggestions = [];
    elements.applyAllSuggestionsBtn.disabled = true;
    elements.suggestionStatusText.textContent = "";
    elements.suggestionList.innerHTML = `<div class="empty-state">正在生成分类建议...</div>`;
    const { suggestions, status } = await buildSuggestionBatch(sites.slice(0, 12));
    if (runId !== state.suggestionRunId) return;
    state.suggestions = suggestions;
    elements.applyAllSuggestionsBtn.disabled = !suggestions.length;
    elements.suggestionStatusText.textContent = status || "";
    elements.suggestionList.innerHTML = "";
    if (!suggestions.length) {
      elements.suggestionList.innerHTML = `<div class="empty-state">当前没有可应用的自动分类建议。</div>`;
      if (!status && state.llmConfig.enabled && state.llmFeatureFlags.categorySuggestionEnabled) {
        elements.suggestionStatusText.textContent = "没有生成新的建议，可能是本地规则已覆盖或当前分类已匹配。";
      }
      return;
    }
    for (const { site, suggestion } of suggestions) {
      const item = document.createElement("div");
      item.className = "suggestion-item";
      const copy = document.createElement("div");
      copy.className = "suggestion-copy";
      copy.append(
        textElement("div", "site-name", site.hostname),
        textElement("p", "", `建议分类：${suggestion.suggestedCategoryName} · 来源：${suggestion.source === "llm" ? "LLM" : "本地规则"}`),
        textElement("p", "", suggestion.reason),
        textElement("p", "", `置信度：${Math.round((suggestion.confidence || 0) * 100)}%`),
      );
      const applyButton = document.createElement("button");
      applyButton.type = "button";
      applyButton.className = "success";
      applyButton.textContent = "应用";
      applyButton.addEventListener("click", async () => {
        state.categoryConfig.siteCategoryMap[site.hostname] = suggestion.suggestedCategoryId;
        await persistCategoryConfig("已应用分类建议。");
        elements.suggestionStatusText.textContent = `已将 ${site.hostname} 归类到 ${suggestion.suggestedCategoryName}。`;
      });
      item.appendChild(copy);
      item.appendChild(applyButton);
      elements.suggestionList.appendChild(item);
    }
  }

  async function persistCategoryConfig(message) {
    state.categoryConfig = createDefaultCategoryConfig(state.categoryConfig);
    await storageSet({ [CATEGORY_CONFIG_KEY]: state.categoryConfig });
    elements.categoryStatusText.textContent = message || "";
    renderCategorySelect();
    renderCategoryList();
    renderBehaviorSettings();
    renderSiteList();
    renderSiteDetails();
    await renderSuggestions();
  }

  async function saveSelectedSiteCategory() {
    if (!state.selectedHostname) return;
    state.categoryConfig.siteCategoryMap[state.selectedHostname] = elements.siteCategorySelect.value || "other";
    await persistCategoryConfig("");
    elements.siteStatusText.textContent = "站点分类已保存。";
  }

  async function addCustomCategory() {
    const name = elements.newCategoryInput.value.trim();
    if (!name) {
      elements.categoryStatusText.textContent = "请输入分类名称。";
      return;
    }
    if (state.categoryConfig.categories.some((category) => category.name === name)) {
      elements.categoryStatusText.textContent = "已存在同名分类。";
      return;
    }
    state.categoryConfig.categories.push({ id: buildUniqueCategoryId(name, state.categoryConfig.categories), name, system: false });
    elements.newCategoryInput.value = "";
    await persistCategoryConfig("新分类已创建。");
  }

  async function saveBehaviorSettings() {
    const categoryGoals = {};
    document.querySelectorAll("[data-goal-category]").forEach((input) => {
      const minutes = Math.max(0, Number(input.value) || 0);
      if (minutes > 0) categoryGoals[input.dataset.goalCategory] = minutes;
    });
    const distractionCategoryIds = Array.from(document.querySelectorAll("[data-distraction-category]:checked")).map((input) => input.dataset.distractionCategory);
    const allowedCategoryIds = Array.from(document.querySelectorAll("[data-focus-category]:checked")).map((input) => input.dataset.focusCategory);
    state.goalConfig = createDefaultGoalConfig({ enabled: elements.goalEnabledInput.checked, categoryGoals });
    state.focusConfig = createDefaultFocusConfig({
      ...state.focusConfig,
      distractionReminderEnabled: elements.distractionEnabledInput.checked,
      distractionThresholdMinutes: Number(elements.distractionThresholdInput.value) || 15,
      distractionCategoryIds,
      allowedCategoryIds,
    });
    state.presenceConfig = createDefaultPresenceConfig({
      enabled: elements.presenceEnabledInput.checked,
      idleThresholdMinutes: elements.presenceThresholdSelect.value,
    });
    await storageSet({
      [GOAL_CONFIG_KEY]: state.goalConfig,
      [FOCUS_CONFIG_KEY]: state.focusConfig,
      [PRESENCE_CONFIG_KEY]: state.presenceConfig,
    });
    elements.behaviorStatusText.textContent = "行为规则已保存。";
    renderBehaviorSettings();
  }

  async function applyScene(sceneId) {
    const preset = SCENE_PRESETS.find((scene) => scene.id === sceneId);
    if (!preset) return;
    state.sceneConfig = createDefaultSceneConfig({ activeSceneId: sceneId });
    state.goalConfig = createDefaultGoalConfig(preset.goalConfig);
    state.focusConfig = createDefaultFocusConfig(preset.focusConfig);
    await storageSet({
      [SCENE_CONFIG_KEY]: state.sceneConfig,
      [GOAL_CONFIG_KEY]: state.goalConfig,
      [FOCUS_CONFIG_KEY]: state.focusConfig,
    });
    elements.sceneStatusText.textContent = `已切换到${preset.name}。`;
    renderSceneButtons();
    renderBehaviorSettings();
  }

  async function saveLLMSettings() {
    state.llmConfig = createDefaultLLMConfig({
      enabled: elements.llmEnabledInput.checked,
      provider: elements.llmProviderSelect.value,
      apiBaseUrl: elements.llmApiBaseUrlInput.value,
      apiKey: elements.llmApiKeyInput.value,
      model: elements.llmModelInput.value,
      timeoutMs: Number(elements.llmTimeoutInput.value) || 15000,
      privacyMode: elements.llmPrivacyModeSelect.value,
    });
    state.llmFeatureFlags = createDefaultLLMFeatureFlags({
      categorySuggestionEnabled: elements.llmCategorySuggestionEnabledInput.checked,
      smartSummaryEnabled: elements.llmSmartSummaryEnabledInput.checked,
    });
    await storageSet({
      [LLM_CONFIG_KEY]: state.llmConfig,
      [LLM_FEATURE_FLAGS_KEY]: state.llmFeatureFlags,
    });
    const validationError = validateLLMSettings(state.llmConfig);
    elements.llmStatusText.textContent = validationError || "LLM 配置已保存。";
    await renderSuggestions();
  }

  async function applyAllSuggestions() {
    const suggestions = state.suggestions;
    if (!suggestions.length) return;
    elements.applyAllSuggestionsBtn.disabled = true;
    for (const { site, suggestion } of suggestions) {
      state.categoryConfig.siteCategoryMap[site.hostname] = suggestion.suggestedCategoryId;
    }
    await persistCategoryConfig("已批量应用分类建议。");
    elements.suggestionStatusText.textContent = `已应用 ${suggestions.length} 条分类建议。`;
  }

  async function initialize() {
    const [result, { stats }] = await Promise.all([
      storageGet([CATEGORY_CONFIG_KEY, GOAL_CONFIG_KEY, FOCUS_CONFIG_KEY, SCENE_CONFIG_KEY, LLM_CONFIG_KEY, LLM_FEATURE_FLAGS_KEY, PRESENCE_CONFIG_KEY]),
      StatsStore.request("GET_STATS"),
    ]);
    state.sites = extractSitesFromStats(stats);
    state.categoryConfig = createDefaultCategoryConfig(result[CATEGORY_CONFIG_KEY] || {});
    state.goalConfig = createDefaultGoalConfig(result[GOAL_CONFIG_KEY] || {});
    state.focusConfig = createDefaultFocusConfig(result[FOCUS_CONFIG_KEY] || {});
    state.presenceConfig = createDefaultPresenceConfig(result[PRESENCE_CONFIG_KEY] || {});
    state.sceneConfig = createDefaultSceneConfig(result[SCENE_CONFIG_KEY] || {});
    state.llmConfig = createDefaultLLMConfig(result[LLM_CONFIG_KEY] || {});
    state.llmFeatureFlags = createDefaultLLMFeatureFlags(result[LLM_FEATURE_FLAGS_KEY] || {});
    renderCategorySelect();
    renderCategoryList();
    renderBehaviorSettings();
    renderSceneButtons();
    renderLLMSettings();
    renderSiteList();
    renderSiteDetails();
    await renderSuggestions();
  }

  elements.siteSearchInput.addEventListener("input", async (event) => {
    state.searchText = event.target.value || "";
    renderSiteList();
    await renderSuggestions();
  });
  elements.saveSiteCategoryBtn.addEventListener("click", async () => { await saveSelectedSiteCategory(); });
  elements.addCategoryBtn.addEventListener("click", async () => { await addCustomCategory(); });
  elements.saveBehaviorBtn.addEventListener("click", async () => { await saveBehaviorSettings(); });
  elements.sceneWorkBtn.addEventListener("click", async () => { await applyScene("work"); });
  elements.sceneStudyBtn.addEventListener("click", async () => { await applyScene("study"); });
  elements.sceneRelaxBtn.addEventListener("click", async () => { await applyScene("relax"); });
  elements.llmProviderSelect.addEventListener("change", () => {
    elements.llmApiBaseUrlInput.placeholder = getDefaultBaseUrl(elements.llmProviderSelect.value) || "https://api.example.com/v1";
  });
  elements.saveLlmConfigBtn.addEventListener("click", async () => { await saveLLMSettings(); });
  elements.applyAllSuggestionsBtn.addEventListener("click", async () => { await applyAllSuggestions(); });

  await initialize();
});
