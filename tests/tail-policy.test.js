import test from 'node:test';
import assert from 'node:assert/strict';
import { tailPolicy } from '../extension/tail-policy.js';

test('dynamic token limit does not fill all available context', () => {
    const policy = tailPolicy({ rawTailMode: 'tokens', rawTailValue: 0 }, 50000, 5000);
    assert.equal(policy.budget, 12500);
    assert.equal(policy.maxMessages, Number.MAX_SAFE_INTEGER);
    assert.equal(policy.minimumMessages, 4);
});

test('dynamic token limit caps at twenty-five thousand tokens', () => {
    const policy = tailPolicy({ rawTailMode: 'tokens', rawTailValue: 0 }, 200000, 20000);
    assert.equal(policy.budget, 25000);
});

test('explicit token limit remains bounded by fixed prompt overhead', () => {
    const policy = tailPolicy({ rawTailMode: 'tokens', rawTailValue: 30000 }, 50000, 38000);
    assert.equal(policy.budget, 7000);
    assert.equal(policy.limitMode, 'tokens');
});

test('turn mode uses only the selected turn limit plus context safety', () => {
    const policy = tailPolicy({ rawTailMode: 'turns', rawTailValue: 5 }, 50000, 5000);
    assert.equal(policy.maxMessages, 10);
    assert.equal(policy.budget, 40000);
    assert.equal(policy.limitMode, 'turns');
});
