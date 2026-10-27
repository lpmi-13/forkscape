export type Source = 'model' | 'recorded' | 'inferred';
export type EventKind = 'start' | 'fork' | 'cow_fault' | 'write' | 'exit' | 'reap';
export interface ProcessState { pid: number; parentPid: number | null; role: 'master' | 'worker'; status: 'running' | 'zombie'; pages: number[]; descriptorIds: string[]; threads: number; counter: number }
export interface FrameState { id: number; region: string; owner: number | null }
export interface WorldEvent { kind: EventKind; source: Source; step: number; pid: number; frameId?: number; newFrameId?: number; description: string; terminal: string }
export interface WorldState { source: Source; pageSize: number; processes: ProcessState[]; frames: FrameState[]; events: WorldEvent[]; nextPid: number; nextFrameId: number; step: number }
export type Action = { type: 'fork'; parentPid: number } | { type: 'write' | 'exit' | 'reap'; pid: number; page?: number };

export function initialWorld(): WorldState {
  return {
    source: 'model', pageSize: 4096, nextPid: 4101, nextFrameId: 6, step: 0,
    processes: [{ pid: 4100, parentPid: null, role: 'master', status: 'running', pages: [0, 1, 2, 3, 4, 5], descriptorIds: ['listen:8000'], threads: 1, counter: 0 }],
    frames: ['code', 'libraries', 'heap', 'heap', 'heap', 'stack'].map((region, id) => ({ id, region, owner: null })),
    events: [{ kind: 'start', source: 'model', step: 0, pid: 4100, description: 'The master has six mapped pages and a listening socket.', terminal: '$ ps -o pid,ppid,rss,cmd --forest\n  PID  PPID   RSS CMD\n 4100     1    24K gunicorn: master' }],
  };
}

export function sharers(world: WorldState, frameId: number): number {
  return world.processes.reduce((count, process) => count + process.pages.filter(id => id === frameId).length, 0);
}

export function applyAction(previous: WorldState, action: Action): WorldState {
  const world: WorldState = { ...previous, step: previous.step + 1, processes: previous.processes.map(p => ({ ...p, pages: [...p.pages], descriptorIds: [...p.descriptorIds] })), frames: previous.frames.map(f => ({ ...f })), events: [...previous.events] };
  const add = (event: Omit<WorldEvent, 'source' | 'step'>) => world.events.push({ ...event, source: 'model', step: world.step });
  const running = (pid: number) => { const p = world.processes.find(item => item.pid === pid && item.status === 'running'); if (!p) throw Error(`PID ${pid} is not running`); return p; };
  if (action.type === 'fork') {
    const parent = running(action.parentPid), pid = world.nextPid++;
    world.processes.push({ ...parent, pid, parentPid: parent.pid, role: 'worker', pages: [...parent.pages], descriptorIds: [...parent.descriptorIds], threads: 1 });
    add({ kind: 'fork', pid, description: `PID ${pid} forks from ${parent.pid}. Both page tables point to the same physical frames.`, terminal: `$ ps -o pid,ppid,rss,cmd --forest\n  PID  PPID   RSS CMD\n ${parent.pid}     1    24K gunicorn: master\n ${pid}  ${parent.pid}    24K  \\_ gunicorn: worker\n# parent fork() → ${pid}; child fork() → 0` });
  } else if (action.type === 'write') {
    const process = running(action.pid), page = action.page ?? 2, oldId = process.pages[page];
    if (oldId === undefined) throw Error(`Page ${page} is not mapped by PID ${action.pid}`);
    if (sharers(world, oldId) > 1) {
      const oldFrame = world.frames.find(f => f.id === oldId);
      if (!oldFrame) throw Error(`Missing frame ${oldId}`);
      const newId = world.nextFrameId++;
      world.frames.push({ id: newId, region: oldFrame.region, owner: process.pid });
      process.pages[page] = newId;
      if (page === 2) process.counter++;
      add({ kind: 'cow_fault', pid: process.pid, frameId: oldId, newFrameId: newId, description: `PID ${process.pid} writes 8 bytes. One shared 4 KiB page is copied.`, terminal: `$ cat /proc/${process.pid}/smaps_rollup\nPrivate_Dirty:        4 kB\n# modeled minor fault; new frame ${newId}` });
    } else {
      if (page === 2) process.counter++;
      add({ kind: 'write', pid: process.pid, frameId: oldId, description: `PID ${process.pid} writes an exclusive page. Its frame is reused.`, terminal: `$ cat /proc/${process.pid}/smaps_rollup\nPrivate_Dirty:        4 kB\n# modeled: no new frame` });
    }
  } else if (action.type === 'exit') {
    const process = running(action.pid); process.status = 'zombie'; process.pages = [];
    world.frames = world.frames.filter(frame => sharers(world, frame.id) > 0);
    add({ kind: 'exit', pid: process.pid, description: `PID ${process.pid} exits. Its mappings are released; a zombie waits to be reaped.`, terminal: `$ ps -o pid,ppid,stat,cmd\n ${process.pid}  ${process.parentPid} Z    [gunicorn] <defunct>` });
  } else {
    const process = world.processes.find(p => p.pid === action.pid);
    if (!process || process.status !== 'zombie') throw Error(`PID ${action.pid} is not a zombie`);
    world.processes = world.processes.filter(p => p.pid !== action.pid);
    add({ kind: 'reap', pid: action.pid, description: `The master calls waitpid() and reaps PID ${action.pid}.`, terminal: `$ ps -o pid,ppid,stat,cmd\n# PID ${action.pid} no longer appears` });
  }
  return world;
}

export function memoryRows(world: WorldState) {
  return world.processes.map(p => ({ pid: p.pid, role: p.role, status: p.status,
    rss: p.pages.length * world.pageSize,
    pss: p.pages.reduce((sum, id) => sum + world.pageSize / sharers(world, id), 0),
    uss: p.pages.filter(id => sharers(world, id) === 1).length * world.pageSize,
  }));
}
export function physicalBytes(world: WorldState) { return world.frames.length * world.pageSize; }
export function assertInvariants(world: WorldState) {
  for (const frame of world.frames) if (sharers(world, frame.id) < 1) throw Error(`Unreferenced frame ${frame.id}`);
  for (const process of world.processes) for (const id of process.pages) if (!world.frames.some(f => f.id === id)) throw Error(`PID ${process.pid} maps missing frame ${id}`);
  const pss = memoryRows(world).reduce((sum, row) => sum + row.pss, 0);
  if (Math.abs(pss - physicalBytes(world)) > 0.001) throw Error('PSS mismatch');
}

export const guidedActions: Action[] = [
  { type: 'fork', parentPid: 4100 }, { type: 'write', pid: 4101, page: 2 },
  { type: 'write', pid: 4100, page: 3 }, { type: 'fork', parentPid: 4100 },
  { type: 'write', pid: 4102, page: 2 }, { type: 'exit', pid: 4101 }, { type: 'reap', pid: 4101 },
];
export function guidedHistory(): WorldState[] {
  const states = [initialWorld()];
  for (const action of guidedActions) { const next = applyAction(states.at(-1)!, action); assertInvariants(next); states.push(next); }
  return states;
}
