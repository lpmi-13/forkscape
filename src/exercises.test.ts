import assert from 'node:assert/strict';
import test from 'node:test';
import { classificationComplete, classificationItems, emptyExerciseProgress, forkPageTableKiB, moduleComplete, traceComplete } from './exercises.ts';

test('classification requires a checked placement for every item', () => {
  const progress = emptyExerciseProgress();
  progress.classification = Object.fromEntries(classificationItems.map(item => [item.id, item.owner]));
  assert.equal(classificationComplete(progress), false);
  progress.classificationChecked = true;
  assert.equal(classificationComplete(progress), true);
  progress.classification.socket = 'process';
  assert.equal(classificationComplete(progress), false);
});

test('address trace needs the same frame before write and different child frame after', () => {
  const progress = emptyExerciseProgress();
  progress.trace = { beforeParent: 2, beforeChild: 2, afterParent: 2, afterChild: 6 };
  assert.equal(traceComplete(progress.trace), true);
  assert.equal(traceComplete({ ...progress.trace, afterChild: 2 }), false);
  assert.equal(traceComplete({ ...progress.trace, beforeChild: undefined }), false);
  assert.equal(moduleComplete(3, true, progress), true);
  assert.equal(moduleComplete(3, false, progress), false);
});

test('copy-size exercise separates predictions from observed outcomes', () => {
  const progress = emptyExerciseProgress();
  assert.equal(forkPageTableKiB(200), 404);
  progress.sizeGuess = { forkKiB: 204800, copyBytes: 8 };
  assert.equal(moduleComplete(4, true, progress), false);
  progress.copyObserved = true;
  assert.equal(moduleComplete(4, true, progress), true);
  assert.equal(moduleComplete(4, false, progress), false);
});
