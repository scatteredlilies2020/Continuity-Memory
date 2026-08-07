import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCapturePromptMeasurement } from '../extension/prompt-measurement-policy.js';

test('captures real prompt measurements', () => {
    assert.equal(shouldCapturePromptMeasurement({ dryRun: false }), true);
    assert.equal(shouldCapturePromptMeasurement({}), true);
});

test('does not let a dry-run preview overwrite the last real request total', () => {
    assert.equal(shouldCapturePromptMeasurement({ dryRun: true }), false);
});
