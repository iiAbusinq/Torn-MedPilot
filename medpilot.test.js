const assert = require('assert');
const {
    MEDS, ALLOWED_BLOOD, BLOOD_BAG_IDS,
    plan, byStartOrder, parseMaxCooldown, parseMaxMedicalCooldown, foldStock, parsePerks,
    predictedHospital, predictedCooldown, pathLabel, asClock, asDuration, firstCheaperWait, lifeAfterWaiting,
} = require('./medpilot.user.js');

const meds = MEDS;
const bagsInTable = MEDS.filter(m => /^Blood Bag/.test(m.name)).map(m => m.id).sort();
assert.deepEqual(bagsInTable, [...BLOOD_BAG_IDS].sort());
assert.equal(MEDS.length, 11);
assert.ok(MEDS.every(m => m.hospital > 0 && m.life > 0 && m.cooldown > 0));
const all = { 66: 5, 67: 5, 68: 5, 739: 5, 732: 5 };

const one = (hosp, bonus, ...rest) => {
    const p = plan(hosp, 0, bonus, ...rest);
    assert.equal(p.items.length, 1);
    return p.items[0].name;
};
assert.equal(one(15, 0, meds, all, 'o-'), 'Small First Aid Kit');
assert.equal(one(25, 0, meds, all, 'o-'), 'First Aid Kit');
assert.equal(one(50, 0, meds, all, 'o-'), 'Morphine');
assert.equal(one(100, 0, meds, all, 'o-'), 'Blood Bag : O-');
assert.equal(one(50, 50, meds, all, 'o-'), 'First Aid Kit');
assert.match(plan(100, 0, 0, meds, { 732: 1 }, 'o-').error, /blood type O-/);
assert.match(plan(100, 0, 0, meds, {}, 'o-').error, /No usable medical items/);
assert.equal(one(100, 0, meds, { 732: 1 }, 'a+'), 'Blood Bag : A+');
assert.equal(one(100, 0, meds, { 739: 1 }, 'a+'), 'Blood Bag : O-');
assert.ok(plan(10, 0, 0, meds, {}, 'o-').error);

const chain = plan(130, 0, 0, meds, all, 'o-');
assert.deepEqual(chain.items.map(i => i.name), ['Small First Aid Kit', 'Blood Bag : O-']);
assert.equal(chain.cooldown, 40);
assert.equal(plan(300, 0, 0, meds, { 739: 3 }, 'o-').items.length, 3);
const short = plan(300, 0, 0, meds, { 739: 1 }, 'o-');
assert.equal(short.short, 180);
assert.match(short.error, /Short by 180m \(best -120m\)/);

{
    const qty = { ...all };
    const whole = plan(137, 0, 2, meds, qty, 'o+');
    assert.deepEqual(whole.items.map(i => i.name), ['Small First Aid Kit', 'Blood Bag : O-']);
    assert.equal(whole.cooldown, 40);
    let left = 137, spent = 0, steps = 0;
    while (left > 0 && steps < 10) {
        const step = plan(left, 0, 2, meds, qty, 'o+');
        assert.ok(!step.error, 'path must stay feasible');
        const it = step.items[0];
        qty[it.id]--;
        left -= it.hospital;
        spent += it.cooldown;
        steps++;
    }
    assert.ok(left <= 0, 'stepping through the path leaves hospital');
    assert.equal(spent, whole.cooldown);
    assert.equal(steps, whole.items.length);
}

{
    const stock = { 739: 10, 66: 10, 67: 10, 68: 10 };
    const sum = (items, k) => items.reduce((t, i) => t + i[k], 0);

    const life = plan(0, 100, 0, MEDS, stock, 'o-');
    assert.equal(life.cooldown, 105);
    assert.ok(sum(life.items, 'life') >= 100);

    assert.equal(plan(100, 0, 0, MEDS, stock, 'o-').cooldown, 30);

    const both = plan(100, 100, 0, MEDS, stock, 'o-');
    assert.equal(both.cooldown, 105);
    assert.ok(sum(both.items, 'hospital') >= 100 && sum(both.items, 'life') >= 100);

    assert.ok(both.cooldown >= plan(100, 0, 0, MEDS, stock, 'o-').cooldown);

    assert.ok(plan(0, 100, 0, MEDS, { 732: 10 }, 'o-').error);
    assert.ok(plan(0, 100, 0, MEDS, { 68: 1 }, 'o-').error);

    const boosted = plan(0, 100, 50, MEDS, stock, 'o-');
    assert.equal(boosted.cooldown, 75);
    assert.equal(boosted.items.length, 3);
    assert.ok(sum(boosted.items, 'life') >= 100);
}

{
    const now = 1_600_000_000;
    const min = 60;
    const start = now + 60 * min;
    const target = start - 60 * min;
    assert.equal(predictedHospital(start, target), target);
    assert.equal(predictedHospital(start - 20 * min, target), target);
    assert.equal(predictedHospital(0, target), 0);
    assert.equal(predictedHospital(start, 0), start);

    const cd = now + 20 * min;
    assert.equal(predictedCooldown(now, cd), cd);
    assert.equal(predictedCooldown(now + 25 * min, cd), now + 25 * min);
    assert.equal(predictedCooldown(cd, 0), cd);
}

{
    const stock = { 66: 5, 67: 5, 68: 5, 739: 5 };
    const without = id => MEDS.filter(m => m.id !== id);
    assert.equal(plan(60, 0, 0, MEDS, stock, 'o-').items[0].name, 'Morphine');
    const noMorph = plan(60, 0, 0, without(66), stock, 'o-');
    assert.ok(!noMorph.items.some(i => i.name === 'Morphine'));
    assert.deepEqual(noMorph.items.map(i => i.name), ['Small First Aid Kit', 'First Aid Kit']);
    assert.equal(noMorph.cooldown, 25);
    assert.ok(plan(60, 0, 0, [], stock, 'o-').error);
    assert.ok(plan(60, 50, 0, [], stock, 'o-').error);
}

{
    const stock = { 66: 5, 67: 5, 68: 5, 739: 5 };
    const out = plan(60, 0, 0, MEDS, stock, 'o-');
    const both = plan(60, 0, 0, MEDS, stock, 'o-');
    assert.equal(both.cooldown, out.cooldown);
    assert.deepEqual(both.items.map(i => i.name), out.items.map(i => i.name));
    assert.equal(both.items[0].name, 'Morphine');
    assert.equal(plan(0, 0, 0, MEDS, stock, 'o-').items.length, 0);
}

{
    const deep = { 66: 6975, 67: 2273, 68: 551, 738: 8498, 739: 1428 };
    const life = r => r.items.reduce((t, i) => t + i.life, 0);
    const at200 = plan(200, 0, 2, MEDS, deep, 'o+');
    assert.equal(at200.cooldown, 60);
    assert.equal(at200.items.length, 2, 'two bags, not three smaller items');
    assert.equal(life(at200), 61.2, 'two bags restore 61.2% with the 2% bonus');
    const at260 = plan(260, 0, 2, MEDS, deep, 'o+');
    assert.equal(at260.cooldown, 70);
    assert.ok(Math.abs(life(at260) - 66.3) < 1e-9);
}

{
    const bag = { cooldown: 30, hospital: 120, life: 30, name: 'Blood Bag : O-', id: 739 };
    const sfak = { cooldown: 10, hospital: 20, life: 5, name: 'Small First Aid Kit', id: 68 };
    assert.deepEqual(byStartOrder([bag, sfak]).map(i => i.cooldown), [10, 30]);
    const stock2 = { 739: 10, 66: 10, 67: 10, 68: 10 };
    const cds = plan(130, 0, 0, MEDS, stock2, 'o-').items.map(i => i.cooldown);
    assert.deepEqual(cds, [...cds].sort((x, y) => x - y), 'plan path ascends');
    const fcds = plan(100, 100, 0, MEDS, stock2, 'o-').items.map(i => i.cooldown);
    assert.deepEqual(fcds, [...fcds].sort((x, y) => x - y), 'plan path ascends');
}

assert.equal(parseMaxCooldown('08:45:00'), 525);
assert.equal(parseMaxCooldown('06:00:00'), 360);
assert.equal(parseMaxCooldown(undefined), null);

assert.equal(parseMaxMedicalCooldown({ faction_perks: [
    '+ 180 minutes maximum medical cooldown',
] }), 540);
assert.equal(parseMaxMedicalCooldown({
    education_perks: ['+ 10% medical item effectiveness'],
    faction_perks: ['+ 20% medical item effectiveness'],
}), 360);

assert.deepEqual(foldStock([
    { itemID: 67, qty: 100, itemActions: { usable: true } },
    { itemID: 67, qty: 23, itemActions: { usable: true } },
    { itemID: 68, qty: 5, itemActions: { usable: false } },
]), { 67: 123 });
assert.deepEqual(foldStock(undefined), {});

assert.equal(parsePerks({
    education_perks: ['+ 1% dexterity', '+ 10% medical item effectiveness'],
    faction_perks: ['+ 20% medical item effectiveness'],
    job_perks: [],
}), 30);

{
    const step = short => ({ short });
    assert.equal(pathLabel([step('FAK')]), 'FAK');
    assert.equal(pathLabel([step('SFAK'), step('SFAK'), step('FAK')]), '2× SFAK → FAK');
    assert.equal(pathLabel([step('SFAK'), step('FAK'), step('Morphine')]),
        'SFAK → FAK → Morphine');
    const bags = plan(300, 0, 0, MEDS, { 739: 5 }, 'o-');
    assert.equal(pathLabel(bags.items), '3× Bag');
}

{
    assert.equal(asClock(0), '0m 00s');
    assert.equal(asClock(0.5), '0m 30s');
    assert.equal(asClock(-1), '0m 00s');
    assert.equal(asClock(125.5), '2h 05m 30s');
    assert.equal(asClock(59.996), '1h 00m 00s');
}

console.log('ok');

{
    const gain = { increment: 117, interval: 300 };
    const life = { current: 887, maximum: 1675 };
    const after = (minutes, toNext) => lifeAfterWaiting(life, minutes, gain, toNext).current;
    assert.equal(after(2, 180), 887);
    assert.equal(after(3, 180), 887 + 117);
    assert.equal(after(7, 180), 887 + 117);
    assert.equal(after(8, 180), 887 + 234, 'the second boundary lands five minutes later');
    assert.equal(lifeAfterWaiting({ current: 1600, maximum: 1675 }, 10, gain, 60).current, 1675);
    assert.deepEqual(lifeAfterWaiting(life, 30, null, 60), life);
}

{
    const stepped = wait => (wait < 8 ? 40 : 30);
    const found = firstCheaperWait(stepped, 15, 40);
    assert.ok(Math.abs(found - 8) <= 1 / 60, 'lands on the boundary within a second');
    assert.equal(firstCheaperWait(stepped, 5, 40), null, 'boundary outside the window');
    assert.equal(firstCheaperWait(() => 40, 15, 40), null, 'nothing to gain');

    const stock = { 66: 50, 67: 50, 68: 50, 739: 50 };
    const cost = wait => plan(Math.max(0, Math.ceil(22 - wait)), 0, 0, MEDS, stock, 'o-').cooldown;
    assert.equal(cost(0), 15);
    const wait = firstCheaperWait(cost, 15, 15);
    assert.ok(wait > 1.9 && wait <= 2.1, `expected about two minutes, got ${wait}`);
    assert.equal(cost(wait), 10);
}
