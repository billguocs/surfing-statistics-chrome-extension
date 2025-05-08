// content.js
console.log('Content script loaded for:', window.location.href);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    console.log('Page became hidden:', window.location.href);
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_HIDDEN' });
    } catch (e) {
      console.warn('Extension context invalidated:', e);
    }
  } else if (document.visibilityState === 'visible') {
    console.log('Page became visible:', window.location.href);
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_VISIBLE' });
    } catch (e) {
      console.warn('Extension context invalidated:', e);
    }
  }
});

// Inform background script when the page is initially loaded and visible
// This helps if the content script loads after the tab is already active
if (document.visibilityState === 'visible') {
    // Adding a small delay to ensure background script is ready for messages, especially on extension load/reload
    setTimeout(() => {
        console.log('Page initially visible:', window.location.href);
        try {
          chrome.runtime.sendMessage({ type: 'PAGE_VISIBLE' });
        } catch (e) {
          console.warn('Extension context invalidated:', e);
        }
    }, 500);
}