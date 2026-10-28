import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyAction, assertInvariants, mappedPages, memoryRows, physicalBytes, residentPages, type WorldState } from './model.ts';
import { buildReplay, parseRecording, recordingText, type Replay } from './recording.ts';
import { scenarioById, scenarioStates } from './scenarios.ts';

const PAGE = 4096;
const header = (args: Record<string, unknown> = {}) => ({ ph: 'M', name: 'forkscape', pid: 0, args: { version: 1, page_size: PAGE, ...args } });
let clock = 0;
type Event = Record<string, unknown>;
const at = (gap = 10) => (clock += gap);
const ev = (name: string, pid: number, args: Record<string, unknown> = {}, gap = 10): Event => ({ ph: 'i', name, pid, tid: pid, ts: at(gap), args });
const mmap = (pid: number, addr: number, pages: number, extra: Record<string, unknown> = {}) => ev('mmap', pid, { addr: `0x${addr.toString(16)}`, len: pages * PAGE, ...extra });
const faults = (pid: number, addr: number, pages: number[], write: boolean, gap = 10) => pages.map(page => ev('fault', pid, { addr: addr + page * PAGE + 24, write }, gap));
const replayOf = (events: Event[], headerArgs: Record<string, unknown> = {}, budget?: number) => buildReplay(parseRecording(JSON.stringify({ traceEvents: [header(headerArgs), ...events] })), budget);
const final = (replay: Replay) => replay.states.at(-1)!;
const sum = (world: WorldState, key: 'rss' | 'pss') => memoryRows(world).reduce((total, row) => total + row[key], 0);
const range = (start: number, count: number) => Array.from({ length: count }, (_, index) => start + index);

// The copy-on-write decay scenario, as a recorder would see it: the same mappings, touches, fork, and the worker's reads.
const CODE = 0x400000, LIBS = 0x500000, HEAP = 0x600000, STACK = 0x7f0000, CATALOG = 0x800000;
function decayRecording(): Event[] {
  clock = 0;
  return [
    ev('exec', 4100, { comm: 'gunicorn' }),
    mmap(4100, CODE, 1, { file: '/srv/app.py' }), mmap(4100, LIBS, 1, { file: '/usr/lib/libpython.so' }),
    mmap(4100, HEAP, 3), mmap(4100, STACK, 1),
    ...faults(4100, CODE, [0], false), ...faults(4100, LIBS, [0], false), ...faults(4100, HEAP, [0, 1, 2], true), ...faults(4100, STACK, [0], true),
    mmap(4100, CATALOG, 6, { name: 'catalog' }), ...faults(4100, CATALOG, range(0, 6), true),
    ev('fork', 4100, { child: 4101 }),
    ...faults(4101, CATALOG, range(0, 6), true), ...faults(4101, CATALOG, [0, 1], true),
  ];
}

test('the three container forms read the same events', () => {
  const events = [header(), ...decayRecording()];
  const object = parseRecording(JSON.stringify({ traceEvents: events }));
  // A streaming writer may leave the array open with a trailing comma.
  const array = parseRecording(`[\n${events.map(item => `${JSON.stringify(item)},`).join('\n')}\n`);
  const lines = parseRecording(events.map(item => JSON.stringify(item)).join('\n'));
  for (const parsed of [array, lines]) {
    assert.deepEqual(parsed.events.map(item => [item.name, item.pid, item.ts]), object.events.map(item => [item.name, item.pid, item.ts]));
  }
  assert.equal(object.meta.pageSize, PAGE);
});

test('the header is required and versioned', () => {
  assert.throws(() => parseRecording(JSON.stringify({ traceEvents: [ev('exec', 1)] })), /no Forkscape header/);
  assert.throws(() => parseRecording(JSON.stringify([{ ...header(), args: { version: 2 } }])), /version 1; this file has version 2/);
  assert.throws(() => parseRecording(JSON.stringify([header({ page_size: 3000 })])), /page_size must be a power of two/);
  assert.throws(() => parseRecording('not json'), /should start with \{ or \[/);
  assert.throws(() => parseRecording('{"traceEvents": ['), /not valid JSON/);
  assert.throws(() => buildReplay(parseRecording(JSON.stringify([header()]))), /no process events/);
  // The header may also sit in otherData, as Trace Event Format metadata.
  const other = parseRecording(JSON.stringify({ traceEvents: [ev('exec', 7)], otherData: { forkscape: { version: 1, title: 'Boot' } } }));
  assert.equal(other.meta.title, 'Boot');
});

test('events that cannot be read are skipped and named, not fatal', () => {
  clock = 0;
  const replay = replayOf([ev('exec', 10), { ph: 'i', name: 'fault', pid: 10 }, ev('fork', 10, { child: 'x' }), ev('mmap', 10, { addr: 4096 }), { ph: 's', name: 'flow', pid: 10, ts: 99 }, ev('fork', 10, { child: 11 })]);
  const note = replay.notes.find(text => /could not be read/.test(text))!;
  assert.match(note, /^3 events could not be read/);
  assert.match(note, /Event 4 \(fork\): args\.child must be a positive integer/);
  assert.ok(replay.notes.some(text => /1 trace event of other kinds was ignored/.test(text)));
  assert.equal(final(replay).processes.length, 2);
});

test('replaying the decay scenario as a recording gives the scenario’s memory', () => {
  const replay = replayOf(decayRecording());
  const expected = scenarioStates(scenarioById('cow-decay')!).at(-1)!, world = final(replay);
  assert.equal(replay.tilePages, 1, 'a small recording is drawn page for page');
  const rows = (state: WorldState) => memoryRows(state).map(row => [row.pid, row.role, row.rss, row.pss, row.uss]);
  assert.deepEqual(rows(world), rows(expected));
  assert.equal(world.frames.length, expected.frames.length);
  const exact = replay.stages.at(-1)!.exact;
  assert.equal(exact.sumRss, sum(expected, 'rss'));
  assert.equal(exact.sumPss, sum(expected, 'pss'));
  assert.deepEqual(exact.processes.map(row => [row.pid, row.rss, row.pss]), memoryRows(expected).map(row => [row.pid, row.rss, row.pss]));
  replay.states.forEach(assertInvariants);
});

test('stages start at forks and markers, and a pause splits a run of faults', () => {
  const events = decayRecording();
  const fork = events.findIndex(item => item.name === 'fork');
  // A pause before the worker's second pair of reads, and a recorder's marker after the fork.
  events.splice(fork + 1, 0, { ph: 'i', cat: 'gunicorn', name: 'post_fork', pid: 4101, ts: (events[fork].ts as number) + 1, args: {} });
  events.slice(-2).forEach(item => { item.ts = (item.ts as number) + 200_000; });
  const replay = replayOf(events);
  assert.deepEqual(replay.stages.map(stage => stage.kind), ['exec', 'fork', 'marker', 'write']);
  assert.match(replay.stages[1].caption, /The master \(PID 4100\) forks worker 4101\. The worker’s page table points at 10 resident pages \(40 KiB\)/);
  assert.match(replay.stages[2].caption, /^gunicorn: post_fork in worker 4101\. Worker 4101: 6 copy-on-write copies\./);
  assert.match(replay.stages[3].caption, /2 write faults on pages it already owned/);
  assert.match(replay.stages[2].figures, /in use 72 KiB \(\+24 KiB\)/);
  assert.deepEqual(replay.phases.map(phase => [phase.label, phase.first, phase.last]), [['Startup', 0, 0], ['Forking workers', 1, 3]]);
  assert.deepEqual(replay.stages[2].focus, { pid: 4101, page: final(replay).processes[1].regions.find(region => region.name === 'catalog')!.startPage + 5 });
});

test('phases follow the recorder’s phase events when it has any', () => {
  const events = decayRecording();
  const fork = events.findIndex(item => item.name === 'fork');
  events.splice(fork, 0, ev('phase', 4100, { label: 'Spawn workers' }));
  events.forEach((item, index) => { item.ts = index * 10; });
  const replay = replayOf(events);
  assert.deepEqual(replay.phases.map(phase => phase.label), ['Start', 'Spawn workers']);
  assert.equal(replay.stages[replay.phases[1].first].kind, 'phase');
});

test('a large recording is drawn in tiles, while the ledger counts every page', () => {
  clock = 0;
  const pages = 1024;
  const events = [ev('exec', 1), mmap(1, CATALOG, pages), ...faults(1, CATALOG, range(0, pages), true, 1), ev('fork', 1, { child: 2 })];
  // The worker copies every eighth page of the catalog, then all of it.
  const tenth = range(0, pages / 8).map(index => index * 8);
  const partial = replayOf([...events, ...faults(2, CATALOG, tenth, true, 1)]);
  assert.equal(partial.tilePages, 64, '1,024 pages fit 24 tiles at 64 pages per tile');
  assert.equal(final(partial).pageSize, 64 * PAGE);
  for (const process of final(partial).processes) assert.ok(mappedPages(process) <= 24);
  assert.equal(final(partial).frames.length, 16, 'no tile is copied until half its pages are');
  assert.equal(partial.stages.at(-1)!.exact.sumPss, (pages + tenth.length) * PAGE, 'the ledger still counts each copied page');
  const whole = replayOf([...events, ...faults(2, CATALOG, range(0, pages), true, 1)]);
  assert.equal(final(whole).frames.length, 32, 'every tile is copied once the worker has copied it all');
  assert.equal(whole.stages.at(-1)!.exact.sumPss, 2 * pages * PAGE);
  assert.match(whole.notes[0], /Each tile stands for 64 pages \(256 KiB\)/);
  // A larger budget halves the tile.
  assert.equal(replayOf([...events], {}, 48).tilePages, 32);
  [...partial.states, ...whole.states].forEach(assertInvariants);
});

test('faults outside every recorded mapping get an unrecorded region', () => {
  clock = 0;
  const replay = replayOf([ev('exec', 1), ...faults(1, 0x10000000, [0, 1, 2], false), ev('fork', 1, { child: 2 }), ...faults(2, 0x10000000, [0], false)]);
  const region = final(replay).processes[0].regions[0];
  assert.equal(region.name, 'unrecorded');
  assert.equal(region.kind, 'file');
  assert.ok(replay.notes.some(text => /4 faults landed outside every recorded mapping/.test(text)));
  // The worker's read maps the frame the master already has in the page cache.
  const [master, worker] = final(replay).processes;
  assert.equal(worker.pages[region.startPage], master.pages[region.startPage]);
});

test('munmap and madvise give pages back, and exec replaces the address space', () => {
  clock = 0;
  const replay = replayOf([
    ev('exec', 1), mmap(1, HEAP, 8), ...faults(1, HEAP, range(0, 8), true),
    ev('madvise', 1, { addr: HEAP, len: 2 * PAGE, advice: 'MADV_DONTNEED' }),
    ev('munmap', 1, { addr: HEAP + 6 * PAGE, len: 2 * PAGE }),
    ev('fork', 1, { child: 2 }), ev('exec', 2, { comm: 'sh' }), mmap(2, STACK, 1), ...faults(2, STACK, [0], true),
  ]);
  const [master, child] = final(replay).processes;
  assert.equal(residentPages(master), 4);
  assert.equal(child.name, 'sh');
  assert.equal(residentPages(child), 1);
  assert.deepEqual(replay.stages.at(-1)!.exact.processes.map(row => row.rss / PAGE), [4, 1]);
  replay.states.forEach(assertInvariants);
});

test('descriptors, threads, exits, and other processes', () => {
  clock = 0;
  const replay = replayOf([
    ev('exec', 1), ev('open', 1, { fd: 3, object: 'socket:[99]', kind: 'socket', name: '0.0.0.0:8000' }), ev('thread', 1, { new_tid: 7 }),
    ev('fork', 1, { child: 2 }), ev('fork', 1, { child: 3 }), ev('fault', 999, { addr: 4096, write: true }),
    ev('exit', 3), ev('oom_kill', 2),
  ]);
  const kinds = replay.stages.map(stage => stage.kind);
  assert.deepEqual(kinds, ['exec', 'thread', 'fork', 'fork', 'exit', 'oom_kill']);
  assert.match(replay.stages[5].caption, /The OOM killer stops worker 2\./);
  const world = replay.states[3];
  assert.deepEqual(world.processes.map(process => process.descriptors.map(fd => fd.objectId)), [['socket:[99]'], ['socket:[99]'], ['socket:[99]']]);
  assert.deepEqual(world.processes[0].threadIds, [1, 7]);
  assert.deepEqual(world.processes[1].threadIds, [2], 'only the forking thread survives');
  assert.deepEqual(final(replay).processes.map(process => process.pid), [1], 'without reap events, exited workers are removed');
  assert.ok(replay.notes.some(text => /1 event from processes outside PID 1’s tree was ignored/.test(text)));
});

test('measured counters are charted beside the ledger’s figures', () => {
  clock = 0;
  const replay = replayOf([ev('exec', 1), mmap(1, HEAP, 2), ...faults(1, HEAP, [0, 1], true), { ph: 'C', name: 'memory', pid: 1, ts: at(), args: { rss_kib: 900, pss_kib: 850 } },
    { ph: 'C', name: 'cgroup', pid: 0, ts: at(), args: { memory_current_kib: 1200 } }, ev('fork', 1, { child: 2 }), { ph: 'C', name: 'memory', pid: 2, ts: at(), args: { rss_kib: 100 } }]);
  assert.deepEqual(replay.chart.series.map(series => [series.label, series.line]), [['Σ RSS · measured', 'solid'], ['Σ PSS · measured', 'solid'], ['Σ RSS · from events', 'dashed'], ['Σ PSS · from events', 'dashed'], ['memory.current', 'dotted']]);
  assert.deepEqual(replay.chart.series[0].values, [900 * 1024, 1000 * 1024]);
  assert.deepEqual(replay.chart.series[2].values, [8192, 16384]);
  assert.deepEqual(replay.chart.series[4].values, [1200 * 1024, 1200 * 1024]);
});

test('the synthetic example recording replays cleanly', () => {
  const text = readFileSync(new URL('../public/recordings/synthetic-gunicorn-boot.json', import.meta.url), 'utf8');
  const parsed = parseRecording(text);
  assert.equal(parsed.meta.synthetic, true);
  const replay = buildReplay(parsed);
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(replay.notes.filter(note => /could not|ignored|outside every/.test(note)), []);
  assert.deepEqual(replay.phases.map(phase => phase.label), ['Startup', 'Forking workers', 'Workers running']);
  replay.states.forEach(assertInvariants);
  for (const state of replay.states) for (const process of state.processes) assert.ok(mappedPages(process) <= 24);
  // Each worker's catalog scan copies the catalog: memory in use grows while Σ RSS does not.
  const scans = replay.stages.filter(stage => /GET \/scan/.test(stage.caption));
  assert.equal(scans.length, 2);
  for (const stage of scans) {
    const before = replay.stages[replay.stages.indexOf(stage) - 1].exact;
    assert.equal(stage.exact.sumRss, before.sumRss);
    assert.ok(stage.exact.sumPss > before.sumPss);
  }
});

const hex = (value: number) => `0x${value.toString(16)}`;
const slice = (name: string, pid: number, args: Record<string, unknown>, dur: number, gap = 10): Event => ({ ph: 'X', name, pid, tid: pid, ts: at(gap), dur, args });

test('mremap moves resident pages without faults, grows with fresh pages, and gives back what a shrink cuts', () => {
  clock = 0;
  const from = 0x7f0000000000, to = 0x7f0000100000;
  const replay = replayOf([
    ev('exec', 1, { comm: 'python' }),
    mmap(1, from, 4), ...faults(1, from, [0, 1, 2, 3], true),
    ev('mremap', 1, { addr: hex(from), old_len: 4 * PAGE, new_len: 8 * PAGE, new_addr: hex(to) }),
    ...faults(1, to, [0, 1, 2, 3, 4, 5], true),
    ev('mremap', 1, { addr: hex(to), old_len: 8 * PAGE, new_len: 2 * PAGE, new_addr: hex(to) }),
  ]);
  const stage = replay.stages.at(-1)!;
  assert.match(stage.caption, /moves or resizes 2 mappings with mremap, 6 new zeroed pages, 4 write faults on pages it already owned, gives back 16 KiB/);
  assert.equal(stage.exact.sumRss, 2 * PAGE);
  assert.deepEqual(replay.notes.filter(note => /outside every/.test(note)), [], 'no fault lands outside the moved mapping');
});

test('adjacent anonymous mappings merge, as the kernel merges them, without two pages sharing an offset', () => {
  clock = 0;
  const base = 0x7f0000200000, away = 0x7f0000400000;
  const merged = replayOf([ev('exec', 1), mmap(1, base, 2), mmap(1, base - 2 * PAGE, 2), mmap(1, base + 2 * PAGE, 2, { name: 'arena' }), ...faults(1, base - 2 * PAGE, range(0, 6), true)]);
  assert.deepEqual(final(merged).processes[0].regions.map(region => region.name), ['anonymous', 'arena'], 'the first two merge; a differently named one does not');
  // The upper half moves away; a mapping just below its new place must not merge into offsets the lower half still holds.
  clock = 0;
  const replay = replayOf([
    ev('exec', 1), mmap(1, base, 2), mmap(1, base - 2 * PAGE, 2), ...faults(1, base - 2 * PAGE, range(0, 4), true),
    ev('mremap', 1, { addr: hex(base), old_len: 2 * PAGE, new_len: 2 * PAGE, new_addr: hex(away) }),
    mmap(1, away - 2 * PAGE, 2), ...faults(1, away - 2 * PAGE, [0, 1], true),
  ]);
  assert.match(replay.stages.at(-1)!.caption, /6 new zeroed pages/);
  assert.doesNotMatch(replay.stages.at(-1)!.caption, /already owned/);
  assert.equal(replay.stages.at(-1)!.exact.sumRss, 6 * PAGE);
});

test('a process with many mappings is drawn in groups by kind that fit the deck', () => {
  clock = 0;
  const start = ev('exec', 1, { comm: 'python' });
  const libraries = range(0, 40).flatMap(index => [mmap(1, 0x7f1000000000 + index * 0x100000, 4, { file: `/usr/lib/lib${index}.so`, perms: 'r-xp' }), ...faults(1, 0x7f1000000000 + index * 0x100000, [0, 1], false)]);
  const replay = replayOf([start, ...libraries, mmap(1, 0x7f2000000000, 512, { name: 'catalog arena' }), ...faults(1, 0x7f2000000000, range(0, 512), true, 1)]);
  assert.ok(replay.notes.some(note => /41 mappings, too many to draw one by one, so each process’s mappings are drawn in 2 groups by kind/.test(note)), replay.notes.join(' | '));
  const process = final(replay).processes[0];
  assert.deepEqual(process.regions.map(region => region.name), ['code and read-only files', 'catalog arena']);
  assert.ok(mappedPages(process) <= 24);
  assert.equal(memoryRows(final(replay))[0].rss, (40 * 2 + 512) * PAGE, 'the views show the exact count, not the tiles');
});

test('moments that come together share a stage, and an idle wake folds into the next stage', () => {
  clock = 0;
  const replay = replayOf([
    ev('exec', 1, { comm: 'gunicorn' }), mmap(1, HEAP, 8), ...faults(1, HEAP, range(0, 8), true),
    ev('fork', 1, { child: 2 }, 20_000), ev('fork', 1, { child: 3 }, 20_000),
    slice('request', 2, { method: 'GET', path: '/scan' }, 500, 100_000), slice('request', 3, { method: 'GET', path: '/scan' }, 500),
    ...faults(2, HEAP, range(0, 8), true), ...faults(3, HEAP, range(0, 8), true),
    ...faults(1, HEAP, [0], true, 200_000),
    ev('exit', 2, {}, 200_000), ev('exit', 3, {}, 100),
  ]);
  const captions = replay.stages.map(stage => stage.caption);
  assert.ok(captions.some(caption => /^Workers 2 and 3 each handle a request: GET \/scan\. Worker 2: 8 copy-on-write copies/.test(caption)), captions.join('\n'));
  const exits = captions.find(caption => /^Workers 2 and 3 exit\./.test(caption));
  assert.match(exits!, /The master \(PID 1\): 1 write fault on pages it already owned/, 'the idle write is folded into the exits');
  assert.equal(replay.stages.length, 5, 'exec, two forks, the requests, and the exits');
});

test('fault-around pages count as file pages mapped and are named in the caption', () => {
  clock = 0;
  const replay = replayOf([ev('exec', 1), mmap(1, CODE, 32, { file: '/usr/lib/libpython.so' }), ...faults(1, CODE, [5], false),
    ...range(0, 16).filter(page => page !== 5).map(page => ev('fault', 1, { addr: CODE + page * PAGE, write: false, around: true }))]);
  assert.match(replay.stages.at(-1)!.caption, /16 file pages mapped, 15 of them by fault-around/);
});

test('recorded stages carry exact figures for every view, and an action drops them', () => {
  clock = 0;
  const replay = replayOf([ev('exec', 1), mmap(1, HEAP, 1024), ...faults(1, HEAP, range(0, 1024).filter(page => page % 3 === 0), true, 1), ev('fork', 1, { child: 2 }),
    ...faults(2, HEAP, range(0, 300), true, 1)]);
  assert.ok(replay.tilePages > 1);
  for (const stage of replay.stages) {
    const rows = memoryRows(stage.state);
    for (const item of stage.exact.processes) {
      const row = rows.find(candidate => candidate.pid === item.pid)!;
      assert.equal(row.rss, item.rss);
      assert.ok(Math.abs(row.pss - item.pss) < 1e-6);
    }
    assert.equal(physicalBytes(stage.state), stage.exact.sumPss);
  }
  const state = final(replay), worker = memoryRows(state).find(row => row.pid === 2)!;
  assert.equal(worker.rss, 542 * PAGE, 'the 342 pages shared at fork, 100 of them now copies, and 200 new ones');
  assert.equal(applyAction(state, { type: 'read', pid: 1, page: 0 }).exact, undefined);
});

test('a gzip-compressed recording reads the same as the plain file', async () => {
  const text = readFileSync(new URL('../public/recordings/synthetic-gunicorn-boot.json', import.meta.url), 'utf8');
  const zipped = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  assert.equal(await recordingText(zipped), text);
  assert.equal(await recordingText(new Blob([text])), text);
});
