import type { WorldState } from './model.ts';

/** One curve and duration for every step, so the scene, chart, and comparison move together. Slow in and slow out keeps a moving object easy to follow. */
export const stepMotion = { duration: 600, bezier: [.4, 0, .2, 1] as const };
const timing = { duration: stepMotion.duration, easing: `cubic-bezier(${stepMotion.bezier.join(', ')})` };

/** CSS's cubic-bezier() timing function: eased progress for linear progress in [0, 1]. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = (t: number) => ((ax * t + bx) * t + cx) * t;
  return (progress: number) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    // Newton's method usually lands in a few steps; bisection covers a flat slope.
    let t = progress;
    for (let index = 0; index < 8 && Math.abs(x(t) - progress) > 1e-7; index++) {
      const slope = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(slope) < 1e-6) break;
      t -= (x(t) - progress) / slope;
    }
    if (!(t >= 0 && t <= 1) || Math.abs(x(t) - progress) > 1e-7) {
      let low = 0, high = 1;
      t = progress;
      while (high - low > 1e-7) { if (x(t) < progress) low = t; else high = t; t = (low + high) / 2; }
    }
    return ((ay * t + by) * t + cy) * t;
  };
}
export const stepEase = cubicBezier(...stepMotion.bezier);

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A new process's parent, and a copy-on-write copy's source frame. */
export type StepLinks = { parents: Map<number, number>; copies: Map<number, number> };
const linksBetween = (before: WorldState, after: WorldState): StepLinks => {
  const pids = new Set(before.processes.map(process => process.pid)), frames = new Set(before.frames.map(frame => frame.id));
  const parents = new Map(after.processes.flatMap(process => !pids.has(process.pid) && process.parentPid !== null && pids.has(process.parentPid) ? [[process.pid, process.parentPid]] : []));
  const copies = new Map<number, number>();
  for (const process of after.processes) {
    // A child's page that was copied in the same jump as its fork copies its parent's frame.
    const previous = before.processes.find(item => item.pid === (parents.get(process.pid) ?? process.pid));
    process.pages.forEach((id, page) => {
      const source = previous?.pages[page];
      if (id !== null && !frames.has(id) && source !== null && source !== undefined) copies.set(id, source);
    });
  }
  return { parents, copies };
};
/**
 * How a step's objects connect across it. Stepping forward, a forked process's parts come out of its parent's, and a copy comes out of the frame it copies.
 * Stepping back, they return there. Reaping or unmapping going forward only removes things.
 */
export function stepLinks(before: WorldState, after: WorldState) {
  const none: StepLinks = { parents: new Map(), copies: new Map() };
  return { enter: linksBetween(before, after), exit: after.step < before.step ? linksBetween(after, before) : none };
}
/** Objects are keyed `p/<pid>/…` for a process's parts and `f/<frame>/…` for a frame's, so a part's counterpart in the linked process or frame shares the rest of its key. */
export function linkedKey(key: string, links: StepLinks) {
  const match = /^([pf])\/(\d+)(\/.*)?$/.exec(key);
  const id = match && (match[1] === 'p' ? links.parents : links.copies).get(Number(match[2]));
  return id === undefined || id === null ? undefined : `${match![1]}/${id}${match![3] ?? ''}`;
}

const tweened = ['backgroundColor', 'borderColor', 'color', 'boxShadow', 'fill'] as const;
type Mark = { rect: DOMRect; style: string[] };
const drawnMarks = (root: ParentNode) => [...root.querySelectorAll<HTMLElement | SVGElement>('[data-motion]')].filter(element => element.getClientRects().length);
const styleOf = (element: Element) => { const style = getComputedStyle(element); return tweened.map(name => style[name]); };

/**
 * Records where each keyed mark under root is drawn before a render replaces it. The returned function moves each replacement from there and
 * eases its colours, so a mark appears to travel; a mark with no counterpart fades in. Text in a mark updates at once.
 */
export function captureMarks(root: ParentNode): (links: StepLinks) => void {
  if (reducedMotion()) return () => {};
  const marks = new Map<string, Mark>(drawnMarks(root).map(element => [element.dataset.motion!, { rect: element.getBoundingClientRect(), style: styleOf(element) }]));
  return links => {
    // How far each moved mark starts from its new place on screen. A nested mark is carried by its parent, so it moves only by the difference.
    const offsets = new Map<Element, [number, number]>();
    for (const element of drawnMarks(root)) {
      const key = element.dataset.motion!, from = marks.get(key) ?? marks.get(linkedKey(key, links) ?? '');
      if (!from) { element.animate({ opacity: [0, 1] }, timing); continue; }
      const rect = element.getBoundingClientRect(), style = styleOf(element);
      const [carriedX, carriedY] = offsets.get(element.parentElement?.closest('[data-motion]') as Element) ?? [0, 0];
      const offset: [number, number] = [from.rect.left - rect.left, from.rect.top - rect.top];
      offsets.set(element, offset);
      // SVG marks move in their drawing's units; a bar also starts at its old width.
      const unit = element instanceof SVGElement ? element.ownerSVGElement?.getScreenCTM()?.a || 1 : 1;
      const [dx, dy] = [(offset[0] - carriedX) / unit, (offset[1] - carriedY) / unit];
      const scale = element instanceof SVGRectElement && rect.width > 0 ? from.rect.width / rect.width : 1;
      const changed = tweened.flatMap((name, index) => from.style[index] === style[index] ? [] : [[name, index] as const]);
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(scale - 1) < .01 && !changed.length) continue;
      const start: Keyframe = { transform: `translate(${dx}px, ${dy}px)${Math.abs(scale - 1) < .01 ? '' : ` scale(${scale}, 1)`}` }, end: Keyframe = { transform: 'none' };
      changed.forEach(([name, index]) => { start[name] = from.style[index]; end[name] = style[index]; });
      element.animate([start, end], timing);
    }
  };
}
