const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function frame(topFrame) {
  let time = 100000;
  let visible = true;
  let media = [];
  let receive;
  const sent = [];
  const handlers = new Map();
  const window = { addEventListener(name, handler) { handlers.set(name, handler); } };
  window.top = topFrame ? window : {};
  class Clock extends Date { static now() { return time; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), {
    window, Date: Clock, console,
    document: {
      get visibilityState() { return visible ? "visible" : "hidden"; },
      addEventListener(name, handler) { handlers.set(name, handler); },
      querySelectorAll: () => media,
    },
    chrome: { runtime: {
      sendMessage: async (message) => sent.push(message),
      onMessage: { addListener(handler) { receive = handler; } },
    } },
  });
  return {
    sent, handlers,
    advance(ms) { time += ms; },
    visible(value) { visible = value; },
    media(value) { media = value; },
    query(requestId) {
      let response;
      receive({ type: "GET_MEDIA_STATE", requestId }, {}, (value) => response = value);
      return response;
    },
  };
}

test("only the top frame sends whole-page visibility signals", () => {
  const top = frame(true);
  const child = frame(false);
  assert.equal(top.sent[0].type, "PAGE_VISIBLE");
  assert.equal(child.sent.length, 0);
  assert.equal(child.handlers.has("pagehide"), false);
  assert.equal(child.handlers.has("visibilitychange"), false);
  top.visible(false);
  top.handlers.get("visibilitychange")();
  assert.equal(top.sent.at(-1).type, "PAGE_HIDDEN");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].match_about_blank, true);
});

test("playing child frames report positives even when the broadcast response came from another frame", () => {
  const child = frame(false);
  child.media([{ paused: false, ended: false, muted: true }]);
  assert.equal(child.query("probe").hasActiveMedia, true);
  assert.equal(child.sent.at(-1).type, "FRAME_MEDIA_STATE");
  assert.equal(child.sent.at(-1).requestId, "probe");
  child.media([{ paused: true, ended: false }, { paused: false, ended: true }]);
  const count = child.sent.length;
  assert.equal(child.query("stopped").hasActiveMedia, false);
  assert.equal(child.sent.length, count);
});

test("iframe interactions obey visibility, trusted-input, and throttle guards", () => {
  const child = frame(false);
  child.handlers.get("wheel")({ isTrusted: true });
  assert.equal(child.sent.at(-1).type, "PAGE_ACTIVE");
  child.handlers.get("keydown")({ isTrusted: true });
  assert.equal(child.sent.length, 1);
  child.advance(15000);
  child.handlers.get("keydown")({ isTrusted: false });
  assert.equal(child.sent.length, 1);
  child.visible(false);
  child.handlers.get("pointerdown")({ isTrusted: true });
  assert.equal(child.sent.length, 1);
  child.visible(true);
  child.handlers.get("keydown")({ isTrusted: true });
  assert.equal(child.sent.length, 2);
});
