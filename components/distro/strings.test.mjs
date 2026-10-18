import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { distroStrings } = await jiti.import("./strings.ts");

test("every distro string table carries the same non-empty keys", () => {
  // The three tables are typed against each other, but the app ships zh-TW as
  // a first-class locale while these strings live outside lib/i18n/messages —
  // this pins the parity the i18n registry test enforces for the catalogs.
  const tables = {
    en: distroStrings("en"),
    "zh-CN": distroStrings("zh-CN"),
    "zh-TW": distroStrings("zh-TW"),
  };
  const reference = Object.keys(tables.en).sort();
  assert.ok(reference.length > 0, "the distro string table must not be empty");
  for (const [locale, table] of Object.entries(tables)) {
    assert.deepEqual(Object.keys(table).sort(), reference, `${locale} keys must match English`);
    for (const key of reference) {
      assert.ok(typeof table[key] === "string" && table[key].length > 0, `${locale}.${key} must be a non-empty string`);
    }
  }
  assert.notEqual(tables["zh-CN"].save, tables["zh-TW"].save, "zh-TW must not fall back to the Simplified table");
});

test("distro strings follow the app's locale resolution", () => {
  // Mirrors lib/i18n/registry.ts: Traditional for zh-TW/zh-Hant*/zh-HK/zh-MO,
  // Simplified for every other zh*, English otherwise.
  assert.equal(distroStrings("zh-TW"), distroStrings("zh-Hant"));
  assert.equal(distroStrings("zh-Hant-HK"), distroStrings("zh-TW"));
  assert.equal(distroStrings("zh-HK"), distroStrings("zh-MO"));
  assert.equal(distroStrings("zh"), distroStrings("zh-CN"));
  assert.equal(distroStrings("zh-SG"), distroStrings("zh-CN"));
  assert.equal(distroStrings("en-US"), distroStrings("fr-FR"));
  assert.notEqual(distroStrings("zh-CN"), distroStrings("zh-TW"));
  assert.notEqual(distroStrings("en"), distroStrings("zh-CN"));
});
