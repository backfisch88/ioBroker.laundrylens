"use strict";

/**
 * tests/test_notification_recipient.js
 *
 * The recipient of a notification is a select. Its first entry, "All
 * (broadcast)", has an empty value. A select hides the text of an empty value
 * unless displayEmpty is set, so choosing "All (broadcast)" left the field
 * blank (issue #77).
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(
  __dirname,
  "..",
  "src-admin",
  "src",
  "tabs",
  "NotificationsTab.tsx",
);

describe("notification recipient select", () => {
  const source = fs.readFileSync(file, "utf8");

  it("shows the text of the empty value (All (broadcast))", () => {
    const start = source.indexOf(
      "label={t('Recipient')}\n                        value={config.target}",
    );
    assert.ok(start > 0, "the recipient select was not found");
    const end = source.indexOf("{recipients.map", start);
    const select = source.slice(start, end);
    assert.ok(select.includes("displayEmpty: true"), "displayEmpty is missing");
    assert.ok(
      select.includes("shrink: true"),
      "the label must stay above the text",
    );
    assert.ok(
      select.includes("<MenuItem value=\"\">{t('All (broadcast)')}</MenuItem>"),
    );
  });
});
