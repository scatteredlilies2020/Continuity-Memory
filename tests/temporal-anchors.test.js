import assert from 'node:assert/strict';
import test from 'node:test';
import { addDerivedArc, addDerivedEra, mergeExtraction } from '../extension/memory-model.js';
import { buildMemoryPrompt } from '../extension/retrieval.js';
import { anchoredRelativeText, anchoredStoryTime, l1AnchorId } from '../extension/temporal-anchors.js';

function world() {
    return {
        id: 'temporal-world', name: 'Temporal test', revision: 0, scene: null,
        entities: [], facts: [], states: [], relationships: [], events: [], capsules: [], arcs: [], eras: [], extractions: [], threads: [], sources: {},
    };
}

function extraction({ title = 'Scene', storyTime = '', temporal, event, fact, thread } = {}) {
    return {
        scene: { location: '', time: storyTime, participants: ['A'], activity: '', mood: '' },
        sceneCapsule: {
            title, storyTime, location: '', participants: ['A'], opening: `${title} opened.`, beats: [], emotionalArc: '', closing: `${title} closed.`, importance: 3,
            temporal: temporal || { frame: 'main narrative', relation: 'unknown', elapsed: '', certainty: 'unknown' },
        },
        entities: [],
        facts: fact ? [{ subject: 'A', predicate: 'memory', value: fact, category: 'history', importance: 3, persistence: 'persistent' }] : [],
        states: [], relationships: [],
        events: event ? [{ title: event.title, summary: event.summary || event.title, participants: ['A'], location: '', storyTime: event.storyTime || '', consequences: '', importance: 3, temporal: event.temporal }] : [],
        threads: thread ? [{ title: 'Plan', detail: thread, status: 'open', participants: ['A'], importance: 3 }] : [],
    };
}

test('deictic wording remains bound to the immutable L1 where it was recorded', () => {
    const target = world();
    const chatKey = 'chat:deictic';
    mergeExtraction(target, extraction({
        title: 'Yesterday meeting', storyTime: 'yesterday',
        fact: 'A met B yesterday', thread: 'A will call B tomorrow',
        event: {
            title: 'Yesterday meeting', storyTime: 'yesterday',
            temporal: { frame: 'main narrative', relation: 'before', elapsed: 'one local day', certainty: 'explicit' },
        },
    }), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    const firstAnchor = target.capsules[0].temporal.anchorId;

    mergeExtraction(target, extraction({
        title: 'Later scene', storyTime: 'later',
        temporal: { frame: 'main narrative', relation: 'after', elapsed: '', certainty: 'implicit' },
    }), { chatKey, from: 8, to: 15, allowStateUpdates: true });

    assert.equal(firstAnchor, l1AnchorId({ chatKey, from: 0, to: 7 }));
    assert.equal(target.events[0].temporal.referenceId, firstAnchor);
    assert.equal(target.events[0].temporal.elapsed, 'one local day');
    assert.equal(target.facts[0].temporalAnchorId, firstAnchor);
    assert.equal(target.threads[0].temporalAnchorId, firstAnchor);
    const prompt = buildMemoryPrompt(target, [{ name: 'User', mes: 'What about the meeting and call?' }], 3000, chatKey).prompt;
    assert.match(prompt, new RegExp(`yesterday[^\\n]*relative to ${firstAnchor}`, 'i'));
    assert.match(prompt, new RegExp(`tomorrow \\(relative to ${firstAnchor}\\)`, 'i'));
});

test('message distance never becomes elapsed story time', () => {
    const target = world();
    const chatKey = 'chat:long-day';
    mergeExtraction(target, extraction({ title: 'Morning' }), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    const firstAnchor = target.capsules[0].temporal.anchorId;
    mergeExtraction(target, extraction({
        title: 'Still the same day',
        temporal: { frame: 'main narrative', relation: 'same-period', elapsed: 'one year', certainty: 'implicit' },
    }), { chatKey, from: 2000, to: 2007, allowStateUpdates: true });

    assert.equal(target.capsules[1].temporal.referenceId, firstAnchor);
    assert.equal(target.capsules[1].temporal.relation, 'same-period');
    assert.equal(target.capsules[1].temporal.elapsed, '');
});

test('an explicit time skip survives even across few messages', () => {
    const target = world();
    const chatKey = 'chat:time-skip';
    mergeExtraction(target, extraction({ title: 'Before skip' }), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        title: 'After skip', storyTime: 'one year later',
        temporal: { frame: 'main narrative', relation: 'after', elapsed: 'one year', certainty: 'explicit' },
    }), { chatKey, from: 100, to: 107, allowStateUpdates: true });

    assert.equal(target.capsules[1].temporal.referenceId, target.capsules[0].temporal.anchorId);
    assert.equal(target.capsules[1].temporal.elapsed, 'one year');
    assert.match(anchoredStoryTime(target.capsules[1]), /interval one year/);
});

test('subjective frames link only to their own prior frame', () => {
    const target = world();
    const chatKey = 'chat:frames';
    mergeExtraction(target, extraction({ title: 'Main scene' }), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        title: 'Dream century',
        temporal: { frame: 'A dream', relation: 'detached', elapsed: '', certainty: 'explicit' },
    }), { chatKey, from: 8, to: 15, allowStateUpdates: true });
    mergeExtraction(target, extraction({
        title: 'Main resumes',
        temporal: { frame: 'main narrative', relation: 'after', elapsed: '', certainty: 'implicit' },
    }), { chatKey, from: 16, to: 23, allowStateUpdates: true });

    assert.equal(target.capsules[1].temporal.referenceId, '');
    assert.equal(target.capsules[1].temporal.relation, 'detached');
    assert.equal(target.capsules[2].temporal.referenceId, target.capsules[0].temporal.anchorId);
    assert.notEqual(target.capsules[2].temporal.referenceId, target.capsules[1].temporal.anchorId);
});

test('L2 and L3 preserve anchor spans without inflating ordinary text', () => {
    const target = world();
    const chatKey = 'chat:hierarchy';
    mergeExtraction(target, extraction({ title: 'First' }), { chatKey, from: 0, to: 7, allowStateUpdates: true });
    mergeExtraction(target, extraction({ title: 'Second' }), { chatKey, from: 8, to: 15, allowStateUpdates: true });
    const arc = addDerivedArc(target, {
        title: 'Last year arc', storyTime: 'last year', participants: ['A'], summary: 'Two scenes occurred.', turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 3,
    }, target.capsules);
    const era = addDerivedEra(target, {
        title: 'Era', storyTime: 'last year', participants: ['A'], summary: 'The arc occurred.', turningPoints: [], emotionalArc: '', closingState: '', openThreads: [], importance: 3,
    }, [arc]);

    assert.deepEqual(arc.temporalAnchorIds, target.capsules.map(item => item.temporal.anchorId));
    assert.deepEqual(era.temporalAnchorIds, arc.temporalAnchorIds);
    assert.match(anchoredStoryTime(era), /relative to L1-.*…L1-/);
    assert.equal(anchoredStoryTime({ storyTime: 'After school', temporalAnchorIds: arc.temporalAnchorIds }), 'After school');
    assert.equal(anchoredRelativeText('A waited at the station', arc), 'A waited at the station');
    assert.equal(anchoredRelativeText('A waited for the last 300 days', arc), `A waited for the last 300 days (relative to ${arc.temporalAnchorIds[0]}…${arc.temporalAnchorIds.at(-1)})`);
});

test('legacy relative phrases fail closed until they are re-extracted with anchors', () => {
    assert.equal(anchoredStoryTime({ storyTime: 'yesterday' }), 'yesterday; relative to its recorded past source; exact anchor unavailable');
    assert.equal(anchoredRelativeText('They will return tomorrow', {}), 'They will return tomorrow (relative to its recorded past source; exact anchor unavailable)');
});
