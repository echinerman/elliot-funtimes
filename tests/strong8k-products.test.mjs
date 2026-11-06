import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getLegacyProductMigrationCandidates,
    inferStrong8kDuration,
    mergeStrong8kProducts,
    normalizeStrong8kProduct,
    strong8kProductPayload
} from '../strong8k-products.mjs';

const legacy = [
    { id: '1_month', name: '1 Month Access', price: 10, credits: 1 },
    { id: '3_month', name: '3 Months Bundle', price: 25, credits: 3 },
    { id: '6_month', name: '6 Months Deal', price: 40, credits: 6 },
    { id: '12_month', name: '1 Year VIP', price: 60, credits: 12 }
];

test('maps supported legacy names and credits to renewal durations', () => {
    assert.equal(inferStrong8kDuration({ name: '1 Year VIP' }), 12);
    assert.equal(inferStrong8kDuration({ id: '3_month' }), 3);
    assert.equal(inferStrong8kDuration({ credits: 6 }), 6);
});

test('merges both collections without hiding legacy siblings', () => {
    const merged = mergeStrong8kProducts([
        { id: '12_month', name: '1 Year VIP', price: 70, credits: 12 }
    ], legacy);

    assert.deepEqual(merged.filter(product => product.kind === 'renewal').map(product => product.duration_months), [1, 3, 6, 12]);
    assert.equal(merged.find(product => product.duration_months === 12).price, 70);
    assert.equal(merged.find(product => product.duration_months === 12).source, 'canonical');
});

test('finds only legacy renewal durations missing from the canonical collection', () => {
    const candidates = getLegacyProductMigrationCandidates([
        { id: '12_month', name: '1 Year VIP', price: 70, credits: 12 }
    ], legacy);

    assert.deepEqual(candidates.map(product => product.duration_months), [1, 3, 6]);
});

test('links credits directly to renewal duration', () => {
    assert.deepEqual(strong8kProductPayload({
        id: '12_month',
        name: '1 Year VIP',
        price: 70,
        duration_months: 12,
        credits: 99,
        active: true
    }), {
        name: '1 Year VIP',
        price: 70,
        duration_months: 12,
        credits: 12,
        kind: 'renewal',
        active: true,
        sort_order: 12
    });
});

test('keeps unsupported legacy products out of the renewal flow', () => {
    const demo = normalizeStrong8kProduct({ id: 'demo_1day', name: 'Demo (1 Day)', credits: 0 });
    assert.equal(demo.kind, 'manual');
    assert.equal(demo.active, false);
});
