import assert from 'node:assert/strict';
import test from 'node:test';
import { regionPages, selectionDetail, type Detail, type Selection } from './detail.ts';
import { applyAction, initialWorld, objectRefCount, sharers, type Action, type WorldState } from './model.ts';
import { scenarioById, scenarios, scenarioStates } from './scenarios.ts';

// Every scenario step, plus single-holder cases no scenario reaches: a file only the master has open, and a shared mapping nobody else maps.
const walk: Action[] = [
  { type: 'open_file', pid: 4100, name: 'sample.log' },
  { type: 'read_file', pid: 4100, fd: 4, bytes: 16 },
  { type: 'mmap', pid: 4100, name: 'shared.data', pageCount: 1, kind: 'file', sharing: 'shared', fileKey: 'shared.data' },
  { type: 'write', pid: 4100, page: 6 },
  { type: 'fork', parentPid: 4100 },
  { type: 'read', pid: 4101, page: 6 },
  { type: 'close_fd', pid: 4101, fd: 4 },
  { type: 'exit', pid: 4101 },
];
const states = [...scenarios.flatMap(scenarioStates), ...walk.reduce<WorldState[]>((list, action) => [...list, applyAction(list.at(-1)!, action)], [initialWorld()])];
const none = (pid: number): Selection => ({ pid, page: null, frame: null, objectId: null, structure: null });
// "Shared" also names a mapping type, the kernel's zero page, and the sandbox's shared.data region; none says whether another holder has the thing.
const claimsSharing = (detail: Detail, regionName = '') => /shar/i.test(`${detail.summary} ${detail.metaphor} ${detail.mechanism}`.replaceAll(regionName, '').replace(/shared (mapping|zero page)|not shared/gi, ''));

test('the inspector calls a page or kernel object shared exactly when another mapping or descriptor holds it', () => {
  states.forEach((world, at) => {
    for (const process of world.processes) {
      process.descriptors.forEach((fd, index) => {
        const many = objectRefCount(world, fd.objectId) > 1;
        assert.equal(claimsSharing(selectionDetail(world, { ...none(process.pid), objectId: fd.objectId })), many, `state ${at}: ${fd.objectId}`);
        assert.equal(claimsSharing(selectionDetail(world, { ...none(process.pid), structure: { pid: process.pid, part: 'cable', index } })), many, `state ${at}: PID ${process.pid} fd ${fd.fd} cable`);
      });
      for (const region of process.regions) for (const page of regionPages(region)) {
        const id = process.pages[page] ?? null;
        assert.equal(claimsSharing(selectionDetail(world, { ...none(process.pid), page: { pid: process.pid, page } }), region.name), id !== null && sharers(world, id) > 1, `state ${at}: PID ${process.pid} page ${page}`);
      }
    }
  });
});

test('every selection in every reachable state renders without missing values', () => {
  states.forEach((world, at) => {
    const selections: Selection[] = [
      ...world.processes.flatMap(process => [none(process.pid), ...process.status === 'running' ? [
        ...(['page_table', 'stack'] as const).map(part => ({ ...none(process.pid), structure: { pid: process.pid, part, index: 0 } })),
        ...process.threadIds.map((_, index) => ({ ...none(process.pid), structure: { pid: process.pid, part: 'thread' as const, index } })),
      ] : []]),
      ...world.frames.map(frame => ({ ...none(world.processes[0].pid), frame: frame.id })),
    ];
    for (const selection of selections) assert.doesNotMatch(Object.values(selectionDetail(world, selection)).join(' '), /undefined|NaN|\[object/, `state ${at}: ${JSON.stringify(selection)}`);
  });
});

test('a lone listening socket is not shared until a fork copies its descriptor', () => {
  const before = initialWorld(), after = applyAction(before, { type: 'fork', parentPid: 4100 });
  assert.match(selectionDetail(before, { ...none(4100), objectId: 'listen:8000' }).mechanism, /PID 4100 fd 3\. Only this descriptor refers to the listening socket, so it is not shared\./);
  assert.match(selectionDetail(after, { ...none(4100), objectId: 'listen:8000' }).mechanism, /PID 4100 fd 3 · PID 4101 fd 3\. 2 descriptors share this listening socket\./);
});

test('the fork stack names the PID each fork returned', () => {
  const world = scenarioStates(scenarioById('decay-oom')!).at(-1)!;
  const stack = (pid: number) => selectionDetail(world, { ...none(pid), structure: { pid, part: 'stack', index: 0 } }).mechanism;
  assert.match(stack(4100), /returned 4101, 4103, one per child, to this parent/);
  assert.match(stack(4103), /returned 0 to this child and 4103 to its parent, PID 4100/);
});
