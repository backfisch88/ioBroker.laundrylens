"use strict";

/**
 * Builds the user interfaces and puts them where their hosts look for them. The results are committed.
 *
 *   node tasks            everything
 *   node tasks --admin    src-admin         -> admin/custom         (the tab in Admin)
 *   node tasks --devices  src-devices       -> admin/dm-widgets     (the tile of the devices app)
 *   node tasks --vis      src-widgets       -> widgets/laundrylens  (the vis-2 widget)
 *   node tasks --wc       src-webcomponents -> admin/webcomponents  (the web component: Aura and other hosts)
 */

const {
  deleteFoldersRecursive,
  buildReact,
  copyFiles,
  npmInstall,
} = require("@iobroker/build-tools");

// mf-manifest.json is copied on purpose in all the Module Federation builds: the hosts fetch it next to the remote
// entry to decide which GUI API generation or shared modules the bundle was built against.
const PARTS = {
  admin: {
    src: "src-admin",
    target: "admin/custom",
    files: ["src-admin/build/**/*", "!src-admin/build/index.html"],
  },
  devices: {
    src: "src-devices",
    target: "admin/dm-widgets",
    files: ["src-devices/build/**/*", "!src-devices/build/index.html"],
    // The icon of the tile in the catalogue of the devices app, named by `common.deviceWidgets`
    extraFiles: ["src-devices/img/*"],
  },
  vis: {
    src: "src-widgets",
    target: "widgets/laundrylens",
    // With `img`: Vite copies `public/` into the build
    files: ["src-widgets/build/**/*", "!src-widgets/build/index.html"],
  },
  wc: {
    src: "src-webcomponents",
    target: "admin/webcomponents",
    // One ES module and its manifest, named by `common.webComponents`
    files: ["src-webcomponents/build/*.js", "src-webcomponents/build/*.json"],
  },
};

async function buildPart(part) {
  const src = `${__dirname}/${part.src}/`;
  // Emptied first, so no chunk of an earlier build - with a different hash - is left behind to ship
  deleteFoldersRecursive(`${__dirname}/${part.target}`);
  deleteFoldersRecursive(`${src}build`);
  await npmInstall(src);
  await buildReact(src, { rootDir: src, vite: true });
  copyFiles(part.files, `${part.target}/`);
  if (part.extraFiles) {
    copyFiles(part.extraFiles, `${part.target}/`);
  }
}

async function main() {
  const chosen = process.argv.slice(2).map((arg) => arg.replace(/^--/, ""));
  const unknown = chosen.filter((name) => !PARTS[name]);
  if (unknown.length) {
    throw new Error(
      `Unknown part ${unknown.join(", ")}, known are ${Object.keys(PARTS).join(", ")}`,
    );
  }
  for (const name of chosen.length ? chosen : Object.keys(PARTS)) {
    await buildPart(PARTS[name]);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(2);
});
