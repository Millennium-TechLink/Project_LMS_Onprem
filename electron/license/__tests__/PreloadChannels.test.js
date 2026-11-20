/**
 * PreloadChannels.test.js
 * The sandboxed preload cannot require LicenseConstants, so its inlined channel names must match.
 * Run with: node onprem/electron/license/__tests__/PreloadChannels.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { IPC_CHANNELS } = require('../LicenseConstants');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
const body = src.match(/const IPC_CHANNELS = Object\.freeze\(\{([\s\S]*?)\}\);/);

let failed = 0;
if (!body) {
    console.log('  FAIL: inlined IPC_CHANNELS not found in preload.js');
    failed++;
} else {
    if (/require\(['"]\.\.?\//.test(src)) {
        console.log('  FAIL: preload.js requires a local module (breaks under the sandbox)');
        failed++;
    }
    const inlined = {};
    for (const m of body[1].matchAll(/([A-Z_]+):\s*'([^']+)'/g)) inlined[m[1]] = m[2];
    for (const [k, v] of Object.entries(IPC_CHANNELS)) {
        if (inlined[k] !== v) {
            console.log(`  FAIL: ${k} expected ${v}, got ${inlined[k]}`);
            failed++;
        }
    }
}
console.log(failed ? 'PRELOAD CHANNELS TEST FAILED' : 'PRELOAD CHANNELS TEST PASSED');
process.exit(failed ? 1 : 0);
