import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, assertInvariants, chargedBytes, guidedHistory, initialWorld, memoryRows, objectRefCount, pageTableBytes, physicalBytes, sharers } from './model.ts';

test('fork shares data frames and inherits the listening descriptor', () => {
  const before = initialWorld(), after = applyAction(before, { type: 'fork', parentPid: 4100 });
  assert.equal(physicalBytes(after), physicalBytes(before));
  assert.equal(sharers(after, 2), 2);
  assert.deepEqual(after.processes[0].pages, after.processes[1].pages);
  assert.deepEqual(after.processes[1].descriptors, before.processes[0].descriptors);
  assert.equal(objectRefCount(after, 'listen:8000'), 2);
  assert.equal(pageTableBytes(after) - pageTableBytes(before), 8192);
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

test('file mappings share cache frames, private file writes copy, and munmap releases only unreferenced frames', () => {
  let world = applyAction(initialWorld(), { type: 'fork', parentPid: 4100 });
  world = applyAction(world, { type: 'mmap', pid: 4100, name: 'data', pageCount: 2, kind: 'file', sharing: 'shared', fileKey: 'dataset' });
  world = applyAction(world, { type: 'mmap', pid: 4101, name: 'data', pageCount: 2, kind: 'file', sharing: 'shared', fileKey: 'dataset' });
  assert.equal(world.processes[0].pages[6], world.processes[1].pages[6]);
  assert.equal(sharers(world, world.processes[0].pages[6]!), 2);
  const beforeWrite = physicalBytes(world);
  world = applyAction(world, { type: 'write', pid: 4101, page: 6 });
  assert.equal(physicalBytes(world), beforeWrite);
  const sharedFrame = world.frames.find(frame => frame.id === world.processes[0].pages[6]);
  assert.equal(sharedFrame?.revision, 1);
  const regionId = world.processes[0].regions.at(-1)!.id;
  world = applyAction(world, { type: 'munmap', pid: 4100, regionId });
  assert.equal(physicalBytes(world), beforeWrite);
  world = applyAction(world, { type: 'munmap', pid: 4101, regionId: world.processes[1].regions.at(-1)!.id });
  assert.equal(physicalBytes(world), beforeWrite - 8192);
  world = applyAction(world, { type: 'mmap', pid: 4101, name: 'private file', pageCount: 1, kind: 'file', sharing: 'private', fileKey: 'private' });
  const page = world.processes[1].nextPage - 1;
  const oldFrame = world.processes[1].pages[page];
  world = applyAction(world, { type: 'write', pid: 4101, page });
  assert.notEqual(world.processes[1].pages[page], oldFrame);
  assert.equal(world.events.at(-1)?.kind, 'cow_fault');
  assertInvariants(world);
});

test('inherited descriptors share an offset and close independently', () => {
  let world = applyAction(initialWorld(), { type: 'open_file', pid: 4100, name: 'sample.log' });
  world = applyAction(world, { type: 'fork', parentPid: 4100 });
  world = applyAction(world, { type: 'read_file', pid: 4101, fd: 4, bytes: 16 });
  assert.equal(world.kernelObjects.find(o => o.id === 'file-1')?.offset, 16);
  assert.equal(objectRefCount(world, 'file-1'), 2);
  world = applyAction(world, { type: 'close_fd', pid: 4101, fd: 4 });
  assert.equal(objectRefCount(world, 'file-1'), 1);
  world = applyAction(world, { type: 'read_file', pid: 4100, fd: 4, bytes: 4 });
  assert.equal(world.kernelObjects.find(o => o.id === 'file-1')?.offset, 20);
  assertInvariants(world);
});

test('fork keeps one thread and copies a lock held by a missing thread', () => {
  let world = applyAction(initialWorld(), { type: 'spawn_thread', pid: 4100 });
  const tid = world.processes[0].threadIds[1];
  world = applyAction(world, { type: 'lock', pid: 4100, lockId: 'import-lock', tid });
  world = applyAction(world, { type: 'fork', parentPid: 4100 });
  assert.deepEqual(world.processes[1].threadIds, [4101]);
  assert.equal(world.processes[1].locks[0].ownerTid, tid);
  assert.throws(() => applyAction(world, { type: 'lock', pid: 4101, lockId: 'import-lock', tid: 4101 }), /already held/);
  assertInvariants(world);
});

test('memory limit counts page tables and OOM releases a victim into zombie state', () => {
  let world = initialWorld();
  const limit = chargedBytes(world);
  world = applyAction(world, { type: 'set_limit', bytes: limit });
  world = applyAction(world, { type: 'fork', parentPid: 4100 });
  assert.equal(world.events.at(-1)?.kind, 'oom_kill');
  assert.equal(world.processes[1].status, 'zombie');
  assert.equal(world.processes[1].pages.length, 0);
  assert.equal(chargedBytes(world), limit);
  assertInvariants(world);
});

test('deterministic action walks preserve accounting and prior snapshots', () => {
  for (let seed = 1; seed <= 12; seed++) {
    let random = seed;
    const next = (length: number) => { random = (random * 1664525 + 1013904223) >>> 0; return random % length; };
    let world = initialWorld();
    for (let turn = 0; turn < 40; turn++) {
      const prior = world, previous = structuredClone(world);
      const running = world.processes.filter(p => p.status === 'running');
      const zombies = world.processes.filter(p => p.status === 'zombie');
      const choices = [
        ...running.length < 4 ? [{ type: 'fork' as const, parentPid: running[0]?.pid ?? 4100 }] : [],
        ...running.flatMap(p => [
          { type: 'write' as const, pid: p.pid, page: 2 },
          { type: 'mmap' as const, pid: p.pid, name: 'scratch', pageCount: 1, kind: 'anonymous' as const, sharing: 'private' as const },
          ...p.regions.filter(r => r.id.startsWith('region-')).map(r => ({ type: 'munmap' as const, pid: p.pid, regionId: r.id })),
          ...p.role === 'worker' ? [{ type: 'exit' as const, pid: p.pid }] : [],
        ]),
        ...zombies.map(p => ({ type: 'reap' as const, pid: p.pid })),
      ];
      world = applyAction(world, choices[next(choices.length)]);
      assert.deepEqual(prior, previous);
      assertInvariants(world);
    }
  }
});

test('descriptor offsets and surviving threads hold across varied fork shapes', () => {
  for (let count = 1; count <= 6; count++) {
    let world = initialWorld();
    for (let index = 0; index < count; index++) {
      world = applyAction(world, { type: 'open_file', pid: 4100, name: `file-${index}` });
      world = applyAction(world, { type: 'spawn_thread', pid: 4100 });
    }
    const parent = world.processes[0];
    const callerTid = parent.threadIds[count];
    world = applyAction(world, { type: 'lock', pid: 4100, lockId: 'held', tid: parent.threadIds[1] });
    world = applyAction(world, { type: 'fork', parentPid: 4100, callerTid });
    const child = world.processes[1];
    assert.deepEqual(child.threadIds, [child.pid]);
    assert.deepEqual(child.descriptors, world.processes[0].descriptors);
    assert.notStrictEqual(child.descriptors[0], world.processes[0].descriptors[0]);
    assert.equal(child.locks[0].ownerTid, parent.threadIds[1]);
    for (const fd of child.descriptors.filter(item => item.fd > 3)) {
      world = applyAction(world, { type: 'read_file', pid: child.pid, fd: fd.fd, bytes: fd.fd });
      const parentFd = world.processes[0].descriptors.find(item => item.fd === fd.fd)!;
      assert.equal(world.kernelObjects.find(object => object.id === parentFd.objectId)?.offset, fd.fd);
      world = applyAction(world, { type: 'close_fd', pid: child.pid, fd: fd.fd });
      assert.equal(objectRefCount(world, parentFd.objectId), 1);
      assertInvariants(world);
    }
  }
});

test('invariant checks reject duplicate descriptors and threads', () => {
  const duplicateFd = initialWorld();
  duplicateFd.processes[0].descriptors.push({ ...duplicateFd.processes[0].descriptors[0] });
  assert.throws(() => assertInvariants(duplicateFd), /duplicate descriptors/);
  const duplicateTid = initialWorld();
  duplicateTid.processes[0].threadIds.push(duplicateTid.processes[0].threadIds[0]);
  assert.throws(() => assertInvariants(duplicateTid), /duplicate threads/);
});
