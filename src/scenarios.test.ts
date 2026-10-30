import assert from 'node:assert/strict';
import test from 'node:test';
import { chargedBytes, memoryRows, physicalBytes, type WorldState } from './model.ts';
import { DECAY_OOM_LIMIT, DECAY_SIZED_LIMIT, scenarioById, scenarioStates, scenarios, seriesValue, stepFocus } from './scenarios.ts';

const PAGE = 4096;
const states = (id: string) => scenarioStates(scenarioById(id)!);
const fixStates = (id: string) => scenarioStates(scenarioById(id)!.fix);
const rss = (world: WorldState, pid: number) => memoryRows(world).find(row => row.pid === pid)?.rss;
const pss = (world: WorldState, pid: number) => memoryRows(world).find(row => row.pid === pid)!.pss;
const sumRss = (world: WorldState) => memoryRows(world).reduce((sum, row) => sum + row.rss, 0);
const sumPss = (world: WorldState) => memoryRows(world).reduce((sum, row) => sum + row.pss, 0);

test('every scenario is deterministic, valid at each step, and points its chart and focus at existing data', () => {
  assert.equal(new Set(scenarios.map(scenario => scenario.id)).size, scenarios.length);
  for (const scenario of scenarios) {
    const history = scenarioStates(scenario);
    assert.equal(history.length, scenario.steps.length);
    assert.deepEqual(history, scenarioStates(scenario));
    for (const id of scenario.related) assert.ok(scenarioById(id), `${scenario.id} links to ${id}`);
    if (scenario.contrast) assert.ok(scenarioById(scenario.contrast.scenario), `${scenario.id} contrasts with ${scenario.contrast.scenario}`);
    if (scenario.accounting) assert.equal(scenario.group, 'memory');
    // Switching to the fix keeps the reader's step, so both runs have the same number of steps.
    assert.equal(scenario.fix.steps.length, scenario.steps.length, `${scenario.id}: the fix replays the same steps`);
    for (const [run, label] of [[scenario, scenario.id], [scenario.fix, `${scenario.id} fix`]] as const) {
      const runHistory = scenarioStates(run);
      assert.deepEqual(runHistory, scenarioStates(run));
      runHistory.forEach((world, index) => {
        const focus = stepFocus(run, index, world);
        assert.ok(world.processes.some(process => process.pid === focus.pid), `${label} step ${index} focus`);
      });
      for (const series of (run.chart ?? scenario.chart)?.series ?? []) {
        assert.ok(runHistory.some(world => seriesValue(world, series) !== null), `${label}: ${series.label} has data`);
      }
    }
  }
});

test('copy-on-write decay grows memory one page per request, then stops, while worker RSS stays flat', () => {
  const history = states('cow-decay');
  const forked = history[1];
  for (let request = 1; request <= 8; request++) {
    const world = history[1 + Math.min(request, 7)];
    assert.equal(rss(world, 4101), rss(forked, 4101));
    assert.equal(physicalBytes(world) - physicalBytes(forked), Math.min(request, 6) * PAGE);
  }
  // Each copy ends a two-way share: the worker and the master each go from half a page to a whole one.
  const done = history.at(-1)!;
  assert.equal(pss(done, 4101) - pss(forked, 4101), 6 * PAGE / 2);
  assert.equal(pss(done, 4100) - pss(forked, 4100), 6 * PAGE / 2);
  assert.equal(sumPss(done), physicalBytes(done));
});

test('a leak raises worker RSS and memory together after the reserved pages start out non-resident', () => {
  const history = states('leak');
  const [forked, reserved] = [history[1], history[2]];
  assert.equal(rss(reserved, 4101), rss(forked, 4101));
  assert.equal(memoryRows(reserved).find(row => row.pid === 4101)!.mapped - memoryRows(forked).find(row => row.pid === 4101)!.mapped, 8 * PAGE);
  history.slice(3).forEach((world, index) => {
    assert.equal(rss(world, 4101)! - rss(reserved, 4101)!, (index + 1) * PAGE);
    assert.equal(physicalBytes(world) - physicalBytes(reserved), (index + 1) * PAGE);
  });
});

test('decay reaches the limit with flat worker RSS, kills the highest-PID tied worker, and a respawn shares again', () => {
  const history = states('decay-oom');
  assert.equal(chargedBytes(history[5]), DECAY_OOM_LIMIT);
  assert.equal(rss(history[5], 4101), rss(history[1], 4101));
  const killed = history[6];
  assert.equal(killed.events.at(-1)?.kind, 'oom_kill');
  assert.equal(killed.events.at(-1)?.pid, 4102);
  assert.ok(chargedBytes(killed) < chargedBytes(history[5]));
  const respawned = history[7];
  assert.equal(respawned.processes.find(process => process.pid === 4103)?.status, 'running');
  assert.equal(physicalBytes(respawned), physicalBytes(killed));
  for (const world of history) assert.ok(chargedBytes(world) <= DECAY_OOM_LIMIT);
});

test('summed RSS overcounts shared pages while memory in use stays flat', () => {
  const history = states('rss-overcount');
  assert.ok(history.every(world => physicalBytes(world) === physicalBytes(history[0])));
  assert.equal(sumRss(history.at(-1)!), 3 * physicalBytes(history[0]));
});

test('a new worker starts below the master and grows twice: once for free, once with real memory', () => {
  const [, forked, warmed, imported] = states('worker-warmup');
  assert.equal(rss(forked, 4100)! - rss(forked, 4101)!, 2 * PAGE);
  assert.equal(rss(warmed, 4101), rss(forked, 4100));
  assert.equal(physicalBytes(warmed), physicalBytes(forked));
  assert.equal(pss(warmed, 4101) - pss(forked, 4101), PAGE, 'the worker takes half of each of two code pages');
  assert.equal(pss(warmed, 4100) - pss(forked, 4100), -PAGE, 'and the master gives up the same');
  assert.equal(sumPss(warmed), sumPss(forked));
  assert.equal(rss(imported, 4101)! - rss(warmed, 4101)!, 2 * PAGE);
  assert.equal(physicalBytes(imported) - physicalBytes(warmed), 2 * PAGE);
});

test('without preload each worker builds a private app heap, so the fleet uses more memory', () => {
  const preload = states('rss-overcount').at(-1)!, perWorker = states('no-preload').at(-1)!;
  assert.equal(physicalBytes(perWorker) - physicalBytes(preload), 3 * PAGE);
  assert.ok(sumRss(perWorker) - physicalBytes(perWorker) < sumRss(preload) - physicalBytes(preload));
  // Σ RSS ranks the setups the wrong way round: higher with preload, though preload uses less memory.
  assert.ok(sumRss(preload) > sumRss(perWorker));
  assert.ok(sumPss(preload) < sumPss(perWorker));
});

test('inherited handles share one offset, and a lock held at fork stays held in the worker', () => {
  const offset = states('shared-offset').at(-1)!;
  assert.equal(offset.kernelObjects.find(object => object.kind === 'file')?.offset, 128);
  const [, , , forked, released] = states('thread-lock');
  const worker = released.processes.find(process => process.pid === 4101)!;
  assert.deepEqual(forked.processes[1].threadIds, [4101]);
  assert.equal(worker.locks[0].ownerTid, 5000);
  assert.ok(!worker.threadIds.includes(5000));
  assert.equal(released.processes[0].locks[0].ownerTid, null);
});

test('memory fixes stop the growth their problems show', () => {
  // A flat buffer copies only the page holding its header; reading the rest copies nothing.
  const buffer = fixStates('cow-decay');
  assert.equal(physicalBytes(buffer.at(-1)!) - physicalBytes(buffer[1]), PAGE);
  for (const world of buffer.slice(1)) assert.equal(rss(world, 4101), rss(buffer[1], 4101));
  // A two-entry cache levels off once it is full.
  const cache = fixStates('leak');
  for (const world of cache.slice(4)) assert.equal(physicalBytes(world) - physicalBytes(cache[2]), 2 * PAGE);
  // A limit sized after decay holds the copy that crossed the boot-time limit, and every later one.
  const sized = fixStates('decay-oom');
  assert.ok(chargedBytes(sized[6]) > DECAY_OOM_LIMIT);
  assert.equal(physicalBytes(sized.at(-1)!) - physicalBytes(sized[1]), 2 * 6 * PAGE, 'both workers copy the whole catalog');
  for (const world of sized) {
    assert.ok(chargedBytes(world) <= DECAY_SIZED_LIMIT);
    assert.ok(!world.events.some(event => event.kind === 'oom_kill'));
  }
});

test('setup fixes share what each worker built for itself, and summing PSS reports memory in use', () => {
  const pssDashboard = scenarioById('rss-overcount')!.fix.chart!.series.find(series => series.metric === 'sumPss')!;
  assert.deepEqual(fixStates('rss-overcount'), states('rss-overcount'), 'the processes are unchanged; only the measurement is');
  for (const world of fixStates('rss-overcount')) assert.equal(seriesValue(world, pssDashboard), physicalBytes(world));
  // With the URLconf built in the master, the first request copies one page instead of allocating two.
  const warmed = fixStates('worker-warmup');
  assert.equal(physicalBytes(warmed[3]) - physicalBytes(warmed[2]), PAGE);
  assert.equal(rss(warmed[3], 4101), rss(warmed[2], 4101));
  // Preload brings no-preload's final state to the preloaded one: less memory, though a higher Σ RSS.
  const preloaded = fixStates('no-preload').at(-1)!, perWorker = states('no-preload').at(-1)!;
  assert.deepEqual(memoryRows(preloaded), memoryRows(states('rss-overcount').at(-1)!));
  assert.ok(physicalBytes(preloaded) < physicalBytes(perWorker));
  assert.ok(sumRss(preloaded) > sumRss(perWorker));
});

test('opening handles and starting threads after fork gives each worker its own', () => {
  const offsets = fixStates('shared-offset').at(-1)!;
  const files = offsets.kernelObjects.filter(object => object.kind === 'file');
  assert.deepEqual(files.map(object => object.offset), [64, 64], 'each worker reads from its own offset');
  assert.ok(!offsets.processes[0].descriptors.some(fd => files.some(object => object.id === fd.objectId)), 'the master holds no copy');
  const worker = fixStates('thread-lock').at(-1)!.processes.find(process => process.pid === 4101)!;
  assert.deepEqual(worker.threadIds, [4101, 5000]);
  assert.deepEqual(worker.locks, [{ id: 'export-queue', ownerTid: null }]);
});
