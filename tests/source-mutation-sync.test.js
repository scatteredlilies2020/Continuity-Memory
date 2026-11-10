import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/index.js', import.meta.url), 'utf8');
const sync = source.match(/function synchronizeSourceMutation\([^]*?^}/m)[0];
function fixture(repair) {
    const scope = vm.createContext({ mutationRepairPromise: null, mutationSync: 42, divergenceRepairRequested: true,
        runtime: { processing: false }, clearTimeout: () => {},
        getTailRollbackStatus: () => ({ detected: false }), repairDivergedBranch: repair,
        syncChangedExtractions: () => assert.fail('deletion must repair the suffix') });
    vm.runInContext(sync, scope);
    return scope;
}

test('timer and immediate generation share one repair, cancelling the debounce', async () => {
    let release, calls = 0;
    const work = new Promise(resolve => { release = resolve; });
    const scope = fixture(async () => { calls++; return work; });
    const first = scope.synchronizeSourceMutation();
    assert.equal(scope.synchronizeSourceMutation(), first);
    assert.equal(scope.mutationSync, null);
    release({ repaired: true });
    assert.equal((await first).repaired, true);
    assert.equal(calls, 1);
    assert.equal(scope.mutationRepairPromise, null);
    assert.equal(scope.divergenceRepairRequested, false);
});

test('failed or deferred repair preserves the pending deletion and remains retryable', async () => {
    for (const repair of [() => { throw new Error('offline'); }, async () => ({ deferred: true })]) {
        const scope = fixture(repair);
        try { await scope.synchronizeSourceMutation(); } catch (error) { assert.match(error.message, /offline/); }
        assert.equal(scope.divergenceRepairRequested, true);
        assert.equal(scope.mutationRepairPromise, null);
        scope.repairDivergedBranch = async () => ({ repaired: true });
        assert.equal((await scope.synchronizeSourceMutation()).repaired, true);
    }
});

test('another mutation arriving during repair is not cleared by its completion', async () => {
    let release;
    const scope = fixture(() => new Promise(resolve => { release = resolve; }));
    const run = scope.synchronizeSourceMutation();
    await Promise.resolve();
    scope.divergenceRepairRequested = true;
    release({ repaired: true });
    await run;
    assert.equal(scope.divergenceRepairRequested, true);
});
