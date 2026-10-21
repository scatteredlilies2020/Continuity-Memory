import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReviewedMemoryContent } from '../extension/review-content.js';
import { approveExtractionReview, cancelExtractionReview, getPendingExtractionReview, regenerateExtractionReview, requestExtractionReview } from '../extension/extraction-review.js';

function digest() {
    return { scene: { location: 'Road', time: '', participants: ['Alice'], activity: 'Walking', mood: '' },
        sceneCapsule: { title: 'A walk', storyTime: '', location: 'Road', participants: ['Alice'], opening: 'Alice walks.', beats: [], emotionalArc: '', closing: '', importance: 3 },
        entities: [], facts: [{ targetId: 'fact-one', subject: 'Alice', predicate: 'snack', value: 'bread', category: 'preference', persistence: 'persistent', importance: 3 }],
        states: [], relationships: [], events: [], threads: [], backgrounds: [], identityResolutions: [], recordMerges: [], chronicleEntry: 'Alice walks.',
        _sourceScenarioContext: [{ text: 'An actual source note.', messageIndex: 0 }] };
}

test('Digest review accepts prose, lists and profile content while preserving record routing', () => {
    const original = digest();
    const edited = structuredClone(original);
    edited.facts[0].value = 'cake';
    edited.sceneCapsule.beats = ['Alice stops by the bakery.'];
    assert.equal(assertReviewedMemoryContent(edited, original), edited);
    assert.deepEqual(original, digest());
});

test('Digest review rejects protected fields, source manipulation, wrong targets and invalid types', () => {
    const original = digest();
    const attempts = [
        value => { value.facts[0].targetId = 'some-other-record'; },
        value => { value.facts[0].targetId = ''; },
        value => { delete value.facts[0].targetId; },
        value => { value.facts[0].subject = 'Bob'; },
        value => { value.facts[0].predicate = 'unrelated identity'; },
        value => { value.facts[0].id = 'replace-record'; },
        value => { value.facts[0].sources = [{ chatKey: 'wrong', from: 0, to: 99 }]; },
        value => { value.sceneCapsule.from = 999; },
        value => { value._sourceScenarioContext[0].text = 'Invented evidence'; },
        value => { value._newInternalField = true; },
        value => { value.identityResolutions = [{ reference: 'Alice', canonical: 'Bob', evidence: 'Wrong identity' }]; },
        value => { value.recordMerges = [{ collection: 'facts', canonicalId: 'fact-one', duplicateIds: ['other'], evidence: 'Wrong merge' }]; },
        value => { value.scene.participants = 'Alice'; },
        value => { value.facts[0].value = { value: 'cake' }; },
        value => { value.facts[0].importance = 99; },
        value => { value.sceneCapsule.beats = Array(11).fill('Point'); },
    ];
    for (const mutate of attempts) {
        const edited = structuredClone(original);
        mutate(edited);
        assert.throws(() => assertReviewedMemoryContent(edited, original), /Invalid or protected/);
    }
});

test('Chronicle review changes content without admitting child links or source ranges', () => {
    const original = { title: 'History', summary: 'An old summary.', participants: [], turningPoints: [], openThreads: [], importance: 3 };
    assertReviewedMemoryContent({ ...original, summary: 'A corrected summary.' }, original, 'C1');
    for (const field of ['id', 'childIds', 'capsuleIds', 'chatKey', 'from', 'to', 'level']) {
        assert.throws(() => assertReviewedMemoryContent({ ...original, [field]: [] }, original, 'C1'), /protected/);
    }
});

test('an invalid Digest draft stays open and can be corrected without changing the selected candidate', async () => {
    const original = digest();
    const completion = requestExtractionReview({ result: original,
        validate: (value, candidate) => assertReviewedMemoryContent(value, candidate) });
    const id = getPendingExtractionReview().id;
    const wrong = structuredClone(original);
    wrong.facts[0].targetId = 'wrong';
    assert.throws(() => approveExtractionReview(JSON.stringify(wrong), id), /protected/);
    assert.equal(getPendingExtractionReview().id, id);
    assert.match(getPendingExtractionReview().json, /wrong/);
    const corrected = structuredClone(original);
    corrected.facts[0].value = 'cake';
    approveExtractionReview(JSON.stringify(corrected), id);
    assert.equal((await completion).facts[0].value, 'cake');
    assert.deepEqual(original, digest());
});

test('Digest drafts hide internal source metadata while keeping the original candidate for validation', async () => {
    const original = digest();
    let source;
    const completion = requestExtractionReview({ result: original, validate: (value, candidate) => {
        source = candidate._sourceScenarioContext;
        return assertReviewedMemoryContent(value, candidate);
    } });
    const review = getPendingExtractionReview();
    assert.ok(!review.json.includes('_sourceScenarioContext'));
    assert.ok(!review.originalJson.includes('_sourceScenarioContext'));
    const edited = JSON.parse(review.json);
    edited.facts[0].value = 'cake';
    approveExtractionReview(JSON.stringify(edited));
    assert.equal((await completion).facts[0].value, 'cake');
    assert.deepEqual(source, original._sourceScenarioContext);
});

test('a regenerated review validates routing against its own candidate', async () => {
    const original = digest();
    const regenerated = digest();
    regenerated.facts[0].targetId = 'new-candidate-target';
    const completion = requestExtractionReview({ result: original, regenerate: async () => regenerated,
        validate: (value, candidate) => assertReviewedMemoryContent(value, candidate) });
    await regenerateExtractionReview(getPendingExtractionReview().json);
    const edited = JSON.parse(getPendingExtractionReview().json);
    edited.facts[0].value = 'cake';
    approveExtractionReview(JSON.stringify(edited));
    assert.equal((await completion).facts[0].targetId, 'new-candidate-target');
    assert.equal(getPendingExtractionReview(), null);
});

test('an old review cannot approve a later record candidate', async () => {
    const first = requestExtractionReview({ result: digest() });
    const id = getPendingExtractionReview().id;
    cancelExtractionReview(undefined, id);
    await assert.rejects(first);
    const second = requestExtractionReview({ result: digest() });
    assert.throws(() => approveExtractionReview('{}', id), /no longer active/);
    cancelExtractionReview();
    await assert.rejects(second);
});
