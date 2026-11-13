"use strict";

/**
 * tests/test_admin_icons.js
 *
 * The texts of the admin tab keep their emoji, because the emoji are part of
 * the translation keys in admin/i18n. src-admin shows them as duotone icons:
 * the MUI components that render texts come from src/ui.tsx, which replaces the
 * emoji (src/icons.tsx). A component imported straight from MUI, or an emoji
 * without an icon, shows up as a plain emoji between the icons.
 */

const assert = require("node:assert");
const { readAdminSource, readAdminSources } = require("./lib/adminSources");

const EMOJI = /[\u{1F300}-\u{1FAFF}☀-➿⬀-⯿←-⇿⏩-⏺]/gu;
// Texts that are sent as they are, not shown in the tab: notification messages and the canvas of the graph
const NOT_SHOWN = [
  /^\s*(startMsg|updateMsg|doneMsg):/,
  /LEGACY|startMsg|updateMsg|doneMsg/,
  /'🔔 Test'/,
  /fillText/,
  /t\('🧺 \{device\}/,
  /t\('[^']*\{device\}/,
  /^\s*'🧺 \{device\}/,
  /Go to review →/,
];

describe("admin tab icons", () => {
  const icons = readAdminSource("icons.tsx");
  const mapped = new Set(
    [...icons.matchAll(/^\s*'(.+?)': \[\w+, '\w+'\],/gmu)].map((m) => m[1]),
  );

  it("maps the emoji to icons of one family", () => {
    assert.ok(mapped.size >= 40, `only ${mapped.size} emoji are mapped`);
    assert.match(icons, /from '@phosphor-icons\/react'/);
    assert.match(icons, /weight="duotone"/);
  });

  it("has an icon for every emoji that the tab shows", () => {
    const missing = new Set();
    for (const line of readAdminSources().split("\n")) {
      if (NOT_SHOWN.some((re) => re.test(line))) {
        continue;
      }
      for (const emoji of line.match(EMOJI) || []) {
        if (!mapped.has(emoji)) {
          missing.add(emoji);
        }
      }
    }
    assert.deepStrictEqual([...missing], []);
  });

  it("has an icon for every phase emoji", () => {
    const phases = require("../admin/phaseLabels.json");
    for (const { emoji } of Object.values(phases)) {
      const bare = emoji.replace(/️/g, "");
      assert.ok(mapped.has(bare), `no icon for the phase emoji ${bare}`);
    }
  });

  it("takes an emoji with its variation selector and drops the space after it", () => {
    assert.match(
      icons,
      /\(\$\{Object\.keys\(ICON_MAP\)\.join\('\|'\)\}\)\\\\uFE0F\?\( \?\)/,
    );
    assert.match(icons, /gap=\{!!match\[2\]\}/);
  });

  it("uses the colour of the text on a coloured background", () => {
    assert.match(icons, /props\.mono \? 'currentColor'/);
    const ui = readAdminSource("ui.tsx");
    assert.match(ui, /props\.variant === 'contained'/);
  });

  it("is hidden from screen readers, the text carries the meaning", () => {
    assert.match(icons, /aria-hidden="true"/);
  });
});

describe("admin tab components", () => {
  it("import the components that show texts from ui.tsx, not from MUI", () => {
    const wrapped = [
      "Alert",
      "Button",
      "Chip",
      "DialogTitle",
      "FormControlLabel",
      "IconButton",
      "MenuItem",
      "Tab",
      "TableCell",
      "Typography",
    ];
    const ui = readAdminSource("ui.tsx");
    for (const name of wrapped) {
      assert.match(ui, new RegExp(`export const ${name} = iconized`), name);
    }
    const sources = readAdminSources();
    const direct = [
      ...sources.matchAll(/import \{([^}]*)\} from '@mui\/material';/g),
    ]
      .flatMap((m) => m[1].split(","))
      .map((name) => name.trim())
      .filter((name) => wrapped.includes(name));
    // ui.tsx itself imports the originals under another name
    assert.deepStrictEqual(
      direct.filter((name) => !/ as /.test(name)),
      [],
    );
  });

  it("render an emoji inside a Select through withIcons, as MUI shows the raw children there", () => {
    const overview = readAdminSource("tabs/OverviewTab.tsx");
    assert.match(overview, /withIcons\(t\('🤖 Automatic'\)\)/);
  });
});

describe("programs table on a phone", () => {
  const programs = readAdminSource("tabs/ProgramsTab.tsx");

  it("moves the date under the name and hides its column", () => {
    assert.match(
      programs,
      /HIDE_ON_PHONE = \{ display: \{ xs: 'none', sm: 'table-cell' \} \}/,
    );
    assert.strictEqual(
      (programs.match(/sx=\{HIDE_ON_PHONE\}/g) || []).length,
      2,
    );
    assert.match(programs, /display: \{ xs: 'block', sm: 'none' \}/);
  });

  it("keeps the action buttons in one row", () => {
    assert.match(programs, /align="right"\s+sx=\{\{ whiteSpace: 'nowrap' \}\}/);
  });
});
