const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(`${__dirname}/medpilot.user.js`, 'utf8');

test('settings and API account data have explicit single-instance module boundaries', () => {
    assert.match(source, /function createSettingsStore\(\)/);
    assert.match(source, /function createApiClient\(/);
    assert.equal((source.match(/createSettingsStore\(\)/g) || []).length, 2);
    assert.equal((source.match(/createApiClient\(/g) || []).length, 2);
});

test('inventory and page status have explicit single-instance module boundaries', () => {
    assert.match(source, /function createInventoryService\(/);
    assert.match(source, /function createStatusReader\(\)/);
    assert.equal((source.match(/createInventoryService\(/g) || []).length, 2);
    assert.equal((source.match(/createStatusReader\(\)/g) || []).length, 2);
});

test('panel DOM has an explicit single-instance module boundary', () => {
    assert.match(source, /function createPanelView\(/);
    assert.equal((source.match(/createPanelView\(/g) || []).length, 2);
});

test('item-use prediction and recovery have an explicit single-instance module boundary', () => {
    assert.match(source, /function createUseController\(/);
    assert.equal((source.match(/createUseController\(/g) || []).length, 2);
});

test('the userscript has one named bootstrap path', () => {
    assert.match(source, /^\(function bootstrap\(\) \{/m);
    assert.equal((source.match(/function bootstrap\(\)/g) || []).length, 1);
});
