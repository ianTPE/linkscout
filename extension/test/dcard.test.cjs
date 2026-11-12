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

function article({ href, title, time, buttons }) {
  const el = (text, attrs = {}) => ({ textContent: text, getAttribute: (n) => attrs[n] ?? null });
  const map = { 'a[href*="/p/"]': href ? el("18 小時", { href }) : null, h2: title == null ? null : el(title), time: time ? el(time, { datetime: time }) : null };
  return { querySelector: (s) => map[s] ?? null, querySelectorAll: (s) => (s === "button" ? buttons.map((b) => el(b)) : []) };
}

test("post cards", () => {
  const base = "https://www.dcard.tw/search/posts?query=x";
  assert.deepEqual(dcardRow(article({ href: "/f/girl/p/262426522", title: " 實用週邊分享 ", time: "2026-11-09T14:08:07.487Z", buttons: ["6", "5", "", "", "2"] }), base),
    { id: "262426522", forum: "girl", title: "實用週邊分享", url: "https://www.dcard.tw/f/girl/p/262426522", created: "2026-11-09T14:08:07.487Z", likes: 6, comments: 5 });
  assert.equal(dcardRow(article({ href: "/f/girl", title: "t", time: null, buttons: [] }), base), null);
  assert.equal(dcardRow(article({ href: "/f/girl/p/1", title: "", time: null, buttons: [] }), base), null);
});
