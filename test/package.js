"use strict";

const path = require("path");
const { tests } = require("@iobroker/testing");

// Validates package.json and io-package.json against each other and against
// the schema ioBroker expects (required properties, matching name/version,
// etc.). This is what the ioBroker repository checker's "testing-action-check"
// step actually looks for when it runs "npm run test:package" - previously
// this script was a no-op stub, which is why the checker flagged it (E3051)
// for not logging the expected output.
tests.packageFiles(path.join(__dirname, ".."));
