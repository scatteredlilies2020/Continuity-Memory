import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { buildMemoryPrompt, prepareRetrievalCorpus } from '../extension/retrieval.js';
import { CHAT_KEY, recallWorld, recallCases, evaluateRecall } from './fixtures/recall-world.mjs';

function argument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`--${name} needs a value.`);
    return process.argv[index + 1];
}
const sizes = argument('sizes', '500,2000,10000').split(',').map(Number);
const runs = Number(argument('runs', '3'));
if (!sizes.length || sizes.some(size => !Number.isSafeInteger(size) || size < 0 || size > 100000)) throw new Error('Sizes must be integers from 0 to 100000.');
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error('Runs must be an integer from 1 to 100.');

function distribution(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return {
        median: Number((sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2).toFixed(2)),
        max: Number(sorted.at(-1).toFixed(2)),
    };
}
function build(world, scenario) {
    return buildMemoryPrompt(world, [{ is_user: true, mes: scenario.query }], 6000, CHAT_KEY, [], undefined, new Map(), scenario.options);
}

// JIT warmup is not part of the measurements; fixture generation/cloning is
// excluded too. Cold means an uncached world, not a fresh Node process.
const warmup = recallWorld(50);
for (const scenario of recallCases) build(warmup, scenario);
const results = [];
for (const size of sizes) {
    const original = recallWorld(size);
    const coldBuildMs = [], prepareMs = [], warmBuildMs = [], promptTokens = [];
    const failures = [];
    let checks = 0;
    let yields = 0;
    const check = (world, scenario, result) => {
        checks++;
        const report = evaluateRecall(world, scenario, result);
        if (!report.passed) failures.push(report);
        promptTokens.push(result.estimatedTokens);
    };
    for (let run = 0; run < runs; run++) {
        const prepared = structuredClone(original);
        let start = performance.now();
        await prepareRetrievalCorpus(prepared, async () => { yields++; await setImmediate(); });
        prepareMs.push(performance.now() - start);
        for (const scenario of recallCases) {
            const cold = structuredClone(original);
            start = performance.now();
            const coldResult = build(cold, scenario);
            coldBuildMs.push(performance.now() - start);
            check(cold, scenario, coldResult);
            start = performance.now();
            const warmResult = build(prepared, scenario);
            warmBuildMs.push(performance.now() - start);
            check(prepared, scenario, warmResult);
            if (coldResult.prompt !== warmResult.prompt) failures.push({ name: scenario.name, reason: 'cold/prepared prompt mismatch' });
        }
    }
    results.push({
        distractors: size,
        records: ['facts', 'states', 'entities', 'relationships', 'events', 'threads', 'backgrounds', 'capsules'].reduce((sum, key) => sum + original[key].length, 0),
        sourceMessages: 640, cases: recallCases.length, runs, checks, passed: failures.length === 0,
        coldBuildMs: distribution(coldBuildMs), prepareMs: distribution(prepareMs),
        warmBuildMs: distribution(warmBuildMs), preparationYields: yields,
        estimatedPromptTokens: { min: Math.min(...promptTokens), max: Math.max(...promptTokens) }, failures,
    });
}
console.log(JSON.stringify({
    fixture: 'fabricated long-history memory; no live chat or model calls',
    runtime: process.version, platform: `${process.platform}/${process.arch}`,
    timing: 'milliseconds; includes local retrieval/packing only, no network or generation; not a CI timing threshold',
    results,
}, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
