import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyExerciseProgress } from './exercises.ts';
import { MAX_PROGRESS_BYTES, completedCount, parseProgress, type ProgressFile } from './progress.ts';

const sample: ProgressFile = {
  version: 3, answers: { '1': 1, '2': 1, '3': 1, '4': 1 },
  exercises: { ...emptyExerciseProgress(), classification: { pid: 'process', address: 'process', descriptors: 'process', threads: 'process', socket: 'kernel', file: 'kernel' }, classificationChecked: true, forkWalkthroughDone: true, trace: { beforeParent: 2, beforeChild: 2, afterParent: 2, afterChild: 6 }, sizeGuess: { forkKiB: 404, copyBytes: 4096 }, copyObserved: true },
  caseStudy: { prediction: 1, viewedDecay: true, viewedLeak: true, decayCause: 'decay', leakCause: 'leak', evidence: 'trend', checked: true },
};

test('exported progress parses into the five completed activities', () => {
  assert.deepEqual(parseProgress(JSON.stringify(sample)), sample);
  assert.equal(completedCount(sample), 5);
});

test('import rejects unsupported, malformed and oversized files before replacing progress', () => {
  assert.throws(() => parseProgress('{'), /valid JSON/);
  assert.throws(() => parseProgress(JSON.stringify({ ...sample, version: 4 })), /version 3/);
  assert.throws(() => parseProgress(JSON.stringify({ ...sample, answers: { '1': 9 } })), /answers\.1/);
  assert.throws(() => parseProgress(JSON.stringify({ ...sample, exercises: { ...sample.exercises, trace: { beforeParent: '2' } } })), /trace\.beforeParent/);
  assert.throws(() => parseProgress(JSON.stringify({ ...sample, caseStudy: { ...sample.caseStudy, viewedLeak: 'yes' } })), /viewedLeak/);
  assert.throws(() => parseProgress(' '.repeat(MAX_PROGRESS_BYTES + 1)), /larger than 64 KiB/);
});
