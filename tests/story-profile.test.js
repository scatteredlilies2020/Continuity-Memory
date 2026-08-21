import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStoryRequestProfile } from '../extension/story-profile.js';

test('story model defaults to the extraction profile', () => {
    assert.deepEqual(resolveStoryRequestProfile({ memoryProfileId: 'extractor', storyProfileId: '' }), {
        profileId: 'extractor',
        directKind: 'extraction',
    });
});

test('story model can use its own connection profile', () => {
    assert.deepEqual(resolveStoryRequestProfile({ memoryProfileId: 'extractor', storyProfileId: 'story-model' }), {
        profileId: 'story-model',
        directKind: 'extraction',
    });
});

test('explicit Story Direct uses the summarizer API configuration', () => {
    assert.deepEqual(resolveStoryRequestProfile({ memoryProfileId: 'extractor', storyProfileId: '__direct__' }), {
        profileId: '__direct__',
        directKind: 'summary',
    });
});

test('inherited extraction Direct remains an extraction API request', () => {
    assert.deepEqual(resolveStoryRequestProfile({ memoryProfileId: '__direct__', storyProfileId: '' }), {
        profileId: '__direct__',
        directKind: 'extraction',
    });
});
