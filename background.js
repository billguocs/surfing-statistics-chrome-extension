// background.js

let activeTabId = null;
let tabStartTime = {}; // Stores the start time for each tab { tabId: timestamp }
let tabUrlMap = {}; // Stores the URL for each tab { tabId: url }
let tabTitleMap = {}; // Stores the title for each tab { tabId: title }

// Function to extract hostname from URL
function getHostnameFromUrl(url) {
  try {
    // Ensure the URL has a scheme, otherwise URL constructor might fail or use current page's scheme
    if (
      url &&
      !url.startsWith("http://") &&
      !url.startsWith("https://") &&
      !url.startsWith("ftp://")
    ) {
      // For URLs like 'localhost:3000' or 'example.com' without a scheme
      // we can't reliably parse them with new URL() directly if they are not absolute.
      // However, for extension internal pages or special schemes, we might want to keep them as is or handle differently.
      // For now, if it doesn't look like a standard web URL, return it as is or a placeholder.
      if (url.includes(":") && !url.startsWith("chrome")) {
        // e.g. localhost:8000
        // try to prepend http, this might not always be correct but works for common dev servers
        return new URL(`http://${url}`).hostname;
      }
      return url; // Return original if not a standard http/https/ftp URL (e.g. chrome://, file://)
    }
    return new URL(url).hostname;
  } catch (e) {
    console.warn("Invalid URL for hostname extraction:", url, e);
    return url; // Return original URL as fallback if parsing fails
  }
}

// Function to get current date in YYYY-MM-DD format
function getCurrentDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Function to get current week number
function getCurrentWeek() {
  const today = new Date();
  const firstDayOfYear = new Date(today.getFullYear(), 0, 1);
  const pastDaysOfYear = (today - firstDayOfYear) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

// Function to update time spent on a tab
async function updateTabTime(tabId, endTime) {
  if (tabStartTime[tabId] && tabUrlMap[tabId]) {
    const startTime = tabStartTime[tabId];
    const duration = Math.round((endTime - startTime) / 1000); // Duration in seconds
    const fullUrl = tabUrlMap[tabId];
    const hostname = getHostnameFromUrl(fullUrl);
    const title = tabTitleMap[tabId] || "";
    // Log time if duration is positive, hostname is valid, and it's not a chrome internal page
    if (
      duration > 0 &&
      hostname &&
      fullUrl &&
      !fullUrl.startsWith("chrome://") &&
      !fullUrl.startsWith("about:")
    ) {
      console.log(
        `Tab ${tabId} (${hostname} from ${fullUrl}) was active for ${duration} seconds. Title: ${title}`
      );
      const today = getCurrentDate();
      const currentWeek = getCurrentWeek();
      chrome.storage.local.get(["dailyStats", "weeklyStats", "tabMeta"], (result) => {
        let dailyStats = result.dailyStats || {};
        let weeklyStats = result.weeklyStats || {};
        let tabMeta = result.tabMeta || {};
        // Update daily stats
        dailyStats[today] = dailyStats[today] || {};
        dailyStats[today][hostname] = (dailyStats[today][hostname] || 0) + duration;
        // Update weekly stats
        const weekKey = `${new Date().getFullYear()}-W${String(currentWeek).padStart(2, "0")}`;
        weeklyStats[weekKey] = weeklyStats[weekKey] || {};
        weeklyStats[weekKey][hostname] = (weeklyStats[weekKey][hostname] || 0) + duration;
        // Store meta info: { [hostname]: { url, title } }
        tabMeta[hostname] = { url: fullUrl, title };
        chrome.storage.local.set({ dailyStats, weeklyStats, tabMeta }, () => {
          console.log(
            "Time logged for",
            hostname,
            "Daily:",
            dailyStats,
            "Weekly:",
            weeklyStats,
            "Meta:",
            tabMeta
          );
        });
      });
    }
  }
}

// Listener for when a tab is activated
if (typeof chrome.tabs !== "undefined" && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    console.log("Tab activated:", activeInfo.tabId);
    const now = Date.now();

    // Update time for the previously active tab
    if (activeTabId !== null && activeTabId !== activeInfo.tabId) {
      await updateTabTime(activeTabId, now);
    }

    activeTabId = activeInfo.tabId;
    chrome.tabs.get(activeTabId, async (tab) => {
      if (chrome.runtime.lastError) {
        console.warn(
          "Error getting tab info in onActivated:",
          chrome.runtime.lastError.message
        );
        return;
      }
      try {
        if (tab && tab.url) {
          tabStartTime[activeTabId] = now;
          tabUrlMap[activeTabId] = tab.url; // Store full URL for context
          tabTitleMap[activeTabId] = tab.title || ""; // Store tab title
          const hostname = getHostnameFromUrl(tab.url);
          if (
            hostname &&
            !tab.url.startsWith("chrome://") &&
            !tab.url.startsWith("about:")
          ) {
            console.log(
              `Timer started for tab ${activeTabId} (${hostname}) at ${new Date(
                now
              ).toLocaleTimeString()}`
            );
          } else {
            console.log(
              `Timer started for tab ${activeTabId} (URL: ${
                tab.url
              }, not logging time) at ${new Date(now).toLocaleTimeString()}`
            );
          }
        }
      } catch (e) {
        console.error("Error in onActivated tab callback:", e);
      }
    });
  });
} else {
  console.error(
    "chrome.tabs.onActivated is not available, cannot add listener."
  );
}

// Listener for when a tab is updated (e.g., URL changes)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId === activeTabId && changeInfo.url) {
    console.log(`Tab ${tabId} URL changed to: ${changeInfo.url}`);
    const now = Date.now();
    await updateTabTime(tabId, now); // Log time for the old URL

    // Start timer for the new URL
    if (
      tab.url &&
      !tab.url.startsWith("chrome://") &&
      !tab.url.startsWith("about:")
    ) {
      tabStartTime[tabId] = now;
      tabUrlMap[tabId] = tab.url; // Store full URL
      const hostname = getHostnameFromUrl(tab.url);
      if (hostname) {
        console.log(
          `Timer restarted for tab ${tabId} (${hostname}) at ${new Date(
            now
          ).toLocaleTimeString()}`
        );
      } else {
        console.log(
          `Timer restarted for tab ${tabId} (URL: ${
            tab.url
          }, not logging time) at ${new Date(now).toLocaleTimeString()}`
        );
      }
    } else if (tab.url) {
      // If it's a chrome internal page, clear start time if it was previously set for a trackable URL
      delete tabStartTime[tabId];
      tabUrlMap[tabId] = tab.url;
      console.log(
        `Tab ${tabId} URL changed to internal page: ${tab.url}. Timer stopped.`
      );
    }
  } else if (changeInfo.url && tabUrlMap[tabId] !== changeInfo.url) {
    // If a background tab URL changes, just update its URL mapping
    tabUrlMap[tabId] = changeInfo.url;
  }
});

// Listener for when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  console.log("Tab removed:", tabId);
  const now = Date.now();
  await updateTabTime(tabId, now);
  delete tabUrlMap[tabId]; // Clean up URL map
  if (tabId === activeTabId) {
    activeTabId = null;
  }
});

// Listener for when a window focus changes
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const now = Date.now();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Browser lost focus
    console.log("Browser lost focus");
    if (activeTabId !== null) {
      await updateTabTime(activeTabId, now);
      // We don't clear activeTabId here, because the tab is still technically active in its window
      // but we mark its start time as null to indicate it's not currently being timed.
      delete tabStartTime[activeTabId];
    }
  } else {
    // Browser gained focus, find the active tab in the newly focused window
    console.log("Browser gained focus");
    chrome.tabs.query({ active: true, windowId: windowId }, async (tabs) => {
      if (chrome.runtime.lastError) {
        console.warn(
          "Error querying tabs in onFocusChanged:",
          chrome.runtime.lastError.message
        );
        return;
      }
      try {
        if (tabs && tabs.length > 0) {
          const currentFocusedTab = tabs[0];
          if (activeTabId !== null && activeTabId !== currentFocusedTab.id) {
            // If there was a previously active tab in another window, log its time.
            await updateTabTime(activeTabId, now);
          }

          activeTabId = currentFocusedTab.id;
          const fullUrl = tabUrlMap[activeTabId] || currentFocusedTab.url;
          tabTitleMap[activeTabId] = currentFocusedTab.title || ""; // Store tab title
          const hostname = getHostnameFromUrl(fullUrl);

          if (
            fullUrl &&
            !fullUrl.startsWith("chrome://") &&
            !fullUrl.startsWith("about:")
          ) {
            if (!tabStartTime[activeTabId]) {
              // Only start/resume if not already timing this tab
              tabStartTime[activeTabId] = now;
              if (!tabUrlMap[activeTabId]) {
                // If it's a newly focused tab not previously in map
                tabUrlMap[activeTabId] = fullUrl;
                console.log(
                  `Timer started for newly focused tab ${activeTabId} (${hostname}) at ${new Date(
                    now
                  ).toLocaleTimeString()}`
                );
              } else {
                console.log(
                  `Timer resumed for tab ${activeTabId} (${hostname}) at ${new Date(
                    now
                  ).toLocaleTimeString()}`
                );
              }
            }
          } else {
            // If it's an internal page, ensure no timer is running for it
            delete tabStartTime[activeTabId];
            if (fullUrl) tabUrlMap[activeTabId] = fullUrl; // Keep track of its URL though
            console.log(
              `Focused tab ${activeTabId} is an internal page (${fullUrl}). Timer not started/resumed.`
            );
          }
        }
      } catch (e) {
        console.error("Error in onFocusChanged tab callback:", e);
      }
    });
  }
});

// Content script will send messages about page visibility
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (!sender.tab) return; // Ignore messages not from a content script

  const tabId = sender.tab.id;
  const now = Date.now();

  if (request.type === "PAGE_HIDDEN") {
    console.log(`Page hidden in tab ${tabId}`);
    if (tabId === activeTabId && tabStartTime[tabId]) {
      await updateTabTime(tabId, now);
      delete tabStartTime[tabId]; // Stop timing, but keep it as activeTabId
    }
  } else if (request.type === "PAGE_VISIBLE") {
    console.log(`Page visible in tab ${tabId}`);
    if (tabId === activeTabId && !tabStartTime[tabId] && tabUrlMap[tabId]) {
      const fullUrl = tabUrlMap[tabId];
      const hostname = getHostnameFromUrl(fullUrl);
      if (
        hostname &&
        fullUrl &&
        !fullUrl.startsWith("chrome://") &&
        !fullUrl.startsWith("about:")
      ) {
        tabStartTime[tabId] = now;
        console.log(
          `Timer resumed for tab ${tabId} (${hostname}) due to visibility change at ${new Date(
            now
          ).toLocaleTimeString()}`
        );
      } else {
        console.log(
          `Page became visible for tab ${tabId} (${fullUrl}), but not resuming timer as it's an internal or invalid URL.`
        );
      }
    }
  }
});

console.log("Background script loaded.");
