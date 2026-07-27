'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Minimal integration test: starts the adapter against a real js-controller
// instance and verifies it comes up cleanly (reaches info.connection) with
// zero devices configured - the adapter must handle that gracefully rather
// than crashing, since a fresh install always starts with no devices.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Adapter startup', getHarness => {
            it('Adapter starts up without crashing (no devices configured)', function () {
                this.timeout(60000);
                return new Promise((resolve, reject) => {
                    const harness = getHarness();
                    harness.startAdapterAndWait()
                        .then(() => resolve())
                        .catch(err => reject(err));
                });
            });
        });
    },
});
