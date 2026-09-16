const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const browsers = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const render = (t, body, extraCss = '', windowSize = '800,600') => {
    const browser = browsers.find(fs.existsSync);
    if (!browser) {
        t.skip('Chromium browser unavailable');
        return null;
    }

    const source = fs.readFileSync(`${__dirname}/medpilot.user.js`, 'utf8');
    const start = source.indexOf('const CSS = `') + 'const CSS = `'.length;
    const css = source.slice(start, source.indexOf('`;', start));
    const html = `<!doctype html><style>${css}${extraCss}</style>${body}`;
    const result = spawnSync(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', `--window-size=${windowSize}`, '--dump-dom',
        `data:text/html;base64,${Buffer.from(html).toString('base64')}`], { encoding: 'utf8', timeout: 15000 });

    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
};

test('an open API popup is painted above the following Torn panel', t => {
    const output = render(t, `
        <div class="cm-panel" style="height:100px">
            <div class="cm-settings" style="display:block">
                <div class="cm-key-field">
                    <details class="cm-api-info" open><summary>i</summary>
                        <div id="popup" class="cm-api-popup" style="height:160px">API usage</div>
                    </details>
                </div>
            </div>
        </div>
        <div id="torn" style="position:relative;z-index:10;height:200px;background:#333">Torn panel</div>
        <script>
            const topElement = document.elementFromPoint(500, 150);
            document.body.dataset.top = topElement?.closest('#popup,#torn')?.id || topElement?.className || 'none';
        </script>`);

    if (output) assert.match(output, /data-top="popup"/);
});

test('API popup values remain readable against Torn table styles', t => {
    const output = render(t, `
        <div class="content-wrapper"><div class="cm-panel"><div class="cm-api-popup">
            <table><tbody><tr><td id="value">Personal medical cooldown and life planning</td></tr></tbody></table>
        </div></div></div>
        <script>document.body.dataset.valueColor = getComputedStyle(document.querySelector('#value')).color</script>`,
    '.content-wrapper td{color:rgb(10,10,10)}');

    if (output) assert.match(output, /data-value-color="rgb\(207, 207, 207\)"/);
});

test('Torn PDA API popup stays fully inside a narrow viewport', t => {
    const output = render(t, `
        <div class="cm-panel cm-pda"><div class="cm-settings cm-open">
            <div class="cm-key-field" style="flex:none;width:170px">
                <details class="cm-api-info" open><summary>i</summary>
                    <div id="popup" class="cm-api-popup" style="height:420px">API usage</div>
                </details>
            </div>
        </div></div>
        <script>
            const box = document.querySelector('#popup').getBoundingClientRect();
            document.body.dataset.inside = String(box.left >= 0 && box.top >= 0
                && box.right <= innerWidth && box.bottom <= innerHeight);
        </script>`, '', '360,640');

    if (output) assert.match(output, /data-inside="true"/);
});

test('spendable item pills wrap below the API key and blood type', t => {
    const output = render(t, `
        <div class="cm-panel"><div class="cm-settings cm-open">
            <div id="key" class="cm-key-field"><label>API key</label><input></div>
            <label id="blood">Your blood type<select><option>O+</option></select></label>
            <div id="items" class="cm-field">Items it may spend from your items
                <span class="cm-toggles"><button class="cm-chip">SFAK</button><button class="cm-chip">Blood bags</button></span>
            </div>
            <button id="save" class="cm-save">Save</button>
        </div></div>
        <script>
            const rect = id => document.querySelector('#' + id).getBoundingClientRect();
            const key = rect('key'), blood = rect('blood'), items = rect('items'), save = rect('save');
            const firstRow = Math.abs(key.bottom - blood.bottom) < 2;
            const secondRow = items.top > key.bottom + 5 && Math.abs(items.bottom - save.bottom) < 2;
            document.body.dataset.layout = String(firstRow && secondRow);
        </script>`);

    if (output) assert.match(output, /data-layout="true"/);
});
