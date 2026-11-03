// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// index.ts
import path from 'path';
import Mocha from 'mocha';
import glob from 'glob';

export function run(): Promise<void> {
    // Create the mocha test
    const mocha : Mocha = new Mocha({
        ui: 'tdd',
        timeout: 100000000,
        color: true
    });

    const testsRoot : string = path.resolve(__dirname, '..');

    return new Promise((c, e) => {
        glob('**/**.test.js', { cwd: testsRoot }, (err, files) => {
            if (err) {
                return e(err);
            }

            // Add files to the test suite
            files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

            try {
                // Run the mocha test
                mocha.run(failures => {
                    if (failures > 0) {
                        e(new Error(`${failures} tests failed.`));
                    } else {
                        c();
                    }
                });
            } catch (err) {
                console.error(err);
                e(err);
            }
        });
    });
}
