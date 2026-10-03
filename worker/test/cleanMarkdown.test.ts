import { describe, expect, it } from "vitest";
import { cleanMarkdown, toPassages, toPlainText } from "../src/cleanMarkdown";

const prose = (n: number) => "Lorem ipsum dolor sit amet. ".repeat(Math.ceil(n / 28)).slice(0, n);

describe("cleanMarkdown", () => {
  it("starts at the H1 that matches the page title", () => {
    const raw = ["# Sign up for our newsletter", "", "# MutationObserver", "", prose(120)].join("\n");
    const page = cleanMarkdown(raw, "MutationObserver - Web APIs | MDN");
    expect(page.markdown.startsWith("# MutationObserver")).toBe(true);
    expect(page.markdown).not.toContain("newsletter");
  });

  it("matches an H1 whose title contains a hyphen", () => {
    const raw = ["Menu", "", "# Engineer-Angular", "", prose(120)].join("\n");
    expect(cleanMarkdown(raw, "Engineer-Angular｜Acme").markdown.startsWith("# Engineer-Angular")).toBe(true);
  });

  it("reads the title from front matter", () => {
    expect(cleanMarkdown('---\ntitle: "Hello"\n---\nBody text').title).toBe("Hello");
  });

  it("drops link-dense blocks but keeps prose", () => {
    const nav = "[Home](/) [Docs](/docs) [Blog](/blog) [Pricing](/pricing)";
    const page = cleanMarkdown(`${nav}\n\n${prose(120)}`);
    expect(page.markdown).not.toContain("Pricing");
    expect(page.blocks).toHaveLength(1);
  });

  it("keeps a code fence with blank lines as one block", () => {
    const code = "```js\nconst a = 1;\n\nconst b = 2;\n```";
    const page = cleanMarkdown(`Intro\n\n${code}`);
    expect(page.blocks).toContainEqual({ text: code, code: true });
  });
});

describe("toPassages", () => {
  const block = (text: string) => ({ text, code: false });

  it("counts CJK characters double, so a short Chinese paragraph qualifies", () => {
    const chinese = "這是一段關於工作內容的說明文字，".repeat(3); // 48 chars, weight 96
    const english = prose(48); // weight 48
    expect(toPassages([block(english), block(chinese)])).toEqual([chinese]);
  });

  it("falls back to the longest paragraph when none is long enough", () => {
    expect(toPassages([block("Short one here."), block("A slightly longer line of text.")])).toEqual([
      "A slightly longer line of text.",
    ]);
  });

  it("skips headings, tables and code", () => {
    const long = prose(120);
    const out = toPassages([block(`# ${long}`), block(`| ${long} |`), { text: long, code: true }, block(long)]);
    expect(out).toEqual([long]);
  });

  it("truncates passages to 600 characters", () => {
    expect(toPassages([block(prose(900))])[0]).toHaveLength(601);
  });
});

describe("toPlainText", () => {
  it("keeps link labels and drops Markdown marks", () => {
    expect(toPlainText("**Bold** and [a link](https://x.y) with `code`\n- item")).toBe(
      "Bold and a link with code\n• item",
    );
  });
});
