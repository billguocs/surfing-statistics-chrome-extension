let lastSentState = null;
let initialVisibilityTimer = null;

function sendVisibilityMessage(type) {
  if (lastSentState === type) {
    return;
  }

  lastSentState = type;

  try {
    chrome.runtime.sendMessage({ type });
  } catch (error) {
    console.warn("Extension context invalidated:", error);
  }
}

function syncVisibilityState() {
  if (document.visibilityState === "hidden") {
    sendVisibilityMessage("PAGE_HIDDEN");
    return;
  }

  sendVisibilityMessage("PAGE_VISIBLE");
}

document.addEventListener("visibilitychange", syncVisibilityState);

window.addEventListener("pagehide", () => {
  sendVisibilityMessage("PAGE_HIDDEN");
});

window.addEventListener("pageshow", () => {
  syncVisibilityState();
});

if (document.visibilityState === "visible") {
  initialVisibilityTimer = setTimeout(() => {
    syncVisibilityState();
    initialVisibilityTimer = null;
  }, 300);
}

window.addEventListener("beforeunload", () => {
  if (initialVisibilityTimer) {
    clearTimeout(initialVisibilityTimer);
    initialVisibilityTimer = null;
  }
  sendVisibilityMessage("PAGE_HIDDEN");
});
