let lastSentState = null;

function sendVisibilityMessage(type) {
  if (lastSentState === type) {
    return;
  }

  lastSentState = type;

  try {
    chrome.runtime.sendMessage({ type }).catch(() => {});
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

// Child-frame navigation/visibility must never pause or replace the whole tab.
if (window === window.top) {
  document.addEventListener("visibilitychange", syncVisibilityState);
  window.addEventListener("pagehide", () => sendVisibilityMessage("PAGE_HIDDEN"));
  window.addEventListener("pageshow", syncVisibilityState);
  syncVisibilityState();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type !== "GET_MEDIA_STATE") return;
  const hasActiveMedia = Array.from(document.querySelectorAll("video, audio"))
    .some((media) => !media.paused && !media.ended);
  sendResponse({ hasActiveMedia });
  // tabs.sendMessage returns only one frame's response. Report positives separately
  // so a fast negative response from the top document cannot hide a playing iframe.
  if (request.requestId && hasActiveMedia) {
    try {
      chrome.runtime.sendMessage({ type: "FRAME_MEDIA_STATE", requestId: request.requestId, hasActiveMedia }).catch(() => {});
    } catch (error) {
      console.warn("Extension context invalidated:", error);
    }
  }
});

let lastActiveSentAt = 0;
const ACTIVE_THROTTLE_MS = 15000;

function sendActiveIfVisible(event) {
  if (!event.isTrusted || document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now - lastActiveSentAt < ACTIVE_THROTTLE_MS) return;
  lastActiveSentAt = now;
  try {
    chrome.runtime.sendMessage({ type: "PAGE_ACTIVE" }).catch(() => {});
  } catch (error) {
    console.warn("Extension context invalidated:", error);
  }
}

document.addEventListener("pointerdown", sendActiveIfVisible, true);
document.addEventListener("keydown", sendActiveIfVisible, true);
document.addEventListener("wheel", sendActiveIfVisible, { capture: true, passive: true });
document.addEventListener("touchstart", sendActiveIfVisible, true);
