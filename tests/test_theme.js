"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "admin", "tab_m.html"),
  "utf8",
);
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const body = html.slice(html.indexOf("</style>"));

describe("admin tab theme", () => {
  it("defines light and dark token sets", () => {
    assert.ok(/:root\s*\{[^}]*--card:/.test(css));
    assert.ok(/:root\[data-theme="dark"\]\s*\{[^}]*--card:/.test(css));
  });

  it("has no hard-coded surface colours left in the stylesheet rules", () => {
    // the toggle knob is intentionally white in both themes
    const rules = css
      .slice(css.indexOf("* { box-sizing"))
      .split("\n")
      .filter((l) => !l.startsWith(".toggle::after"))
      .join("\n");
    assert.ok(
      !/background:\s*#(fff|f8f9fa|fafbfc|e8eaed)\b/i.test(rules),
      "surface colours must use tokens",
    );
    assert.ok(
      !/color:\s*#(202124|e37400|c5221f|1e7e34)\b/i.test(rules),
      "text colours must use tokens",
    );
  });

  it("detects the admin theme before first paint", () => {
    const head = html.slice(0, html.indexOf("socket.io.js"));
    assert.ok(head.includes("setAttribute('data-theme'"));
    assert.ok(head.includes("App.theme"));
    assert.ok(head.includes("prefers-color-scheme"));
  });

  it("charts read their colours from the theme, not fixed light values", () => {
    assert.ok(!body.includes("'#f8f9fa'"), "chart background must be themed");
    assert.ok(
      !body.includes("strokeStyle = '#e0e0e0'"),
      "chart grid must be themed",
    );
    assert.ok(body.includes("cssVar('--chart-grid')"));
  });

  it("redraws charts when the theme changes and respects reduced motion", () => {
    assert.ok(body.includes("function redrawCharts"));
    assert.ok(css.includes("prefers-reduced-motion"));
  });
});

describe("admin tab icons", () => {
  const mapSrc = html.slice(
    html.indexOf("var ICON_MAP"),
    html.indexOf("var ICON_RE"),
  );
  const mapped = new Set(
    Object.keys(
      JSON.parse(
        mapSrc.slice(mapSrc.indexOf("{"), mapSrc.lastIndexOf("}") + 1),
      ),
    ),
  );

  it("has an SVG icon for every emoji used in the tab", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}←-⇿☀-➿⬀-⯿]/gu;
    const used = new Set(
      (html.slice(html.indexOf("</style>")).match(emoji) || []).filter(
        (c) => c !== "→",
      ),
    );
    const missing = [...used].filter((c) => !mapped.has(c));
    assert.deepStrictEqual(missing, []);
  });

  it("swaps emoji for icons at render time without touching translation keys", () => {
    assert.ok(html.includes("function iconizeNode"));
    assert.ok(html.includes("MutationObserver"));
    assert.ok(html.includes('data-i18n="📊 Overview"'));
  });

  it("consumes the emoji variation selector for every icon, not only the last", () => {
    assert.ok(
      html.includes("new RegExp('(?:' + Object.keys(ICON_MAP).join('|') + ')"),
    );
  });

  it("drops the space after an icon so spacing is controlled by CSS only", () => {
    assert.ok(html.includes("while (text.charAt(last) === ' ') last++;"));
  });

  it("only adds spacing to icons that are followed by text", () => {
    assert.ok(html.includes("ic.className += ' ic-gap'"));
    assert.ok(html.includes(".ic.ic-gap { margin-right"));
  });
});
