export type Source = 'model' | 'recorded' | 'inferred';
export type EventKind = 'start' | 'fork' | 'read' | 'zero_page' | 'demand_zero' | 'minor_fault' | 'major_fault' | 'cow_fault' | 'write' | 'mmap' | 'munmap' | 'open' | 'file_read' | 'close' | 'thread' | 'lock' | 'unlock' | 'limit' | 'oom_kill' | 'exit' | 'reap';
export type RegionKind = 'anonymous' | 'file';
export interface RegionState { id: string; name: string; startPage: number; pageCount: number; kind: RegionKind; sharing: 'private' | 'shared'; writable: boolean; fileKey?: string }
export interface DescriptorState { fd: number; objectId: string }
export interface KernelObjectState { id: string; kind: 'socket' | 'file'; offset: number }
export interface LockState { id: string; ownerTid: number | null }
/** pages[i] is the frame behind virtual page i. A page inside a region with no frame is mapped but not resident. */
export interface ProcessState {
  pid: number; parentPid: number | null; role: 'master' | 'worker'; status: 'running' | 'zombie';
  pages: (number | null)[]; regions: RegionState[]; descriptors: DescriptorState[];
  threadIds: number[]; locks: LockState[]; counter: number; nextPage: number;
}
export interface FrameState { id: number; region: string; kind: RegionKind; owner: number | null; revision: number; fileKey?: string }
export interface WorldEvent { kind: EventKind; source: Source; step: number; pid: number; frameId?: number; newFrameId?: number; description: string }
export interface WorldState {
  source: Source; pageSize: number; processes: ProcessState[]; frames: FrameState[]; kernelObjects: KernelObjectState[];
  events: WorldEvent[]; nextPid: number; nextTid: number; nextFrameId: number; nextRegionId: number; nextObjectId: number;
  limitBytes: number | null; step: number;
}
export type Action =
  | { type: 'fork'; parentPid: number; callerTid?: number }
  | { type: 'read' | 'write'; pid: number; page?: number }
  | { type: 'exit' | 'reap'; pid: number }
  | { type: 'mmap'; pid: number; name: string; pageCount: number; kind: RegionKind; sharing: 'private' | 'shared'; writable?: boolean; fileKey?: string }
  | { type: 'munmap'; pid: number; regionId: string }
  | { type: 'open_file'; pid: number; name: string }
  | { type: 'read_file'; pid: number; fd: number; bytes: number }
  | { type: 'close_fd'; pid: number; fd: number }
  | { type: 'spawn_thread'; pid: number }
  | { type: 'lock' | 'unlock'; pid: number; lockId: string; tid: number }
  | { type: 'set_limit'; bytes: number | null };

export function initialWorld(): WorldState {
  const regions: RegionState[] = [
    { id: 'code', name: 'code', startPage: 0, pageCount: 1, kind: 'file', sharing: 'private', writable: false, fileKey: 'app' },
    { id: 'libraries', name: 'libraries', startPage: 1, pageCount: 1, kind: 'file', sharing: 'private', writable: false, fileKey: 'libpython' },
    { id: 'heap', name: 'heap', startPage: 2, pageCount: 3, kind: 'anonymous', sharing: 'private', writable: true },
    { id: 'stack', name: 'stack', startPage: 5, pageCount: 1, kind: 'anonymous', sharing: 'private', writable: true },
  ];
  return {
    source: 'model', pageSize: 4096, nextPid: 4101, nextTid: 5000, nextFrameId: 6,
    nextRegionId: 1, nextObjectId: 1, limitBytes: null, step: 0,
    processes: [{ pid: 4100, parentPid: null, role: 'master', status: 'running', pages: [0, 1, 2, 3, 4, 5],
      regions, descriptors: [{ fd: 3, objectId: 'listen:8000' }], threadIds: [4100], locks: [], counter: 0, nextPage: 6 }],
    frames: regions.flatMap(region => Array.from({ length: region.pageCount }, (_, offset) => ({
      id: region.startPage + offset, region: region.name, kind: region.kind, owner: null, revision: 0,
      ...(region.kind === 'file' ? { fileKey: pageCacheKey(region, region.startPage + offset) } : {}),
    }))),
    kernelObjects: [{ id: 'listen:8000', kind: 'socket', offset: 0 }],
    events: [{ kind: 'start', source: 'model', step: 0, pid: 4100,
      description: 'The master has six resident pages, a listening socket descriptor, and one thread.' }],
  };
}

export function sharers(world: WorldState, frameId: number): number {
  return world.processes.reduce((count, process) => count + process.pages.filter(id => id === frameId).length, 0);
}
/** A file page's page-cache key: its file and its offset within the mapping. */
export const pageCacheKey = (region: RegionState, page: number) => `${region.fileKey}:${page - region.startPage}`;
export function regionForPage(process: ProcessState, page: number): RegionState | undefined {
  return process.regions.find(region => page >= region.startPage && page < region.startPage + region.pageCount);
}
export function mappedPages(process: ProcessState): number {
  return process.regions.reduce((total, region) => total + region.pageCount, 0);
}
export function residentPages(process: ProcessState): number {
  return process.pages.filter(id => id !== null).length;
}
/** Fork copies page-table entries only for private regions holding anonymous pages; other pages fault in later. */
export function forkCopiesEntries(world: WorldState, process: ProcessState, region: RegionState): boolean {
  if (region.sharing !== 'private') return false;
  return process.pages.slice(region.startPage, region.startPage + region.pageCount)
    .some(id => id !== null && world.frames.find(frame => frame.id === id)?.kind === 'anonymous');
}
export function objectRefCount(world: WorldState, objectId: string): number {
  return world.processes.reduce((count, process) => count + process.descriptors.filter(fd => fd.objectId === objectId).length, 0);
}
export function pageTableBytes(world: WorldState): number {
  return world.processes.reduce((total, process) => {
    if (process.status !== 'running') return total;
    const leaves = new Set(process.pages.flatMap((id, index) => id === null ? [] : [Math.floor(index / 512)]));
    return total + world.pageSize * (1 + leaves.size);
  }, 0);
}
export function physicalBytes(world: WorldState): number { return world.frames.length * world.pageSize; }
export function chargedBytes(world: WorldState): number { return physicalBytes(world) + pageTableBytes(world); }
function cloneWorld(previous: WorldState): WorldState {
  return { ...previous, step: previous.step + 1,
    processes: previous.processes.map(p => ({ ...p, pages: [...p.pages], regions: p.regions.map(r => ({ ...r })),
      descriptors: p.descriptors.map(fd => ({ ...fd })), threadIds: [...p.threadIds], locks: p.locks.map(lock => ({ ...lock })) })),
    frames: previous.frames.map(f => ({ ...f })), kernelObjects: previous.kernelObjects.map(object => ({ ...object })), events: [...previous.events] };
}
function releaseUnused(world: WorldState) {
  world.frames = world.frames.filter(frame => sharers(world, frame.id) > 0);
  world.kernelObjects = world.kernelObjects.filter(object => objectRefCount(world, object.id) > 0);
}
function stopProcess(world: WorldState, process: ProcessState) {
  process.status = 'zombie'; process.pages = []; process.regions = []; process.descriptors = [];
  process.threadIds = []; process.locks = [];
  releaseUnused(world);
}

export function applyAction(previous: WorldState, action: Action): WorldState {
  const world = cloneWorld(previous);
  const add = (event: Omit<WorldEvent, 'source' | 'step'>) => world.events.push({ ...event, source: 'model', step: world.step });
  const running = (pid: number) => {
    const process = world.processes.find(p => p.pid === pid && p.status === 'running');
    if (!process) throw Error(`PID ${pid} is not running`);
    return process;
  };
  if (action.type === 'fork') {
    const parent = running(action.parentPid);
    if (action.callerTid !== undefined && !parent.threadIds.includes(action.callerTid)) throw Error(`Thread ${action.callerTid} is not in PID ${parent.pid}`);
    const pid = world.nextPid++;
    const pages = parent.pages.map((id, page) => {
      const region = regionForPage(parent, page);
      return id !== null && region && forkCopiesEntries(world, parent, region) ? id : null;
    });
    const copied = pages.filter(id => id !== null).length, skipped = residentPages(parent) - copied, objects = parent.descriptors.length;
    world.processes.push({ ...parent, pid, parentPid: parent.pid, role: 'worker', pages,
      regions: parent.regions.map(r => ({ ...r })), descriptors: parent.descriptors.map(fd => ({ ...fd })),
      threadIds: [pid], locks: parent.locks.map(lock => ({ ...lock })) });
    add({ kind: 'fork', pid, description: `PID ${pid} forks from ${parent.pid}. It shares ${copied} of the parent’s frames${objects ? ` and ${objects === 1 ? 'its kernel object' : `its ${objects} kernel objects`}` : ''}; only the calling thread survives.${skipped ? ` ${skipped} file-backed page${skipped === 1 ? ' is' : 's are'} not resident in the child until it touches ${skipped === 1 ? 'it' : 'them'}.` : ''}` });
  } else if (action.type === 'read' || action.type === 'write') {
    const process = running(action.pid), page = action.page ?? 2, write = action.type === 'write';
    const region = regionForPage(process, page);
    if (!region) throw Error(`Page ${page} is not mapped by PID ${action.pid}`);
    if (write && !region.writable) throw Error(`Region ${region.name} is read-only`);
    const kib = world.pageSize / 1024;
    let oldId = process.pages[page] ?? null;
    if (oldId === null && region.kind === 'anonymous') {
      if (!write) {
        add({ kind: 'zero_page', pid: process.pid, description: `PID ${process.pid} reads untouched page ${page}. The kernel maps its shared zero page, which RSS does not count.` });
      } else {
        const newId = world.nextFrameId++;
        world.frames.push({ id: newId, region: region.name, kind: 'anonymous', owner: process.pid, revision: 1 });
        process.pages[page] = newId;
        if (page === 2) process.counter++;
        add({ kind: 'demand_zero', pid: process.pid, newFrameId: newId, description: `PID ${process.pid} writes untouched page ${page}. The kernel allocates a zeroed ${kib} KiB frame, so RSS grows.` });
      }
      return finish(world, add);
    }
    let fault: 'minor_fault' | 'major_fault' | null = null;
    if (oldId === null) {
      // A file page outside this process's page table: map the page-cache frame, reading it from disk if absent.
      const fileKey = pageCacheKey(region, page);
      let cached = world.frames.find(item => item.fileKey === fileKey);
      fault = cached ? 'minor_fault' : 'major_fault';
      if (!cached) {
        cached = { id: world.nextFrameId++, region: region.name, kind: 'file', owner: null, revision: 0, fileKey };
        world.frames.push(cached);
      }
      oldId = cached.id;
      process.pages[page] = oldId;
    }
    const frame = world.frames.find(item => item.id === oldId);
    if (!frame) throw Error(`Missing frame ${oldId}`);
    const count = sharers(world, oldId);
    const faultNote = fault === 'minor_fault' ? ' It was already in the page cache, so a minor fault maps it.' : fault === 'major_fault' ? ' A major fault reads it from disk into the page cache.' : '';
    if (!write) {
      add({ kind: fault ?? 'read', pid: process.pid, frameId: oldId, description: fault
        ? `PID ${process.pid} touches file page ${page}.${faultNote} RSS grows${fault === 'minor_fault' ? '; physical memory does not' : ''}.`
        : `PID ${process.pid} reads virtual page ${page}; its mapping and frame are unchanged.` });
    } else if (region.sharing === 'private' && (frame.kind === 'file' || count > 1)) {
      const newId = world.nextFrameId++;
      world.frames.push({ id: newId, region: region.name, kind: 'anonymous', owner: process.pid, revision: frame.revision + 1 });
      process.pages[page] = newId;
      if (page === 2) process.counter++;
      releaseUnused(world);
      add({ kind: 'cow_fault', pid: process.pid, frameId: oldId, newFrameId: newId,
        description: `PID ${process.pid} writes 8 bytes to page ${page} of a private mapping.${faultNote} ${count > 1 ? `${count} mappings share its frame` : 'Its frame belongs to the page cache'}, so the kernel copies one ${kib} KiB page${fault ? '' : '; RSS is unchanged'}.` });
    } else {
      if (page === 2) process.counter++;
      frame.revision++;
      add({ kind: 'write', pid: process.pid, frameId: oldId,
        description: region.sharing === 'shared' ? `PID ${process.pid} writes page ${page} of a shared mapping.${faultNote} ${count > 1 ? 'Every other mapping of it sees the change.' : 'No other mapping has the page.'}` : `PID ${process.pid} writes exclusive page ${page}; its frame is reused.` });
    }
  } else if (action.type === 'mmap') {
    const process = running(action.pid);
    if (!Number.isSafeInteger(action.pageCount) || action.pageCount < 1 || action.pageCount > 4096) throw Error('pageCount must be 1–4096');
    if (action.kind === 'file' && !action.fileKey) throw Error('File mapping needs a fileKey');
    const startPage = process.nextPage, id = `region-${world.nextRegionId++}`;
    process.nextPage += action.pageCount;
    const region: RegionState = { id, name: action.name, startPage, pageCount: action.pageCount,
      kind: action.kind, sharing: action.sharing, writable: action.writable ?? true,
      ...(action.kind === 'file' ? { fileKey: action.fileKey } : {}) };
    process.regions.push(region);
    for (let offset = 0; offset < action.pageCount; offset++) process.pages[startPage + offset] = null;
    add({ kind: 'mmap', pid: process.pid, description: `PID ${process.pid} maps ${action.pageCount} ${action.kind} page${action.pageCount === 1 ? '' : 's'} as ${action.name}. Nothing is resident until a page is touched.` });
  } else if (action.type === 'munmap') {
    const process = running(action.pid), region = process.regions.find(r => r.id === action.regionId);
    if (!region) throw Error(`Region ${action.regionId} is not mapped by PID ${process.pid}`);
    for (let page = region.startPage; page < region.startPage + region.pageCount; page++) process.pages[page] = null;
    process.regions = process.regions.filter(r => r.id !== region.id);
    releaseUnused(world);
    add({ kind: 'munmap', pid: process.pid, description: `PID ${process.pid} unmaps ${region.name}; unreferenced frames are released.` });
  } else if (action.type === 'open_file') {
    const process = running(action.pid), objectId = `file-${world.nextObjectId++}`;
    const fd = Math.max(2, ...process.descriptors.map(item => item.fd)) + 1;
    world.kernelObjects.push({ id: objectId, kind: 'file', offset: 0 });
    process.descriptors.push({ fd, objectId });
    add({ kind: 'open', pid: process.pid, description: `PID ${process.pid} opens ${action.name} on fd ${fd}; the open-file object starts at offset 0.` });
  } else if (action.type === 'read_file') {
    const process = running(action.pid), descriptor = process.descriptors.find(fd => fd.fd === action.fd);
    if (!descriptor) throw Error(`FD ${action.fd} is not open in PID ${process.pid}`);
    const object = world.kernelObjects.find(item => item.id === descriptor.objectId);
    if (!object || object.kind !== 'file') throw Error(`FD ${action.fd} is not a file`);
    if (!Number.isSafeInteger(action.bytes) || action.bytes < 0) throw Error('Read size must be a non-negative integer');
    const before = object.offset, holders = objectRefCount(world, object.id); object.offset += action.bytes;
    add({ kind: 'file_read', pid: process.pid, description: `PID ${process.pid} reads ${action.bytes} bytes on fd ${action.fd}; the file offset${holders > 1 ? `, shared by ${holders} descriptors,` : ''} moves from ${before} to ${object.offset}.` });
  } else if (action.type === 'close_fd') {
    const process = running(action.pid), descriptor = process.descriptors.find(fd => fd.fd === action.fd);
    if (!descriptor) throw Error(`FD ${action.fd} is not open in PID ${process.pid}`);
    process.descriptors = process.descriptors.filter(fd => fd !== descriptor);
    releaseUnused(world);
    const remaining = objectRefCount(world, descriptor.objectId);
    add({ kind: 'close', pid: process.pid, description: `PID ${process.pid} closes fd ${action.fd}. ${remaining ? `${remaining} other descriptor${remaining === 1 ? ' still refers' : 's still refer'} to the same object.` : 'It was the last descriptor for the object, so the kernel releases it.'}` });
  } else if (action.type === 'spawn_thread') {
    const process = running(action.pid), tid = world.nextTid++;
    process.threadIds.push(tid);
    add({ kind: 'thread', pid: process.pid, description: `PID ${process.pid} starts thread ${tid}.` });
  } else if (action.type === 'lock' || action.type === 'unlock') {
    const process = running(action.pid);
    if (!process.threadIds.includes(action.tid)) throw Error(`Thread ${action.tid} is not in PID ${process.pid}`);
    let lock = process.locks.find(item => item.id === action.lockId);
    if (!lock) { lock = { id: action.lockId, ownerTid: null }; process.locks.push(lock); }
    if (action.type === 'lock') {
      if (lock.ownerTid !== null) throw Error(`Lock ${lock.id} is already held`);
      lock.ownerTid = action.tid;
    } else {
      if (lock.ownerTid !== action.tid) throw Error(`Thread ${action.tid} does not own lock ${lock.id}`);
      lock.ownerTid = null;
    }
    add({ kind: action.type, pid: process.pid, description: `Thread ${action.tid} ${action.type === 'lock' ? 'takes' : 'releases'} lock ${action.lockId}.` });
  } else if (action.type === 'set_limit') {
    if (action.bytes !== null && (!Number.isSafeInteger(action.bytes) || action.bytes < 0)) throw Error('Limit must be a non-negative integer or null');
    world.limitBytes = action.bytes;
    add({ kind: 'limit', pid: 0, description: action.bytes === null ? 'Model memory limit removed.' : `Model memory limit set to ${action.bytes} bytes, including page tables.` });
  } else if (action.type === 'exit') {
    const process = running(action.pid);
    stopProcess(world, process);
    add({ kind: 'exit', pid: process.pid, description: `PID ${process.pid} exits. Its mappings and descriptors are released; a zombie waits to be reaped.` });
  } else {
    const process = world.processes.find(p => p.pid === action.pid);
    if (!process || process.status !== 'zombie') throw Error(`PID ${action.pid} is not a zombie`);
    world.processes = world.processes.filter(p => p.pid !== action.pid);
    add({ kind: 'reap', pid: action.pid, description: `The parent calls waitpid() and reaps PID ${action.pid}.` });
  }
  return finish(world, add);
}

function finish(world: WorldState, add: (event: Omit<WorldEvent, 'source' | 'step'>) => void): WorldState {
  while (world.limitBytes !== null && chargedBytes(world) > world.limitBytes) {
    const victim = world.processes.filter(p => p.status === 'running').sort((a, b) => residentPages(b) - residentPages(a) || b.pid - a.pid)[0];
    if (!victim) throw Error('Memory limit cannot be satisfied');
    stopProcess(world, victim);
    add({ kind: 'oom_kill', pid: victim.pid, description: `Model memory limit exceeded. PID ${victim.pid}, with the most resident pages, is selected as the OOM victim.` });
  }
  return world;
}

/** Per-process accounting over resident pages. Mapped counts every page in the process's regions, resident or not. */
export function memoryRows(world: WorldState) {
  const fileFrames = new Set(world.frames.filter(frame => frame.kind === 'file').map(frame => frame.id));
  return world.processes.map(p => ({ pid: p.pid, role: p.role, status: p.status,
    mapped: mappedPages(p) * world.pageSize,
    rss: residentPages(p) * world.pageSize,
    rssFile: p.pages.filter(id => id !== null && fileFrames.has(id)).length * world.pageSize,
    pss: p.pages.reduce<number>((sum, id) => sum + (id === null ? 0 : world.pageSize / sharers(world, id)), 0),
    uss: p.pages.filter(id => id !== null && sharers(world, id) === 1).length * world.pageSize,
  }));
}
/** A process's resident bytes split by how many processes map each frame. RSS counts every group in full; PSS divides each by its sharers. */
export function pssBreakdown(world: WorldState, process: ProcessState) {
  const bySharers = new Map<number, number>();
  for (const id of process.pages) if (id !== null) {
    const count = sharers(world, id);
    bySharers.set(count, (bySharers.get(count) ?? 0) + world.pageSize);
  }
  return { exclusive: bySharers.get(1) ?? 0,
    shared: [...bySharers].filter(([count]) => count > 1).sort(([a], [b]) => a - b).map(([count, bytes]) => ({ sharers: count, bytes })) };
}
export function assertInvariants(world: WorldState) {
  const ids = new Set<number>();
  const processIds = new Set<number>();
  const objectIds = new Set<string>();
  for (const object of world.kernelObjects) {
    if (objectIds.has(object.id)) throw Error(`Duplicate kernel object ${object.id}`);
    objectIds.add(object.id);
  }
  for (const frame of world.frames) {
    if (ids.has(frame.id)) throw Error(`Duplicate frame ${frame.id}`);
    ids.add(frame.id);
    if (sharers(world, frame.id) < 1) throw Error(`Unreferenced frame ${frame.id}`);
  }
  for (const process of world.processes) {
    if (processIds.has(process.pid)) throw Error(`Duplicate PID ${process.pid}`);
    processIds.add(process.pid);
    if (process.status === 'zombie' && (process.pages.length || process.regions.length || process.descriptors.length || process.threadIds.length || process.locks.length)) throw Error(`Zombie ${process.pid} holds resources`);
    if (process.status === 'running' && !process.threadIds.length) throw Error(`Running PID ${process.pid} has no thread`);
    if (new Set(process.threadIds).size !== process.threadIds.length) throw Error(`PID ${process.pid} has duplicate threads`);
    if (new Set(process.descriptors.map(fd => fd.fd)).size !== process.descriptors.length) throw Error(`PID ${process.pid} has duplicate descriptors`);
    if (new Set(process.locks.map(lock => lock.id)).size !== process.locks.length) throw Error(`PID ${process.pid} has duplicate locks`);
    for (const [page, id] of process.pages.entries()) {
      if (id === null) continue;
      if (!ids.has(id)) throw Error(`PID ${process.pid} maps missing frame ${id}`);
      if (!regionForPage(process, page)) throw Error(`PID ${process.pid} page ${page} has no region`);
    }
    for (const descriptor of process.descriptors) if (!world.kernelObjects.some(object => object.id === descriptor.objectId)) throw Error(`FD ${descriptor.fd} has no object`);
  }
  for (const object of world.kernelObjects) if (objectRefCount(world, object.id) < 1) throw Error(`Unreferenced kernel object ${object.id}`);
  const pss = memoryRows(world).reduce((sum, row) => sum + row.pss, 0);
  if (Math.abs(pss - physicalBytes(world)) > 0.001) throw Error('PSS mismatch');
  if (world.limitBytes !== null && chargedBytes(world) > world.limitBytes) throw Error('Memory limit exceeded');
}
