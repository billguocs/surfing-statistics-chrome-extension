let lastSentState = null;
let initialVisibilityTimer = null;
let hasActiveMedia = false;

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

function syncMediaState() {
  hasActiveMedia = Array.from(document.querySelectorAll("video, audio")).some(
    (media) => !media.paused && !media.ended
  );
}

function bindMediaTracking() {
  syncMediaState();
  document.addEventListener(
    "play",
    (event) => {
      if (event.target instanceof HTMLMediaElement) syncMediaState();
    },
    true
  );
  document.addEventListener(
    "pause",
    (event) => {
      if (event.target instanceof HTMLMediaElement) syncMediaState();
    },
    true
  );
  document.addEventListener(
    "ended",
    (event) => {
      if (event.target instanceof HTMLMediaElement) syncMediaState();
    },
    true
  );
  window.addEventListener("pageshow", syncMediaState);
}

bindMediaTracking();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === "GET_MEDIA_STATE") {
    sendResponse({ hasActiveMedia });
  }
});
