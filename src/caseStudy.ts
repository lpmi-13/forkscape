import { applyAction, assertInvariants, initialWorld, memoryRows, physicalBytes, type WorldState } from './model.ts';

export type CaseKind = 'decay' | 'leak';
export const CASE_REQUESTS = 24;
export const CATALOG_PAGES = 12;

/** Deterministic teaching histories. One request is one modeled page operation. */
export function caseHistories(): Record<CaseKind, WorldState[]> {
  let start = applyAction(initialWorld(), {
    type: 'mmap', pid: 4100, name: 'preloaded catalog', pageCount: CATALOG_PAGES,
    kind: 'anonymous', sharing: 'private',
  });
  const catalogStart = start.processes[0].regions.at(-1)!.startPage;
  start = applyAction(start, { type: 'fork', parentPid: 4100 });
  const decay = [start], leak = [start];
  for (let request = 1; request <= CASE_REQUESTS; request++) {
    decay.push(applyAction(decay.at(-1)!, {
      type: 'write', pid: 4101, page: catalogStart + (request - 1) % CATALOG_PAGES,
    }));
    leak.push(applyAction(leak.at(-1)!, {
      type: 'mmap', pid: 4101, name: `retained request ${request}`,
      pageCount: 1, kind: 'anonymous', sharing: 'private',
    }));
  }
  for (const state of [...decay, ...leak]) assertInvariants(state);
  return { decay, leak };
}

export function caseMetrics(state: WorldState) {
  const worker = memoryRows(state).find(row => row.pid === 4101)!;
  return { physical: physicalBytes(state), workerRss: worker.rss, workerPss: worker.pss, workerUss: worker.uss };
}

export interface CaseProgress {
  prediction?: number;
  viewedDecay: boolean;
  viewedLeak: boolean;
  decayCause?: CaseKind;
  leakCause?: CaseKind;
  evidence?: string;
  checked: boolean;
}

export function caseComplete(progress: CaseProgress): boolean {
  return progress.prediction !== undefined && progress.viewedDecay && progress.viewedLeak && progress.checked
    && progress.decayCause === 'decay' && progress.leakCause === 'leak' && progress.evidence === 'trend';
}
