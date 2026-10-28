import assert from 'node:assert/strict';
import test from 'node:test';
import { CASE_REQUESTS, CATALOG_PAGES, caseComplete, caseHistories, caseMetrics } from './caseStudy.ts';
import { assertInvariants, memoryRows } from './model.ts';

test('both cases have the same early physical growth, then decay levels off', () => {
  const { decay, leak } = caseHistories();
  assert.equal(decay.length, CASE_REQUESTS + 1);
  assert.equal(leak.length, CASE_REQUESTS + 1);
  const baseline = caseMetrics(decay[0]).physical;
  for (let request = 0; request <= CATALOG_PAGES; request++) {
    assert.equal(caseMetrics(decay[request]).physical, caseMetrics(leak[request]).physical);
    assert.equal(caseMetrics(decay[request]).physical - baseline, request * 4096);
  }
  for (let request = CATALOG_PAGES; request <= CASE_REQUESTS; request++) {
    assert.equal(caseMetrics(decay[request]).physical - baseline, CATALOG_PAGES * 4096);
    assert.equal(caseMetrics(leak[request]).physical - baseline, request * 4096);
    assertInvariants(decay[request]);
    assertInvariants(leak[request]);
  }
  assert.equal(memoryRows(decay.at(-1)!).find(row => row.pid === 4101)?.uss, CATALOG_PAGES * 4096);
  assert.equal(memoryRows(leak.at(-1)!).find(row => row.pid === 4101)?.uss, CASE_REQUESTS * 4096);
  assert.deepEqual(caseHistories(), caseHistories());
});

test('case completion needs prediction, inspection of both histories, and causal links', () => {
  const progress = {
    prediction: 0, viewedDecay: true, viewedLeak: true, decayCause: 'decay' as const,
    leakCause: 'leak' as const, evidence: 'trend', checked: true,
  };
  assert.equal(caseComplete(progress), true);
  assert.equal(caseComplete({ ...progress, viewedLeak: false }), false);
  assert.equal(caseComplete({ ...progress, evidence: 'rss' }), false);
  assert.equal(caseComplete({ ...progress, leakCause: 'decay' }), false);
});
