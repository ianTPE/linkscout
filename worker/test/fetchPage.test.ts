import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage } from "../src/fetchPage";

afterEach(() => vi.unstubAllGlobals());

describe("Shopee fetch exclusion", () => {
  it.each(["https://shopee.tw/product/1/2", "https://www.shopee.tw/", "https://SHOPEE.tw/"])(
    "rejects %s before calling Browser Run or Jina", async (url) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(fetchPage({ CF_ACCOUNT_ID: "test", CF_API_TOKEN: "test" }, url)).rejects.toThrow(/automatic fetching is disabled/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
