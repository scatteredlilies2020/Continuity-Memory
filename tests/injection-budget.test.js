import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicInjectionBudget, resolveInjectionBudget } from '../extension/injection-budget.js';

test('dynamic injection budget uses twenty percent of context without a fixed ceiling', () => {
    assert.equal(dynamicInjectionBudget(32000), 6400);
    assert.equal(dynamicInjectionBudget(50000), 10000);
    assert.equal(dynamicInjectionBudget(128000), 25600);
    assert.equal(dynamicInjectionBudget(200000), 40000);
    assert.equal(dynamicInjectionBudget(1000000), 200000);
});

test('explicit injection budgets remain available', () => {
    assert.deepEqual(resolveInjectionBudget(4500, 128000), { tokens: 4500, mode: 'fixed', contextSize: 128000 });
    assert.deepEqual(resolveInjectionBudget(0, 128000), { tokens: 25600, mode: 'dynamic', contextSize: 128000 });
});
