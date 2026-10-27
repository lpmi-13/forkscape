import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, assertInvariants, guidedHistory, initialWorld, memoryRows, physicalBytes, sharers } from './model.ts';

test('fork shares data frames and inherits the listening descriptor', () => {
  const before = initialWorld(), after = applyAction(before, { type: 'fork', parentPid: 4100 });
  assert.equal(physicalBytes(after), physicalBytes(before));
  assert.equal(sharers(after, 2), 2);
  assert.deepEqual(after.processes[0].pages, after.processes[1].pages);
  assert.deepEqual(after.processes[1].descriptorIds, before.processes[0].descriptorIds);
  assertInvariants(after);
});
test('first write copies a page; a second write reuses it', () => {
  const forked = applyAction(initialWorld(), { type: 'fork', parentPid: 4100 });
  const copied = applyAction(forked, { type: 'write', pid: 4101, page: 2 });
  assert.equal(physicalBytes(copied) - physicalBytes(forked), 4096);
  assert.notEqual(copied.processes[0].pages[2], copied.processes[1].pages[2]);
  const reused = applyAction(copied, { type: 'write', pid: 4101, page: 2 });
  assert.equal(physicalBytes(reused), physicalBytes(copied));
  assert.equal(reused.events.at(-1)?.kind, 'write');
});
test('guided states balance PSS and release exited processes', () => {
  for (const world of guidedHistory()) {
    assertInvariants(world);
    assert.ok(Math.abs(memoryRows(world).reduce((sum, row) => sum + row.pss, 0) - physicalBytes(world)) < 0.001);
  }
  assert.equal(guidedHistory()[6].processes.find(p => p.pid === 4101)?.pages.length, 0);
});
test('same actions produce identical histories', () => assert.deepEqual(guidedHistory(), guidedHistory()));
