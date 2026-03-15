(function () {
  const LLM_CONFIG_KEY = "llmConfig";
  const LLM_FEATURE_FLAGS_KEY = "llmFeatureFlags";
  const PROVIDERS = {
    openai: "openai",
    anthropic: "anthropic",
    gemini: "gemini",
    custom: "custom",
  };

  function createDefaultLLMConfig(config = {}) {
    const provider = Object.values(PROVIDERS).includes(config.provider) ? config.provider : PROVIDERS.openai;
    return {
      enabled: Boolean(config.enabled),
      provider,
      apiBaseUrl: String(config.apiBaseUrl || "").trim(),
      apiKey: String(config.apiKey || "").trim(),
      model: String(config.model || "").trim(),
      timeoutMs: Math.max(3000, Number(config.timeoutMs) || 15000),
      temperature: Math.max(0, Math.min(1, Number(config.temperature) || 0.2)),
      maxTokens: Math.max(200, Number(config.maxTokens) || 800),
      privacyMode: config.privacyMode === "full_context" ? "full_context" : "hostname_only",
    };
  }

  function createDefaultLLMFeatureFlags(flags = {}) {
    return {
      categorySuggestionEnabled: Boolean(flags.categorySuggestionEnabled),
      smartSummaryEnabled: Boolean(flags.smartSummaryEnabled),
    };
  }

  function getDefaultBaseUrl(provider) {
    if (provider === PROVIDERS.openai) return "https://api.openai.com/v1";
    if (provider === PROVIDERS.anthropic) return "https://api.anthropic.com/v1";
    if (provider === PROVIDERS.gemini) return "https://generativelanguage.googleapis.com/v1beta";
    return "";
  }

  function resolveBaseUrl(config) {
    return config.apiBaseUrl || getDefaultBaseUrl(config.provider);
  }

  function ensureConfig(config) {
    const normalized = createDefaultLLMConfig(config);
    if (!normalized.enabled || !normalized.apiKey || !normalized.model) {
      throw new Error("LLM config is incomplete");
    }
    return normalized;
  }

  function buildSiteContext(config, site) {
    if (config.privacyMode === "full_context") {
      return {
        hostname: site.hostname,
        title: site.title || "",
        url: site.url || "",
      };
    }
    return { hostname: site.hostname };
  }

  function buildCategoryPromptPayload(config, payload) {
    return {
      task: "classify_sites",
      categories: payload.categories.map((category) => ({ id: category.id, name: category.name })),
      sites: payload.sites.map((site) => ({
        id: site.id,
        ...buildSiteContext(config, site),
      })),
      output_schema: {
        suggestions: [
          {
            id: "same as input site id",
            categoryId: "one of provided category ids",
            reason: "short explanation",
            confidence: "number 0..1",
          },
        ],
      },
    };
  }

  function buildSummaryPromptPayload(config, payload) {
    return {
      task: "summarize_browsing_report",
      reportType: payload.reportType,
      viewType: payload.viewType,
      periodLabel: payload.periodLabel,
      sceneName: payload.sceneName,
      categories: payload.categories.map((category) => ({
        id: category.id,
        name: category.name,
        seconds: category.seconds,
        share: category.share,
      })),
      sites: payload.sites.map((site) => ({
        hostname: site.hostname,
        seconds: site.seconds,
        title: config.privacyMode === "full_context" ? site.title || "" : "",
        url: config.privacyMode === "full_context" ? site.url || "" : "",
      })),
      analysis: payload.analysis.map((item) => ({
        categoryName: item.categoryName,
        deltaSeconds: item.deltaSeconds,
      })),
      output_schema: {
        summary: [
          "3-4 concise insights in Chinese, each as a standalone sentence",
        ],
      },
    };
  }

  function buildSystemPrompt() {
    return [
      "You classify websites into one of the provided categories.",
      "Return strict JSON.",
      "Output must contain a top-level key named suggestions.",
      "Each suggestion must include id, categoryId, reason, confidence.",
      "Only use categoryId values from the provided category list.",
      "confidence must be a number between 0 and 1.",
      "If uncertain, choose the most likely category instead of inventing new values.",
    ].join(" ");
  }

  function buildSummarySystemPrompt() {
    return [
      "You summarize a browsing time report for a Chrome extension user.",
      "Return strict JSON.",
      "Output must contain a top-level key named summary.",
      "summary must be an array of 3 to 4 concise Chinese sentences.",
      "Each sentence should describe one useful insight or suggestion.",
      "Do not mention missing data unless it materially affects the conclusion.",
      "Do not include markdown or numbering.",
    ].join(" ");
  }

  async function fetchJson(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function requestOpenAIChat(config, payload) {
    const baseUrl = resolveBaseUrl(config).replace(/\/+$/, "");
    const data = await fetchJson(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: JSON.stringify(buildCategoryPromptPayload(config, payload)) },
          ],
        }),
      },
      config.timeoutMs
    );
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("OpenAI-style response content missing");
    }
    return JSON.parse(content);
  }

  async function requestOpenAISummary(config, payload) {
    const baseUrl = resolveBaseUrl(config).replace(/\/+$/, "");
    const data = await fetchJson(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: buildSummarySystemPrompt() },
            { role: "user", content: JSON.stringify(buildSummaryPromptPayload(config, payload)) },
          ],
        }),
      },
      config.timeoutMs
    );
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("OpenAI-style summary content missing");
    }
    return JSON.parse(content);
  }

  async function requestAnthropicChat(config, payload) {
    const baseUrl = resolveBaseUrl(config).replace(/\/+$/, "");
    const data = await fetchJson(
      `${baseUrl}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          system: buildSystemPrompt(),
          messages: [
            {
              role: "user",
              content: JSON.stringify(buildCategoryPromptPayload(config, payload)),
            },
          ],
        }),
      },
      config.timeoutMs
    );
    const content = data?.content?.find((item) => item.type === "text")?.text;
    if (!content || typeof content !== "string") {
      throw new Error("Anthropic response content missing");
    }
    return JSON.parse(content);
  }

  async function requestAnthropicSummary(config, payload) {
    const baseUrl = resolveBaseUrl(config).replace(/\/+$/, "");
    const data = await fetchJson(
      `${baseUrl}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          system: buildSummarySystemPrompt(),
          messages: [
            {
              role: "user",
              content: JSON.stringify(buildSummaryPromptPayload(config, payload)),
            },
          ],
        }),
      },
      config.timeoutMs
    );
    const content = data?.content?.find((item) => item.type === "text")?.text;
    if (!content || typeof content !== "string") {
      throw new Error("Anthropic summary content missing");
    }
    return JSON.parse(content);
  }

  async function requestGeminiChat(config, payload) {
    const baseUrl = resolveBaseUrl(config).replace(/\/+$/, "");
    const url = `${baseUrl}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    const data = await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            responseMimeType: "application/json",
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `${buildSystemPrompt()}\n${JSON.stringify(buildCategoryPromptPayload(config, payload))}`,
                },
              ],
            },
          ],
        }),
      },
      config.timeoutMs
    );
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content || typeof content !== "string") {
      throw new Error("Gemini response content missing");
    }
    return JSON.parse(content);
  }

  async function requestGeminiSummary(config, payload) {
    const baseUrl = resolveBaseUrl(config).replace(/\/+$/, "");
    const url = `${baseUrl}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    const data = await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            responseMimeType: "application/json",
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `${buildSummarySystemPrompt()}\n${JSON.stringify(buildSummaryPromptPayload(config, payload))}`,
                },
              ],
            },
          ],
        }),
      },
      config.timeoutMs
    );
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content || typeof content !== "string") {
      throw new Error("Gemini summary content missing");
    }
    return JSON.parse(content);
  }

  async function requestStructuredJson(config, payload) {
    if (config.provider === PROVIDERS.anthropic) {
      return await requestAnthropicChat(config, payload);
    }
    if (config.provider === PROVIDERS.gemini) {
      return await requestGeminiChat(config, payload);
    }
    return await requestOpenAIChat(config, payload);
  }

  async function requestStructuredSummary(config, payload) {
    if (config.provider === PROVIDERS.anthropic) {
      return await requestAnthropicSummary(config, payload);
    }
    if (config.provider === PROVIDERS.gemini) {
      return await requestGeminiSummary(config, payload);
    }
    return await requestOpenAISummary(config, payload);
  }

  function normalizeSuggestionList(result, categoriesById) {
    const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];
    return suggestions
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : "",
        categoryId: typeof item.categoryId === "string" ? item.categoryId : "",
        reason: typeof item.reason === "string" ? item.reason : "LLM returned no reason",
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        source: "llm",
      }))
      .filter((item) => item.id && categoriesById.has(item.categoryId));
  }

  async function requestCategorySuggestions(config, payload) {
    const normalized = ensureConfig(config);
    const categoriesById = new Set(payload.categories.map((category) => category.id));
    const result = await requestStructuredJson(normalized, payload);
    return normalizeSuggestionList(result, categoriesById);
  }

  function normalizeSummaryItems(result) {
    return (Array.isArray(result?.summary) ? result.summary : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 4);
  }

  async function requestSmartSummary(config, payload) {
    const normalized = ensureConfig(config);
    const result = await requestStructuredSummary(normalized, payload);
    return normalizeSummaryItems(result);
  }

  window.LLMUtils = {
    LLM_CONFIG_KEY,
    LLM_FEATURE_FLAGS_KEY,
    PROVIDERS,
    createDefaultLLMConfig,
    createDefaultLLMFeatureFlags,
    getDefaultBaseUrl,
    requestCategorySuggestions,
    requestSmartSummary,
  };
})();
