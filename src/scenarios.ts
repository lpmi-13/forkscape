import { applyAction, assertInvariants, chargedBytes, initialWorld, memoryRows, physicalBytes, type Action, type WorldState } from './model.ts';

export type ScenarioGroup = 'memory' | 'handles';
export type ChartSeries =
  | { label: string; metric: 'rss' | 'pss' | 'uss'; pid: number }
  | { label: string; metric: 'sumRss' | 'physical' | 'charge' };
export interface ScenarioStep { caption: string; actions: Action[] }
export interface Scenario {
  id: string;
  group: ScenarioGroup;
  title: string;
  /** The production symptom, as an on-call engineer would first meet it. */
  symptom: string;
  steps: ScenarioStep[];
  chart?: { series: ChartSeries[]; limit?: boolean };
  watch: string;
  mechanism: string;
  production: string;
  evidence: string;
  /** Why RSS and PSS disagree here, for scenarios where that difference is the point. */
  accounting?: string;
  /** Another scenario whose final state is compared with this one's on Σ RSS and Σ PSS. */
  contrast?: { scenario: string; label: string; ownLabel: string };
  /** What the Linux reference probes observed, if they cover this scenario. */
  reference?: string;
  related: string[];
}

const writes = (pid: number, pages: number[]): Action[] => pages.map(page => ({ type: 'write', pid, page }));
const reads = (pid: number, pages: number[]): Action[] => pages.map(page => ({ type: 'read', pid, page }));
const map = (pid: number, name: string, pageCount: number): Action => ({ type: 'mmap', pid, name, pageCount, kind: 'anonymous', sharing: 'private' });
const range = (start: number, count: number) => Array.from({ length: count }, (_, index) => start + index);
const fork: Action = { type: 'fork', parentPid: 4100 };
// Pages 0–5 are code, libraries, heap, and stack; regions mapped later start at page 6.
const CODE = [0, 1];
const APP = range(6, 3);
const CATALOG = range(6, 6);
const preloadApp: Action[] = [map(4100, 'app', 3), ...writes(4100, APP)];
const preloadCatalog: Action[] = [map(4100, 'catalog', 6), ...writes(4100, CATALOG)];
const RSS = (pid: number): ChartSeries => ({ label: `Worker ${pid} RSS`, metric: 'rss', pid });
const PSS = (pid: number): ChartSeries => ({ label: `Worker ${pid} PSS`, metric: 'pss', pid });
const IN_USE: ChartSeries = { label: 'Memory in use (Σ PSS)', metric: 'physical' };
const SUM_RSS: ChartSeries = { label: 'Σ RSS', metric: 'sumRss' };
export const DECAY_OOM_LIMIT = 26 * 4096;

export const scenarios: Scenario[] = [
  {
    id: 'cow-decay', group: 'memory', title: 'Memory climbs while RSS stays flat',
    symptom: 'Container memory climbs for hours, yet every worker’s RSS is flat and no request leaks objects.',
    steps: [
      { caption: 'With preload_app, the master builds a 6-page catalog at import time, before any worker exists.', actions: preloadCatalog },
      { caption: 'Gunicorn forks a worker. Its page table points at the master’s heap, stack, and catalog frames. Nothing is copied.', actions: [fork] },
      ...CATALOG.map((page, index) => ({
        caption: `Request ${index + 1} only reads entries on catalog page ${page}. CPython increments their reference counts, which writes to the page, so the kernel copies it for the worker.`,
        actions: writes(4101, [page]),
      })),
      { caption: 'Requests 7 and 8 read pages the worker already copied. Its copies are exclusive, so the writes reuse them and nothing new is allocated.', actions: writes(4101, [6, 7]) },
    ],
    chart: { series: [RSS(4101), PSS(4101), IN_USE] },
    watch: 'The worker’s RSS never moves. Its PSS and memory in use grow with every copy until the whole catalog is copied, then stop.',
    mechanism: 'A copy-on-write fault swaps a shared page for a private copy of it. The worker already had that page resident, so its RSS is unchanged, but the copy is new memory. In CPython, reading an object updates its reference count, so reads of preloaded data become page writes.',
    accounting: 'RSS counted each shared catalog page in full before the copy, so the copy changes nothing in RSS. PSS charged the worker and the master half a page each; after the copy, each pays for a whole page. The master’s PSS rises too, though it did nothing.',
    production: 'Alerts and dashboards built on per-worker RSS miss this growth; per-worker PSS and Σ PSS show it. It is bounded by the size of the shared heap, but every worker pays it, and it can reach a container limit. gc.freeze() before forking keeps the cyclic collector off preloaded objects but does not stop reference-count writes. Keeping large read-only data outside Python objects, fewer workers, or recycling workers with max_requests limit the total.',
    evidence: '/proc/<pid>/smaps_rollup: Private_Dirty vs Shared_Dirty over time · minflt in /proc/<pid>/stat · cgroup memory.current',
    reference: 'Django 6.1 on Gunicorn, 2 workers: one read-only scan of a 150,000-entry preloaded catalog per worker added 55.2 MiB to Σ PSS and 0 KiB to Σ RSS. Each worker’s Private_Dirty rose 27.6 MiB, matching 7,070–7,076 minor faults × 4 KiB. Each worker’s PSS rose 18.4 MiB, and so did the master’s, though it served no requests.',
    related: ['leak', 'decay-oom'],
  },
  {
    id: 'leak', group: 'memory', title: 'A leak grows without limit',
    symptom: 'Worker memory rises with every request and never levels off.',
    steps: [
      { caption: 'With preload_app, the master builds a 6-page catalog at import time.', actions: preloadCatalog },
      { caption: 'Gunicorn forks a worker that shares the master’s pages.', actions: [fork] },
      { caption: 'The worker’s allocator reserves room for new objects. Mapped size grows, but nothing is resident until it is written.', actions: [map(4101, 'retained objects', 8)] },
      ...range(12, 8).map((page, index) => ({
        caption: `Request ${index + 1} appends an object to a module-level list and never removes it. Writing it makes one more page resident.`,
        actions: writes(4101, [page]),
      })),
    ],
    chart: { series: [RSS(4101), IN_USE] },
    watch: 'The worker’s RSS and memory in use rise together, one page per request, with no plateau. Its RSS and PSS rise by the same amount, because the new pages are not shared.',
    mechanism: 'Retained objects need new pages. They are private from their first write, so each one adds to the worker’s RSS as well as to memory in use.',
    production: 'Unlike copy-on-write decay, a leak shows in RSS and keeps growing with request volume. Decay raises Private_Dirty while RSS holds; a leak raises both. Recycling workers hides a leak without fixing it; a heap profiler finds what is retained.',
    evidence: '/proc/<pid>/status: VmRSS, RssAnon · smaps_rollup: Private_Dirty · tracemalloc or a heap profiler',
    reference: 'Django 6.1: requests that each kept a 256 KiB object raised a worker’s Private_Dirty by about the retained size, for example 9.5 MiB for 9.75 MiB retained. RSS rose a little less, 9.1 MiB, because the allocator reused pages that were already resident.',
    related: ['cow-decay', 'decay-oom'],
  },
  {
    id: 'decay-oom', group: 'memory', title: 'Copy-on-write decay reaches the memory limit',
    symptom: 'The pod is OOM-killed after hours of steady growth, though no request leaks memory.',
    steps: [
      { caption: 'The master preloads a 6-page catalog. The container’s memory limit leaves room for 8 more pages.', actions: [...preloadCatalog, { type: 'set_limit', bytes: DECAY_OOM_LIMIT }] },
      { caption: 'Gunicorn forks two workers. Their first requests run code from the page cache, which adds no memory.', actions: [fork, fork, ...reads(4101, CODE), ...reads(4102, CODE)] },
      ...range(6, 4).map(page => ({
        caption: `Both workers read entries on catalog page ${page}. Each one gets its own copy of the page.`,
        actions: writes(4101, [page]).concat(writes(4102, [page])),
      })),
      { caption: 'Worker 4101 reads catalog page 10. The copy pushes the charge past the limit, and the OOM killer stops a worker. In this model it picks the process with the most resident pages, breaking ties by the highest PID.', actions: writes(4101, [10]) },
      { caption: 'Gunicorn reaps the killed worker and forks a replacement, which starts out sharing the master’s pages again.', actions: [{ type: 'reap', pid: 4102 }, fork, ...reads(4103, CODE)] },
    ],
    chart: { series: [RSS(4101), { label: 'Memory charge (cgroup)', metric: 'charge' }], limit: true },
    watch: 'The charge climbs toward the limit while worker RSS stays flat. After the kill, the charge drops because the dead worker’s copies are freed.',
    mechanism: 'Every worker that reads preloaded data copies it separately, so decay grows with the worker count. The cgroup charges every copied page. When the charge exceeds the limit and nothing can be reclaimed, the kernel kills a process in the group.',
    accounting: 'The cgroup charges each frame once, like Σ PSS, so every copy counts against the limit. Worker RSS already counted the shared pages, so the copies never show in it.',
    production: 'The pattern is slow growth, an OOM kill, then a respawn that briefly lowers memory. Size the limit from Σ PSS after decay, not at boot; measure decay per worker, then choose a worker count and limit together.',
    evidence: 'memory.events: oom_kill · memory.current · dmesg or journalctl -k · Σ PSS over time',
    reference: 'Earlier probes with a 64 MiB cgroup and no swap recorded one oom_kill in each of 3 runs. The kernel chose the child with the higher oom_score_adj. This model’s victim rule is only a teaching rule.',
    related: ['cow-decay', 'leak'],
  },
  {
    id: 'rss-overcount', group: 'memory', title: 'Summed RSS overstates memory',
    symptom: 'A dashboard adds up worker RSS and reports far more memory than the node is using.',
    steps: [
      { caption: 'With preload_app, the master imports the app into 3 heap pages before forking.', actions: preloadApp },
      { caption: 'Gunicorn forks worker 4101. It shares the master’s frames, so memory in use does not change.', actions: [fork] },
      { caption: 'Gunicorn forks worker 4102.', actions: [fork] },
      { caption: 'Both workers serve requests and run code that is already in the page cache. Each maps the same frames.', actions: [...reads(4101, CODE), ...reads(4102, CODE)] },
    ],
    chart: { series: [SUM_RSS, IN_USE] },
    watch: 'Σ RSS gains a whole process with every fork, while Σ PSS, the memory in use, stays put.',
    mechanism: 'RSS counts every resident page a process maps, including pages shared with other processes. PSS divides each shared page among its sharers, so Σ PSS equals the memory actually in use.',
    accounting: 'Each fork adds the shared pages to one more RSS figure, so Σ RSS counts them once per process. PSS splits each shared page among the processes that map it, so Σ PSS stays equal to the memory in use.',
    production: 'Capacity plans and alerts built on workers × RSS overstate memory several times over. Sum PSS across the master and workers, or read the cgroup’s memory.current.',
    evidence: '/proc/<pid>/smaps_rollup: Pss summed over the process tree · smem -t · cgroup memory.current',
    reference: 'Django 6.1 on Gunicorn with preload_app and 2 workers: Σ RSS was 259.8–259.9 MiB at boot while Σ PSS was 90.2–90.3 MiB. Each worker reported 84.7–84.8 MiB of RSS and 29.1–29.2 MiB of PSS.',
    related: ['no-preload', 'worker-warmup'],
  },
  {
    id: 'worker-warmup', group: 'memory', title: 'New workers grow after boot',
    symptom: 'A new worker reports less RSS than the master, then its RSS climbs during its first requests.',
    steps: [
      { caption: 'With preload_app, the master imports the app before forking. Its code and library pages are resident.', actions: preloadApp },
      { caption: 'Gunicorn forks a worker. Linux copies page-table entries for its anonymous memory but not for file-backed code it never wrote, so those pages are missing from its RSS.', actions: [fork] },
      { caption: 'The first request runs app and library code. Those pages are in the page cache, so minor faults map them. RSS grows; memory in use does not.', actions: reads(4101, CODE) },
      { caption: 'Django imports ROOT_URLCONF and its views on this first request, after the fork. Their objects fill new private pages: RSS and memory in use both grow.', actions: [map(4101, 'urlconf + views', 2), ...writes(4101, [9, 10])] },
    ],
    chart: { series: [RSS(4101), IN_USE] },
    watch: 'Worker RSS rises at both steps. Memory in use (Σ PSS) rises only at the second.',
    mechanism: 'Fork skips page-table entries that a fault can refill from the page cache, so a new worker’s file-backed pages come back as it runs. Lazy imports allocate after the fork, so every worker builds its own copy.',
    accounting: 'The first RSS rise is code pages the worker now maps alongside the master. The worker’s PSS gains half of each page, the master’s PSS loses the same, and Σ PSS does not change. Only the second rise adds memory.',
    production: 'Early RSS growth in a new worker is partly free and partly real. The lazy-import part is paid again by every worker, including respawns. Importing the URLconf in the master before forking shares those objects, but it runs more code at import time, where side effects are riskier.',
    evidence: '/proc/<pid>/status: RssFile and RssAnon · smaps_rollup: Private_Dirty · sys.modules in a post_fork hook',
    reference: 'Django 6.1: workers started with 5.0–5.1 MiB RssFile against the master’s 11.0–11.1 MiB. Their first request added 1.0–1.1 MiB RssFile and 6.8 MiB RssAnon. The URLconf was absent from sys.modules in post_fork. The first requests raised Σ RSS by 14.6–14.7 MiB but Σ PSS by 20.4 MiB, because they also copied shared heap pages, which RSS does not show. Importing the URLconf in the master cut that Σ PSS growth to 4.3–4.4 MiB.',
    related: ['rss-overcount', 'no-preload'],
  },
  {
    id: 'no-preload', group: 'memory', title: 'Without preload, every worker pays for the app',
    symptom: 'Memory grows in step with the worker count, and each new worker is slow to start.',
    steps: [
      { caption: 'Without preload_app, the master only runs Gunicorn. It never imports the app.', actions: [] },
      { caption: 'Gunicorn forks two workers. They share the master’s small heap.', actions: [fork, fork] },
      { caption: 'Worker 4101 imports the app after the fork. Code comes from the page cache, but the imported objects fill 3 new private pages.', actions: [...reads(4101, CODE), map(4101, 'app', 3), ...writes(4101, APP)] },
      { caption: 'Worker 4102 imports its own copy of the app.', actions: [...reads(4102, CODE), map(4102, 'app', 3), ...writes(4102, APP)] },
    ],
    chart: { series: [SUM_RSS, IN_USE] },
    watch: 'Memory in use grows by the app’s size for each worker. Σ RSS and Σ PSS stay closer together than with preload, because less is shared.',
    mechanism: 'Each worker imports the app into its own private pages. Code and libraries are still shared through the page cache, but the imported heap is not.',
    accounting: 'Σ RSS ranks the two setups the wrong way round. Preload shares more pages, and RSS counts every shared page once per process, so Σ RSS comes out higher with preload even though Σ PSS shows it uses less memory.',
    contrast: { scenario: 'rss-overcount', label: 'With preload', ownLabel: 'Without preload' },
    production: 'Preload saves memory at boot and makes respawns cheap. It also runs import-time side effects once in the master, where connections and threads can be inherited, and its savings shrink as decay copies the shared heap.',
    evidence: 'Σ PSS with and without preload_app · worker start time in Gunicorn logs',
    reference: 'Django 6.1, 2 workers, at boot: Σ RSS was 259.8–259.9 MiB with preload and 206.2–206.4 MiB without, while Σ PSS was 90.2–90.3 MiB with preload and 174.4 MiB without. After each worker scanned the catalog, Σ PSS was 165.9 MiB with preload and 188.5–188.6 MiB without.',
    related: ['rss-overcount', 'cow-decay'],
  },
  {
    id: 'shared-offset', group: 'handles', title: 'An inherited file shares one offset',
    symptom: 'Workers that inherit a descriptor opened before fork interfere with each other’s reads or protocol streams.',
    steps: [
      { caption: 'The master starts with its listening socket.', actions: [] },
      { caption: 'At import time, the app opens a data file and keeps its descriptor.', actions: [{ type: 'open_file', pid: 4100, name: 'catalog.csv' }] },
      { caption: 'Gunicorn forks two workers. Each copies the descriptor table, so all three descriptors refer to one open-file object.', actions: [fork, fork] },
      { caption: 'Worker 4101 reads 64 bytes. The shared offset moves to 64.', actions: [{ type: 'read_file', pid: 4101, fd: 4, bytes: 64 }] },
      { caption: 'Worker 4102 expects the start of the file, but its read begins at byte 64.', actions: [{ type: 'read_file', pid: 4102, fd: 4, bytes: 64 }] },
    ],
    watch: 'One kernel object, three cables. The offset in the inspector advances with every worker’s read.',
    mechanism: 'Fork copies descriptors, not the objects they refer to. The file offset belongs to the open-file object, so every process shares it.',
    production: 'A database connection opened at import time is shared the same way: one TCP or TLS stream used by every worker, which surfaces as protocol or SSL errors. Close such handles before forking and open new ones in each worker.',
    evidence: '/proc/<pid>/fd and fdinfo (pos) · the same socket inode under several PIDs in ss -tnp',
    related: ['thread-lock'],
  },
  {
    id: 'thread-lock', group: 'handles', title: 'A background thread does not survive fork',
    symptom: 'A metrics or tracing SDK stops exporting from workers, or a worker hangs on its first request.',
    steps: [
      { caption: 'The master starts with one thread.', actions: [] },
      { caption: 'An SDK initialized at import time starts a background exporter thread.', actions: [{ type: 'spawn_thread', pid: 4100 }] },
      { caption: 'The exporter takes its queue lock while it flushes.', actions: [{ type: 'lock', pid: 4100, lockId: 'export-queue', tid: 5000 }] },
      { caption: 'Gunicorn forks while the lock is held. The worker gets only the forking thread. Its copy of the lock still names the exporter as owner.', actions: [fork] },
      { caption: 'In the master, the exporter releases the lock. The worker’s copy stays held, so the first worker code that takes it waits forever.', actions: [{ type: 'unlock', pid: 4100, lockId: 'export-queue', tid: 5000 }] },
    ],
    watch: 'The master has two thread spindles and the worker has one. Inspect the worker: its lock is owned by a thread it does not have.',
    mechanism: 'Fork duplicates only the calling thread. Memory, including lock state, is copied as it was at that instant.',
    production: 'Start SDKs, exporters, and background threads in a post_fork hook, never at import time in a preloaded app.',
    evidence: '/proc/<pid>/task · py-spy dump of a stuck worker',
    related: ['shared-offset'],
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return scenarios.find(scenario => scenario.id === id);
}

/** One world state per step: the state after that step's actions. */
export function scenarioStates(scenario: Scenario): WorldState[] {
  const states: WorldState[] = [];
  let world = initialWorld();
  for (const step of scenario.steps) {
    for (const action of step.actions) world = applyAction(world, action);
    assertInvariants(world);
    states.push(world);
  }
  return states;
}

export function seriesValue(state: WorldState, series: ChartSeries): number | null {
  if (series.metric === 'physical') return physicalBytes(state);
  if (series.metric === 'charge') return chargedBytes(state);
  const rows = memoryRows(state);
  if (series.metric === 'sumRss') return rows.reduce((sum, row) => sum + row.rss, 0);
  if (series.metric !== 'rss' && series.metric !== 'pss' && series.metric !== 'uss') return null;
  const { pid, metric } = series;
  const row = rows.find(item => item.pid === pid && item.status === 'running');
  return row ? row[metric] : null;
}

/** The process and page a step's last action touched, so the views can point at what changed. */
export function stepFocus(scenario: Scenario, index: number, state: WorldState): { pid: number; page: number | null } {
  const action = scenario.steps[index].actions.at(-1);
  const exists = (pid: number) => state.processes.some(process => process.pid === pid);
  if (action?.type === 'fork') return { pid: state.nextPid - 1, page: null };
  if (action && 'pid' in action && exists(action.pid)) {
    return { pid: action.pid, page: (action.type === 'read' || action.type === 'write') && action.page !== undefined ? action.page : null };
  }
  return { pid: 4100, page: null };
}
