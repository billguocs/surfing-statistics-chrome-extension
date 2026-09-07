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

// 同页回看恢复：页面持续可见但被"系统空闲"暂停后，用户一旦回到本页
// 交互（点击/滚轮/键盘/触摸），发轻量 PAGE_ACTIVE 让 background 恢复计时。
// 节流 15s：避免连续滚动/击键连发消息。
let lastActiveSentAt = 0;
const ACTIVE_THROTTLE_MS = 15000;

function sendActiveIfVisible() {
  if (document.visibilityState !== "visible") {
    return;
  }
  const now = Date.now();
  if (now - lastActiveSentAt < ACTIVE_THROTTLE_MS) {
    return;
  }
  lastActiveSentAt = now;
  try {
    chrome.runtime.sendMessage({ type: "PAGE_ACTIVE" });
  } catch (error) {
    console.warn("Extension context invalidated:", error);
  }
}

document.addEventListener("pointerdown", sendActiveIfVisible, true);
document.addEventListener("keydown", sendActiveIfVisible, true);
document.addEventListener("wheel", sendActiveIfVisible, { capture: true, passive: true });
document.addEventListener("touchstart", sendActiveIfVisible, true);
