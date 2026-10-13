import { expect, test } from "vitest";
import { providerCatalogKey } from "../src/lib/catalog";

test("provider model aliases match the native stable catalog format", () => {
  expect(providerCatalogKey("a", "hello")).toBe("studio-a-a430d84680aabd0b");
  expect(providerCatalogKey("A", "hello")).toBe(providerCatalogKey("a", "hello"));
  expect(providerCatalogKey("a", "other")).not.toBe(providerCatalogKey("a", "hello"));
});
