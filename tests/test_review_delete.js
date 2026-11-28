"use strict";

/**
 * tests/test_review_delete.js
 *
 * A cycle in the review list can be deleted there: the list shows every
 * unconfirmed cycle, and a cycle one can't tell the program of any more
 * would stay in it for good.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const tab = fs.readFileSync(
  path.join(__dirname, "..", "src-admin", "src", "tabs", "ReviewTab.tsx"),
  "utf8",
);

describe("review list: delete a cycle", () => {
  it("has a delete button for each cycle", () => {
    assert.match(tab, /onClick=\{\(\) => void deleteCycle\(cycle\)\}/);
  });

  it("asks before deleting", () => {
    const fn = tab.slice(tab.indexOf("const deleteCycle"));
    assert.ok(
      fn.indexOf("confirm(") !== -1 &&
        fn.indexOf("confirm(") < fn.indexOf("'deleteCycle'"),
    );
  });

  it("sends the cycle to the backend and reloads the list", () => {
    assert.match(
      tab,
      /api\.send\('deleteCycle', \{ deviceId, cycleId: cycle\.id \}\)/,
    );
    const fn = tab.slice(tab.indexOf("const deleteCycle"));
    assert.ok(fn.indexOf("await reload()") !== -1);
  });

  it("uses texts that exist in all languages", () => {
    for (const lang of [
      "de",
      "en",
      "es",
      "fr",
      "it",
      "nl",
      "pl",
      "pt",
      "ru",
      "uk",
      "zh-cn",
    ]) {
      const words = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "..", "admin", "i18n", `${lang}.json`),
          "utf8",
        ),
      );
      for (const key of [
        "Delete",
        "Really delete this cycle?",
        "Cycle deleted",
      ]) {
        assert.ok(words[key], `${lang}.json lacks: ${key}`);
      }
    }
  });
});
