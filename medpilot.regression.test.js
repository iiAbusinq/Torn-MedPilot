const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { MEDS, BLOOD_BAG_IDS, plan } = require('./medpilot.user.js');

test('a blood bag remains available when the cheaper two-item path cannot finish', () => {
    const result = plan(60, 0, 0, MEDS.filter(m => m.id !== 66),
        { 67: 1, 68: 1, 739: 1 }, 'o-', { cooldownNow: 350, maxCooldown: 360 });
    assert.deepEqual(result.items.map(m => m.id), [739]);
    assert.equal(result.cooldown, 30);
});

test('7.5% missing life at +50% needs only one SFAK', () => {
    const result = plan(0, 7.5, 50, MEDS, { 68: 2 }, 'o-');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].life, 7.5);
});

async function browser({ stock = { 68: 3, 739: 2 }, current = 1300, maximum = 2000,
    hospitalMinutes = 0, cooldownMinutes = 0, settings = {}, lifeAvailable = true, armoury = false,
    medicalIcon = true, factionPerks = [], storage = new Map(), startNow = 1_800_000_000_000,
    timezoneOffsetMinutes = 0, secureStorage = null, accessLevel = 3,
    inventoryTimestamp = Math.floor(startNow / 1000), armouryDomLoaded = true,
    unusableArmouryIds = [], pda = false, pdaApiKey = null, sidebarLife = null } = {}) {
    settings = { apiKey: 'test-key', ...settings };
    let now = startNow;
    let holdStock = false, holdNextApi = false, stockReads = 0, apiReads = 0;
    let failStock = false, apiFailure = null, currentFactionPerks = factionPerks;
    let focused = true;
    const documentListeners = new Map(), windowListeners = new Map();
    const stockResponses = [], apiResponses = [];
    const elements = new Map(), intervals = new Map(), observers = [], requests = [], fetches = [];
    function element(key) {
        if (!elements.has(key)) {
            const listeners = new Map();
            const classes = new Set();
            elements.set(key, {
                isConnected: true, disabled: false, textContent: '',
                querySelector: selector => element(key + selector),
                querySelectorAll: () => [],
                addEventListener: (event, handler) => listeners.set(event, handler),
                click() { if (!this.disabled) return listeners.get('click')?.({}); },
                focus() { this.focused = true; },
                insertAdjacentHTML() {}, remove() {}, appendChild() {},
                classList: {
                    add: name => classes.add(name),
                    contains: name => classes.has(name),
                    remove: name => classes.delete(name),
                    toggle(name, force) {
                        const enabled = force === undefined ? !classes.has(name) : force;
                        if (enabled) classes.add(name); else classes.delete(name);
                        return enabled;
                    },
                },
            });
        }
        return elements.get(key);
    }
    const sidebar = { hospital: hospitalMinutes ? now / 1000 + hospitalMinutes * 60 : 0,
        cooldown: cooldownMinutes ? now / 1000 + cooldownMinutes * 60 : 0 };
    const life = { isConnected: lifeAvailable, textContent: `${current}/${maximum}` };
    const armouryRows = Object.entries(stock).map(([id, quantity]) => ({
        querySelector(selector) {
            if (selector === '.img-wrap[data-itemid]') return { dataset: { itemid: id } };
            if (selector === '.qty') return { textContent: String(quantity) };
            if (selector === '.use.active') return unusableArmouryIds.includes(+id) ? null : {};
            return null;
        },
    }));
    const armouryMedicalList = {
        querySelectorAll: selector => selector === ':scope > li' ? armouryRows : [],
    };
    const strip = { isConnected: true, get __reactPropsTest() {
        const children = [];
        if (medicalIcon) children.push({ props: { iconKey: 'medical_cooldown',
            icon: { timerExpiresAt: sidebar.cooldown, factionUpgrade: '06:00:00' } } });
        if (sidebar.hospital) children.push({ props: { iconKey: 'hospital',
            icon: { timerExpiresAt: sidebar.hospital } } });
        return { children };
    } };
    const anchor = { insertAdjacentElement(position, panel) { this.previousElementSibling = panel; } };
    const document = {
        createElement: tag => element(tag), head: element('head'), cookie: '',
        visibilityState: 'visible', hasFocus: () => focused,
        addEventListener: (event, handler) => documentListeners.set(event, handler),
        querySelector(selector) {
            if (selector.includes('status-icons')) return strip.isConnected ? strip : null;
            if (selector.includes('bar__')) return life.isConnected ? life : null;
            if (selector === (armoury ? '#faction-armoury-tabs' : '.equipped-items-wrap')) return anchor;
            if (selector === ".armoury-tabs[id*='medical'] .item-list") {
                return armoury && armouryDomLoaded ? armouryMedicalList : null;
            }
            return null;
        },
    };
    const response = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
    storage.set('cheap_medout_v2', JSON.stringify(settings));
    secureStorage ||= storage.secureStorage || new Map();
    storage.secureStorage = secureStorage;
    const sessionStorage = {};
    if (sidebarLife) {
        sessionStorage.sidebarData123 = JSON.stringify({ bars: { life: sidebarLife } });
    }
    sessionStorage.getItem = key => sessionStorage[key] ?? null;
    const context = {
        document, window: {
            addEventListener: (event, handler) => windowListeners.set(event, handler),
            ...(pda ? { __tornpda: { tab: {} } } : {}),
        },
        location: { pathname: armoury ? '/factions.php' : '/item.php', hash: armoury ? '#/tab=armoury' : '' },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key),
        },
        GM_getValue: (key, fallback) => secureStorage.has(key) ? secureStorage.get(key) : fallback,
        GM_setValue: (key, value) => secureStorage.set(key, value),
        GM_deleteValue: key => secureStorage.delete(key),
        sessionStorage,
        URLSearchParams, Date: class extends Date {
            static now() { return now; }
            getTimezoneOffset() { return -timezoneOffsetMinutes; }
        },
        MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
        setInterval: (callback, delay) => { intervals.set(delay, callback); return delay; },
        clearInterval: id => intervals.delete(id),
        fetch(url, options = {}) {
            fetches.push({ url, body: options.body });
            if (url.startsWith('https://api.torn.com/')) {
                if (url.includes('/v2/user/inventory')) {
                    stockReads++;
                    if (failStock) return Promise.reject(new Error('Stock unavailable'));
                    const snapshot = response({ inventory: {
                        items: Object.entries(stock).map(([id, amount]) => ({ id: +id, amount,
                            equipped: false, name: `Item ${id}`, faction_owned: false, uid: null })),
                        timestamp: inventoryTimestamp,
                    }, _metadata: { total: Object.keys(stock).length, links: {} } });
                    return holdStock ? new Promise(resolve => stockResponses.push(() => resolve(snapshot)))
                        : Promise.resolve(snapshot);
                }
                if (url.includes('/v2/faction/inventory')) {
                    stockReads++;
                    if (accessLevel < 3) return Promise.resolve(response({
                        error: { code: 16, error: 'Access level of this key is not high enough' } }));
                    if (failStock) return Promise.reject(new Error('Stock unavailable'));
                    const snapshot = response({ inventory: Object.entries(stock).map(([id, amount]) => ({
                        id: +id, name: `Item ${id}`, type: 'Medical', amount, uids: [], loaned: null,
                    })), inventory_timestamp: inventoryTimestamp,
                    _metadata: { total: Object.keys(stock).length, links: {} } });
                    return holdStock ? new Promise(resolve => stockResponses.push(() => resolve(snapshot)))
                        : Promise.resolve(snapshot);
                }
                if (url.includes('selections=info')) return Promise.resolve(response({ access_level: accessLevel,
                    access_type: accessLevel === 3 ? 'Limited' : accessLevel === 2 ? 'Minimal' : 'Public' }));
                apiReads++;
                if (apiFailure) return Promise.resolve(response({ error: apiFailure }));
                const apiResponse = response({ education_perks: [], faction_perks: currentFactionPerks,
                    ...(url.includes('bars') ? { life: { current, maximum,
                        increment: maximum * 0.05, interval: 300 } } : {}) });
                if (holdNextApi) {
                    holdNextApi = false;
                    return new Promise(resolve => apiResponses.push(() => resolve(apiResponse)));
                }
                return Promise.resolve(apiResponse);
            }
            const body = options.body;
            if (body.get('step') === (armoury ? 'armouryTabContent' : 'getCategoryList')) {
                stockReads++;
                if (failStock) return Promise.reject(new Error('Stock unavailable'));
                const snapshot = response(armoury ? {
                    items: Object.entries(stock).map(([id, qty]) => ({ itemID: +id, qty, itemActions: { usable: true } })),
                } : {
                    list: Object.entries(stock).map(([ID, Qty]) => ({ ID: +ID, Qty, use: true })),
                    total: Object.keys(stock).length,
                });
                return holdStock ? new Promise(resolve => stockResponses.push(() => resolve(snapshot)))
                    : Promise.resolve(snapshot);
            }
            assert.equal(body.get('step'), 'useItem');
            assert.equal(body.get('fac'), armoury ? '1' : null);
            return new Promise((resolve, reject) => requests.push({ id: +body.get('itemID'),
                consumed: false,
                consume() { if (!this.consumed) { stock[this.id]--; this.consumed = true; } },
                finish(success = true) {
                    if (success) this.consume();
                    resolve(response({ success, text: success ? '' : 'Refused' }));
                },
                loseResponse() { this.consume(); reject(new Error('Response lost')); },
                reply(body) { resolve(response(body)); },
                invalidJSON() { resolve({ ...response(null), json: async () => { throw new SyntaxError('Invalid JSON'); } }); },
                httpError() { resolve({ ...response({ success: false }), ok: false, status: 503 }); },
                reject }));
        },
    };
    let source = fs.readFileSync(`${__dirname}/medpilot.user.js`, 'utf8');
    if (pdaApiKey !== null) source = source.replaceAll('###PDA-APIKEY###', pdaApiKey);
    vm.runInNewContext(source, context);
    const flush = () => new Promise(resolve => setImmediate(resolve));
    await flush();
    return {
        button: name => element('div#cm-' + name),
        element: name => element('div#cm-' + name),
        detail: name => element('div#cm-' + name + '.t2').textContent,
        title: name => element('div#cm-' + name + '.t1').textContent,
        text: name => element('div#cm-' + name).textContent,
        hint: name => element('div#cm-' + name + '-hint').innerHTML,
        async saveKey(key) {
            element('div#cm-key').value = key;
            element('div#cm-blood').value = 'o-';
            await element('div#cm-save').click();
        },
        requests, sidebar, flush, apiResponses, storage, secureStorage, fetches,
        stockResponses, holdStock(value = true) { holdStock = value; }, stockReads: () => stockReads,
        panelHtml: () => element('div').innerHTML,
        apiReads: () => apiReads,
        holdNextApi() { holdNextApi = true; },
        setFactionPerks(value) { currentFactionPerks = value; },
        failStock(value = true) { failStock = value; },
        failApi(code = 2) { apiFailure = { code, error: 'Invalid API key' }; },
        elapse(seconds) { now += seconds * 1000; },
        tick(seconds = 0) { now += seconds * 1000; intervals.get(1000)(); },
        advance(seconds) {
            const end = now + seconds * 1000;
            const next = new Map([...intervals.keys()].map(delay => [delay, now + delay]));
            while (Math.min(...next.values()) <= end) {
                now = Math.min(...next.values());
                for (const [delay, due] of next) {
                    if (due !== now) continue;
                    intervals.get(delay)();
                    next.set(delay, due + delay);
                }
            }
            now = end;
        },
        setLife(value) { life.textContent = `${value}/${maximum}`; },
        setLifeAvailable(value) { life.isConnected = value; },
        setLifeText(value) { life.textContent = value; },
        setIconsAvailable(value) { strip.isConnected = value; },
        setActive(value) {
            focused = value;
            document.visibilityState = value ? 'visible' : 'hidden';
            documentListeners.get('visibilitychange')();
            windowListeners.get(value ? 'focus' : 'blur')();
        },
        statusChanged() { observers.forEach(callback => callback()); },
    };
}

test('saving an API key keeps it out of the page localStorage', async () => {
    const b = await browser();

    await b.saveKey('secret-key');

    assert.equal(JSON.parse(b.storage.get('cheap_medout_v2')).apiKey, undefined);
    assert.equal(b.storage.get('cheap_medout_api_v1'), undefined);
    assert.equal(b.secureStorage.get('cheap_medout_api_key_v1'), 'secret-key');
});

test('Torn PDA uses its injected API key instead of a stored desktop key', async () => {
    const b = await browser({ pda: true, pdaApiKey: 'pda-key', settings: { apiKey: 'desktop-key' } });

    const apiUrls = b.fetches.filter(call => call.url.startsWith('https://api.torn.com/'))
        .map(call => call.url);
    assert.ok(apiUrls.length > 0);
    assert.ok(apiUrls.every(url => url.includes('key=pda-key')));
});

test('Torn PDA shows its managed-key status instead of an API-key input', async () => {
    const b = await browser({ pda: true, pdaApiKey: 'pda-key' });

    assert.doesNotMatch(b.panelHtml(), /id="cm-key"/);
    assert.match(b.panelHtml(), /Using the API key provided by Torn PDA/i);
    assert.match(b.panelHtml(), /Minimal access required/i);
});

test('a legacy API key is migrated out of the page localStorage', async () => {
    const b = await browser({ settings: { apiKey: 'legacy-key', bloodType: 'ab+' } });

    assert.equal(JSON.parse(b.storage.get('cheap_medout_v2')).apiKey, undefined);
    assert.equal(JSON.parse(b.storage.get('cheap_medout_v2')).bloodType, 'ab+');
    assert.equal(b.secureStorage.get('cheap_medout_api_key_v1'), 'legacy-key');
});

test('legacy spend choices migrate to separate own and armoury profiles', async () => {
    const b = await browser({ settings: { exclude: [66], extraPct: 50 } });
    const saved = JSON.parse(b.storage.get('cheap_medout_v2'));

    assert.deepEqual(saved.excludeOwn, [66]);
    assert.deepEqual(saved.excludeArmoury, [66]);
    assert.equal('exclude' in saved, false);
    assert.equal('extraPct' in saved, false);
});

test('own items and faction armoury use independent spend profiles', async () => {
    const settings = {
        excludeOwn: [...BLOOD_BAG_IDS],
        excludeArmoury: [66, 67, 68],
    };
    const own = await browser({ settings, stock: { 68: 10, 739: 10 }, hospitalMinutes: 120 });
    const armoury = await browser({ armoury: true, settings,
        stock: { 68: 10, 739: 10 }, hospitalMinutes: 120 });

    assert.match(own.title('go'), /Small First Aid Kit/);
    assert.match(armoury.title('go'), /Blood Bag/);
});

test('unusable API keys and their cache are removed after an API error', async t => {
    for (const code of [2, 10, 13, 18]) await t.test(`error ${code}`, async () => {
        const secureStorage = new Map([['cheap_medout_api_v1', { apiKey: 'older-key' }]]);
        const b = await browser({ secureStorage });
        b.failApi(code);

        await b.saveKey('unusable-key');

        assert.equal(secureStorage.has('cheap_medout_api_key_v1'), false);
        assert.equal(secureStorage.has('cheap_medout_api_v1'), false);
    });
});

test('removing an API key deletes its secure storage copy', async () => {
    const secureStorage = new Map([['cheap_medout_api_key_v1', 'old-key']]);
    const b = await browser({ secureStorage });

    await b.saveKey('');

    assert.equal(secureStorage.has('cheap_medout_api_key_v1'), false);
});

test('without an API key the panel does not guess the inventory', async () => {
    const b = await browser({ hospitalMinutes: 20, settings: { apiKey: '' } });

    assert.equal(b.button('go').disabled, true);
    assert.equal(b.detail('go'), 'Minimal API key required for inventory');
    assert.equal(b.fetches.some(call => call.body?.get('step') === 'getCategoryList'), false);
});

test('the required-key notice cannot be dismissed and opens the focused API-key field', async () => {
    const b = await browser({ settings: { apiKey: '' } });

    assert.equal(b.text('flash-action'), 'Add API key');
    assert.equal(b.element('flash-action').hidden, false);
    assert.equal(b.element('flash-x').hidden, true);
    b.button('flash-x').click();
    assert.match(b.text('flash-text'), /Minimal API key required/i);

    b.button('flash-action').click();
    assert.equal(b.element('settings').classList.contains('cm-open'), true);
    assert.equal(b.element('key').focused, true);
});

test('personal inventory comes from the official v2 API without an internal inventory request', async () => {
    const b = await browser({ hospitalMinutes: 20 });

    assert.equal(b.fetches.some(call => call.url.includes('/v2/user/inventory')), true);
    assert.equal(b.fetches.some(call => call.body?.get('step') === 'getCategoryList'), false);
    assert.equal(b.button('go').disabled, false);
});

test('an unloaded armoury does not automatically request its medical inventory', async () => {
    const b = await browser({ armoury: true, armouryDomLoaded: false, hospitalMinutes: 20 });

    assert.equal(b.fetches.some(call => call.url.includes('/v2/faction/inventory')), false);
    assert.equal(b.fetches.some(call => call.body?.get('step') === 'armouryTabContent'), false);
    assert.equal(b.button('go').disabled, true);
    assert.equal(b.text('flash-action'), 'Load medical inventory');
});

test('the manual armoury load action makes one inventory request and enables planning', async () => {
    const b = await browser({ armoury: true, armouryDomLoaded: false, hospitalMinutes: 20 });

    await b.button('flash-action').click();
    await b.flush();

    const loads = b.fetches.filter(call => call.body?.get('step') === 'armouryTabContent');
    assert.equal(loads.length, 1);
    assert.equal(b.button('go').disabled, false);
});

test('a manually loaded armoury inventory survives reloads without expiring', async () => {
    const storage = new Map();
    const first = await browser({ armoury: true, armouryDomLoaded: false,
        hospitalMinutes: 20, storage });
    await first.button('flash-action').click();

    const reloaded = await browser({ armoury: true, armouryDomLoaded: false,
        hospitalMinutes: 20, storage, startNow: 1_900_000_000_000 });

    assert.equal(reloaded.fetches.some(call => call.body?.get('step') === 'armouryTabContent'), false);
    assert.equal(reloaded.button('go').disabled, false);
});

test('faction items used by the script stay deducted after a reload', async () => {
    const storage = new Map();
    const first = await browser({ armoury: true, hospitalMinutes: 20,
        stock: { 68: 1 }, storage });
    first.button('go').click();
    first.requests[0].finish();
    await first.flush();

    const reloaded = await browser({ armoury: true, armouryDomLoaded: false,
        hospitalMinutes: 20, stock: { 68: 1 }, storage });

    assert.equal(reloaded.fetches.some(call => call.body?.get('step') === 'armouryTabContent'), false);
    assert.equal(reloaded.button('go').disabled, true);
});

test('a failed manual armoury load stays blocked and offers a retry', async () => {
    const b = await browser({ armoury: true, armouryDomLoaded: false, hospitalMinutes: 20 });
    b.failStock();

    await b.button('flash-action').click();
    await b.flush();

    assert.equal(b.button('go').disabled, true);
    assert.equal(b.text('flash-action'), 'Load medical inventory');
    assert.equal(b.element('flash-action').hidden, false);
});

test('a loaded armoury medical tab supplies inventory without another request', async () => {
    const b = await browser({ armoury: true, armouryDomLoaded: true, hospitalMinutes: 20 });

    assert.equal(b.fetches.some(call => call.url.includes('/v2/faction/inventory')), false);
    assert.equal(b.fetches.some(call => call.body?.get('step') === 'armouryTabContent'), false);
    assert.equal(b.button('go').disabled, false);
});

test('armoury DOM items without an active Use action are not offered', async () => {
    const b = await browser({ armoury: true, armouryDomLoaded: true, hospitalMinutes: 20,
        stock: { 66: 1, 68: 1 }, unusableArmouryIds: [68] });

    assert.match(b.title('go'), /Morphine/);
});

test('a Minimal key enables medical planning with own and armoury inventory', async () => {
    const storage = new Map();
    const b = await browser({ armoury: true, hospitalMinutes: 20, accessLevel: 2, storage });

    assert.equal(b.fetches.some(call => call.url.includes('/v2/faction/inventory')), false);
    assert.equal(b.fetches.some(call => call.body?.get('step') === 'armouryTabContent'), false);
    assert.equal(b.button('go').disabled, false);
    assert.equal(b.secureStorage.get('cheap_medout_api_key_v1'), 'test-key');

    const own = await browser({ hospitalMinutes: 20, accessLevel: 2, storage });
    assert.equal(own.fetches.some(call => call.url.includes('/v2/user/inventory')), true);
    assert.equal(own.button('go').disabled, false);
});

test('saving a Minimal key accepts it for medical planning', async () => {
    const b = await browser({ armoury: true, accessLevel: 2, settings: { apiKey: '' } });

    await b.saveKey('minimal-key');

    assert.match(b.text('flash-text'), /Key works/i);
    assert.equal(b.secureStorage.get('cheap_medout_api_key_v1'), 'minimal-key');
});

test('a Public Only key cannot enable medical planning', async () => {
    const b = await browser({ hospitalMinutes: 20, accessLevel: 1 });

    assert.equal(b.fetches.some(call => call.url.includes('/v2/user/inventory')), false);
    assert.equal(b.button('go').disabled, true);
});

test('the API disclosure explains how faction stock is loaded', async () => {
    const b = await browser();

    assert.match(b.panelHtml(), /Faction stock/);
    assert.match(b.panelHtml(), /stored until you refresh it/i);
});

test('inventory API snapshots are reused until the next local clock hour', async () => {
    const storage = new Map();
    const first = await browser({ storage, hospitalMinutes: 20, stock: { 68: 1 } });
    const second = await browser({ storage, hospitalMinutes: 20, stock: { 68: 9 } });

    assert.equal(first.stockReads(), 1);
    assert.equal(second.stockReads(), 0);
});

test('locally reserved items stay deducted while Torn returns the same inventory snapshot', async () => {
    const storage = new Map();
    const snapshot = 1_800_000_000;
    const first = await browser({ storage, hospitalMinutes: 20, stock: { 68: 1 },
        inventoryTimestamp: snapshot });
    first.button('go').click();
    first.requests[0].finish();
    await first.flush();

    const stale = await browser({ storage, hospitalMinutes: 20, stock: { 68: 1 },
        inventoryTimestamp: snapshot });
    assert.equal(stale.button('go').disabled, true);

    const fresh = await browser({ storage, hospitalMinutes: 20, stock: { 68: 1 },
        inventoryTimestamp: snapshot + 3600, startNow: 1_800_003_600_000 });
    assert.equal(fresh.button('go').disabled, false);
});

test('a Minimal API key supplies the maximum cooldown without a medical cooldown icon', async () => {
    const b = await browser({ medicalIcon: false, settings: { apiKey: 'test-key' },
        accessLevel: 2, factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    assert.equal(b.text('cd'), '0m 00s / 9h 0m');
});

test('the sidebar maximum takes precedence over the API maximum', async () => {
    const b = await browser({ settings: { apiKey: 'test-key' },
        factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    assert.equal(b.text('cd'), '0m 00s / 6h 0m');
});

test('panel loads within the same clock hour reuse the perks response', async () => {
    const storage = new Map();
    const first = await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage,
        startNow: 1_800_000_600_000, factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    const second = await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage,
        startNow: 1_800_003_540_000, factionPerks: [] });
    assert.equal(first.apiReads(), 1);
    assert.equal(second.apiReads(), 0);
    assert.equal(second.text('cd'), '0m 00s / 9h 0m');
});

test('the perks cache expires at the start of the next clock hour', async () => {
    const storage = new Map();
    await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage,
        startNow: 1_800_003_540_000, factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    const nextHour = await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage,
        startNow: 1_800_003_600_000, factionPerks: [] });
    assert.equal(nextHour.apiReads(), 1);
    assert.equal(nextHour.text('cd'), '0m 00s / 6h 0m');
});

test('returning to a mounted panel after the hour boundary refreshes its perks', async () => {
    const b = await browser({ medicalIcon: false, settings: { apiKey: 'test-key' },
        factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    b.setActive(false);
    b.elapse(3600);
    b.setFactionPerks([]);
    b.setActive(true);
    await b.flush();
    assert.equal(b.apiReads(), 2);
    assert.equal(b.text('cd'), '0m 00s / 6h 0m');
});

test('a fractional-offset timezone expires on its local whole hour', async () => {
    const storage = new Map();
    await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage,
        startNow: 1_800_003_540_000, timezoneOffsetMinutes: 345,
        factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    const sameLocalHour = await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage,
        startNow: 1_800_003_600_000, timezoneOffsetMinutes: 345, factionPerks: [] });
    assert.equal(sameLocalHour.apiReads(), 0);
    assert.equal(sameLocalHour.text('cd'), '0m 00s / 9h 0m');
});

test('a different API key does not reuse the current hour cache', async () => {
    const storage = new Map();
    await browser({ medicalIcon: false, settings: { apiKey: 'first-key' }, storage,
        factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    storage.secureStorage.set('cheap_medout_api_key_v1', 'second-key');
    const changed = await browser({ medicalIcon: false, storage,
        factionPerks: [] });
    assert.equal(changed.apiReads(), 1);
    assert.equal(changed.text('cd'), '0m 00s / 6h 0m');
});

test('a late response from an old API key cannot overwrite the new key cache', async () => {
    const storage = new Map();
    const b = await browser({ medicalIcon: false, settings: { apiKey: 'first-key' }, storage,
        factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    b.tick(3600);
    b.holdNextApi();
    const oldRefresh = b.button('refresh').click();
    await b.flush();
    b.setFactionPerks([]);
    await b.saveKey('second-key');
    b.apiResponses[0]();
    await oldRefresh;
    const reloaded = await browser({ medicalIcon: false, settings: { apiKey: 'second-key' }, storage,
        startNow: 1_800_003_600_000, factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    assert.equal(reloaded.apiReads(), 0);
    assert.equal(reloaded.text('cd'), '0m 00s / 6h 0m');
});

test('a perks request crossing the hour boundary refetches for the new hour', async () => {
    const storage = new Map();
    const b = await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage,
        factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    b.elapse(7140);
    b.setFactionPerks([]);
    b.holdNextApi();
    const refresh = b.button('refresh').click();
    await b.flush();
    b.elapse(60);
    b.apiResponses[0]();
    await refresh;
    assert.equal(b.apiReads(), 3);
    const reloaded = await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage,
        startNow: 1_800_007_200_000, factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    assert.equal(reloaded.apiReads(), 0);
    assert.equal(reloaded.text('cd'), '0m 00s / 6h 0m');
});

test('overlapping refreshes share one perks request for the hour', async () => {
    const b = await browser({ settings: { apiKey: 'test-key' } });
    b.elapse(3600);
    b.holdNextApi();
    const first = b.button('refresh').click();
    await b.flush();
    const second = b.button('refresh').click();
    await b.flush();
    assert.equal(b.apiReads(), 2);
    b.apiResponses[0]();
    await Promise.all([first, second]);
});

test('an invalid current-hour perks cache is ignored', async () => {
    const storage = new Map();
    await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage,
        factionPerks: ['+ 180 minutes maximum medical cooldown'] });
    const cached = storage.secureStorage.get('cheap_medout_api_v1');
    storage.secureStorage.set('cheap_medout_api_v1', { ...cached, detectedEffectiveness: '50' });
    const b = await browser({ medicalIcon: false, settings: { apiKey: 'test-key' }, storage });
    assert.equal(b.apiReads(), 1);
    assert.equal(b.text('cd'), '0m 00s / 6h 0m');
});

test('full life waits for a readable life bar and recovers when it becomes available', async () => {
    const b = await browser({ current: 2000, lifeAvailable: false, stock: { 68: 3, 739: 10 } });
    assert.equal(b.text('life'), '—');
    assert.equal(b.button('full').disabled, true);
    assert.equal(b.hint('full'), '');
    b.button('full').click(); b.button('full').click();
    assert.equal(b.requests.length, 0);
    b.setLifeAvailable(true); b.tick();
    assert.equal(b.button('full').disabled, true, 'full health needs no medication');
    b.setLife(1900); b.tick();
    assert.equal(b.button('full').disabled, false);
    b.button('full').click();
    assert.deepEqual(b.requests.map(r => r.id), [68]);
});

test('Torn PDA reads life from the sidebar session data when its life bar is absent', async () => {
    const b = await browser({ lifeAvailable: false, pda: true, pdaApiKey: 'test-key',
        sidebarLife: { amount: 1200, max: 2000 }, stock: { 68: 30 } });

    assert.equal(b.text('life'), '1200/2000');
    assert.equal(b.button('full').disabled, false);
});

test('full life rechecks a disappearing life bar before another predicted use', async () => {
    const b = await browser({ current: 1800, stock: { 68: 30 } });
    b.button('full').click();
    assert.equal(b.button('full').disabled, false);
    b.setLifeAvailable(false);
    b.button('full').click();
    assert.equal(b.button('full').disabled, true);
    assert.equal(b.hint('full'), '');
    assert.equal(b.requests.length, 1, 'a pending heal does not substitute for a readable life bar');
});

test('unreadable life text blocks full life while hospital-only medout remains usable', async () => {
    const b = await browser({ hospitalMinutes: 20, stock: { 68: 30 } });
    b.setLifeText('Loading…'); b.tick();
    assert.equal(b.button('full').disabled, true);
    assert.equal(b.button('go').disabled, false);
    b.button('go').click();
    assert.deepEqual(b.requests.map(r => r.id), [68]);
});

test('hospital and medical clocks do not round the remaining second upward', async () => {
    const b = await browser({ hospitalMinutes: 20, cooldownMinutes: 30 });
    b.tick(0.2);
    assert.equal(b.text('hosp'), '19m 59s');
    assert.match(b.text('cd'), /^29m 59s \/ /);
});

test('visible clocks update between full planning ticks without rounding down the hospital plan', async () => {
    const b = await browser({ stock: { 68: 1, 67: 1 },
        hospitalMinutes: 20 + 0.8 / 60, cooldownMinutes: 30 + 0.8 / 60 });
    assert.match(b.title('go'), /First Aid Kit/);
    b.advance(0.9);
    assert.equal(b.text('hosp'), '19m 59s');
    assert.match(b.text('cd'), /^29m 59s \/ /);
    b.tick();
    assert.match(b.title('go'), /Small First Aid Kit/);
});

test('rapid full-life clicks dispatch the whole locally predicted path before any response', async () => {
    const b = await browser();
    b.button('full').click();
    assert.match(b.title('full'), /Blood Bag/);
    b.button('full').click();
    assert.deepEqual(b.requests.map(r => r.id), [68, 739]);
    b.button('full').click();
    assert.equal(b.requests.length, 2, 'the local life prediction prevents an unnecessary third use');
    b.requests[1].finish();
    await b.flush();
    assert.equal(b.stockReads(), 1, 'do not reconcile stock while other uses are pending');
    b.requests[0].finish();
    await b.flush();
    assert.equal(b.stockReads(), 1, 'reconcile against the cached API snapshot after the last response');
    assert.equal(b.button('full').disabled, true, 'predicted full life needs no further item');
    b.setLife(1400); b.tick();
    assert.equal(b.button('full').disabled, true);
    b.setLife(2000); b.tick();
    assert.equal(b.button('full').disabled, true);
});

test('medout can dispatch its second item while the first response is still pending', async () => {
    const b = await browser({ stock: { 68: 1, 739: 2 }, hospitalMinutes: 130 });
    b.button('go').click(); b.button('go').click();
    assert.deepEqual(b.requests.map(r => r.id), [68, 739]);
    assert.equal(b.text('hosp'), 'none');
    b.requests[1].finish(); await b.flush();
    b.requests[0].finish(false); await b.flush();
    assert.match(b.text('hosp'), /10m/, 'only the refused SFAK is undone, retaining the bag');
    assert.match(b.title('go'), /Small First Aid Kit/);
    assert.match(b.text('cd'), /^30m/);
});

test('a failed early heal retains a later heal including life beyond the full-life cap', async () => {
    const b = await browser({ stock: { 67: 2, 739: 2 }, current: 1300 });
    b.button('full').click(); b.button('full').click();
    assert.deepEqual(b.requests.map(r => r.id), [67, 739]);
    b.requests[1].finish(); await b.flush();
    b.requests[0].finish(false); await b.flush();
    assert.match(b.title('full'), /First Aid Kit/);
    assert.equal(b.detail('full'), '15m cooldown');
    assert.match(b.text('cd'), /^30m/);
});

test('switching from medout to full life uses the healing predicted by the pending medout', async () => {
    const b = await browser({ stock: { 68: 2, 739: 2 }, hospitalMinutes: 20 });
    b.button('go').click(); b.button('full').click();
    assert.deepEqual(b.requests.map(r => r.id), [68, 739]);
    assert.equal(b.button('full').disabled, true);
});

test('an older inventory response cannot restore items reserved by rapid clicks', async () => {
    const b = await browser({ stock: { 68: 1, 739: 1 } });
    b.tick(3600); b.holdStock(); b.button('refresh').click(); b.tick(); await b.flush();
    b.button('full').click(); b.button('full').click();
    assert.equal(b.requests.length, 2);
    b.stockResponses[0](); await b.flush();
    b.sidebar.hospital = 1_800_000_000 + 1200; b.statusChanged();
    assert.equal(b.button('go').disabled, true, 'both items are still reserved locally');
});

test('all overlapping failures restore the original plan regardless of response order', async () => {
    for (const order of [[0, 1], [1, 0]]) {
        const b = await browser({ stock: { 68: 1, 739: 1 }, hospitalMinutes: 130 });
        b.button('go').click(); b.button('go').click();
        assert.equal(b.requests.length, 2);
        for (const index of order) { b.requests[index].finish(false); await b.flush(); }
        assert.match(b.text('hosp'), /2h.*10m/);
        assert.match(b.text('cd'), /^0m/);
        assert.equal(b.detail('go'), 'SFAK → Bag · 40m CD');
        assert.equal(b.button('go').disabled, false);
    }
});

test('a late failure after sidebar catch-up does not overwrite authoritative life', async () => {
    const b = await browser();
    b.button('full').click(); b.button('full').click();
    b.setLife(2000); b.tick();
    b.requests[1].finish(); await b.flush();
    b.requests[0].finish(false); await b.flush();
    assert.equal(b.button('full').disabled, true);
});

test('legacy extra medical effect no longer changes planning', async () => {
    const b = await browser({ stock: { 68: 2 }, current: 1850, settings: { extraPct: 50 } });
    assert.equal(b.detail('full'), '2× SFAK · 20m CD');
});

test('the panel offers the feasible alternative near the cooldown cap', async () => {
    const b = await browser({ stock: { 67: 1, 68: 1, 739: 1 }, hospitalMinutes: 60,
        cooldownMinutes: 350, settings: { exclude: [66] } });
    assert.equal(b.button('go').disabled, false);
    assert.match(b.title('go'), /Blood Bag/);
});

test('a new hospitalization replaces a pending release prediction without an observed discharge', async () => {
    const b = await browser({ stock: { 66: 5, 739: 5 }, hospitalMinutes: 60 });
    b.button('go').click();
    b.requests[0].finish(); await b.flush();
    assert.equal(b.text('hosp'), 'none');
    b.sidebar.hospital += 3600;
    b.statusChanged();
    assert.match(b.text('hosp'), /2h/);
    assert.equal(b.button('go').disabled, false);
});

test('a refused use restores the full-life plan and stock', async () => {
    const b = await browser({ stock: { 68: 1, 739: 1 } });
    b.button('full').click();
    b.requests[0].finish(false); await b.flush();
    assert.match(b.title('full'), /Small First Aid Kit/);
    assert.equal(b.button('full').disabled, false);
});

test('a refused second item retains the first successful heal while the sidebar lags', async () => {
    const b = await browser();
    b.button('full').click(); b.requests[0].finish(); await b.flush();
    b.button('full').click(); b.requests[1].finish(false); await b.flush();
    assert.match(b.title('full'), /Blood Bag/);
    assert.equal(b.detail('full'), '30m cooldown');
});

test('a failed request cannot restore predictions belonging to an earlier hospitalization', async () => {
    const b = await browser({ stock: { 66: 5, 739: 5 }, hospitalMinutes: 60 });
    b.button('go').click();
    b.sidebar.hospital += 3600; b.statusChanged();
    b.requests[0].finish(false); await b.flush();
    assert.match(b.text('hosp'), /2h/);
    assert.equal(b.button('go').disabled, false);
});

test('a life drop resets a release prediction even when the new hospital stay is shorter', async () => {
    const b = await browser({ stock: { 66: 5, 739: 5 }, hospitalMinutes: 60 });
    b.button('go').click(); b.requests[0].finish(); await b.flush();
    b.sidebar.hospital -= 1800; b.setLife(1); b.statusChanged();
    assert.match(b.text('hosp'), /30m/);
    assert.equal(b.button('go').disabled, false);
});

test('an unconfirmed prediction eventually yields to the sidebar instead of hiding hospital forever', async () => {
    const b = await browser({ stock: { 66: 5, 739: 5 }, hospitalMinutes: 60 });
    b.button('go').click(); b.requests[0].finish(); await b.flush();
    b.sidebar.hospital -= 1800; b.tick(60);
    assert.match(b.text('hosp'), /29m/);
    assert.equal(b.button('go').disabled, false);
});

test('partial hospital updates retain the remaining release prediction', async () => {
    const b = await browser({ stock: { 68: 1, 739: 2 }, hospitalMinutes: 130 });
    b.button('go').click(); b.requests[0].finish(); await b.flush();
    b.button('go').click(); b.requests[1].finish(); await b.flush();
    b.sidebar.hospital -= 1200; b.tick();
    assert.equal(b.text('hosp'), 'none');
    assert.equal(b.button('go').disabled, true);
});

test('no plan is offered at the cap or when even the cheapest last-step prefix does not fit', () => {
    for (const result of [
        plan(60, 0, 0, MEDS, { 739: 2 }, 'o-', { cooldownNow: 360, maxCooldown: 360 }),
        plan(130, 0, 0, MEDS, { 68: 1, 739: 1 }, 'o-', { cooldownNow: 350, maxCooldown: 360 }),
    ]) {
        assert.equal(result.error, 'Med CD full, wait 1m');
        assert.equal(result.wait, 1);
        assert.equal(result.items, undefined);
    }
    assert.deepEqual(plan(130, 0, 0, MEDS, { 68: 1, 739: 1 }, 'o-',
        { cooldownNow: 349, maxCooldown: 360 }).items.map(m => m.id), [68, 739]);
});

test('a cooldown wait never assumes existing cooldown can fall below zero', () => {
    const after = wait => plan(1000 - wait, 0, 0, MEDS, { 68: 100 }, 'o-',
        { cooldownNow: 0, maxCooldown: 360 });
    const result = after(0);
    assert.equal(result.wait, 280);
    assert.equal(result.error, 'Med CD full, wait 4h 40m');
    assert.ok(after(result.wait - 1).error);
    assert.equal(after(result.wait).items.length, 36);
});

test('button waits count down for the whole plan across the cooldown cap', async () => {
    const b = await browser({ stock: { 66: 10 }, hospitalMinutes: 140,
        cooldownMinutes: 361, current: 1000, maximum: 2000 });
    assert.equal(b.detail('go'), 'Med CD full, wait 22m');
    assert.equal(b.detail('full'), 'Med CD full, wait 1h 2m');
    b.tick(60);
    assert.equal(b.detail('go'), 'Med CD full, wait 21m');
    assert.equal(b.detail('full'), 'Med CD full, wait 1h 1m');
    b.tick(1);
    assert.equal(b.detail('go'), 'Med CD full, wait 20m');
    assert.equal(b.detail('full'), 'Med CD full, wait 1h 0m');
    b.button('go').click();
    b.button('full').click();
    assert.equal(b.requests.length, 0, 'both plans remain blocked below the cap');
    b.tick(1200);
    assert.equal(b.button('go').disabled, false);
    assert.equal(b.button('full').disabled, true);
});

test('the cooldown wait accounts for a shorter hospital stay before cooldown reaches zero', () => {
    const result = plan(130, 0, 0, MEDS, { 68: 1, 739: 1 }, 'o-',
        { cooldownNow: 365, maxCooldown: 360 });
    assert.equal(result.wait, 10);
    assert.deepEqual(plan(120, 0, 0, MEDS, { 68: 1, 739: 1 }, 'o-',
        { cooldownNow: 355, maxCooldown: 360 }).items.map(item => item.id), [739]);
});

test('a life goal that cannot fit even at zero cooldown gets no invented wait', () => {
    const result = plan(0, 100, 0, MEDS, { 68: 20 }, 'o-',
        { cooldownNow: 0, maxCooldown: 60 });
    assert.ok(result.error);
    assert.equal(result.wait, undefined);
});

test('saving an API key enables regeneration hints immediately', async () => {
    const b = await browser({ current: 1900, stock: { 68: 3 }, settings: { apiKey: '' } });
    assert.equal(b.hint('full'), '');
    await b.saveKey('test-key');
    assert.match(b.hint('full'), /No items<\/strong> · 0m CD/);
});

test('removing an API key clears previously loaded regeneration hints', async () => {
    const b = await browser({ current: 1900, stock: { 68: 3 }, medicalIcon: false,
        factionPerks: ['+ 180 minutes maximum medical cooldown'], settings: { apiKey: 'test-key' } });
    assert.match(b.hint('full'), /No items<\/strong> · 0m CD/);
    assert.equal(b.text('cd'), '0m 00s / 9h 0m');
    await b.saveKey('');
    assert.equal(b.hint('full'), '');
    assert.equal(b.text('cd'), '0m 00s / 6h 0m?');
});

test('replacing a valid API key with an invalid key clears its maximum cooldown', async () => {
    const b = await browser({ medicalIcon: false,
        factionPerks: ['+ 180 minutes maximum medical cooldown'], settings: { apiKey: 'test-key' } });
    assert.equal(b.text('cd'), '0m 00s / 9h 0m');
    b.failApi();
    await b.saveKey('invalid-key');
    assert.equal(b.apiReads(), 2);
    assert.equal(b.text('cd'), '0m 00s / 6h 0m?');
});

test('a failed API refresh clears its previously loaded maximum cooldown', async () => {
    const b = await browser({ medicalIcon: false,
        factionPerks: ['+ 180 minutes maximum medical cooldown'], settings: { apiKey: 'test-key' } });
    assert.equal(b.text('cd'), '0m 00s / 9h 0m');
    b.tick(3600);
    b.failApi();
    await b.button('refresh').click();
    assert.equal(b.text('cd'), '0m 00s / 6h 0m?');
});

test('the wait suggestion shows the same seconds as the hospital clock', async () => {
    const b = await browser({ stock: { 68: 1, 739: 1 }, hospitalMinutes: 128 + 23.6 / 60, current: 1800 });
    assert.equal(b.text('hosp'), '2h 08m 23s');
    assert.match(b.hint('go'), /Wait <span class="cm-wait-time"[^>]*>8m 23s<\/span>/);
});

test('the separate wait suggestion names the future path and clears after using the current step', async () => {
    const b = await browser({ stock: { 68: 1, 739: 1 }, hospitalMinutes: 128, current: 1800 });
    assert.equal(b.detail('go'), 'SFAK → Bag · 40m CD');
    assert.match(b.hint('go'), /Wait <span class="cm-wait-time"[^>]*>8m 00s<\/span> → <strong>Bag<\/strong> · 30m CD/);
    assert.match(b.hint('full'), /→ <strong>Bag<\/strong> · 30m CD/);
    b.button('go-hint').click();
    assert.equal(b.requests.length, 0, 'the suggestion does not dispatch an item');
    b.button('go').click();
    assert.deepEqual(b.requests.map(request => request.id), [68]);
    assert.match(b.title('go'), /Blood Bag/);
    assert.equal(b.hint('go'), '');
});

test('the wait suggestion shows the complete future path when it needs several items', async () => {
    const b = await browser({ stock: { 68: 1, 739: 3 }, hospitalMinutes: 248 });
    assert.match(b.hint('go'), /→ <strong>2× Bag<\/strong> · 60m CD/);
});

test('fractional healing sums do not demand another item because of floating-point residue', () => {
    const result = plan(0, 66.3, 2, MEDS, { 68: 1, 739: 2 }, 'o-');
    assert.deepEqual(result.items.map(m => m.id), [68, 739, 739]);
});

test('a frozen life bar cannot offer more healing after the hospital prediction timeout', async () => {
    const b = await browser();
    b.button('full').click(); b.requests[0].finish(); await b.flush();
    b.button('full').click(); b.requests[1].finish(); await b.flush();
    b.tick(16);
    assert.equal(b.button('full').disabled, true);
    b.button('full').click();
    assert.equal(b.requests.length, 2);
    b.setLife(1400); b.tick(16);
    assert.equal(b.button('full').disabled, true);
    b.setLife(2000); b.tick();
    b.setLife(1800); b.tick();
    assert.equal(b.button('full').disabled, false, 'real damage makes healing useful again');
});

test('a lost response preserves the reservation and pauses both buttons until status confirms use', async () => {
    const b = await browser({ current: 1900, stock: { 68: 3 } });
    b.button('full').click(); b.requests[0].loseResponse(); await b.flush();
    assert.equal(b.button('full').disabled, true);
    assert.equal(b.button('go').disabled, true);
    assert.match(b.text('cd'), /^10m/);
    assert.equal(b.stockReads(), 1, 'wait five seconds before the recovery request');
    b.button('full').click();
    assert.equal(b.requests.length, 1);
    b.tick(5); await b.flush();
    assert.equal(b.stockReads(), 1, 'recovery reuses the hourly API snapshot');
    assert.equal(b.button('full').disabled, true, 'inventory alone must not unlock use');
    b.setLife(2000); b.sidebar.cooldown = 1_800_000_600;
    b.tick(5); await b.flush();
    assert.equal(b.stockReads(), 1);
    assert.match(b.text('flash-text'), /confirmed/i);
    assert.equal(b.button('full').disabled, true, 'full health does not need another item');
    b.setLife(1900); b.tick(); b.button('full').click();
    assert.equal(b.requests.length, 2, 'new damage is actionable after reconciliation');
});

test('slow requests allow rapid planned clicks until five seconds, then pause without replaying', async () => {
    const b = await browser({ hospitalMinutes: 250, stock: { 739: 5 } });
    b.button('go').click();
    b.tick(4); b.button('go').click();
    assert.equal(b.requests.length, 2);
    assert.equal(b.button('go').disabled, false);
    b.tick(1); await b.flush();
    assert.equal(b.button('go').disabled, true);
    assert.equal(b.button('full').disabled, true);
    assert.equal(b.stockReads(), 1);
    b.button('go').click();
    assert.equal(b.requests.length, 2);
    b.tick(5); await b.flush();
    assert.equal(b.stockReads(), 1);
    b.tick(60); await b.flush();
    assert.equal(b.stockReads(), 1, 'automatic recovery checks do not bypass the hourly API cache');
    assert.match(b.text('flash-text'), /unable to confirm/i);
    assert.equal(b.requests.length, 2, 'checks never repeat an item-use request');
});

test('late explicit results end recovery and undo only the refused item', async () => {
    const b = await browser({ hospitalMinutes: 130, stock: { 68: 2, 739: 2 } });
    b.button('go').click(); b.button('go').click();
    b.tick(5); await b.flush();
    assert.equal(b.button('go').disabled, true);
    b.requests[1].finish(); await b.flush();
    assert.equal(b.button('go').disabled, true, 'the other request remains unresolved');
    b.requests[0].finish(false); await b.flush();
    assert.equal(b.button('go').disabled, false);
    assert.match(b.title('go'), /Small First Aid Kit/);
    assert.match(b.text('cd'), /^29m/);
    b.button('go').click();
    assert.deepEqual(b.requests.map(r => r.id), [68, 739, 68]);
});

test('a partial rapid-use update cannot clear recovery for the whole sequence', async () => {
    const b = await browser({ hospitalMinutes: 130, stock: { 68: 2, 739: 2 } });
    b.button('go').click(); b.button('go').click();
    b.requests[0].loseResponse(); b.requests[1].consume(); await b.flush();
    b.sidebar.hospital -= 1200; b.sidebar.cooldown = 1_800_000_600; b.setLife(1400);
    b.tick(5); await b.flush();
    assert.equal(b.button('go').disabled, true);
    b.sidebar.hospital = 0; b.sidebar.cooldown = 1_800_002_400; b.setLife(2000);
    b.tick(5); await b.flush();
    assert.match(b.text('flash-text'), /confirmed/i);
    b.setLife(1900); b.tick(); b.button('full').click();
    assert.deepEqual(b.requests.map(r => r.id), [68, 739, 68]);
    b.requests[1].finish(false); await b.flush();
    assert.equal(b.button('full').disabled, true, 'a late result cannot undo the new use or observed healing');
    b.requests[2].finish(); await b.flush();
    assert.equal(b.button('full').disabled, true);
});

test('unexpected JSON, invalid JSON and HTTP errors all pause without rollback', async () => {
    for (const respond of [r => r.reply({}), r => r.reply(null), r => r.invalidJSON(), r => r.httpError()]) {
        const b = await browser({ hospitalMinutes: 130, stock: { 739: 3 } });
        b.button('go').click(); respond(b.requests[0]); await b.flush();
        assert.equal(b.button('go').disabled, true);
        assert.equal(b.button('full').disabled, true);
        assert.match(b.text('hosp'), /^10m/);
        assert.match(b.text('cd'), /^30m/);
        assert.equal(b.requests.length, 1);
    }
});

test('failed recovery reads stay paused and the refresh button can check again', async () => {
    const b = await browser({ current: 1900, stock: { 68: 3 } });
    b.button('full').click(); b.requests[0].loseResponse(); await b.flush();
    b.failStock();
    b.tick(5); await b.flush(); b.tick(5); await b.flush();
    assert.equal(b.button('full').disabled, true);
    assert.match(b.text('flash-text'), /unable to confirm/i);
    b.failStock(false); b.setLife(2000); b.sidebar.cooldown = 1_800_000_600;
    b.button('refresh').click(); await b.flush();
    assert.match(b.text('flash-text'), /confirmed/i);
    b.setLife(1900); b.tick();
    assert.equal(b.button('full').disabled, false);
});

test('recovery checks reuse cached API inventory and require matching status data', async () => {
    const b = await browser({ current: 1900, stock: { 68: 3 } });
    b.button('full').click(); b.requests[0].loseResponse(); await b.flush();
    b.tick(5); await b.flush();
    assert.equal(b.stockReads(), 1);
    assert.doesNotMatch(b.text('flash-text'), /Item use confirmed/);
    b.setLife(2000); b.sidebar.cooldown = 1_800_000_600;
    b.tick(5); await b.flush();
    assert.match(b.text('flash-text'), /Item use confirmed/);
    assert.equal(b.stockReads(), 1);
});

test('two inconclusive cached recovery checks stop automatically and allow a manual check', async () => {
    const b = await browser({ current: 1900, stock: { 68: 3 } });
    b.button('full').click(); b.requests[0].loseResponse(); await b.flush();
    for (let i = 0; i < 4; i++) { b.tick(5); await b.flush(); }
    assert.equal(b.stockReads(), 1);
    assert.match(b.text('flash-text'), /Unable to confirm/);
    b.tick(60); await b.flush();
    assert.equal(b.stockReads(), 1);
    assert.equal(b.button('full').disabled, true);
    b.setLife(2000); b.sidebar.cooldown = 1_800_000_600;
    b.button('refresh').click(); await b.flush();
    assert.match(b.text('flash-text'), /Item use confirmed/);
});

test('recovery requires readable life and icons even when the inventory matches', async () => {
    for (const hide of [b => b.setLifeAvailable(false), b => b.setIconsAvailable(false)]) {
        const b = await browser({ current: 1900, stock: { 68: 3 } });
        b.button('full').click(); b.requests[0].loseResponse(); await b.flush();
        b.setLife(2000); b.sidebar.cooldown = 1_800_000_600; hide(b);
        b.tick(5); await b.flush();
        assert.doesNotMatch(b.text('flash-text'), /Item use confirmed/);
        assert.equal(b.button('full').disabled, true);
        b.setLifeAvailable(true); b.setIconsAvailable(true);
        b.tick(5); await b.flush();
        assert.match(b.text('flash-text'), /Item use confirmed/);
    }
});

test('recovery accounts for an explicit refusal alongside a consumed item with a lost response', async () => {
    const b = await browser({ hospitalMinutes: 130, stock: { 68: 2, 739: 2 } });
    b.button('go').click(); b.button('go').click();
    b.requests[0].finish(false); b.requests[1].loseResponse(); await b.flush();
    b.sidebar.hospital -= 7200; b.sidebar.cooldown = 1_800_001_800; b.setLife(1900);
    b.tick(5); await b.flush();
    assert.match(b.text('flash-text'), /Item use confirmed/);
    assert.equal(b.button('go').disabled, false);
    assert.match(b.title('go'), /Small First Aid Kit/);
    b.button('go').click();
    assert.deepEqual(b.requests.map(r => r.id), [68, 739, 68]);
});

test('an inactive tab performs no recovery polls and catches overdue requests on return', async () => {
    const b = await browser({ hospitalMinutes: 250, stock: { 739: 5 } });
    b.button('go').click(); b.setActive(false); b.advance(20); await b.flush();
    assert.equal(b.stockReads(), 1);
    b.setActive(true); await b.flush();
    assert.equal(b.button('go').disabled, true);
    assert.equal(b.stockReads(), 1, 'recovery and focus reuse the hourly API snapshot');
});

test('armoury recovery preserves rapid use without an automatic inventory request', async () => {
    const b = await browser({ armoury: true, hospitalMinutes: 130, stock: { 68: 2, 739: 2 } });
    b.button('go').click(); b.button('go').click();
    assert.deepEqual(b.requests.map(r => r.id), [68, 739]);
    b.requests[0].loseResponse(); b.requests[1].finish(); await b.flush();
    b.sidebar.hospital = 0; b.sidebar.cooldown = 1_800_002_400; b.setLife(2000);
    b.tick(5); await b.flush();
    assert.match(b.text('flash-text'), /Item use confirmed/);
    assert.equal(b.stockReads(), 0);
    assert.equal(b.requests.length, 2);
    assert.equal(b.button('full').disabled, true);
});

test('recovery after an earlier successful use compares whole hit points consistently', async () => {
    const b = await browser({ maximum: 1625, current: 1000, hospitalMinutes: 40, stock: { 68: 10 } });
    b.button('go').click(); b.requests[0].finish(); await b.flush();
    b.button('go').click(); b.requests[1].loseResponse(); await b.flush();
    b.sidebar.hospital = 0; b.sidebar.cooldown = 1_800_001_200; b.setLife(1162);
    b.tick(5); await b.flush();
    assert.match(b.text('flash-text'), /Item use confirmed/);
    assert.equal(b.button('full').disabled, false);
});

test('an inactive recovery remains paused until the page is active again', async () => {
    const b = await browser({ current: 1900, stock: { 68: 3 } });
    b.button('full').click(); b.requests[0].loseResponse(); await b.flush();
    b.setActive(false); b.advance(10);
    b.setLife(2000); b.sidebar.cooldown = 1_800_000_600;
    assert.doesNotMatch(b.text('flash-text'), /Item use confirmed/);
    b.setActive(true); await b.flush();
    assert.match(b.text('flash-text'), /Item use confirmed/);
    assert.equal(b.stockReads(), 1);
});
