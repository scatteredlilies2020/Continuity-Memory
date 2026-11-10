import assert from 'node:assert/strict';
import test from 'node:test';
import { fitGenerationMemory, generationMemoryCapacity } from '../extension/generation-context-budget.js';

test('capacity excludes history and CM but reserves preset, response, recent turns and safety', () => {
    const manager = { serviceSettings: { openai_max_context: 10000, openai_max_tokens: 2000 },
        tokenHandler: { counts: { main: 1500, chatHistory: 9000, continuity_memory_dynamic: 3000 } } };
    assert.equal(generationMemoryCapacity(8000, manager, 1000), 4988);
    assert.equal(generationMemoryCapacity(10000, manager, 1000), 4988, 'Response allowance is subtracted only once.');
    assert.equal(generationMemoryCapacity(4000, manager, 1000), 988, 'A smaller current context takes precedence.');
    assert.equal(generationMemoryCapacity(8000, { serviceSettings: { openai_max_context: 1000, openai_max_tokens: 2000 } }), 0);
});

const snapshot = { injection: 'x'.repeat(8000), injectionBudget: { tokens: 7000, mode: 'fixed' }, retrieval: { original: true } };
const options = { snapshot, contextSize: 5000, manager: null, recentText: 'recent', countTokens: async text => text.length };

test('oversized cached recall is rebuilt and measured instead of installed as mandatory', async () => {
    const targets = [];
    const fitted = await fitGenerationMemory({ ...options, rebuild: async tokens => {
        targets.push(tokens);
        return { prompt: 'x'.repeat(tokens + 200), retrievalDiagnostics: { fitted: true } };
    } });
    assert.ok(fitted.injectionTokens <= generationMemoryCapacity(5000, null, 70));
    assert.ok(targets.length > 0);
    assert.ok(targets[0] < 7000);
    assert.equal(fitted.injectionBudget.contextLimited, true);
    assert.deepEqual(fitted.retrieval, { fitted: true });
    assert.equal(snapshot.injection.length, 8000, 'Saved/prepared content is not mutated.');
});

test('an oversized Chronicle automatically fits a request-only excerpt without changing saved memory', async () => {
    const targets = [];
    const prompt = 'Full canonical prose. '.repeat(500) + 'Most recent event.';
    const fitted = await fitGenerationMemory({ ...options, rebuild: async tokens => {
        targets.push(tokens);
        return { prompt };
    } });
    assert.ok(fitted.injectionTokens <= generationMemoryCapacity(5000, null, 70));
    assert.match(fitted.injection, /^\[Continuity Memory: context-limited excerpt/);
    assert.ok(fitted.injection.endsWith('Most recent event.'));
    assert.equal(fitted.injectionBudget.injectionShortened, true);
    assert.equal(snapshot.injection.length, 8000);
    assert.equal(prompt.length, 'Full canonical prose. '.repeat(500).length + 'Most recent event.'.length);
    assert.ok(targets.includes(128));
    assert.ok(targets.length <= 3);
});

test('zero remaining capacity omits only the injected memory and does not block generation', async () => {
    const fitted = await fitGenerationMemory({ ...options, contextSize: 100,
        rebuild: async () => ({ prompt: 'Still too large' }) });
    assert.equal(fitted.injection, '');
    assert.equal(fitted.injectionTokens, 0);
    assert.equal(fitted.injectionBudget.injectionShortened, true);
    assert.equal(snapshot.injection.length, 8000);
});

test('unmeasurable injection is omitted rather than failing the size step', async () => {
    const fitted = await fitGenerationMemory({ ...options, countTokens: async () => NaN });
    assert.equal(fitted.injection, '');
    assert.equal(fitted.injectionTokens, 0);
});

test('ordinary fitting recall is measured once without rebuilding', async () => {
    const small = { injection: 'Small memory', injectionBudget: { tokens: 2000 } };
    const fitted = await fitGenerationMemory({ ...options, snapshot: small, rebuild: () => assert.fail('unnecessary rebuild') });
    assert.equal(fitted.injection, small.injection);
    assert.equal(fitted.injectionTokens, small.injection.length);
    assert.equal(await fitGenerationMemory({ snapshot: null }), null);
});
