import { applyAction, assertInvariants, chargedBytes, initialWorld, memoryRows, physicalBytes, type Action, type WorldState } from './model.ts';

export type ScenarioGroup = 'memory' | 'handles';
export type ChartSeries =
  | { label: string; metric: 'rss' | 'pss' | 'uss'; pid: number }
  | { label: string; metric: 'sumRss' | 'sumPss' | 'physical' | 'charge' };
export interface ScenarioStep { caption: string; actions: Action[] }
/** One replay: the problem as it happens, or the same setup with the fix applied. */
export interface ScenarioRun {
  steps: ScenarioStep[];
  chart?: { series: ChartSeries[]; limit?: boolean };
  watch: string;
}
/** The fix changes one thing about the problem's setup and replays it. A fix without a chart uses the problem's. */
export interface ScenarioFix extends ScenarioRun {
  change: string;
  /** Every fix has a cost. */
  cost: string;
}
export interface Scenario extends ScenarioRun {
  id: string;
  group: ScenarioGroup;
  title: string;
  /** The production symptom, as an on-call engineer would first meet it. */
  symptom: string;
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
  fix: ScenarioFix;
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
// Sized from the charge once both workers have copied the whole catalog, with headroom.
export const DECAY_SIZED_LIMIT = 32 * 4096;

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
    production: 'Alerts and dashboards built on per-worker RSS miss this growth; per-worker PSS and Σ PSS show it. It is bounded by the size of the shared heap, but every worker pays it, and it can reach a container limit. gc.freeze() before forking keeps the cyclic collector off preloaded objects but does not stop reference-count writes. Fewer workers, or recycling workers with max_requests, limit the total without removing the cause.',
    evidence: '/proc/<pid>/smaps_rollup: Private_Dirty vs Shared_Dirty over time · minflt in /proc/<pid>/stat · cgroup memory.current',
    reference: 'Django 6.1 on Gunicorn, 2 workers: one read-only scan of a 150,000-entry preloaded catalog per worker added 55.2 MiB to Σ PSS and 0 KiB to Σ RSS. Each worker’s Private_Dirty rose 27.6 MiB, matching 7,070–7,076 minor faults × 4 KiB. Each worker’s PSS rose 18.4 MiB, and so did the master’s, though it served no requests.',
    related: ['leak', 'decay-oom'],
    fix: {
      change: 'Store the catalog in one flat buffer, such as a bytes object or a NumPy array, instead of as many Python objects. A lookup reads bytes from the buffer and builds only the value it returns, so the catalog’s pages are read, not written. Only the buffer object’s header carries a reference count.',
      cost: 'In exchange, code looks entries up through the buffer’s layout, decoding each value it needs, instead of using dicts and objects directly.',
      steps: [
        { caption: 'With preload_app, the master builds the same 6-page catalog at import time, this time as one flat buffer.', actions: preloadCatalog },
        { caption: 'Gunicorn forks a worker. Its page table points at the master’s heap, stack, and catalog frames. Nothing is copied.', actions: [fork] },
        { caption: 'Request 1 looks up an entry on catalog page 6. Taking a reference to the buffer writes its reference count, in the header on this page, so the kernel copies this one page.', actions: writes(4101, [6]) },
        ...range(7, 5).map((page, index) => ({
          caption: `Request ${index + 2} looks up an entry on catalog page ${page}. The entry is bytes in the buffer, not an object, so the request only reads the page, and it stays shared.`,
          actions: [...writes(4101, [6]), ...reads(4101, [page])],
        })),
        { caption: 'Requests 7 and 8 look up entries on pages 6 and 7. The header page is already the worker’s own, and page 7 is only read, so nothing is copied.', actions: [...writes(4101, [6]), ...reads(4101, [7])] },
      ],
      watch: 'The worker’s RSS stays flat, as before. Its PSS and memory in use rise once, for the header page, then stay flat: reading the buffer copies nothing.',
    },
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
    fix: {
      change: 'Bound what the worker keeps. Replace the module-level list with a cache that holds a fixed number of entries, such as functools.lru_cache(maxsize=…), or keep per-request data in request scope. An evicted entry’s memory is freed, and the allocator reuses it for the next one.',
      cost: 'In exchange, a request that needs an evicted entry builds it again, so the bound trades memory for repeated work.',
      steps: [
        { caption: 'With preload_app, the master builds a 6-page catalog at import time.', actions: preloadCatalog },
        { caption: 'Gunicorn forks a worker that shares the master’s pages.', actions: [fork] },
        { caption: 'The worker’s allocator reserves room for cache entries. Mapped size grows, but nothing is resident until it is written.', actions: [map(4101, 'cache entries', 8)] },
        { caption: 'Request 1 stores its object in a cache that holds 2 entries. Writing it makes one page resident.', actions: writes(4101, [12]) },
        { caption: 'Request 2 stores a second entry, on a new page.', actions: writes(4101, [13]) },
        ...range(3, 6).map(request => ({
          caption: `Request ${request}’s entry evicts the oldest one. Its memory is freed and reused, so the write lands on a page that is already resident.`,
          actions: writes(4101, [12 + (request + 1) % 2]),
        })),
      ],
      watch: 'RSS and memory in use rise for the first two requests, then stay flat: each later entry reuses the page an evicted one freed.',
    },
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
    production: 'The pattern is slow growth, an OOM kill, then a respawn that briefly lowers memory and starts the decay again. Requests in flight on the killed worker fail.',
    evidence: 'memory.events: oom_kill · memory.current · dmesg or journalctl -k · Σ PSS over time',
    reference: 'Earlier probes with a 64 MiB cgroup and no swap recorded one oom_kill in each of 3 runs. The kernel chose the child with the higher oom_score_adj. This model’s victim rule is only a teaching rule.',
    related: ['cow-decay', 'leak'],
    fix: {
      change: 'Size the limit from memory after decay, not at boot. Read the cgroup’s memory.current once every worker has copied what it will copy, for example at the end of a load test, and set the limit above it. Choose the worker count and the limit together.',
      cost: 'In exchange, the container reserves memory for the fully decayed state. If the node cannot spare it, run fewer workers, or remove the decay itself with a flat-buffer catalog, as in the copy-on-write decay scenario.',
      steps: [
        { caption: 'The master preloads a 6-page catalog. The limit is sized from a load test’s peak, so it leaves room for both workers to copy the whole catalog.', actions: [...preloadCatalog, { type: 'set_limit', bytes: DECAY_SIZED_LIMIT }] },
        { caption: 'Gunicorn forks two workers. Their first requests run code from the page cache, which adds no memory.', actions: [fork, fork, ...reads(4101, CODE), ...reads(4102, CODE)] },
        ...range(6, 4).map(page => ({
          caption: `Both workers read entries on catalog page ${page}. Each one gets its own copy of the page.`,
          actions: writes(4101, [page]).concat(writes(4102, [page])),
        })),
        { caption: 'Worker 4101 reads catalog page 10. The copy that crossed the boot-time limit fits under this one.', actions: writes(4101, [10]) },
        { caption: 'Both workers finish copying the catalog. The charge levels off below the limit, and no worker is killed.', actions: [...writes(4102, [10]), ...writes(4101, [11]), ...writes(4102, [11])] },
      ],
      watch: 'The charge climbs as before, then levels off below the limit once both workers have copied the whole catalog. Worker RSS stays flat, and no worker is killed.',
    },
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
    chart: { series: [{ label: 'Dashboard: Σ RSS', metric: 'sumRss' }, IN_USE] },
    watch: 'Σ RSS gains a whole process with every fork, while Σ PSS, the memory in use, stays put.',
    mechanism: 'RSS counts every resident page a process maps, including pages shared with other processes. PSS divides each shared page among its sharers, so Σ PSS equals the memory actually in use.',
    accounting: 'Each fork adds the shared pages to one more RSS figure, so Σ RSS counts them once per process. PSS splits each shared page among the processes that map it, so Σ PSS stays equal to the memory in use.',
    production: 'Capacity plans and alerts built on workers × RSS overstate memory several times over, and the error grows with the worker count.',
    evidence: '/proc/<pid>/smaps_rollup: Pss summed over the process tree · smem -t · cgroup memory.current',
    reference: 'Django 6.1 on Gunicorn with preload_app and 2 workers: Σ RSS was 259.8–259.9 MiB at boot while Σ PSS was 90.2–90.3 MiB. Each worker reported 84.7–84.8 MiB of RSS and 29.1–29.2 MiB of PSS.',
    related: ['no-preload', 'worker-warmup'],
    fix: {
      change: 'Make the dashboard sum PSS over the master and its workers instead of RSS, or read the cgroup’s memory.current. PSS divides each shared page among the processes that map it, so the sum counts each page once. The processes are unchanged; only the measurement is.',
      cost: 'In exchange, PSS is slower to collect, because the kernel walks the page tables to compute it, and one process’s PSS changes when others fork or exit.',
      steps: [
        { caption: 'With preload_app, the master imports the app into 3 heap pages before forking. The dashboard now sums PSS, which is all the master’s.', actions: preloadApp },
        { caption: 'Gunicorn forks worker 4101. The master and the worker split each shared page, so the sum does not change.', actions: [fork] },
        { caption: 'Gunicorn forks worker 4102. Each shared page is split three ways, and the sum still does not change.', actions: [fork] },
        { caption: 'Both workers serve requests and map the same code pages. The dashboard still reports the memory in use.', actions: [...reads(4101, CODE), ...reads(4102, CODE)] },
      ],
      chart: { series: [IN_USE, { label: 'Dashboard: Σ PSS', metric: 'sumPss' }] },
      watch: 'The dashboard’s line lies on memory in use at every step: a fork adds processes that share pages, not memory.',
    },
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
    accounting: 'The first RSS rise is code pages the worker now maps alongside the master. The worker’s PSS gains half of each page, the master’s PSS loses the same, and Σ PSS does not change. Only URLconf pages that the worker allocates or copies add memory.',
    production: 'Early RSS growth in a new worker is partly free and partly real. The lazy-import part is paid again by every worker, including respawns.',
    evidence: '/proc/<pid>/status: RssFile and RssAnon · smaps_rollup: Private_Dirty · sys.modules in a post_fork hook',
    reference: 'Django 6.1: workers started with 5.0–5.1 MiB RssFile against the master’s 11.0–11.1 MiB. Their first request added 1.0–1.1 MiB RssFile and 6.8 MiB RssAnon. The URLconf was absent from sys.modules in post_fork. The first requests raised Σ RSS by 14.6–14.7 MiB but Σ PSS by 20.4 MiB, because they also copied shared heap pages, which RSS does not show. Importing the URLconf in the master cut that Σ PSS growth to 4.3–4.4 MiB.',
    related: ['rss-overcount', 'no-preload'],
    fix: {
      change: 'Import the URLconf in the master before forking, for example by calling django.urls.get_resolver().url_patterns at the end of wsgi.py. Its objects are then built once, in pages every worker shares.',
      cost: 'In exchange, the master runs more code at import time, where side effects such as opening a connection are inherited by every worker. Reference-count writes still copy the pages that requests touch.',
      steps: [
        { caption: 'With preload_app, the master imports the app and, from wsgi.py, the URLconf and its views before forking.', actions: [...preloadApp, map(4100, 'urlconf + views', 2), ...writes(4100, [9, 10])] },
        { caption: 'Gunicorn forks a worker. Its page table points at the master’s heap, URLconf included. File-backed code it never wrote is missing from its RSS, as before.', actions: [fork] },
        { caption: 'The first request runs app and library code. Those pages are in the page cache, so minor faults map them. RSS grows; memory in use does not.', actions: reads(4101, CODE) },
        { caption: 'Resolving the request’s URL uses the URLconf the master built. Nothing new is allocated, but updating reference counts copies the one page of it the request touches.', actions: writes(4101, [9]) },
      ],
      watch: 'Worker RSS rises only for the code pages, because the URLconf was resident from the fork. Memory in use rises by one copied page instead of two new ones.',
    },
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
    production: 'The app’s size, times the worker count, sets how many workers fit on a node, and every respawn imports the app again before it can serve a request.',
    evidence: 'Σ PSS with and without preload_app · worker start time in Gunicorn logs',
    reference: 'Django 6.1, 2 workers, at boot: Σ RSS was 259.8–259.9 MiB with preload and 206.2–206.4 MiB without, while Σ PSS was 90.2–90.3 MiB with preload and 174.4 MiB without. After each worker scanned the catalog, Σ PSS was 165.9 MiB with preload and 188.5–188.6 MiB without.',
    related: ['rss-overcount', 'cow-decay'],
    fix: {
      change: 'Turn on preload_app, so the master imports the app once before forking and every worker starts with it in shared pages. Respawns are cheap, because the app is already in memory.',
      cost: 'In exchange, import-time side effects run in the master, where workers inherit connections and lose threads. A HUP no longer loads new code, because workers fork from the master’s copy. Decay copies part of the shared heap back over time.',
      steps: [
        { caption: 'With preload_app, the master imports the app into 3 heap pages before forking.', actions: preloadApp },
        { caption: 'Gunicorn forks two workers. They share the master’s heap, app included.', actions: [fork, fork] },
        { caption: 'Worker 4101 runs app code from the page cache. The app’s objects are already in pages it shares, so nothing new is allocated.', actions: reads(4101, CODE) },
        { caption: 'Worker 4102 does the same. Memory in use is still what the master used at boot.', actions: reads(4102, CODE) },
      ],
      watch: 'Memory in use stays at the master’s boot size. Σ RSS ends higher than without preload, because it counts the shared app once per process.',
    },
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
    production: 'A database connection opened at import time is shared the same way: one TCP or TLS stream used by every worker, which surfaces as protocol or SSL errors.',
    evidence: '/proc/<pid>/fd and fdinfo (pos) · the same socket inode under several PIDs in ss -tnp',
    related: ['thread-lock'],
    fix: {
      change: 'Close the file in the master before forking, and open it again in each worker from a post_fork hook, so each worker has its own open-file object and offset. For a database connection opened at import time, call django.db.connections.close_all() before forking; each worker then connects on its first query.',
      cost: 'In exchange, every worker holds its own descriptor or connection, so open files and database connections grow with the worker count.',
      steps: [
        { caption: 'The master starts with its listening socket.', actions: [] },
        { caption: 'At import time, the app opens the data file, reads what it needs, and closes it before Gunicorn forks.', actions: [{ type: 'open_file', pid: 4100, name: 'catalog.csv' }, { type: 'close_fd', pid: 4100, fd: 4 }] },
        { caption: 'Gunicorn forks two workers. A post_fork hook opens the file in each, so each worker gets its own open-file object.', actions: [fork, fork, { type: 'open_file', pid: 4101, name: 'catalog.csv' }, { type: 'open_file', pid: 4102, name: 'catalog.csv' }] },
        { caption: 'Worker 4101 reads 64 bytes. Only its own offset moves to 64.', actions: [{ type: 'read_file', pid: 4101, fd: 4, bytes: 64 }] },
        { caption: 'Worker 4102 reads from the start of the file, as it expects. Its offset moves from 0 to 64.', actions: [{ type: 'read_file', pid: 4102, fd: 4, bytes: 64 }] },
      ],
      watch: 'Two file objects, one cable each. In the inspector, each worker’s offset advances only with its own reads.',
    },
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
    production: 'Nothing fails loudly: exports stop, or a worker hangs with no error. Python 3.12 and later issue a DeprecationWarning when a process with other threads forks, but it points at Gunicorn’s code, so the default warning filters hide it; set PYTHONWARNINGS=default to see it.',
    evidence: '/proc/<pid>/task · py-spy dump of a stuck worker',
    reference: 'Gunicorn 26.2 with preload_app and 2 workers, and an app that starts an exporter thread at import time: on Python 3.12, 3.13, and 3.14, the DeprecationWarning was attributed to gunicorn/arbiter.py and reached stderr only with PYTHONWARNINGS=default. A fork called from the main script warned under the default filters. Python 3.11 never warned. In every version, a child forked while the exporter held a lock had one thread and could not take the lock within 1 second.',
    related: ['shared-offset'],
    fix: {
      change: 'Start the exporter in a post_fork hook instead of at import time. The master has no other thread when it forks, and each worker’s exporter is a thread of its own, holding its own lock.',
      cost: 'In exchange, each worker runs its own exporter and connection to the collector, and the master exports nothing unless it starts one too.',
      steps: [
        { caption: 'The master starts with one thread. The SDK is configured at import time, but starts no thread.', actions: [] },
        { caption: 'Gunicorn forks a worker. The master has only its main thread, so no lock can be held mid-flush.', actions: [fork] },
        { caption: 'A post_fork hook starts the exporter in the worker.', actions: [{ type: 'spawn_thread', pid: 4101 }] },
        { caption: 'The worker’s exporter takes its queue lock while it flushes.', actions: [{ type: 'lock', pid: 4101, lockId: 'export-queue', tid: 5000 }] },
        { caption: 'The exporter releases the lock. The next worker code that takes it gets it at once.', actions: [{ type: 'unlock', pid: 4101, lockId: 'export-queue', tid: 5000 }] },
      ],
      watch: 'The master keeps one thread spindle, and the worker gains its own exporter after the fork. Inspect the worker: its lock’s owner is a thread it has.',
    },
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return scenarios.find(scenario => scenario.id === id);
}

/** One world state per step of a run: the state after that step's actions. */
export function scenarioStates(run: Pick<ScenarioRun, 'steps'>): WorldState[] {
  const states: WorldState[] = [];
  let world = initialWorld();
  for (const step of run.steps) {
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
  if (series.metric === 'sumPss') return rows.reduce((sum, row) => sum + row.pss, 0);
  if (series.metric !== 'rss' && series.metric !== 'pss' && series.metric !== 'uss') return null;
  const { pid, metric } = series;
  const row = rows.find(item => item.pid === pid && item.status === 'running');
  return row ? row[metric] : null;
}

/** The process and page a step's last action touched, so the views can point at what changed. */
export function stepFocus(run: Pick<ScenarioRun, 'steps'>, index: number, state: WorldState): { pid: number; page: number | null } {
  const action = run.steps[index].actions.at(-1);
  const exists = (pid: number) => state.processes.some(process => process.pid === pid);
  if (action?.type === 'fork') return { pid: state.nextPid - 1, page: null };
  if (action && 'pid' in action && exists(action.pid)) {
    return { pid: action.pid, page: (action.type === 'read' || action.type === 'write') && action.page !== undefined ? action.page : null };
  }
  return { pid: 4100, page: null };
}
