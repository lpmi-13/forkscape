import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, initialWorld } from './model.ts';
import { cubicBezier, linkedKey, stepEase, stepLinks } from './motion.ts';
import { scenarioById, scenarioStates } from './scenarios.ts';

const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-5, message ?? `${actual} ≈ ${expected}`);
const [preload, forked, copied] = scenarioStates(scenarioById('cow-decay')!);
const frameOf = (state: typeof preload, pid: number, page: number) => state.processes.find(process => process.pid === pid)!.pages[page];

test('cubicBezier reproduces CSS timing functions', () => {
  const linear = cubicBezier(0, 0, 1, 1);
  for (const progress of [0, .2, .5, .8, 1]) close(linear(progress), progress);
  close(cubicBezier(.25, .1, .25, 1)(.5), .8024033877399112, 'CSS ease at half time');
  // Against the curve sampled directly, including ones whose x slope is flat at an end.
  for (const [x1, y1, x2, y2] of [[.4, 0, .2, 1], [0, 0, 0, 1], [1, 0, 1, 1], [.68, -.6, .32, 1.6]]) {
    const ease = cubicBezier(x1, y1, x2, y2), point = (a: number, b: number, t: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    for (let index = 1; index < 200; index++) {
      const t = index / 200, x = point(x1, x2, t);
      assert.ok(Math.abs(ease(x) - point(y1, y2, t)) < 1e-4, `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2}) at ${x}`);
    }
  }
});

test('the step curve starts and ends slowly and never reverses', () => {
  assert.equal(stepEase(0), 0);
  assert.equal(stepEase(1), 1);
  assert.ok(stepEase(.1) < .1 && stepEase(.9) > .9);
  for (let index = 1, last = 0; index <= 100; index++) { const value = stepEase(index / 100); assert.ok(value >= last); last = value; }
});

test('a fork links the child to its parent, and a copy to the frame it copies', () => {
  const fork = stepLinks(preload, forked);
  assert.deepEqual([...fork.enter.parents], [[4101, 4100]]);
  assert.equal(fork.enter.copies.size, 0, 'a fork shares frames rather than copying them');
  const copy = stepLinks(forked, copied);
  assert.deepEqual([...copy.enter.copies], [[frameOf(copied, 4101, 6), frameOf(forked, 4101, 6)]]);
  assert.equal(copy.enter.parents.size, 0);
  // Jumping over the fork, the child's copy still comes from its parent's frame.
  assert.deepEqual([...stepLinks(preload, copied).enter.copies], [[frameOf(copied, 4101, 6), frameOf(preload, 4100, 6)]]);
});

test('stepping back returns a child to its parent and a copy to its source; going forward, a reap only removes', () => {
  assert.deepEqual([...stepLinks(forked, preload).exit.parents], [[4101, 4100]]);
  assert.deepEqual([...stepLinks(copied, forked).exit.copies], [[frameOf(copied, 4101, 6), frameOf(forked, 4101, 6)]]);
  assert.equal(stepLinks(preload, forked).exit.parents.size, 0);
  const exited = applyAction(applyAction(initialWorld(), { type: 'fork', parentPid: 4100 }), { type: 'exit', pid: 4101 });
  const reaped = applyAction(exited, { type: 'reap', pid: 4101 });
  assert.equal(stepLinks(exited, reaped).exit.parents.size, 0);
});

test('a linked key names the same part of the linked process or frame', () => {
  const links = { parents: new Map([[4101, 4100]]), copies: new Map([[9, 6]]) };
  assert.equal(linkedKey('p/4101/page/3/filament', links), 'p/4100/page/3/filament');
  assert.equal(linkedKey('p/4101', links), 'p/4100');
  assert.equal(linkedKey('f/9/tile', links), 'f/6/tile');
  assert.equal(linkedKey('p/4100/deck', links), undefined);
  assert.equal(linkedKey('o/listen:8000/buoy', links), undefined);
  assert.equal(linkedKey('s/trace', links), undefined);
});
