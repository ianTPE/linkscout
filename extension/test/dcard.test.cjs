const { test } = require("node:test");
const assert = require("node:assert/strict");
const { dcardSearch, dcardForum, dcardCount, dcardRow } = require("../dcard.js");

test("search pages only", () => {
  assert.deepEqual(dcardSearch("https://www.dcard.tw/search/posts?query=%E5%90%89%E4%BC%8A%E5%8D%A1%E5%93%87&sort=created"),
    { query: "吉伊卡哇", sort: "created" });
  assert.deepEqual(dcardSearch("https://www.dcard.tw/search?query=owala"), { query: "owala", sort: null });
  assert.equal(dcardSearch("https://www.dcard.tw/f/girl"), null);
  assert.equal(dcardSearch("https://www.dcard.tw/search/posts"), null);
  assert.equal(dcardSearch("https://evil.example/search/posts?query=a"), null);
});

test("forum pages", () => {
  assert.equal(dcardForum("https://www.dcard.tw/f/tech"), "tech");
  assert.equal(dcardForum("https://www.dcard.tw/f/tech/?tab=latest"), "tech?tab=latest");
  assert.equal(dcardForum("https://www.dcard.tw/f/tech/p/262426522"), null);
  assert.equal(dcardForum("https://www.dcard.tw/search/posts?query=a"), null);
  assert.equal(dcardForum("https://evil.example/f/tech"), null);
});

test("counts", () => {
  assert.equal(dcardCount(""), 0);
  assert.equal(dcardCount(" 6 "), 6);
  assert.equal(dcardCount("1,234"), 1234);
  assert.equal(dcardCount("1.2萬"), 12000);
  assert.equal(dcardCount("讚"), null);
});

function article({ href, title, time, buttons, reaction }) {
  const el = (text, attrs = {}) => ({ tagName: "BUTTON", textContent: text, getAttribute: (n) => attrs[n] ?? null });
  const btns = buttons.map((b) => el(b));
  // reaction: index of the likes button, wrapped in a div[aria-haspopup="dialog"] (forum pages).
  let like = null;
  if (reaction != null) {
    like = btns[reaction];
    like.parentElement = { nextElementSibling: btns[reaction + 1] };
  }
  const map = {
    'a[href*="/p/"]': href ? el("18 小時", { href }) : null, h2: title == null ? null : el(title), time: time ? el(time, { datetime: time }) : null,
    'div[aria-haspopup="dialog"] > button': like,
  };
  return { querySelector: (s) => map[s] ?? null, querySelectorAll: (s) => (s === "button" ? btns : []) };
}

test("post cards", () => {
  const base = "https://www.dcard.tw/search/posts?query=x";
  assert.deepEqual(dcardRow(article({ href: "/f/girl/p/262426522", title: " 實用週邊分享 ", time: "2026-11-09T14:08:07.487Z", buttons: ["6", "5", "", "", "2"] }), base),
    { id: "262426522", forum: "girl", title: "實用週邊分享", url: "https://www.dcard.tw/f/girl/p/262426522", created: "2026-11-09T14:08:07.487Z", likes: 6, comments: 5 });
  assert.equal(dcardRow(article({ href: "/f/girl", title: "t", time: null, buttons: [] }), base), null);
  assert.equal(dcardRow(article({ href: "/f/girl/p/1", title: "", time: null, buttons: [] }), base), null);
});

test("forum page cards: likes are in the reaction picker", () => {
  // Button texts as saved from https://www.dcard.tw/f/3c (2026-11-13): menu, four poll
  // options, ♡ 26, 💬 10, then repost, share, collect.
  const base = "https://www.dcard.tw/f/3c";
  const poll = dcardRow(article({ href: "/f/3c/p/1", title: "外接硬碟", time: null, buttons: ["", "ADATA SE880", "TEAMGROUP PD20", "Kingston XS2000", "Samsung T9", "26", "10", "2", "", "1"], reaction: 5 }), base);
  assert.equal(poll.likes, 26);
  assert.equal(poll.comments, 10);
  const plain = dcardRow(article({ href: "/f/3c/p/2", title: "組電腦", time: null, buttons: ["", "", "3", "14", "4", "", "1"], reaction: 2 }), base);
  assert.deepEqual([plain.likes, plain.comments], [3, 14]);
  // No likes yet: the count is blank.
  const none = dcardRow(article({ href: "/f/3c/p/3", title: "NAS", time: null, buttons: ["", "", "", "", "", "", "1"], reaction: 2 }), base);
  assert.deepEqual([none.likes, none.comments], [0, 0]);
});
