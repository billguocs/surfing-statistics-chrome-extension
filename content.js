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

document.addEventListener("visibilitychange", syncVisibilityState);

window.addEventListener("pagehide", () => {
  sendVisibilityMessage("PAGE_HIDDEN");
});

window.addEventListener("pageshow", () => {
  syncVisibilityState();
});

syncVisibilityState();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type !== "GET_MEDIA_STATE") return;
  const hasActiveMedia = Array.from(document.querySelectorAll("video, audio"))
    .some((media) => !media.paused && !media.ended);
  sendResponse({ hasActiveMedia });
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
