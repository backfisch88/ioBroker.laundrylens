"use strict";

const {
  deleteFoldersRecursive,
  buildReact,
  copyFiles,
  npmInstall,
} = require("@iobroker/build-tools");

const srcAdmin = `${__dirname}/src-admin/`;

// mf-manifest.json is copied on purpose: Admin fetches it next to the remote
// entry to decide which GUI API generation the components were built against.
function copyAdminFiles() {
  copyFiles(
    ["src-admin/build/**/*", "!src-admin/build/index.html"],
    "admin/custom/",
  );
}

deleteFoldersRecursive(`${__dirname}/admin/custom`);
deleteFoldersRecursive(`${srcAdmin}build`);

npmInstall(srcAdmin)
  .then(() => buildReact(srcAdmin, { rootDir: srcAdmin, vite: true }))
  .then(() => copyAdminFiles())
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(2);
  });
