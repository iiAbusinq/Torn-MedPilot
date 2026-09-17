// ==UserScript==
// @name         MedPilot
// @namespace    https://github.com/iiAbusinq
// @version      1.0
// @description  Cheapest medical items cooldown-wise: one button to leave hospital, one to leave hospital at full life. Own items on item.php, faction armoury on factions.php
// @author       AlbertoStegeman
// @license      MIT
// @match        https://www.torn.com/item.php*
// @match        https://www.torn.com/factions.php?step=your*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-end
// ==/UserScript==

(function bootstrap() {
    'use strict';

    const PDA_API_KEY = '###PDA-APIKEY###';
    const BAG_ID = {
        'A+': 732, 'A-': 733, 'B+': 734, 'B-': 735, 'AB+': 736, 'AB-': 737, 'O+': 738, 'O-': 739,
    };
    const BLOOD_BAG_IDS = Object.values(BAG_ID);

    const ALLOWED_BLOOD = Object.fromEntries(Object.entries({
        'o+': ['O+', 'O-'],
        'o-': ['O-'],
        'a+': ['A+', 'A-', 'O+', 'O-'],
        'a-': ['A-', 'O-'],
        'b+': ['B+', 'B-', 'O+', 'O-'],
        'b-': ['B-', 'O-'],
        'ab+': ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
        'ab-': ['A-', 'B-', 'AB-', 'O-'],
    }).map(([type, take]) => [type, take.map(t => BAG_ID[t])]));

    const MEDS = [
        { id: 66, name: 'Morphine', short: 'Morphine', hospital: 70, life: 15, cooldown: 20 },
        { id: 67, name: 'First Aid Kit', short: 'FAK', hospital: 40, life: 10, cooldown: 15 },
        { id: 68, name: 'Small First Aid Kit', short: 'SFAK', hospital: 20, life: 5, cooldown: 10 },
        ...Object.entries(BAG_ID).map(([type, id]) =>
            ({ id, name: `Blood Bag : ${type}`, short: 'Bag', hospital: 120, life: 30, cooldown: 30 })),
    ];

    const TOGGLEABLE = MEDS.filter(med => !BLOOD_BAG_IDS.includes(med.id));
    const SPEND_OPTIONS = [
        ...TOGGLEABLE.map(item => ({ short: item.short, ids: [item.id] })),
        { short: 'Blood bags', ids: BLOOD_BAG_IDS },
    ];

    const PERK_RE = /\+\s*(\d+)%\s*medical item effectiveness/i;
    const MAX_MEDICAL_COOLDOWN_RE = /\+\s*(\d+)\s*minutes?\s+maximum medical cooldown/i;

    const UNUSABLE_API_KEY_ERRORS = new Set([2, 10, 13, 18]);

    const DEFAULT_MAX_COOLDOWN = 360;

    const SETTINGS_KEY = 'cheap_medout_v2';
    const API_KEY_KEY = 'cheap_medout_api_key_v1';
    const API_CACHE_KEY = 'cheap_medout_api_v1';
    const INVENTORY_CACHE_KEY = 'cheap_medout_inventory_v1';
    const INVENTORY_USE_KEY = 'cheap_medout_inventory_uses_v1';

    const HINT_MIN_SAVING = 5;
    const HINT_MAX_WAIT = 15;
    const USE_CONFIRMATION_TIMEOUT_MS = 5000;
    const MAX_AUTO_RECOVERY_CHECKS = 2;
    const PREDICTION_GRACE_MS = 15000;


    const byStartOrder = items => items.slice().sort((one, other) => one.cooldown - other.cooldown);

    const predictedHospital = (sidebarStamp, target) =>
        (target ? Math.min(sidebarStamp, target) : sidebarStamp);
    const predictedCooldown = (sidebarStamp, target) =>
        (target ? Math.max(sidebarStamp, target) : sidebarStamp);

    const asClock = (minutes, round = Math.round) => {
        const total = Math.max(0, round(minutes * 60));
        const pad = value => String(value).padStart(2, '0');
        const seconds = pad(total % 60);
        const mins = Math.floor(total / 60) % 60;
        const hours = Math.floor(total / 3600);
        return hours
            ? `${hours}h ${pad(mins)}m ${seconds}s`
            : `${mins}m ${seconds}s`;
    };

    const asDuration = minutes => (minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`
        : `${Math.round(minutes)}m`);

    function firstCheaperWait(cooldownAfter, maxWait, cooldownNow) {
        if (cooldownAfter(maxWait) >= cooldownNow) return null;
        let tooSoon = 0, cheap = maxWait;
        while (cheap - tooSoon > 1 / 60) {
            const mid = (tooSoon + cheap) / 2;
            if (cooldownAfter(mid) < cooldownNow) cheap = mid;
            else tooSoon = mid;
        }
        return cheap;
    }

    function lifeAfterWaiting(life, waitMinutes, regen, secondsToNext) {
        if (!regen || !life) return life;
        const waited = waitMinutes * 60;
        const crossed = waited < secondsToNext ? 0
            : Math.floor((waited - secondsToNext) / regen.interval) + 1;
        return { current: Math.min(life.maximum, life.current + crossed * regen.increment),
            maximum: life.maximum };
    }

    function pathLabel(items) {
        const runs = [];
        for (const item of items) {
            const last = runs[runs.length - 1];
            if (last && last.short === item.short) last.count++;
            else runs.push({ short: item.short, count: 1 });
        }
        return runs.map(run => (run.count > 1 ? `${run.count}× ${run.short}` : run.short)).join(' → ');
    }

    function parseMaxCooldown(hhmmss) {
        const parts = /^(\d+):(\d+):(\d+)$/.exec(hhmmss || '');
        if (!parts) return null;
        const [, hours, minutes, seconds] = parts;
        return +hours * 60 + +minutes + +seconds / 60;
    }

    function plan(hospitalMinutes, lifePercent, effectiveness, meds, quantityById, bloodType,
        { cooldownNow = 0, maxCooldown = Infinity } = {}) {
        const compatibleBags = ALLOWED_BLOOD[bloodType] || [];
        const owned = meds.filter(med => (quantityById[med.id] || 0) > 0);
        const usable = owned.filter(med =>
            !BLOOD_BAG_IDS.includes(med.id) || compatibleBags.includes(med.id));
        if (!usable.length) {
            const incompatibleBags = owned.reduce(
                (total, med) => total + (BLOOD_BAG_IDS.includes(med.id) ? quantityById[med.id] : 0), 0);
            return incompatibleBags
                ? { error: `${incompatibleBags} blood bag(s), none matching blood type ${(bloodType || 'unset').toUpperCase()}.` }
                : { error: 'No usable medical items available.' };
        }

        const profileByEffect = new Map();
        for (const med of usable) {
            const hospital = Math.floor(med.hospital * (1 + effectiveness / 100));
            const life = med.life * (1 + effectiveness / 100);
            const effectKey = `${hospital}|${life}|${med.cooldown}`;
            const profile = profileByEffect.get(effectKey)
                || { hospital, life, cooldown: med.cooldown, quantity: 0, sources: [] };
            profile.quantity += quantityById[med.id];
            profile.sources.push(
                { id: med.id, name: med.name, short: med.short, quantity: quantityById[med.id] });
            profileByEffect.set(effectKey, profile);
        }
        const profiles = [...profileByEffect.values()];

        const counts = new Array(profiles.length).fill(0);
        const rankOf = () => {
            let cooldown = 0, life = 0, itemCount = 0, largestStep = 0;
            counts.forEach((count, index) => {
                if (!count) return;
                cooldown += count * profiles[index].cooldown;
                life += count * profiles[index].life;
                itemCount += count;
                largestStep = Math.max(largestStep, profiles[index].cooldown);
            });
            return { cooldown, life, itemCount, largestStep };
        };
        const isBetter = (rank, current) => {
            if (!current) return true;
            if (rank.cooldown !== current.cooldown) return rank.cooldown < current.cooldown;
            if (rank.life !== current.life) return rank.life > current.life;
            if (rank.itemCount !== current.itemCount) return rank.itemCount < current.itemCount;
            return rank.largestStep > current.largestStep;
        };

        function findBest(wait = 0) {
            const hospitalNeeded = Math.max(0, hospitalMinutes - wait);
            const currentCooldown = Math.max(0, cooldownNow - wait);
            const maxUseful = profiles.map(profile => Math.min(profile.quantity, Math.max(
                Math.ceil(hospitalNeeded / Math.max(profile.hospital, 1)),
                Math.ceil(lifePercent / Math.max(profile.life, 1)))));
            let bestCounts = null, bestRank = null, cooldownBlocked = false;
            counts.fill(0);
            (function search(index, hospitalLeft, lifeLeft, cooldownSoFar) {
                if (bestRank && cooldownSoFar > bestRank.cooldown) return;
                if (hospitalLeft <= 0 && lifeLeft <= 1e-9) {
                    const rank = rankOf();
                    const cooldownBeforeLastItem = currentCooldown + rank.cooldown - rank.largestStep;
                    if (rank.itemCount && cooldownBeforeLastItem >= maxCooldown) {
                        cooldownBlocked = true;
                        return;
                    }
                    if (isBetter(rank, bestRank)) {
                        bestCounts = counts.slice();
                        bestRank = rank;
                    }
                    return;
                }
                if (index >= profiles.length) return;
                const profile = profiles[index];
                for (let count = 0; count <= maxUseful[index]; count++) {
                    counts[index] = count;
                    search(index + 1,
                        hospitalLeft - count * profile.hospital,
                        lifeLeft - count * profile.life,
                        cooldownSoFar + count * profile.cooldown);
                }
                counts[index] = 0;
            })(0, hospitalNeeded, lifePercent, 0);
            return { bestCounts, bestRank, cooldownBlocked };
        }

        const { bestCounts, bestRank, cooldownBlocked } = findBest();
        if (!bestCounts) {
            if (cooldownBlocked) {
                let tooSoon = 0;
                let ready = Math.max(Math.ceil(hospitalMinutes), Math.floor(cooldownNow) + 1);
                if (!findBest(ready).bestCounts) {
                    return { error: 'Medical cooldown limit cannot fit a complete plan.' };
                }
                while (ready - tooSoon > 1) {
                    const mid = Math.floor((tooSoon + ready) / 2);
                    if (findBest(mid).bestCounts) ready = mid;
                    else tooSoon = mid;
                }
                return { error: `Med CD full, wait ${asDuration(ready)}`, wait: ready };
            }
            const reachable = profiles.reduce((total, profile) => total + profile.quantity * profile.hospital, 0);
            return reachable < hospitalMinutes
                ? {
                    error: `Short by ${Math.ceil(hospitalMinutes - reachable)}m (best -${reachable}m).`,
                    short: Math.ceil(hospitalMinutes - reachable),
                }
                : { error: 'Not enough items to also fill your life.' };
        }

        const path = [];
        bestCounts.forEach((count, index) => {
            const profile = profiles[index];
            let remaining = count;
            for (const source of profile.sources) {
                const take = Math.min(remaining, source.quantity);
                for (let taken = 0; taken < take; taken++) {
                    path.push({
                        id: source.id, name: source.name, short: source.short,
                        hospital: profile.hospital, life: profile.life, cooldown: profile.cooldown,
                    });
                }
                remaining -= take;
                if (!remaining) break;
            }
        });
        return { items: byStartOrder(path), cooldown: bestRank.cooldown };
    }

    function foldStock(rows) {
        const quantityById = {};
        for (const row of rows || []) {
            if (!row.itemActions || !row.itemActions.usable) continue;
            quantityById[row.itemID] = (quantityById[row.itemID] || 0) + row.qty;
        }
        return quantityById;
    }

    function parsePerks(perksResponse) {
        let total = 0;
        for (const perkList of Object.values(perksResponse)) {
            if (!Array.isArray(perkList)) continue;
            for (const perk of perkList) {
                const match = PERK_RE.exec(perk);
                if (match) total += +match[1];
            }
        }
        return total;
    }

    function parseMaxMedicalCooldown(perksResponse) {
        const perk = (perksResponse.faction_perks || [])
            .map(text => MAX_MEDICAL_COOLDOWN_RE.exec(text))
            .find(Boolean);
        return DEFAULT_MAX_COOLDOWN + (perk ? +perk[1] : 0);
    }
    if (typeof document === 'undefined') {
        module.exports = {
            MEDS, ALLOWED_BLOOD, BLOOD_BAG_IDS, TOGGLEABLE, SPEND_OPTIONS,
            plan, byStartOrder, parseMaxCooldown, parseMaxMedicalCooldown, foldStock, parsePerks, pathLabel,
            asClock, asDuration, firstCheaperWait, lifeAfterWaiting,
            predictedHospital, predictedCooldown,
        };
        return;
    }

    const isPda = Boolean(window.__tornpda || window.flutter_inappwebview);
    const pdaApiKey = isPda && !PDA_API_KEY.includes('###') ? PDA_API_KEY.trim() : '';

    function createSettingsStore() {
        const stored = (() => {
            try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
        })();
        const legacyApiKey = typeof stored.apiKey === 'string' ? stored.apiKey : '';
        const legacyExclude = Array.isArray(stored.exclude) ? stored.exclude : [];
        delete stored.apiKey;
        delete stored.exclude;
        delete stored.extraPct;
        const secureApiKey = isPda ? '' : GM_getValue(API_KEY_KEY, '');
        if (!isPda && !secureApiKey && legacyApiKey) GM_setValue(API_KEY_KEY, legacyApiKey);
        localStorage.removeItem(API_CACHE_KEY);
        const settings = {
            bloodType: 'o-', excludeOwn: legacyExclude.slice(), excludeArmoury: legacyExclude.slice(),
            ...stored,
            apiKey: isPda ? pdaApiKey : secureApiKey || legacyApiKey,
        };
        const save = () => {
            const { apiKey, ...pageSettings } = settings;
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(pageSettings));
            if (!isPda) {
                if (apiKey) GM_setValue(API_KEY_KEY, apiKey);
                else GM_deleteValue(API_KEY_KEY);
            }
        };
        save();
        return { settings, save };
    }

    const settingsStore = createSettingsStore();
    const { settings, save } = settingsStore;

    function createApiClient({ settings: currentSettings, save: saveSettings }) {
        const accountData = {
            detectedEffectiveness: 0,
            perksKnown: false,
            hour: null,
            lifeRegen: null,
            knownMaxCooldown: null,
            accessLevel: null,
            accessType: null,
        };
        let dataRequest = null;

        const apiHour = () => {
            const stamp = Date.now();
            const offset = -new Date(stamp).getTimezoneOffset();
            return `${Math.floor((stamp + offset * 60000) / 3600000)}:${offset}`;
        };
        const clearAccountData = () => {
            accountData.detectedEffectiveness = 0;
            accountData.perksKnown = false;
            accountData.hour = null;
            accountData.lifeRegen = null;
            accountData.knownMaxCooldown = null;
            accountData.accessLevel = null;
            accountData.accessType = null;
        };
        const discardUnusableKey = (failure, key) => {
            if (!UNUSABLE_API_KEY_ERRORS.has(failure.code) || currentSettings.apiKey !== key) return;
            currentSettings.apiKey = '';
            saveSettings();
            GM_deleteValue(API_CACHE_KEY);
            GM_deleteValue(INVENTORY_CACHE_KEY);
            GM_deleteValue(INVENTORY_USE_KEY);
            clearAccountData();
            failure.apiKeyRemoved = true;
        };
        const request = async (path, key) => {
            const apiKey = key || currentSettings.apiKey;
            const separator = path.includes('?') ? '&' : '?';
            const response = await fetch(
                `https://api.torn.com/${path}${separator}key=${encodeURIComponent(apiKey)}&comment=MedPilot`);
            const body = await response.json();
            if (body.error) {
                const failure = new Error(body.error.error);
                failure.code = body.error.code;
                discardUnusableKey(failure, apiKey);
                throw failure;
            }
            return body;
        };
        const validAccountData = data => data
            && Number.isFinite(data.detectedEffectiveness) && data.detectedEffectiveness >= 0
            && Number.isFinite(data.accessLevel) && data.accessLevel >= 2
            && typeof data.accessType === 'string'
            && (data.knownMaxCooldown === null
                || Number.isFinite(data.knownMaxCooldown) && data.knownMaxCooldown > 0)
            && (data.lifeRegen === null || data.lifeRegen
                && Number.isFinite(data.lifeRegen.increment) && data.lifeRegen.increment >= 0
                && Number.isFinite(data.lifeRegen.interval) && data.lifeRegen.interval > 0);
        const readCache = (key, hour) => {
            try {
                const cached = GM_getValue(API_CACHE_KEY, null);
                return cached?.hour === hour && cached.apiKey === key && validAccountData(cached)
                    ? cached : null;
            } catch { return null; }
        };
        const writeCache = (data, key, hour) => {
            try { GM_setValue(API_CACHE_KEY, { hour, apiKey: key, ...data }); } catch { }
        };
        const applyAccountData = (data, hour) => {
            accountData.detectedEffectiveness = data.detectedEffectiveness;
            accountData.lifeRegen = data.lifeRegen;
            accountData.knownMaxCooldown = data.knownMaxCooldown;
            accountData.accessLevel = data.accessLevel;
            accountData.accessType = data.accessType;
            accountData.perksKnown = true;
            accountData.hour = hour;
        };
        const requestAccountData = (key, hour) => {
            if (dataRequest?.key === key && dataRequest.hour === hour) return dataRequest.promise;
            const pending = { key, hour, promise: null };
            pending.promise = request('key/?selections=info', key).then(info => {
                if (info.access_level < 2) {
                    const failure = new Error('Minimal API access is required.');
                    failure.code = 16;
                    throw failure;
                }
                return request('user/?selections=bars,perks', key).then(account => ({
                    accessLevel: info.access_level,
                    accessType: info.access_type,
                    detectedEffectiveness: parsePerks(account),
                    knownMaxCooldown: parseMaxMedicalCooldown(account),
                    lifeRegen: account.life && account.life.increment
                        ? { increment: account.life.increment, interval: account.life.interval }
                        : null,
                }));
            }).finally(() => {
                if (dataRequest === pending) dataRequest = null;
            });
            dataRequest = pending;
            return pending.promise;
        };
        const loadAccountData = async () => {
            while (currentSettings.apiKey) {
                const key = currentSettings.apiKey;
                const hour = apiHour();
                clearAccountData();
                const cached = readCache(key, hour);
                if (cached) {
                    applyAccountData(cached, hour);
                    return;
                }
                let data;
                try {
                    data = await requestAccountData(key, hour);
                } catch (failure) {
                    discardUnusableKey(failure, key);
                    throw failure;
                }
                if (currentSettings.apiKey !== key) return;
                if (apiHour() !== hour) continue;
                applyAccountData(data, hour);
                writeCache(data, key, hour);
                return;
            }
        };

        return { accountData, apiHour, clearAccountData, loadAccountData, request };
    }

    const apiClient = createApiClient({ settings, save });
    const { accountData, apiHour } = apiClient;
    const api = apiClient.request;
    const clearApiData = apiClient.clearAccountData;
    const refreshPerksAndLife = apiClient.loadAccountData;

    let inventory = null;
    let inventoryError = '';
    let nextMedout = null;
    let nextFullLife = null;
    const effectiveness = () => accountData.detectedEffectiveness;

    const fromArmoury = location.pathname === '/factions.php';
    const requiredAccessLevel = 2;
    const requiredAccessName = 'Minimal';
    const requiredInventoryMessage = fromArmoury
        ? 'Minimal API key required for medical planning'
        : 'Minimal API key required for inventory';

    function createStatusReader() {
        const statusIcons = "[class*='status-icons___'], [class*='statusIcons___']";
        const lifeValue =
            "[class*='bar__'][class*='life__'] :is([class*='bar-value___'], [class*='barValue___'])";
        const elementCache = {};
        let clockOffsetMs = 0;
        let observer = null;

        const findLive = selector => {
            if (elementCache[selector]?.isConnected) return elementCache[selector];
            elementCache[selector] = document.querySelector(selector);
            return elementCache[selector];
        };
        const storedSidebarData = () => {
            try {
                const storageKey = Object.keys(sessionStorage).find(name => /sidebarData\d+/.test(name));
                return storageKey ? JSON.parse(sessionStorage.getItem(storageKey)) : null;
            } catch { return null; }
        };
        const readIcons = () => {
            const strip = findLive(statusIcons);
            const propsKey = strip && Object.keys(strip).find(name => name.startsWith('__reactProps'));
            const rendered = propsKey && strip[propsKey].children;
            if (!Array.isArray(rendered)) return {};
            const iconNamed = wanted => {
                const found = rendered.find(child => child && child.props && child.props.iconKey === wanted);
                return found ? found.props.icon : null;
            };
            return { hospital: iconNamed('hospital'), medical: iconNamed('medical_cooldown') };
        };
        const readLife = () => {
            const value = findLive(lifeValue);
            if (value) {
                const [current, maximum] = value.textContent.split('/').map(part => parseInt(part));
                if (Number.isFinite(current) && maximum > 0) return { current, maximum };
            }
            if (!isPda) return null;
            const life = storedSidebarData()?.bars?.life;
            const current = Number(life?.amount);
            const maximum = Number(life?.max);
            return Number.isFinite(current) && maximum > 0 ? { current, maximum } : null;
        };
        const storedMaxCooldown = () => {
            const medical = storedSidebarData()?.statusIcons?.icons?.medical_cooldown;
            return parseMaxCooldown(medical?.factionUpgrade);
        };
        const serverNow = () => Date.now() + clockOffsetMs;
        const noteServerClock = (response, sentAt) => {
            const served = Date.parse(response.headers.get('date') || '');
            if (!served) return;
            const arrivedAt = Date.now();
            clockOffsetMs = served + 500 + (arrivedAt - sentAt) / 2 - arrivedAt;
        };
        const pageIsActive = () => document.visibilityState === 'visible' && document.hasFocus();
        const watch = onChange => {
            if (observer) return;
            const element = findLive(statusIcons);
            if (!element) return;
            observer = new MutationObserver(() => { if (pageIsActive()) onChange(); });
            observer.observe(element, { childList: true, subtree: true });
        };
        const isWatching = () => !!observer;

        return {
            isWatching, noteServerClock, pageIsActive, readIcons, readLife,
            serverNow, storedMaxCooldown, watch,
        };
    }

    const statusReader = createStatusReader();
    const {
        noteServerClock, pageIsActive, readIcons, readLife, serverNow, storedMaxCooldown,
    } = statusReader;
    function tornPost(page, params) {
        const token = (document.cookie.match(/(?:^|;\s*)rfc_v=([^;]+)/) || [])[1] || '';
        const sentAt = Date.now();
        return fetch(`https://www.torn.com/${page}?rfcv=${token}`, {
            method: 'POST',
            headers: { 'x-requested-with': 'XMLHttpRequest' },
            body: new URLSearchParams(params),
        }).then(response => {
            noteServerClock(response, sentAt);
            if (response.ok === false) throw new Error(`HTTP ${response.status}`);
            return response.json();
        });
    }

    function useItem(id) {
        return tornPost('item.php', fromArmoury
            ? { step: 'useItem', fac: '1', itemID: String(id) }
            : { step: 'useItem', id: String(id), itemID: String(id) });
    }

    function createInventoryService({ settings: currentSettings, request, fromArmoury: isArmoury,
        apiHour, loadArmoury }) {
        let identity = null;
        let armourySnapshot = null;
        const source = isArmoury ? 'faction' : 'user';
        const validCache = (entry, key, hour) => entry
            && entry.apiKey === key && entry.hour === hour && Number.isFinite(entry.timestamp)
            && entry.quantityById && Object.values(entry.quantityById)
                .every(amount => Number.isFinite(amount) && amount >= 0);
        const validArmouryCache = (entry, key) => entry
            && entry.apiKey === key && entry.quantityById
            && Object.values(entry.quantityById)
                .every(amount => Number.isFinite(amount) && amount >= 0);
        const inventoryCache = () => {
            const stored = GM_getValue(INVENTORY_CACHE_KEY, {});
            return stored && typeof stored === 'object' ? stored : {};
        };
        const storeArmourySnapshot = quantityById => {
            armourySnapshot = { ...quantityById };
            const cache = inventoryCache();
            cache.faction = { apiKey: currentSettings.apiKey, quantityById: { ...armourySnapshot } };
            GM_setValue(INVENTORY_CACHE_KEY, cache);
        };
        const storedUses = () => {
            const stored = GM_getValue(INVENTORY_USE_KEY, {});
            return stored && typeof stored === 'object' ? stored : {};
        };
        const applyUses = (snapshot, key) => {
            const uses = storedUses();
            let entry = uses[source];
            if (!entry || entry.apiKey !== key || entry.timestamp !== snapshot.timestamp) {
                entry = { apiKey: key, timestamp: snapshot.timestamp, quantityById: {} };
                uses[source] = entry;
                GM_setValue(INVENTORY_USE_KEY, uses);
            }
            identity = { source, apiKey: key, timestamp: snapshot.timestamp };
            return Object.fromEntries(Object.entries(snapshot.quantityById).map(([id, amount]) =>
                [id, Math.max(0, amount - (entry.quantityById[id] || 0))]));
        };
        const recordUse = (itemId, change) => {
            if (isArmoury) {
                if (!armourySnapshot) return;
                armourySnapshot[itemId] = Math.max(0, (armourySnapshot[itemId] || 0) - change);
                storeArmourySnapshot(armourySnapshot);
                return;
            }
            if (!identity) return;
            const uses = storedUses();
            let entry = uses[identity.source];
            if (!entry || entry.apiKey !== identity.apiKey || entry.timestamp !== identity.timestamp) {
                entry = { apiKey: identity.apiKey, timestamp: identity.timestamp, quantityById: {} };
                uses[identity.source] = entry;
            }
            entry.quantityById[itemId] = Math.max(0, (entry.quantityById[itemId] || 0) + change);
            GM_setValue(INVENTORY_USE_KEY, uses);
        };
        const readArmouryDom = () => {
            const list = document.querySelector(".armoury-tabs[id*='medical'] .item-list");
            if (!list) return null;
            const quantityById = {};
            for (const row of list.querySelectorAll(':scope > li')) {
                if (!row.querySelector('.use.active')) continue;
                const image = row.querySelector('.img-wrap[data-itemid]');
                const quantity = row.querySelector('.qty');
                const id = Number(image?.dataset.itemid);
                const amount = Number(quantity?.textContent);
                if (Number.isFinite(id) && Number.isFinite(amount) && amount >= 0) {
                    quantityById[id] = (quantityById[id] || 0) + amount;
                }
            }
            return quantityById;
        };
        const readArmoury = async manual => {
            if (manual) {
                try {
                    const response = await loadArmoury();
                    if (!Array.isArray(response?.items)) {
                        throw new Error('Unable to load the faction medical inventory.');
                    }
                    storeArmourySnapshot(foldStock(response.items));
                } catch (failure) {
                    failure.requiresManualInventoryLoad = true;
                    throw failure;
                }
            } else if (!armourySnapshot) {
                const domSnapshot = readArmouryDom();
                if (domSnapshot !== null) storeArmourySnapshot(domSnapshot);
                else {
                    const cached = inventoryCache().faction;
                    if (validArmouryCache(cached, currentSettings.apiKey)) {
                        armourySnapshot = { ...cached.quantityById };
                    }
                }
            }
            if (!armourySnapshot) {
                const failure = new Error('Faction medical inventory is not loaded.');
                failure.requiresManualInventoryLoad = true;
                throw failure;
            }
            return { ...armourySnapshot };
        };
        const read = async ({ manual = false } = {}) => {
            if (!currentSettings.apiKey) throw new Error(isArmoury
                ? 'Minimal API key required for medical planning'
                : 'Minimal API key required for inventory');
            if (isArmoury) return readArmoury(manual);
            const key = currentSettings.apiKey;
            const hour = apiHour();
            const cache = inventoryCache();
            let snapshot = validCache(cache[source], key, hour) ? cache[source] : null;
            if (!snapshot) {
                const response = await request('v2/user/inventory?cat=Medical&limit=250', key);
                const rows = response.inventory?.items;
                const timestamp = response.inventory?.timestamp;
                if (!Array.isArray(rows) || !Number.isFinite(timestamp)) {
                    throw new Error('Unable to read medical inventory from the Torn API.');
                }
                const quantityById = {};
                for (const row of rows) quantityById[row.id] = (quantityById[row.id] || 0) + row.amount;
                snapshot = { apiKey: key, hour, timestamp, quantityById };
                cache[source] = snapshot;
                GM_setValue(INVENTORY_CACHE_KEY, cache);
            }
            return applyUses(snapshot, key);
        };
        const clearIdentity = () => { identity = null; armourySnapshot = null; };

        return { clearIdentity, read, recordUse };
    }

    const inventoryService = createInventoryService({
        settings, request: api, fromArmoury, apiHour,
        loadArmoury: () => tornPost('factions.php',
            { step: 'armouryTabContent', type: 'medical', start: '0' }),
    });
    const readInventory = inventoryService.read;
    const recordInventoryUse = inventoryService.recordUse;


    const icon = name => `<svg viewBox="0 0 24 24"><use href="#cm-i-${name}"/></svg>`;
    const stat = (name, key, id) =>
        `<span class="cm-stat">${icon(name)}<span class="k">${key}</span><span class="v" id="cm-${id}">—</span></span>`;

    function createPanelView({ fromArmoury: isArmoury }) {
        const panel = document.createElement('div');
        panel.className = 'cm-panel' + (isPda ? ' cm-pda' : '');
        const apiDataStorage = isPda
            ? 'Latest bars/perks, inventory data and local item deductions, only locally'
            : 'API key, latest bars/perks, inventory data and local item deductions, only locally';
        const keyStorage = isPda
            ? 'Provided by Torn PDA; sent only to the official Torn API'
            : 'Your userscript manager; sent only to the official Torn API';
        panel.innerHTML = `
        <div class="cm-actions">
            <div class="cm-action">
                <button id="cm-go" class="cm-btn" aria-describedby="cm-go-hint" disabled>${icon('drop')}
                    <span class="txt"><span class="t1">Loading…</span><span class="t2"></span></span></button>
                <div id="cm-go-hint" class="cm-wait" role="note"></div>
            </div>
            <div class="cm-action">
                <button id="cm-full" class="cm-btn cm-full" aria-describedby="cm-full-hint" disabled>${icon('pulse')}
                    <span class="txt"><span class="t1">Loading…</span><span class="t2"></span></span></button>
                <div id="cm-full-hint" class="cm-wait" role="note"></div>
            </div>
        </div>
        <div class="cm-status">
            ${stat('hospital', 'Hospital', 'hosp')}
            ${stat('clock', 'Med CD', 'cd')}
            ${stat('heart', 'Life', 'life')}
            <span class="cm-spacer"></span>
            <button id="cm-refresh" class="cm-icon" title="Refresh" aria-label="Refresh">${icon('refresh')}</button>
            <button id="cm-toggle" class="cm-icon" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button>
        </div>
        <div id="cm-flash" class="cm-flash" hidden>
            <span id="cm-flash-text"></span>
            <button id="cm-flash-action" class="cm-flash-action" hidden></button>
            <button id="cm-flash-x" class="cm-x" aria-label="Dismiss">&times;</button>
        </div>
        <div id="cm-settings" class="cm-settings">
            <div class="cm-key-field">
                ${isPda
                    ? '<span class="cm-pda-key">Using the API key provided by Torn PDA<br>Minimal access required</span>'
                    : '<label for="cm-key">API key — Minimal required for medical planning</label>'}
                <details class="cm-api-info">
                    <summary title="How your API key is used" aria-label="How your API key is used">i</summary>
                    <div class="cm-api-popup" role="note">
                        <strong>API usage</strong>
                        <table><tbody>
                            <tr><th>Data storage</th><td>${apiDataStorage}</td></tr>
                            <tr><th>Data sharing</th><td>Nobody</td></tr>
                            <tr><th>Purpose</th><td>Personal medical cooldown and life planning</td></tr>
                            <tr><th>Key storage</th><td>${keyStorage}</td></tr>
                            <tr><th>Access</th><td>Minimal — user bars/perks, own inventory and API-key access level</td></tr>
                            <tr><th>Faction stock</th><td>Read from the armoury page or loaded after your click, then stored until you refresh it</td></tr>
                        </tbody></table>
                    </div>
                </details>
                ${isPda ? '' : '<input id="cm-key" type="password" placeholder="Minimal API key required">'}
            </div>
            <label>Your blood type
                <select id="cm-blood">
                    <option value="">no blood bags</option>
                    ${Object.keys(ALLOWED_BLOOD).map(b => `<option value="${b}">${b.toUpperCase()}</option>`).join('')}
                </select></label>
            <div class="cm-field">Items it may spend ${isArmoury ? 'from the armoury' : 'from your items'}
                <span class="cm-toggles">
                    ${SPEND_OPTIONS.map(option =>
                        `<button type="button" class="cm-chip" data-med-ids="${option.ids.join(',')}">${option.short}</button>`).join('')}
                </span></div>
            <button id="cm-save" class="cm-save">Save</button>
        </div>`;

        const find = id => panel.querySelector('#cm-' + id);
        const goButton = find('go');
        const fullButton = find('full');
        const buttonHints = new Map([[goButton, find('go-hint')], [fullButton, find('full-hint')]]);
        let notice = '';
        let noticeOk = false;
        let noticeDismissible = true;
        let noticeAction = null;
        let noticeActionLabel = '';

        const setNotice = (message, ok, options = {}) => {
            notice = message;
            noticeOk = !!ok;
            noticeDismissible = options.dismissible !== false;
            noticeAction = options.onAction || null;
            noticeActionLabel = options.actionLabel || '';
        };
        const dismissNotice = () => {
            if (!noticeDismissible) return;
            setNotice('', true);
        };
        const renderNotice = () => {
            find('flash-text').textContent = notice;
            find('flash').className = 'cm-flash' + (noticeOk ? ' cm-ok' : '');
            find('flash').hidden = !notice;
            find('flash-x').hidden = !noticeDismissible;
            find('flash-action').textContent = noticeActionLabel;
            find('flash-action').hidden = !noticeAction;
        };
        const setButton = (button, title, detail, enabled, hint) => {
            button.querySelector('.t1').textContent = title;
            button.querySelector('.t2').textContent = detail || '';
            buttonHints.get(button).innerHTML = hint || '';
            button.disabled = !enabled;
        };
        const renderClocks = ({ hospitalExact, used, maxShown, readMax }) => {
            const hospital = hospitalExact > 0 ? asClock(hospitalExact, Math.floor) : 'none';
            const cooldown = `${asClock(used, Math.floor)} / ${asDuration(maxShown)}${readMax ? '' : '?'}`;
            if (find('hosp').textContent !== hospital) find('hosp').textContent = hospital;
            if (find('cd').textContent !== cooldown) find('cd').textContent = cooldown;
        };
        find('flash-action').addEventListener('click', () => noticeAction?.());

        return {
            dismissNotice, element: panel, find, fullButton, goButton,
            renderClocks, renderNotice, setButton, setNotice,
        };
    }

    const panelView = createPanelView({ fromArmoury });
    const panel = panelView.element;
    const $ = panelView.find;
    const goBtn = panelView.goButton;
    const fullBtn = panelView.fullButton;
    const setNotice = panelView.setNotice;
    const setButton = panelView.setButton;
    const renderClocks = panelView.renderClocks;

    function createUseController(dependencies) {
        const {
            accountData, getInventory, pageIsActive, readIcons, readInventory, readLife,
            recordInventoryUse, refreshInventory, render, serverNow, setInventory, setNotice,
            storedMaxCooldown, useItem,
        } = dependencies;
        let pendingUseCount = 0;
        let activeBatch = null;
        let recoveryState = null;
        let hospitalTarget = 0;
        let cooldownTarget = 0;
        let lifeTarget = null;
        let lastHospitalStamp = null;
        let lastSidebarLife = null;
        const predictionRevision = { hospital: 0, cooldown: 0, life: 0 };
        let predictionExpiresAt = 0;
        let inventoryRevision = 0;

        const minsUntil = timestamp => timestamp
            ? Math.max(0, (timestamp * 1000 - serverNow()) / 60000) : 0;
        const requestIsSettled = request =>
            request.status === 'success' || request.status === 'refused';
        const pendingCount = () => pendingUseCount;
        const revision = () => inventoryRevision;
        const bumpRevision = () => { inventoryRevision++; };
        const isRecovering = () => !!recoveryState;
        const recoveryDetail = () => recoveryState
            && (recoveryState.attempts >= MAX_AUTO_RECOVERY_CHECKS && !recoveryState.check
                ? 'unable to confirm use — refresh to check' : 'checking item use…');

        function readCurrentStatus() {
            const icons = readIcons();
            const hospitalStamp = icons.hospital ? icons.hospital.timerExpiresAt : 0;
            const cooldownStamp = icons.medical ? icons.medical.timerExpiresAt : 0;
            const sidebarLife = readLife();
            const newHospital = lastHospitalStamp !== null && hospitalStamp > lastHospitalStamp + 1;
            const lifeLost = sidebarLife && lastSidebarLife
                && (sidebarLife.current < lastSidebarLife.current || sidebarLife.maximum !== lastSidebarLife.maximum);
            const expired = !pendingUseCount && !recoveryState
                && predictionExpiresAt && serverNow() >= predictionExpiresAt;
            if (newHospital || lifeLost || expired) {
                hospitalTarget = 0;
                predictionRevision.hospital++;
                if (newHospital || lifeLost) { lifeTarget = null; predictionRevision.life++; }
                if (expired) {
                    cooldownTarget = 0;
                    predictionRevision.cooldown++;
                    predictionExpiresAt = 0;
                }
            }
            lastHospitalStamp = hospitalStamp;
            if (sidebarLife) lastSidebarLife = sidebarLife;
            if (lifeTarget && sidebarLife
                && sidebarLife.current >= Math.min(lifeTarget.current, lifeTarget.maximum)) {
                lifeTarget = null;
                predictionRevision.life++;
            }
            const readMax = parseMaxCooldown(icons.medical && icons.medical.factionUpgrade)
                || (accountData.knownMaxCooldown ??= storedMaxCooldown());
            const used = minsUntil(predictedCooldown(cooldownStamp, cooldownTarget));
            const maxShown = readMax || DEFAULT_MAX_COOLDOWN;
            const maxCooldown = readMax || Infinity;
            const life = sidebarLife && lifeTarget
                ? { current: Math.max(sidebarLife.current, lifeTarget.current), maximum: sidebarLife.maximum }
                : sidebarLife;
            const hospitalExact = minsUntil(predictedHospital(hospitalStamp, hospitalTarget));
            const hospitalLeft = Math.ceil(hospitalExact);
            if (hospitalTarget && hospitalStamp <= hospitalTarget) {
                hospitalTarget = 0;
                predictionRevision.hospital++;
            }
            if (cooldownTarget && cooldownStamp >= cooldownTarget) {
                cooldownTarget = 0;
                predictionRevision.cooldown++;
            }
            const missingLife = life
                ? Math.max(0, (life.maximum - life.current) / life.maximum * 100) : null;
            return {
                hospitalExact, hospitalLeft, missingLife, life, sidebarLife, used, maxShown,
                maxCooldown, readMax,
            };
        }

        function startRecovery(batch, delay = USE_CONFIRMATION_TIMEOUT_MS) {
            if (recoveryState || batch !== activeBatch) return;
            recoveryState = { batch, attempts: 0, nextCheckAt: Date.now() + delay, check: null };
            setNotice('Checking item use — further uses are paused.', false);
        }

        function showRecoveryStatus() {
            const stopped = recoveryState.attempts >= MAX_AUTO_RECOVERY_CHECKS;
            setNotice(stopped
                ? 'Unable to confirm item use. Uses are paused; refresh to check again.'
                : 'Item use is not confirmed yet. Checking again in 5 seconds.', false);
        }

        function updateRecovery() {
            const timedOut = activeBatch?.requests.some(request =>
                request.status === 'pending'
                && Date.now() - request.sentAt >= USE_CONFIRMATION_TIMEOUT_MS);
            if (!recoveryState && timedOut) startRecovery(activeBatch, 0);
            if (!recoveryState) return;
            const checkExpired = recoveryState.check
                && Date.now() - recoveryState.check.startedAt >= USE_CONFIRMATION_TIMEOUT_MS;
            if (checkExpired) {
                recoveryState.check = null;
                recoveryState.nextCheckAt = Date.now() + USE_CONFIRMATION_TIMEOUT_MS;
                showRecoveryStatus();
            }
            const checkDue = !recoveryState.check
                && recoveryState.attempts < MAX_AUTO_RECOVERY_CHECKS
                && Date.now() >= recoveryState.nextCheckAt;
            if (checkDue) checkRecovery();
        }

        function expectedBatchState(batch) {
            const expectedStock = { ...batch.stock };
            const itemIds = new Set();
            let hospital = batch.hospital;
            let cooldown = batch.cooldown;
            let life = batch.life.current;
            for (const request of batch.requests) {
                if (request.status === 'refused') continue;
                const { item } = request;
                expectedStock[item.id]--;
                itemIds.add(item.id);
                if (hospital) hospital -= item.hospital * 60;
                cooldown = Math.max(cooldown, request.serverStamp) + item.cooldown * 60;
                life += Math.floor(batch.life.maximum * item.life / 100);
            }
            return { expectedStock, itemIds, hospital, cooldown, life };
        }

        function batchMatchesCurrentState(batch, quantityById) {
            const icons = readIcons();
            const life = readLife();
            if (!('hospital' in icons) || !('medical' in icons) || !life || !batch.life
                || life.maximum !== batch.life.maximum) return false;
            const hospitalStamp = icons.hospital ? Number(icons.hospital.timerExpiresAt) : 0;
            const cooldownStamp = icons.medical ? Number(icons.medical.timerExpiresAt) : 0;
            if (!Number.isFinite(hospitalStamp) || !Number.isFinite(cooldownStamp)) return false;
            const expected = expectedBatchState(batch);
            const now = serverNow() / 1000;
            const stockMatches = [...expected.itemIds]
                .every(id => (quantityById[id] || 0) === expected.expectedStock[id]);
            const hospitalMatches = Math.max(0, hospitalStamp - now)
                <= Math.max(0, expected.hospital - now) + 1;
            const cooldownMatches = cooldownStamp >= expected.cooldown - 1;
            const lifeMatches = life.current >= Math.min(life.maximum, expected.life);
            return stockMatches && hospitalMatches && cooldownMatches && lifeMatches;
        }

        function confirmRecoveredBatch(batch, quantityById) {
            for (const request of batch.requests) {
                if (request.status !== 'pending' && request.status !== 'unknown') continue;
                request.status = 'observed';
                if (request.counted) {
                    request.counted = false;
                    pendingUseCount--;
                }
            }
            hospitalTarget = 0;
            cooldownTarget = 0;
            lifeTarget = null;
            predictionExpiresAt = 0;
            for (const axis of Object.keys(predictionRevision)) predictionRevision[axis]++;
            setInventory({ quantityById });
            inventoryRevision++;
            activeBatch = null;
            recoveryState = null;
            setNotice('Item use confirmed.', true);
        }

        async function checkRecovery() {
            const currentRecovery = recoveryState;
            if (!currentRecovery || currentRecovery.check) return;
            const check = { startedAt: Date.now(), revision: inventoryRevision };
            currentRecovery.check = check;
            currentRecovery.attempts++;
            setNotice('Checking item use — further uses are paused.', false);
            try {
                const quantityById = await readInventory();
                const isCurrent = recoveryState === currentRecovery
                    && currentRecovery.check === check
                    && check.revision === inventoryRevision;
                const arrivedInTime = Date.now() - check.startedAt < USE_CONFIRMATION_TIMEOUT_MS;
                if (isCurrent && arrivedInTime
                    && batchMatchesCurrentState(currentRecovery.batch, quantityById)) {
                    confirmRecoveredBatch(currentRecovery.batch, quantityById);
                }
            } catch {
            } finally {
                if (recoveryState === currentRecovery && currentRecovery.check === check) {
                    currentRecovery.check = null;
                    currentRecovery.nextCheckAt = Date.now() + USE_CONFIRMATION_TIMEOUT_MS;
                    showRecoveryStatus();
                }
                if (pageIsActive()) render();
            }
        }

        function createUseBatch(icons, life) {
            return {
                stock: { ...getInventory().quantityById },
                hospital: predictedHospital(icons.hospital?.timerExpiresAt || 0, hospitalTarget),
                cooldown: predictedCooldown(icons.medical?.timerExpiresAt || 0, cooldownTarget),
                life: life && {
                    current: Math.max(life.current, lifeTarget?.current || 0),
                    maximum: life.maximum,
                },
                requests: [],
            };
        }

        function reserveUse(batch, item, icons, life) {
            const serverStamp = serverNow() / 1000;
            const request = {
                item,
                sentAt: Date.now(),
                serverStamp,
                status: 'pending',
                counted: true,
                revision: { ...predictionRevision },
                lifeGain: life ? Math.floor(life.maximum * item.life / 100) : 0,
            };
            batch.requests.push(request);
            if (life) {
                lifeTarget = {
                    maximum: life.maximum,
                    current: Math.max(life.current, lifeTarget?.current || 0) + request.lifeGain,
                };
            }
            hospitalTarget = (hospitalTarget || icons.hospital?.timerExpiresAt || serverStamp)
                - item.hospital * 60;
            cooldownTarget = Math.max(cooldownTarget, icons.medical?.timerExpiresAt || 0, serverStamp)
                + item.cooldown * 60;
            getInventory().quantityById[item.id]--;
            recordInventoryUse(item.id, 1);
            inventoryRevision++;
            predictionExpiresAt = serverNow() + PREDICTION_GRACE_MS;
            pendingUseCount++;
            return request;
        }

        function rollBackUse(request) {
            const { item, revision: requestRevision, lifeGain } = request;
            if (predictionRevision.hospital === requestRevision.hospital) hospitalTarget += item.hospital * 60;
            if (lifeTarget && predictionRevision.life === requestRevision.life) lifeTarget.current -= lifeGain;
            if (predictionRevision.cooldown === requestRevision.cooldown) cooldownTarget -= item.cooldown * 60;
            getInventory().quantityById[item.id]++;
            recordInventoryUse(item.id, -1);
        }

        function finishUseRequest(batch, request) {
            if (request.counted) {
                request.counted = false;
                pendingUseCount--;
            }
            if (request.status === 'observed') return;
            inventoryRevision++;
            if (batch.requests.every(requestIsSettled)) {
                activeBatch = null;
                if (recoveryState?.batch === batch) {
                    recoveryState = null;
                    if (request.status === 'success') setNotice('Item use confirmed.', true);
                }
            }
            if (predictionExpiresAt) predictionExpiresAt = serverNow() + PREDICTION_GRACE_MS;
            if (pageIsActive()) render();
            if (!pendingUseCount && !recoveryState) refreshInventory();
        }

        async function useNext(item) {
            const inventory = getInventory();
            if (recoveryState || !item || !inventory || !(inventory.quantityById[item.id] > 0)) return;
            setNotice('', true);
            const icons = readIcons();
            const life = readLife();
            const batch = activeBatch ||= createUseBatch(icons, life);
            const request = reserveUse(batch, item, icons, life);
            render();
            try {
                const response = await useItem(item.id);
                if (request.status === 'observed') return;
                if (response?.success === false) {
                    request.status = 'refused';
                    rollBackUse(request);
                    setNotice(response.text || `${item.name} was refused.`, false);
                } else if (response?.success === true) {
                    request.status = 'success';
                } else {
                    request.status = 'unknown';
                    startRecovery(batch);
                }
            } catch {
                if (request.status === 'observed') return;
                request.status = 'unknown';
                startRecovery(batch);
            } finally {
                finishUseRequest(batch, request);
            }
        }

        return {
            bumpRevision, checkRecovery, isRecovering, pendingCount, readCurrentStatus,
            recoveryDetail, revision, updateRecovery, useNext,
        };
    }

    const useController = createUseController({
        accountData,
        getInventory: () => inventory,
        pageIsActive,
        readIcons,
        readInventory,
        readLife,
        recordInventoryUse,
        refreshInventory: () => refresh(true),
        render: () => render(),
        serverNow,
        setInventory: value => { inventory = value; },
        setNotice,
        storedMaxCooldown,
        useItem,
    });
    const readCurrentStatus = useController.readCurrentStatus;
    const updateRecovery = useController.updateRecovery;
    const checkRecovery = useController.checkRecovery;
    const useNext = useController.useNext;

    const ANCHOR = fromArmoury ? '#faction-armoury-tabs' : '.equipped-items-wrap';

    const panelBelongsOnPage = () => !fromArmoury || /tab=armou?ry/i.test(location.hash);

    function openSettings(focusKey = false) {
        $('settings').classList.add('cm-open');
        $('toggle').classList.add('cm-open');
        const keyInput = $('key');
        if (keyInput) keyInput.value = settings.apiKey;
        $('blood').value = settings.bloodType;
        const excluded = fromArmoury ? settings.excludeArmoury : settings.excludeOwn;
        panel.querySelectorAll('[data-med-ids]').forEach(chip => {
            const ids = chip.dataset.medIds.split(',').map(Number);
            chip.classList.toggle('cm-on', ids.every(id => !excluded.includes(id)));
        });
        if (focusKey && keyInput) keyInput.focus();
    }

    function closeSettings() {
        $('settings').classList.remove('cm-open');
        $('toggle').classList.remove('cm-open');
    }

    function showRequiredKeyNotice(message = requiredInventoryMessage) {
        if (isPda) {
            setNotice(`${message} Configure a Minimal key in Torn PDA's userscript settings.`, false, {
                dismissible: false,
            });
            return;
        }
        setNotice(message, false, {
            actionLabel: 'Add API key',
            dismissible: false,
            onAction: () => openSettings(true),
        });
    }

    function showArmouryLoadNotice(message = 'Load the faction medical inventory to calculate a plan.') {
        setNotice(message, false, {
            actionLabel: 'Load medical inventory',
            dismissible: false,
            onAction: loadArmouryInventory,
        });
    }

    let mounted = false;
    function ensureMounted() {
        if (!fromArmoury && mounted && statusReader.isWatching() && panel.isConnected) return;
        statusReader.watch(render);
        const anchor = panelBelongsOnPage() ? document.querySelector(ANCHOR) : null;
        if (!anchor) {
            panel.remove();
            mounted = false;
            return;
        }
        if (anchor.previousElementSibling !== panel) anchor.insertAdjacentElement('beforebegin', panel);
        if (!mounted) { mounted = true; refresh(); }
    }

    function render() {
        panelView.renderNotice();
        if (!inventory) {
            const status = readCurrentStatus();
            renderClocks(status);
            $('life').textContent = status.sidebarLife
                ? `${status.sidebarLife.current}/${status.sidebarLife.maximum}` : '—';
            nextMedout = null;
            nextFullLife = null;
            const detail = inventoryError || (settings.apiKey ? 'loading inventory…' : requiredInventoryMessage);
            setButton(goBtn, 'Medout', detail, false);
            setButton(fullBtn, 'Full life', detail, false);
            return;
        }
        updateRecovery();
        const status = readCurrentStatus();
        const { hospitalExact, hospitalLeft, missingLife, life, sidebarLife, used, maxShown,
            maxCooldown, readMax } = status;

        renderClocks(status);
        $('life').textContent = sidebarLife ? `${sidebarLife.current}/${sidebarLife.maximum}` : '—';
        if (useController.isRecovering()) {
            nextMedout = nextFullLife = null;
            const detail = useController.recoveryDetail();
            setButton(goBtn, 'Medout', detail, false);
            setButton(fullBtn, 'Full life', detail, false);
            return;
        }

        const toNextLife = accountData.lifeRegen
            ? accountData.lifeRegen.interval - (serverNow() / 1000) % accountData.lifeRegen.interval : Infinity;

        const waitHint = (res, lifePercent) => {
            const planAfter = waitMinutes => {
                const later = lifeAfterWaiting(life, waitMinutes, accountData.lifeRegen, toNextLife);
                const missing = !lifePercent ? 0
                    : later ? (later.maximum - later.current) / later.maximum * 100
                    : missingLife;
                return plan(Math.max(0, Math.ceil(hospitalExact - waitMinutes)), missing,
                    effectiveness(), usable, inventory.quantityById, settings.bloodType, limits);
            };
            const cooldownAfter = waitMinutes => {
                const cheaper = planAfter(waitMinutes);
                return cheaper.items ? cheaper.cooldown : Infinity;
            };
            const wait = firstCheaperWait(cooldownAfter, HINT_MAX_WAIT, res.cooldown);
            if (wait === null) return '';
            const cheaper = planAfter(wait);
            const saved = res.cooldown - cheaper.cooldown;
            if (saved < HINT_MIN_SAVING) return '';
            return `${icon('hour')}<span>Wait ${asClock(wait)} → `
                + `<strong>${pathLabel(cheaper.items) || 'No items'}</strong> · ${cheaper.cooldown}m CD</span>`;
        };

        const offer = (btn, label, res, lifePercent) => {
            if (res.error) { setButton(btn, label, res.error, false); return null; }
            if (!res.items.length) { setButton(btn, label, 'nothing to do', false); return null; }
            const detail = res.items.length === 1
                ? `${res.cooldown}m cooldown`
                : `${pathLabel(res.items)} · ${res.cooldown}m CD`;
            setButton(btn, `${label}: ${res.items[0].name}`, detail, true, waitHint(res, lifePercent));
            return res.items[0];
        };

        const usable = usablePool();
        const limits = { cooldownNow: used, maxCooldown };

        nextMedout = null;
        if (hospitalLeft <= 0) setButton(goBtn, 'Medout', 'not in hospital', false);
        else nextMedout = offer(goBtn, 'Medout',
            plan(hospitalLeft, 0, effectiveness(), usable, inventory.quantityById, settings.bloodType, limits), 0);

        nextFullLife = null;
        if (!sidebarLife) setButton(fullBtn, 'Full life', 'waiting for life data', false);
        else if (hospitalLeft <= 0 && missingLife <= 0) setButton(fullBtn, 'Full life', 'nothing to do', false);
        else {
            nextFullLife = offer(fullBtn, 'Full life',
                plan(hospitalLeft, missingLife, effectiveness(), usable, inventory.quantityById, settings.bloodType, limits),
                missingLife);
        }
    }

    async function refresh(quiet, includeApi = true, manualInventory = false) {
        if (useController.isRecovering()) {
            if (!quiet) await checkRecovery();
            return false;
        }
        const revision = useController.revision();
        const startedDuringUse = useController.pendingCount() > 0;
        if (!quiet) {
            setButton(goBtn, 'Medout', 'loading…', false);
            setButton(fullBtn, 'Full life', 'loading…', false);
        }
        try {
            inventoryError = '';
            if (!settings.apiKey) clearApiData();
            else if (includeApi && (!quiet || !accountData.perksKnown || accountData.hour !== apiHour())) {
                await refreshPerksAndLife();
            }
            const quantityById = await readInventory({ manual: manualInventory });
            if (!startedDuringUse && !useController.pendingCount() && !useController.isRecovering()
                && revision === useController.revision()) inventory = { quantityById };
            if (pageIsActive()) render();
            return true;
        } catch (e) {
            inventoryError = e.code === 16 ? requiredInventoryMessage : e.message;
            if (!quiet) {
                setButton(goBtn, 'Medout', 'unavailable', false);
                setButton(fullBtn, 'Full life', 'unavailable', false);
            }
            if (e.requiresManualInventoryLoad) showArmouryLoadNotice(
                manualInventory ? 'Could not load faction inventory — try again.' : undefined);
            else if (!settings.apiKey || e.code === 16) showRequiredKeyNotice();
            else setNotice(e.message, false);
            if (pageIsActive()) render();
            return false;
        }
    }

    async function loadArmouryInventory() {
        setNotice('Loading faction medical inventory…', true, { dismissible: false });
        render();
        if (await refresh(false, true, true) && inventory) {
            setNotice(`Loaded — ${inventorySummary()}`, true);
            render();
        }
    }

    function usablePool() {
        const compatibleBags = ALLOWED_BLOOD[settings.bloodType] || [];
        const excluded = fromArmoury ? settings.excludeArmoury : settings.excludeOwn;
        return MEDS
            .filter(med => !excluded.includes(med.id))
            .filter(med => !BLOOD_BAG_IDS.includes(med.id) || compatibleBags.includes(med.id));
    }

    function inventorySummary() {
        const detail = settings.apiKey
            ? `${accountData.detectedEffectiveness}% from perks`
            : 'no API key';
        const usable = usablePool();
        const lines = usable
            .filter(med => !BLOOD_BAG_IDS.includes(med.id) && (inventory.quantityById[med.id] || 0) > 0)
            .map(med => `${med.name} ×${inventory.quantityById[med.id]}`);
        const bagTotal = usable.reduce(
            (total, med) => total
                + (BLOOD_BAG_IDS.includes(med.id) ? inventory.quantityById[med.id] || 0 : 0), 0);
        if (bagTotal) lines.push(`Usable Blood Bags ×${bagTotal}`);
        const source = fromArmoury ? 'armoury' : 'your items';
        return `bonus +${effectiveness()}% (${detail}) · ${source}: `
            + (lines.length ? lines.join(', ') : 'nothing usable');
    }

    goBtn.addEventListener('click', () => { render(); useNext(nextMedout); });
    fullBtn.addEventListener('click', () => { render(); useNext(nextFullLife); });

    panel.querySelector('.cm-toggles').addEventListener('click', e => {
        const chip = e.target.closest('[data-med-ids]');
        if (chip) chip.classList.toggle('cm-on');
    });

    $('flash-x').addEventListener('click', () => { panelView.dismissNotice(); render(); });

    $('refresh').addEventListener('click', async () => {
        if (await refresh(false, true, fromArmoury) && inventory) {
            setNotice(`Refreshed — ${inventorySummary()}`, true);
            render();
        }
    });
    $('toggle').addEventListener('click', () => {
        if ($('settings').classList.contains('cm-open')) closeSettings();
        else openSettings();
    });
    $('save').addEventListener('click', async () => {
        const keyInput = $('key');
        if (keyInput) settings.apiKey = keyInput.value.trim();
        settings.bloodType = $('blood').value;
        const excluded = [...panel.querySelectorAll('[data-med-ids]')]
            .filter(chip => !chip.classList.contains('cm-on'))
            .flatMap(chip => chip.dataset.medIds.split(',').map(Number));
        if (fromArmoury) settings.excludeArmoury = excluded;
        else settings.excludeOwn = excluded;
        save();
        clearApiData();
        inventory = null;
        inventoryService.clearIdentity();
        inventoryError = '';
        closeSettings();

        if (settings.apiKey) {
            setNotice('Checking API key…', true);
            render();
            try {
                await refreshPerksAndLife();
                const quantityById = await readInventory();
                inventory = { quantityById };
                useController.bumpRevision();
                const pct = accountData.detectedEffectiveness;
                const spare = accountData.accessLevel > requiredAccessLevel
                    ? ` This key is ${accountData.accessType}; ${requiredAccessName} would do.` : '';
                setNotice(`Key works — detected +${pct}% medical effect.${spare}`, true);
            } catch (e) {
                inventoryError = e.code === 16 ? requiredInventoryMessage : e.message;
                const removed = e.apiKeyRemoved ? ' It was removed from this script.' : '';
                if (e.requiresManualInventoryLoad) showArmouryLoadNotice();
                else if (e.code === 16) showRequiredKeyNotice('Minimal API access is required.');
                else setNotice((e.code === 2 ? 'That API key is not valid.'
                    : `Key check failed: ${e.message}`) + removed, false);
            }
        } else {
            showRequiredKeyNotice();
        }
        render();
    });

    let ticks = [];
    const startTicks = () => {
        if (!ticks.length) ticks = [
            setInterval(ensureMounted, 300),
            setInterval(render, 1000),
            setInterval(() => { if (inventory) renderClocks(readCurrentStatus()); }, 100),
        ];
    };
    const stopTicks = () => { ticks.forEach(clearInterval); ticks = []; };

    let wasActive = false;
    function onActivityChange() {
        const nowActive = pageIsActive();
        if (nowActive === wasActive) return;
        wasActive = nowActive;
        if (!nowActive) { stopTicks(); return; }
        startTicks();
        const wasMounted = mounted;
        ensureMounted();
        render();
        if (wasMounted) refresh(true);
    }

    document.addEventListener('visibilitychange', onActivityChange);
    window.addEventListener('focus', onActivityChange);
    window.addEventListener('blur', onActivityChange);

    onActivityChange();


    const ICONS = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<g id="cm-i-drop" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<path d="M12 3.2c3.4 3.9 5.6 6.7 5.6 9.3A5.6 5.6 0 0 1 12 18a5.6 5.6 0 0 1-5.6-5.5c0-2.6 2.2-5.4 5.6-9.3Z"/></g>
<g id="cm-i-pulse" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<path d="M20.4 8.6a4.6 4.6 0 0 0-8.4-2.5 4.6 4.6 0 0 0-8.4 2.5c0 4.3 5.9 8 8.4 10.2 2.5-2.2 8.4-5.9 8.4-10.2Z"/>
<path d="M3.9 12.3h3.5l1.5-2.6 2 5 1.7-3.3 1.2 1.9h5.4"/></g>
<g id="cm-i-hospital" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<path d="M4 20.5V8.2l5.2-3.1 5.2 3.1v12.3M14.4 11.2H20v9.3M2.6 20.5h18.8"/><path d="M9.2 9.6v3.4M7.5 11.3h3.4"/></g>
<g id="cm-i-clock" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<circle cx="12" cy="12" r="8.4"/><path d="M12 7.3V12l3.1 1.9"/></g>
<g id="cm-i-heart" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<path d="M20.4 8.6a4.6 4.6 0 0 0-8.4-2.5 4.6 4.6 0 0 0-8.4 2.5c0 4.3 5.9 8 8.4 10.2 2.5-2.2 8.4-5.9 8.4-10.2Z"/></g>
<g id="cm-i-hour" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<path d="M7 3h10M7 21h10M7 3c0 4 5 5.2 5 9s-5 5-5 9M17 3c0 4-5 5.2-5 9s5 5 5 9"/></g>
<g id="cm-i-refresh" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.2 4.6v4.2H16"/></g>
</defs></svg>`;
    panel.insertAdjacentHTML('afterbegin', ICONS);


    const CSS = `
.cm-panel{margin:10px 0;border:1px solid #444;border-radius:6px;color:#ccc;
    background:linear-gradient(180deg,#3b3b3b,#2c2c2c);font:12px Arial,sans-serif;
    box-shadow:0 1px 3px rgba(0,0,0,.4)}
.cm-panel:has(.cm-api-info[open]){position:relative;z-index:100}
.cm-panel .cm-actions{display:flex;gap:10px;padding:10px}
.cm-panel .cm-action{flex:1 1 0;min-width:0}
.cm-panel .cm-btn{width:100%;box-sizing:border-box;min-width:0;display:flex;align-items:center;gap:11px;
    padding:10px 14px;border:0;border-radius:5px;cursor:pointer;text-align:left;color:#fff;
    font:12px Arial,sans-serif;background:linear-gradient(180deg,#3d823d,#357a35)}
.cm-panel .cm-btn.cm-full{background:linear-gradient(180deg,#3d6883,#356a85)}
.cm-panel .cm-btn:hover:not(:disabled){filter:brightness(.9)}
.cm-panel .cm-btn:disabled{background:#3a3a3a;color:#a8a8a8;cursor:default;
    box-shadow:inset 0 0 0 1px #464646}
.cm-panel .cm-btn svg{flex:none;width:22px;height:22px}
.cm-panel .cm-btn .txt{min-width:0;flex:1}
.cm-panel .cm-btn .t1,.cm-panel .cm-btn .t2{display:block}
.cm-panel .cm-btn .t1{font-weight:bold;font-size:12.5px;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis}
.cm-panel .cm-btn .t2{font-size:10.5px;margin-top:2px;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
.cm-panel .cm-wait{display:flex;align-items:center;gap:6px;padding:7px 4px 0;
    color:#dbc89a;font-size:11px;line-height:1.4}
.cm-panel .cm-wait:empty{display:none}
.cm-panel .cm-wait svg{flex:none;width:12px;height:12px}
.cm-panel .cm-wait span{min-width:0;overflow-wrap:anywhere}
@media(max-width:640px){.cm-panel .cm-actions{flex-direction:column}.cm-panel .cm-action{flex:auto}}
.cm-panel .cm-btn:disabled .t2{opacity:1;color:#c9a8a8}
.cm-panel .cm-status{display:flex;align-items:center;border-top:1px solid #454545;
    padding:0 4px 0 10px;flex-wrap:wrap}
.cm-panel .cm-stat{display:flex;align-items:center;gap:7px;padding:9px 14px 9px 0;
    margin-right:14px;border-right:1px solid #444;white-space:nowrap}
.cm-panel .cm-stat:last-of-type{border-right:0;margin-right:0}
.cm-panel .cm-stat svg{flex:none;width:15px;height:15px;color:#7f7f7f}
.cm-panel .cm-stat .k{color:#a3a3a3}
.cm-panel .cm-stat .v{color:#e2e2e2}
.cm-panel .cm-spacer{flex:1}
.cm-panel .cm-icon{width:30px;height:30px;display:grid;place-items:center;border:0;
    border-radius:4px;background:none;color:#9a9a9a;cursor:pointer}
.cm-panel .cm-icon:hover{background:rgba(255,255,255,.07);color:#ddd}
.cm-panel .cm-icon.cm-open{background:rgba(255,255,255,.1);color:#eee}
.cm-panel .cm-icon svg{width:16px;height:16px}
.cm-panel .cm-flash{display:flex;align-items:flex-start;gap:10px;padding:7px 10px;
    border-top:1px solid #454545;font-size:11px;color:#d98c8c}
.cm-panel .cm-flash[hidden]{display:none}
.cm-panel .cm-flash.cm-ok{color:#8ac88a}
.cm-panel .cm-flash span{flex:1;line-height:1.5}
.cm-panel .cm-flash-action{flex:none;padding:4px 10px;border:1px solid #a86161;border-radius:3px;
    background:#6f3636;color:#fff;cursor:pointer;font:11px Arial,sans-serif}
.cm-panel .cm-flash-action:hover{filter:brightness(1.15)}
.cm-panel .cm-flash-action[hidden]{display:none}
.cm-panel .cm-x{flex:none;border:0;padding:0 2px;background:none;color:inherit;opacity:.55;
    cursor:pointer;font:16px/1 Arial,sans-serif}
.cm-panel .cm-x:hover{opacity:1}
.cm-panel .cm-settings{display:none;gap:10px;padding:11px 10px;flex-wrap:wrap;align-items:flex-end;
    border-top:1px solid #454545;background:rgba(0,0,0,.22)}
.cm-panel .cm-settings.cm-open{display:flex}
.cm-panel .cm-settings label{flex:1 1 170px;font-size:11px;color:#949494}
.cm-panel .cm-key-field{position:relative;flex:1 1 170px;font-size:11px;color:#949494}
.cm-panel .cm-pda-key{display:block;padding-right:22px;color:#cfcfcf;line-height:1.45}
.cm-panel .cm-api-info{position:absolute;z-index:4;top:-3px;right:0}
.cm-panel .cm-api-info summary{display:grid;place-items:center;width:16px;height:16px;border:1px solid #666;
    border-radius:50%;color:#ddd;font-size:10px;font-weight:bold;cursor:pointer;list-style:none}
.cm-panel .cm-api-info summary::-webkit-details-marker{display:none}
.cm-panel .cm-api-popup{position:absolute;top:21px;right:0;width:320px;max-width:calc(100vw - 40px);
    padding:10px;border:1px solid #555;border-radius:4px;background:#222;color:#ddd;
    box-shadow:0 5px 18px rgba(0,0,0,.55);font-size:10px;line-height:1.35}
.cm-panel.cm-pda .cm-api-popup{position:fixed;top:50%;right:12px;left:12px;width:auto;max-width:none;
    max-height:calc(100vh - 24px);box-sizing:border-box;overflow:auto;transform:translateY(-50%)}
.cm-panel .cm-api-popup strong{display:block;margin-bottom:6px;color:#fff;font-size:11px}
.cm-panel .cm-api-popup table{width:100%;border-collapse:collapse}
.cm-panel .cm-api-popup th,.cm-panel .cm-api-popup td{padding:4px;border-top:1px solid #3d3d3d;
    color:#cfcfcf;text-align:left;vertical-align:top}
.cm-panel .cm-api-popup th{width:78px;color:#c3c3c3;font-weight:bold}
.cm-panel .cm-settings input,.cm-panel .cm-settings select{width:100%;box-sizing:border-box;
    margin-top:4px;padding:6px;background:#222;border:1px solid #555;border-radius:3px;color:#ddd;
    font:12px Arial,sans-serif}
.cm-panel .cm-field{flex:1 1 calc(100% - 100px);font-size:11px;color:#949494}
.cm-panel .cm-toggles{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}
.cm-panel .cm-chip{flex:none;padding:6px 13px;border:1px solid #4e4e4e;border-radius:13px;
    background:#242424;color:#9a9a9a;cursor:pointer;font:11px Arial,sans-serif;white-space:nowrap;
    line-height:1;transition:background .12s,border-color .12s,color .12s}
.cm-panel .cm-chip:hover{border-color:#6d6d6d;color:#b6b6b6}
.cm-panel .cm-chip.cm-on{background:linear-gradient(180deg,#3d823d,#357a35);border-color:#57b357;
    color:#fff}
.cm-panel .cm-chip.cm-on::before{content:"✓  "}
.cm-panel .cm-chip.cm-on:hover{filter:brightness(.9);color:#fff}
.cm-panel .cm-save{padding:7px 22px;border:0;border-radius:3px;background:#4a6d8c;color:#fff;
    font:12px Arial,sans-serif;cursor:pointer}
`;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
})();
