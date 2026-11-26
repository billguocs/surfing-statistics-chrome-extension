// 点击工具栏图标时，在新标签页打开体检面板。
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("checker.html") });
});
