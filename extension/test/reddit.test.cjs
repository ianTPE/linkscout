const { test } = require("node:test");
const assert = require("node:assert/strict");
const { redditListing, redditInt, redditRow } = require("../reddit.js");

test("listings on Reddit only", () => {
  assert.equal(redditListing("https://www.reddit.com/r/LocalLLaMA/top/?t=day"), "r/LocalLLaMA/top");
  assert.equal(redditListing("https://old.reddit.com/r/esp32/"), "r/esp32");
  assert.equal(redditListing("https://www.reddit.com/"), "home");
  assert.equal(redditListing("https://evil.example/r/x"), null);
  assert.equal(redditListing("not a url"), null);
});

test("integers", () => {
  assert.equal(redditInt("123"), 123);
  assert.equal(redditInt(" -4 "), -4);
  assert.equal(redditInt("1.2k"), null);
  assert.equal(redditInt(null), null);
});

function el(tag, attrs, title) {
  return {
    tagName: tag, getAttribute: (n) => attrs[n] ?? null,
    querySelector: (s) => (s === "a.title" && title != null ? { textContent: title } : null),
  };
}

const base = "https://www.reddit.com/r/LocalLLaMA/";

test("new Reddit posts", () => {
  assert.deepEqual(redditRow(el("SHREDDIT-POST", {
    id: "t3_1abc", "subreddit-prefixed-name": "r/LocalLLaMA", "post-title": " Qwen 4 is out ",
    permalink: "/r/LocalLLaMA/comments/1abc/qwen_4_is_out/", "content-href": "https://qwen.ai/blog",
    author: "someone", "created-timestamp": "2026-11-11T03:00:00.000000+0000", score: "512", "comment-count": "88",
  }), base), {
    id: "t3_1abc", subreddit: "r/LocalLLaMA", title: "Qwen 4 is out", url: "https://www.reddit.com/r/LocalLLaMA/comments/1abc/qwen_4_is_out/",
    link: "https://qwen.ai/blog", author: "someone", created: "2026-11-11T03:00:00.000000+0000", score: 512, comments: 88,
  });
  // A text post links to itself: no separate link.
  const self = redditRow(el("SHREDDIT-POST", {
    id: "t3_2", "subreddit-prefixed-name": "r/x", "post-title": "t", permalink: "/r/x/comments/2/t/",
    "content-href": "https://www.reddit.com/r/x/comments/2/t/", score: "", "comment-count": "0",
  }), base);
  assert.equal(self.link, null);
  assert.equal(self.score, null);
  assert.equal(self.comments, 0);
});

test("old Reddit posts", () => {
  assert.deepEqual(redditRow(el("DIV", {
    "data-fullname": "t3_9z", "data-subreddit": "esp32", "data-permalink": "/r/esp32/comments/9z/x/",
    "data-url": "/r/esp32/comments/9z/x/", "data-author": "a", "data-timestamp": "1794300000000",
    "data-score": "40", "data-comments-count": "7",
  }, "My ESP32 clock"), "https://old.reddit.com/r/esp32/"), {
    id: "t3_9z", subreddit: "r/esp32", title: "My ESP32 clock", url: "https://www.reddit.com/r/esp32/comments/9z/x/",
    link: "https://old.reddit.com/r/esp32/comments/9z/x/", author: "a", created: new Date(1794300000000).toISOString(), score: 40, comments: 7,
  });
  assert.equal(redditRow(el("DIV", { "data-fullname": "t3_ad", "data-promoted": "true", "data-permalink": "/r/x/comments/ad/" }, "Ad"), base), null);
});

test("not posts", () => {
  assert.equal(redditRow(el("SHREDDIT-POST", { id: "t1_comment", "post-title": "t", permalink: "/r/x/comments/1/" }), base), null);
  assert.equal(redditRow(el("SHREDDIT-POST", { id: "t3_1", "post-title": "", permalink: "/r/x/comments/1/" }), base), null);
  assert.equal(redditRow(el("SHREDDIT-POST", { id: "t3_1", "post-title": "t", permalink: "https://evil.example/" }), base), null);
});
