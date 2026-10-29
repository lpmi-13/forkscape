import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, assertInvariants, chargedBytes, initialWorld, memoryRows, objectRefCount, pageTableBytes, physicalBytes, pssBreakdown, sharers, type Action, type WorldState } from './model.ts';

const apply = (world: WorldState, ...actions: Action[]) => actions.reduce((state, action) => { const next = applyAction(state, action); assertInvariants(next); return next; }, world);
const row = (world: WorldState, pid: number) => memoryRows(world).find(item => item.pid === pid)!;

test('fork shares anonymous frames, leaves unwritten file pages out of the child, and inherits the listening descriptor', () => {
  const before = initialWorld(), after = applyAction(before, { type: 'fork', parentPid: 4100 });
  assert.equal(physicalBytes(after), physicalBytes(before));
  assert.equal(sharers(after, 2), 2);
  assert.deepEqual(after.processes[1].pages, [null, null, 2, 3, 4, 5]);
  assert.equal(row(after, 4101).rss, 4 * 4096);
  assert.equal(row(after, 4101).mapped, row(after, 4100).mapped);
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
test('a copy-on-write write leaves the writer’s RSS unchanged and exited processes release their pages', () => {
  const forked = apply(initialWorld(), { type: 'fork', parentPid: 4100 });
  const copied = apply(forked, { type: 'write', pid: 4101, page: 3 });
  assert.equal(copied.events.at(-1)?.kind, 'cow_fault');
  assert.equal(row(copied, 4101).rss, row(forked, 4101).rss);
  assert.equal(row(copied, 4101).uss - row(forked, 4101).uss, 4096);
  const reaped = apply(copied, { type: 'exit', pid: 4101 });
  assert.equal(reaped.processes[1].pages.length, 0);
  assert.equal(physicalBytes(reaped), physicalBytes(initialWorld()));
});

test('mapped pages become resident only when touched; reading untouched anonymous memory uses the zero page', () => {
  const world = apply(initialWorld(), { type: 'mmap', pid: 4100, name: 'scratch', pageCount: 2, kind: 'anonymous', sharing: 'private' });
  assert.equal(row(world, 4100).mapped - row(initialWorld(), 4100).mapped, 8192);
  assert.equal(row(world, 4100).rss, row(initialWorld(), 4100).rss);
  const read = apply(world, { type: 'read', pid: 4100, page: 6 });
  assert.equal(read.events.at(-1)?.kind, 'zero_page');
  assert.equal(physicalBytes(read), physicalBytes(world));
  const written = apply(read, { type: 'write', pid: 4100, page: 6 });
  assert.equal(written.events.at(-1)?.kind, 'demand_zero');
  assert.equal(row(written, 4100).rss - row(world, 4100).rss, 4096);
  assert.throws(() => applyAction(written, { type: 'read', pid: 4100, page: 8 }), /not mapped/);
});

test('a child faults file pages back in from the page cache; uncached file pages need a major fault', () => {
  const forked = apply(initialWorld(), { type: 'fork', parentPid: 4100 });
  const touched = apply(forked, { type: 'read', pid: 4101, page: 0 });
  assert.equal(touched.events.at(-1)?.kind, 'minor_fault');
  assert.equal(touched.processes[1].pages[0], touched.processes[0].pages[0]);
  assert.equal(physicalBytes(touched), physicalBytes(forked));
  assert.equal(row(touched, 4101).rss - row(forked, 4101).rss, 4096);
  const mapped = apply(touched, { type: 'mmap', pid: 4101, name: 'report', pageCount: 1, kind: 'file', sharing: 'private', writable: false, fileKey: 'report' });
  const loaded = apply(mapped, { type: 'read', pid: 4101, page: 6 });
  assert.equal(loaded.events.at(-1)?.kind, 'major_fault');
  assert.equal(physicalBytes(loaded) - physicalBytes(mapped), 4096);
});

test('fork copies entries for a private file region once it holds a copied page, never for shared regions', () => {
  const world = apply(initialWorld(),
    { type: 'mmap', pid: 4100, name: 'config', pageCount: 2, kind: 'file', sharing: 'private', fileKey: 'config' },
    { type: 'read', pid: 4100, page: 6 }, { type: 'write', pid: 4100, page: 7 },
    { type: 'mmap', pid: 4100, name: 'shared', pageCount: 1, kind: 'file', sharing: 'shared', fileKey: 'shared' },
    { type: 'read', pid: 4100, page: 8 },
    { type: 'fork', parentPid: 4100 });
  assert.deepEqual(world.processes[1].pages.slice(6), [world.processes[0].pages[6], world.processes[0].pages[7], null]);
});

test('file mappings share cache frames, private file writes copy, and munmap releases only unreferenced frames', () => {
  let world = applyAction(initialWorld(), { type: 'fork', parentPid: 4100 });
  world = applyAction(world, { type: 'mmap', pid: 4100, name: 'data', pageCount: 2, kind: 'file', sharing: 'shared', fileKey: 'dataset' });
  world = applyAction(world, { type: 'mmap', pid: 4101, name: 'data', pageCount: 2, kind: 'file', sharing: 'shared', fileKey: 'dataset' });
  world = apply(world, ...[6, 7].flatMap(page => [4100, 4101].map(pid => ({ type: 'read' as const, pid, page }))));
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

test('events call an offset, page, or object shared only when another descriptor or mapping holds it', () => {
  const steps: [Action, RegExp][] = [
    [{ type: 'open_file', pid: 4100, name: 'sample.log' }, /opens sample\.log on fd 4/],
    [{ type: 'read_file', pid: 4100, fd: 4, bytes: 16 }, /; the file offset moves from 0 to 16\./],
    [{ type: 'mmap', pid: 4100, name: 'shared.data', pageCount: 1, kind: 'file', sharing: 'shared', fileKey: 'shared.data' }, /maps 1 file page/],
    [{ type: 'write', pid: 4100, page: 6 }, /No other mapping has the page\./],
    [{ type: 'fork', parentPid: 4100 }, /It shares 4 of the parent’s frames and its 2 kernel objects; .* 3 file-backed pages are not resident/],
    [{ type: 'read', pid: 4101, page: 6 }, /minor fault/],
    [{ type: 'write', pid: 4101, page: 6 }, /Every other mapping of it sees the change\./],
    [{ type: 'read_file', pid: 4101, fd: 4, bytes: 16 }, /the file offset, shared by 2 descriptors, moves from 16 to 32\./],
    [{ type: 'write', pid: 4101, page: 2 }, /2 mappings share its frame, so the kernel copies one 4 KiB page; RSS is unchanged\./],
    [{ type: 'close_fd', pid: 4101, fd: 4 }, /1 other descriptor still refers to the same object\./],
    [{ type: 'close_fd', pid: 4100, fd: 4 }, /It was the last descriptor for the object, so the kernel releases it\./],
  ];
  steps.reduce((world, [action, description]) => {
    const next = apply(world, action);
    assert.match(next.events.at(-1)!.description, description);
    return next;
  }, initialWorld());
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

test('memory limit counts page tables and OOM stops the process with the most resident pages', () => {
  let world = initialWorld();
  const limit = chargedBytes(world);
  world = applyAction(world, { type: 'set_limit', bytes: limit });
  world = applyAction(world, { type: 'fork', parentPid: 4100 });
  assert.equal(world.events.at(-1)?.kind, 'oom_kill');
  assert.equal(world.events.at(-1)?.pid, 4100);
  assert.equal(world.processes[0].status, 'zombie');
  assert.equal(world.processes[0].pages.length, 0);
  assert.ok(chargedBytes(world) <= limit);
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
          { type: 'read' as const, pid: p.pid, page: 0 },
          { type: 'mmap' as const, pid: p.pid, name: 'scratch', pageCount: 1, kind: 'anonymous' as const, sharing: 'private' as const },
          ...p.regions.filter(r => r.id.startsWith('region-')).map(r => ({ type: 'write' as const, pid: p.pid, page: r.startPage })),
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
test('the PSS breakdown groups resident pages by sharer count and matches the ledger', () => {
  const world = apply(initialWorld(), { type: 'fork', parentPid: 4100 }, { type: 'fork', parentPid: 4100 }, { type: 'read', pid: 4101, page: 0 }, { type: 'write', pid: 4101, page: 2 });
  const master = pssBreakdown(world, world.processes[0]);
  // Code page 0 is shared with 4101; heap page 2 still with 4102 after 4101 copied it; pages 3–5 with both workers.
  assert.deepEqual(master, { exclusive: 4096, shared: [{ sharers: 2, bytes: 2 * 4096 }, { sharers: 3, bytes: 3 * 4096 }] });
  for (const process of world.processes) {
    const split = pssBreakdown(world, process), ledger = row(world, process.pid);
    assert.equal(split.exclusive + split.shared.reduce((sum, item) => sum + item.bytes, 0), ledger.rss);
    assert.ok(Math.abs(split.exclusive + split.shared.reduce((sum, item) => sum + item.bytes / item.sharers, 0) - ledger.pss) < 1e-9);
  }
});
