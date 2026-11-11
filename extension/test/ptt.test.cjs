const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pttPushes, pttSearch, pttRow } = require("../ptt.js");

test("push counts", () => {
  assert.equal(pttPushes(""), 0);
  assert.equal(pttPushes("21"), 21);
  assert.equal(pttPushes("爆"), 100);
  assert.equal(pttPushes("X3"), -30);
  assert.equal(pttPushes("XX"), -100);
  assert.equal(pttPushes("?"), null);
});

test("search pages only", () => {
  assert.deepEqual(pttSearch("https://www.ptt.cc/bbs/Lifeismoney/search?q=%E5%90%89%E4%BC%8A%E5%8D%A1%E5%93%87"),
    { board: "Lifeismoney", query: "吉伊卡哇", page_no: 1 });
  assert.deepEqual(pttSearch("https://www.ptt.cc/bbs/e-shopping/search?page=2&q=owala"), { board: "e-shopping", query: "owala", page_no: 2 });
  assert.equal(pttSearch("https://www.ptt.cc/bbs/Lifeismoney/index.html"), null);
  assert.equal(pttSearch("https://www.ptt.cc/bbs/Lifeismoney/search"), null);
  assert.equal(pttSearch("https://evil.example/bbs/x/search?q=a"), null);
});

function row(fields, href) {
  const el = (text, attrs = {}) => ({ textContent: text, getAttribute: (n) => attrs[n] ?? null });
  const map = { ".title a": href ? el(fields.title, { href }) : null, ".meta .date": el(fields.date),
    ".nrec": el(fields.nrec), ".meta .author": el(fields.author) };
  return { querySelector: (s) => map[s] ?? null };
}

test("result rows", () => {
  const base = "https://www.ptt.cc/bbs/Lifeismoney/search?q=x";
  assert.deepEqual(pttRow(row({ title: " [情報] 吉伊卡哇 ", date: "10/04", nrec: "21", author: "abc" }, "/bbs/Lifeismoney/M.1.A.2.html"), base),
    { title: "[情報] 吉伊卡哇", url: "https://www.ptt.cc/bbs/Lifeismoney/M.1.A.2.html", date: "10/04", pushes: 21, author: "abc" });
  assert.equal(pttRow(row({ title: "(本文已被刪除)", date: "1/01", nrec: "", author: "-" }, null), base), null);
});
