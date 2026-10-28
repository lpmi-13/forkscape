import './style.css';
import './theme.css';
import { applyAction, assertInvariants, chargedBytes, guidedHistory, initialWorld, memoryRows, pageTableBytes, physicalBytes, regionForPage, sharers, objectRefCount, type Action, type WorldState } from './model';
import type { ForkScene } from './scene';

type ModuleId = 1 | 2 | 3 | 4;
const lessons: Record<ModuleId, { title: string; kicker: string; body: string; question: string; choices: string[]; correct: number; answer: string; onCall: string; evidence: string; focus: number }> = {
  1: { title: 'A process is more than code', kicker: '01 / PROCESS ANATOMY', body: 'A process has its own PID, address space, descriptor table, and threads. A descriptor points to an object held by the kernel. Select a deck to inspect its mappings.', question: 'Which item is the kernel object shared through a file descriptor?', choices: ['The process PID', 'The listening socket', 'The process address space'], correct: 1, answer: 'The socket lives in the kernel. The process holds a descriptor that refers to it.', onCall: 'Find the process tree with ps, memory regions in maps, descriptors in fd, and threads in task.', evidence: 'ps -o pid,ppid,rss,cmd --forest · /proc/<pid>/{maps,fd,task}', focus: 0 },
  2: { title: 'One call, two returns', kicker: '02 / FORK', body: 'The parent and child resume at the same line after fork(). The parent receives the child PID; the child receives zero. Their descriptor tables refer to the same socket.', question: 'How many times does the print after fork() run?', choices: ['Once', 'Twice', 'It depends on memory size'], correct: 1, answer: 'Both processes continue from the fork() call, so each reaches print().', onCall: 'A supervising master must reap exited children or zombies remain in the process table.', evidence: 'ps -o pid,ppid,stat,cmd --forest · waitpid()', focus: 1 },
  3: { title: 'Addresses are names', kicker: '03 / VIRTUAL MEMORY', body: 'Each deck tile is one virtual page. Its filament points through a page table to a physical frame below. The same virtual page index can later point to different frames.', question: 'Parent and child print the same address for an object. Does that prove they still share a physical frame?', choices: ['Yes', 'No', 'Only if their PIDs match'], correct: 1, answer: 'An address is meaningful inside one process. Page-table mappings decide which physical frame it reaches.', onCall: 'An identical Python id() value in two workers is not proof of shared physical memory.', evidence: '/proc/<pid>/maps · /proc/<pid>/pagemap (privilege dependent)', focus: 1 },
  4: { title: 'Copy on write', kicker: '04 / PAGE FAULT', body: 'At fork, the data pages stay shared. A first write to a shared page faults, copies the whole page, and changes only the writer’s mapping. Any process can be the writer.', question: 'A child changes one 8-byte value on a shared 4 KiB page. How many bytes are copied?', choices: ['8 bytes', '4,096 bytes', 'The entire process'], correct: 1, answer: 'The kernel copies one page: 4 KiB in this model. Later writes to that exclusive page reuse its frame.', onCall: 'Scattered small writes can grow Private_Dirty quickly; in-process changes never reach sibling workers.', evidence: '/proc/<pid>/smaps_rollup: Private_Dirty · minor faults in /proc/<pid>/stat', focus: 2 },
};

const history: WorldState[] = [initialWorld()];
const root = document.querySelector<HTMLDivElement>('#app')!;
const saved = (() => { try { return JSON.parse(localStorage.getItem('forkscape-progress') || '{}') as Record<number, number>; } catch { return {}; } })();
let answers: Record<number, number> = saved;
const observedModules: Record<number, boolean> = {};
let moduleId: ModuleId = 1;
let step = 0;
let selectedPid = 4100;
let selectedFrame: number | null = null;
let selectedObjectId: string | null = null;
let selectedPage: { pid: number; page: number } | null = null;
let actionError = '';
let flat = localStorage.getItem('forkscape-flat') === 'true';
let scene: ForkScene | null = null;
let sceneLoading = false;

const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const kb = (bytes: number) => `${Number.isInteger(bytes / 1024) ? bytes / 1024 : (bytes / 1024).toFixed(1)} KiB`;
const world = () => history[step];

root.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true">✦</span><span>FORKSCAPE</span><span class="brand-sub">A PROCESS MEMORY LAB</span></div>
    <div class="top-actions"><span class="badge">MODEL</span><button id="view-toggle" class="subtle" type="button"></button><button id="export-progress" class="subtle" type="button" title="Export your answers as JSON">Export progress</button></div>
  </header>
  <main class="workspace">
    <aside class="lesson-rail">
      <div class="rail-heading"><span>GUIDED LAB</span><span>01—04</span></div>
      <nav id="module-nav" aria-label="Modules"></nav>
      <section id="lesson-content" aria-live="polite"></section>
    </aside>
    <section class="scene-column" aria-label="Process and memory visualization">
      <div class="scene-toolbar"><div><span class="toolbar-dot"></span> LIVE MODEL STATE <span class="toolbar-separator">/</span> <span id="scene-heading"></span></div><div class="camera-controls" aria-label="3D camera controls"><button type="button" data-camera="overview">Overview</button><button type="button" data-camera="process">Decks</button><button type="button" data-camera="memory">Frames</button><button type="button" data-zoom="in" aria-label="Zoom in">＋</button><button type="button" data-zoom="out" aria-label="Zoom out">−</button></div></div>
      <div id="scene-host" class="scene-host"></div>
      <div id="flat-host" class="flat-host" hidden></div>
      <div class="scene-footer"><span>1 tile = 1 page = 4 KiB</span><span><i class="legend-swatch shared"></i> shared <i class="legend-swatch private"></i> exclusive</span><span>Physical layout is schematic</span></div>
    </section>
    <aside id="inspector" class="inspector"></aside>
    <section class="timeline-panel">
      <div class="panel-heading"><span>EVENT TIMELINE</span><span id="event-count"></span></div>
      <div class="timeline-controls"><button id="prev-step" type="button" aria-label="Previous event">◀</button><button id="next-step" type="button" aria-label="Next event">▶</button><input id="time-range" type="range" min="0" max="0" value="0" aria-label="Timeline event" /><span id="step-label"></span></div>
      <div id="event-strip" class="event-strip"></div>
    </section>
    <section class="ledger-panel"><div class="panel-heading"><span>MEMORY LEDGER</span><span>MODEL · PAGE TABLES INCLUDED IN CHARGE</span></div><div id="ledger"></div></section>
    <section class="terminal-panel"><div class="panel-heading"><span>TERMINAL REPLAY</span><span>ILLUSTRATIVE · MODEL</span></div><pre id="terminal"></pre></section>
    <section class="code-panel"><div class="panel-heading"><span>CODE CONTEXT</span><span>PYTHON</span></div><pre id="code"></pre></section>
  </main>
  <div id="narration" class="sr-only" aria-live="polite"></div>
`;

const host = root.querySelector<HTMLElement>('#scene-host')!;
async function ensureScene() {
  if (scene || flat || sceneLoading) return;
  sceneLoading = true;
  try {
    const { ForkScene } = await import('./scene');
    if (flat) return;
    scene = new ForkScene(host);
    scene.setWorld(world(), selectedPid, selectedPage, selectedFrame, selectedObjectId, selection => { selectVisual(selection); });
  } catch { flat = true; render(); }
  finally { sceneLoading = false; }
}

function renderNav() {
  root.querySelector('#module-nav')!.innerHTML = ([1, 2, 3, 4] as ModuleId[]).map(id => `<button class="module-link ${moduleId === id ? 'active' : ''}" type="button" data-module="${id}"><span class="module-number">0${id}</span><span>${escapeHtml(lessons[id].title)}</span><span class="module-check">${answers[id] !== undefined ? '✓' : '↗'}</span></button>`).join('');
}

function renderLesson() {
  const lesson = lessons[moduleId];
  const answered = answers[moduleId] !== undefined;
  const state = world();
  const process = state.processes.find(p => p.pid === selectedPid);
  const active = process?.status === 'running';
  const zombie = process?.status === 'zombie';
  const worker = process?.role === 'worker';
  const openFile = process?.descriptors.find(fd => state.kernelObjects.some(o => o.id === fd.objectId && o.kind === 'file'));
  const heldLock = process?.locks.find(lock => lock.ownerTid !== null && process.threadIds.includes(lock.ownerTid));
  const button = (label: string, action: string, enabled = true) => `<button type="button" data-lab="${action}" ${enabled && answered ? '' : 'disabled'}>${label}</button>`;
  const actions = moduleId === 1
    ? button('Inspect heap page', 'inspect', !!active && process?.pages[2] != null) + button('Open sample file', 'open', !!active) + button('Read 16 bytes', 'file-read', !!active && !!openFile) + button('Close sample file', 'file-close', !!active && !!openFile)
    : moduleId === 2
      ? button('Fork master', 'fork', state.processes[0]?.status === 'running') + button('Exit selected worker', 'exit', !!worker && !!active) + button('Reap selected zombie', 'reap', !!worker && !!zombie)
      : moduleId === 3
        ? button('Fork master', 'fork', state.processes[0]?.status === 'running') + button('Follow heap page', 'inspect', !!active && process?.pages[2] != null) + button('Write selected page', 'write', !!active)
        : button('Fork master', 'fork', state.processes[0]?.status === 'running') + button('Increment selected counter', 'counter', !!active) + button('Write master page', 'master-write', state.processes[0]?.status === 'running') + button('Exit selected worker', 'exit', !!worker && !!active) + button('Reap selected zombie', 'reap', !!worker && !!zombie);
  root.querySelector('#lesson-content')!.innerHTML = `
    <div class="lesson-kicker">${lesson.kicker}</div><h1>${escapeHtml(lesson.title)}</h1><p class="lesson-body">${escapeHtml(lesson.body)}</p>
    <div class="prediction"><div class="section-tag">PREDICT</div><p class="question">${escapeHtml(lesson.question)}</p><form id="prediction-form">${lesson.choices.map((choice, index) => `<label class="choice ${answered && answers[moduleId] === index ? 'chosen' : ''}"><input name="prediction" type="radio" value="${index}" ${answered && answers[moduleId] === index ? 'checked' : ''} ${answered ? 'disabled' : ''}/><span>${escapeHtml(choice)}</span></label>`).join('')}${answered ? '' : '<button class="primary" type="submit">Commit prediction →</button>'}</form>${answered && observedModules[moduleId] ? `<div class="answer ${answers[moduleId] === lesson.correct ? 'correct' : 'review'}"><strong>${answers[moduleId] === lesson.correct ? 'Correct prediction' : 'Compare your prediction'}</strong><p>${escapeHtml(lesson.answer)}</p></div>` : ''}</div>
    <div class="lesson-stage"><div class="section-tag">ACT</div><p>Choose a process or page, then change the model. Each action adds a state to the timeline.</p><div class="lab-actions">${actions}</div><button id="show-event" class="event-button" type="button" ${answered ? '' : 'disabled'}>Load guided example</button><button id="reset-model" class="subtle" type="button">Reset model</button><p id="action-error" class="action-error" role="alert">${escapeHtml(actionError)}</p></div>
    <details class="model-tools"><summary>More model controls</summary><div class="lab-actions">${button('Map anonymous page', 'map-anon', !!active)}${button('Map shared file', 'map-file', !!active)}${button('Unmap latest region', 'unmap', !!active && !!process?.regions.some(r => r.id.startsWith('region-')))}${button('Start thread', 'thread', !!active)}${button('Lock with newest thread', 'lock', !!active && (process?.threadIds.length ?? 0) > 1)}${button('Unlock', 'unlock', !!active && !!heldLock)}${button('Set limit to current use', 'limit')}${button('Remove limit', 'unlimit')}</div></details>
    <div class="lesson-stage"><div class="section-tag">OBSERVE</div><p>${escapeHtml(state.events.at(-1)!.description)}</p><p>Selected PID: ${selectedPid} · physical frames: ${state.frames.length} · counters: ${state.processes.map(p => `${p.pid}=${p.counter}`).join(', ')}</p></div>
    <div class="lesson-stage"><div class="section-tag">EXPLAIN</div><p>${observedModules[moduleId] ? escapeHtml(lesson.answer) : 'Commit a prediction, then use the model controls to reveal the explanation.'}</p></div>
    ${observedModules[moduleId] ? `<div class="on-call"><div class="section-tag">CONNECT · ON CALL</div><p>${escapeHtml(lesson.onCall)}</p><code>${escapeHtml(lesson.evidence)}</code></div>` : ''}
  `;
}

function renderFlat(state: WorldState) {
  root.querySelector('#flat-host')!.innerHTML = `<div class="flat-title">PROCESS ADDRESS SPACES</div><div class="flat-processes">${state.processes.map(process => `<div class="flat-process ${selectedPid === process.pid && selectedPage === null ? 'selected' : ''}"><button type="button" data-pid="${process.pid}"><strong>${process.role.toUpperCase()} · PID ${process.pid}</strong><span>${process.status === 'zombie' ? 'ZOMBIE · mappings released' : `PPID ${process.parentPid ?? '—'} · ${process.pages.filter(id => id !== null).length} pages · ${process.threadIds.length} thread(s)`}</span></button><div class="page-strip">${process.pages.map((id, index) => id === null ? '' : `<button type="button" data-page="${index}" data-page-pid="${process.pid}" aria-label="PID ${process.pid} virtual page ${index}, frame ${id}" class="page-chip ${sharers(state, id) > 1 ? 'is-shared' : ''} ${selectedPage?.pid === process.pid && selectedPage.page === index ? 'selected' : ''}">${index}→F${id}<small>${escapeHtml(regionForPage(process, index)?.name ?? '')}</small></button>`).join('')}</div></div>`).join('')}</div><div class="flat-title">PHYSICAL FRAMES</div><div class="flat-frames">${state.frames.map(frame => `<button type="button" data-frame="${frame.id}" class="flat-frame ${selectedFrame === frame.id ? 'selected' : ''}"><strong>F${frame.id}</strong><span>${escapeHtml(frame.region)}</span><small>${sharers(state, frame.id)} ${sharers(state, frame.id) === 1 ? 'mapping' : 'mappings'}</small></button>`).join('')}</div><div class="flat-title">KERNEL OBJECTS</div><div class="flat-frames">${state.kernelObjects.map(object => `<button type="button" data-object="${escapeHtml(object.id)}" class="flat-frame ${selectedObjectId === object.id ? 'selected' : ''}"><strong>${escapeHtml(object.kind)}</strong><span>${escapeHtml(object.id)}</span><small>${objectRefCount(state, object.id)} descriptor(s)${object.kind === 'file' ? ` · offset ${object.offset}` : ''}</small></button>`).join('')}</div><p class="flat-note">Select a page to trace its mapping. Shared frames have multiple mappings; descriptors can refer to one kernel object.</p>`;
}

function renderInspector(state: WorldState) {
  const frame = selectedFrame === null ? null : state.frames.find(f => f.id === selectedFrame);
  const process = state.processes.find(p => p.pid === selectedPid) || state.processes[0];
  const page = selectedPage?.pid === process?.pid ? selectedPage.page : null;
  const pageFrameId = page === null ? null : process?.pages[page];
  const pageFrame = pageFrameId === null || pageFrameId === undefined ? null : state.frames.find(item => item.id === pageFrameId);
  const region = page === null ? null : regionForPage(process, page);
  const frameMappings = frame ? state.processes.flatMap(p => p.pages.flatMap((id, index) => id === frame.id ? [`PID ${p.pid} page ${index}`] : [])) : [];
  const object = selectedObjectId === null ? null : state.kernelObjects.find(item => item.id === selectedObjectId);
  const objectDescriptors = object ? state.processes.flatMap(p => p.descriptors.filter(fd => fd.objectId === object.id).map(fd => `PID ${p.pid} fd ${fd.fd}`)) : [];
  const body = object
    ? `<h2>${escapeHtml(object.kind)} <em>${escapeHtml(object.id)}</em></h2><p>${objectRefCount(state, object.id)} descriptor(s) point here</p><div class="inspector-rung"><span>METAPHOR</span><p>A buoy in the kernel layer with cables from process decks.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>${objectDescriptors.join(' · ')}. ${object.kind === 'file' ? `Shared file offset: ${object.offset} bytes.` : 'One listening socket is shared.'}</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>/proc/&lt;pid&gt;/fd · ss -lnp</code><small>Object identity and offset shown here are modeled.</small></div>`
    : frame
    ? `<h2>Frame F${frame.id}</h2><p>${escapeHtml(frame.region)} · ${frame.kind} · ${sharers(state, frame.id)} mapping(s)</p><div class="inspector-rung"><span>METAPHOR</span><p>A tile on the memory floor.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>${frameMappings.join(' · ')}. Model write revision: ${frame.revision}. ${frame.fileKey ? `File cache key: ${escapeHtml(frame.fileKey)}.` : 'Anonymous data frame.'}</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>/proc/&lt;pid&gt;/pagemap · /proc/kpagecount</code><small>Exact frame identity often needs privilege. This frame ID is modeled.</small></div>`
    : page !== null && pageFrame && region
      ? `<h2>Virtual page <em>${page}</em></h2><p>PID ${process.pid} → frame F${pageFrame.id}</p><div class="inspector-rung"><span>METAPHOR</span><p>A tile on PID ${process.pid}'s deck; its filament points to the floor.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>${escapeHtml(region.name)} · ${region.kind} · ${region.sharing} · ${region.writable ? 'writable' : 'read-only'}. ${sharers(state, pageFrame.id)} mapping(s) reach this frame. Model write revision: ${pageFrame.revision}.</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>/proc/${process.pid}/maps · smaps_rollup</code><small>Virtual page to exact frame requires privileged pagemap access. This mapping is modeled.</small></div><button type="button" data-frame="${pageFrame.id}" class="subtle">Inspect frame F${pageFrame.id}</button>`
      : `<h2>${process.role === 'master' ? 'Master' : 'Worker'} <em>PID ${process.pid}</em></h2><p>${process.status === 'zombie' ? 'Exited · awaiting reaping' : `${process.pages.filter(id => id !== null).length} mapped pages · ${process.threadIds.length} thread(s)`}</p><div class="inspector-rung"><span>METAPHOR</span><p>A deck with page tiles and descriptor ports.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>Address space: ${process.regions.map(r => `${escapeHtml(r.name)} (${r.pageCount}p)`).join(', ') || 'released'}. Page tables: ${kb(process.status === 'running' ? state.pageSize * (1 + new Set(process.pages.flatMap((id, index) => id === null ? [] : [Math.floor(index / 512)])).size) : 0)}.</p><p>Descriptors: ${process.descriptors.map(fd => { const object = state.kernelObjects.find(o => o.id === fd.objectId)!; return `fd ${fd.fd} → ${escapeHtml(object.id)} (${object.kind}, ${objectRefCount(state, object.id)} refs${object.kind === 'file' ? `, offset ${object.offset}` : ''})`; }).join('; ') || 'none'}.</p><p>Threads: ${process.threadIds.join(', ') || 'none'}. Locks: ${process.locks.map(lock => `${escapeHtml(lock.id)} → ${lock.ownerTid ?? 'free'}${lock.ownerTid !== null && !process.threadIds.includes(lock.ownerTid) ? ' (owner absent after fork)' : ''}`).join('; ') || 'none'}.</p><p>Counter: ${process.counter} in this process.</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>ps · /proc/${process.pid}/maps · fd · task</code><small>All values shown here are model data.</small></div>`;
  root.querySelector('#inspector')!.innerHTML = `<div class="panel-heading"><span>INSPECTOR</span><span>MODEL</span></div><div class="inspector-content">${body}<button id="clear-selection" type="button" class="subtle" ${object || frame || page !== null ? '' : 'hidden'}>← Process</button></div>`;
}

function renderLedger(state: WorldState) {
  const rows = memoryRows(state);
  const totals = rows.reduce((sum, row) => ({ rss: sum.rss + row.rss, pss: sum.pss + row.pss, uss: sum.uss + row.uss }), { rss: 0, pss: 0, uss: 0 });
  root.querySelector('#ledger')!.innerHTML = `<div class="ledger-summary"><div><span>DATA FRAMES</span><strong>${kb(physicalBytes(state))}</strong></div><div><span>PAGE TABLES</span><strong>${kb(pageTableBytes(state))}</strong></div><div><span>MODEL CHARGE</span><strong>${kb(chargedBytes(state))}</strong></div></div><div class="ledger-meta">Σ RSS ${kb(totals.rss)} · Σ PSS ${kb(totals.pss)} · limit ${state.limitBytes === null ? 'none' : kb(state.limitBytes)}</div><table><thead><tr><th>PROCESS</th><th>RSS</th><th>PSS</th><th>USS</th></tr></thead><tbody>${rows.map(row => `<tr class="${selectedPid === row.pid ? 'selected' : ''}" data-pid="${row.pid}"><td>${row.role === 'master' ? 'M' : 'W'} ${row.pid}${row.status === 'zombie' ? ' †' : ''}</td><td>${kb(row.rss)}</td><td>${kb(row.pss)}</td><td>${kb(row.uss)}</td></tr>`).join('')}</tbody></table><p class="ledger-note">RSS, PSS, and USS count mapped data pages. Model charge adds simplified page tables; it excludes other kernel memory and retained page cache. Values are illustrative.</p>`;
}

function renderTimeline(state: WorldState) {
  const event = state.events.at(-1)!;
  const range = root.querySelector('#time-range') as HTMLInputElement;
  range.max = String(history.length - 1);
  range.value = String(step);
  (root.querySelector('#prev-step') as HTMLButtonElement).disabled = step === 0;
  (root.querySelector('#next-step') as HTMLButtonElement).disabled = step === history.length - 1;
  root.querySelector('#step-label')!.textContent = `${step + 1} / ${history.length}`;
  root.querySelector('#event-count')!.textContent = `${history.length} STATES`;
  root.querySelector('#event-strip')!.innerHTML = history.map((item, index) => `<button type="button" data-step="${index}" class="event-tick ${index === step ? 'active' : ''}" aria-label="Step ${index + 1}: ${escapeHtml(item.events.at(-1)!.kind)}"><span class="tick-icon">${({ start: '●', fork: '⑂', cow_fault: '✦', write: '✎', exit: '×', reap: '↻', oom_kill: '!', mmap: '+', munmap: '−' } as Record<string, string>)[item.events.at(-1)!.kind] ?? '•'}</span><span>${escapeHtml(item.events.at(-1)!.kind.replace('_', ' '))}</span></button>`).join('');
  root.querySelector('#terminal')!.textContent = event.terminal;
  root.querySelector('#narration')!.textContent = event.description;
  root.querySelector('#scene-heading')!.textContent = event.kind.replace('_', ' ').toUpperCase();
}

function renderCode() {
  root.querySelector('#code')!.textContent = moduleId === 2 ? `pid = os.fork()\nif pid == 0:\n    print('child: fork returned 0')\nelse:\n    print(f'parent: child is {pid}')` : moduleId === 4 ? `# Both processes begin with the same page mapping.\ncounter += 1  # 8-byte change, page-sized copy\n\n# Another process still sees its own value.` : `# Simplified process model\nmaster = Process(pid=4100)\nmaster.pages = [code, libs, heap, stack]\nmaster.fd[3] = listening_socket`;
}

function render() {
  const state = world();
  if (!state.processes.some(p => p.pid === selectedPid)) selectedPid = state.processes[0]?.pid ?? 4100;
  if (selectedFrame !== null && !state.frames.some(f => f.id === selectedFrame)) selectedFrame = null;
  if (selectedObjectId !== null && !state.kernelObjects.some(o => o.id === selectedObjectId)) selectedObjectId = null;
  if (selectedPage && !state.processes.some(p => p.pid === selectedPage!.pid && p.pages[selectedPage!.page] !== null && p.pages[selectedPage!.page] !== undefined)) selectedPage = null;
  renderNav(); renderLesson(); renderFlat(state); renderInspector(state); renderLedger(state); renderTimeline(state); renderCode();
  host.hidden = flat;
  (root.querySelector('#flat-host') as HTMLElement).hidden = !flat;
  root.querySelector('#view-toggle')!.textContent = flat ? '◈ 3D view' : '▦ Flat view';
  scene?.setWorld(state, selectedPid, selectedPage, selectedFrame, selectedObjectId, selection => { selectVisual(selection); });
  void ensureScene();
}

function selectVisual(selection: { kind: 'process'; pid: number } | { kind: 'page'; pid: number; page: number } | { kind: 'frame'; frameId: number } | { kind: 'object'; objectId: string }) {
  if (answers[moduleId] !== undefined && (moduleId === 1 || moduleId === 3) && selection.kind !== 'process') observedModules[moduleId] = true;
  selectedFrame = selection.kind === 'frame' ? selection.frameId : null;
  selectedObjectId = selection.kind === 'object' ? selection.objectId : null;
  if (selection.kind === 'process' || selection.kind === 'page') selectedPid = selection.pid;
  selectedPage = selection.kind === 'page' ? { pid: selection.pid, page: selection.page } : null;
  render();
}

function runAction(action: Action) {
  try {
    const next = applyAction(world(), action);
    assertInvariants(next);
    history.splice(step + 1, history.length - step - 1, next);
    step = history.length - 1;
    actionError = '';
    if (answers[moduleId] !== undefined && (moduleId !== 4 || action.type === 'write')) observedModules[moduleId] = true;
  } catch (error) { actionError = error instanceof Error ? error.message : String(error); }
  render();
}

root.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const camera = target.closest<HTMLElement>('[data-camera]');
  if (camera) { scene?.setCameraPreset(camera.dataset.camera as 'overview' | 'process' | 'memory'); return; }
  const zoom = target.closest<HTMLElement>('[data-zoom]');
  if (zoom) { scene?.setZoom(zoom.dataset.zoom === 'in'); return; }
  const moduleButton = target.closest<HTMLElement>('[data-module]');
  if (moduleButton) { moduleId = Number(moduleButton.dataset.module) as ModuleId; selectedFrame = null; selectedObjectId = null; selectedPage = null; render(); return; }
  const stepButton = target.closest<HTMLElement>('[data-step]');
  if (stepButton) { step = Number(stepButton.dataset.step); render(); return; }
  const pidButton = target.closest<HTMLElement>('[data-pid]');
  if (pidButton) { selectVisual({ kind: 'process', pid: Number(pidButton.dataset.pid) }); return; }
  const pageButton = target.closest<HTMLElement>('[data-page]');
  if (pageButton) { selectVisual({ kind: 'page', pid: Number(pageButton.dataset.pagePid), page: Number(pageButton.dataset.page) }); return; }
  const frameButton = target.closest<HTMLElement>('[data-frame]');
  if (frameButton) { selectVisual({ kind: 'frame', frameId: Number(frameButton.dataset.frame) }); return; }
  const objectButton = target.closest<HTMLElement>('[data-object]');
  if (objectButton) { selectVisual({ kind: 'object', objectId: objectButton.dataset.object! }); return; }
  if (target.closest('#prev-step')) { step = Math.max(0, step - 1); render(); }
  if (target.closest('#next-step')) { step = Math.min(history.length - 1, step + 1); render(); }
  if (target.closest('#show-event')) { history.splice(0, history.length, ...guidedHistory()); step = Math.min(lessons[moduleId].focus, history.length - 1); selectedPid = 4100; selectedFrame = null; selectedObjectId = null; selectedPage = null; actionError = ''; observedModules[moduleId] = true; render(); return; }
  if (target.closest('#reset-model')) { history.splice(0, history.length, initialWorld()); step = 0; selectedPid = 4100; selectedFrame = null; selectedObjectId = null; selectedPage = null; actionError = ''; render(); return; }
  if (target.closest('#clear-selection')) { selectedFrame = null; selectedObjectId = null; selectedPage = null; render(); return; }
  const actionButton = target.closest<HTMLElement>('[data-lab]');
  if (actionButton && !actionButton.hasAttribute('disabled')) {
    const state = world(), selected = state.processes.find(p => p.pid === selectedPid);
    const action = actionButton.dataset.lab;
    if (action === 'inspect') { selectVisual({ kind: 'page', pid: selectedPid, page: 2 }); return; }
    if (action === 'fork') { runAction({ type: 'fork', parentPid: 4100 }); return; }
    if (action === 'counter') { runAction({ type: 'write', pid: selectedPid, page: 2 }); return; }
    if (action === 'write') { runAction({ type: 'write', pid: selectedPid, page: selectedPage?.pid === selectedPid ? selectedPage.page : 2 }); return; }
    if (action === 'master-write') { runAction({ type: 'write', pid: 4100, page: 2 }); return; }
    if (action === 'exit' || action === 'reap') { runAction({ type: action, pid: selectedPid }); return; }
    if (action === 'open') { runAction({ type: 'open_file', pid: selectedPid, name: 'sample.log' }); return; }
    if (action === 'file-read') { const fd = selected?.descriptors.find(item => state.kernelObjects.some(o => o.id === item.objectId && o.kind === 'file'))?.fd; if (fd !== undefined) runAction({ type: 'read_file', pid: selectedPid, fd, bytes: 16 }); return; }
    if (action === 'file-close') { const fd = selected?.descriptors.find(item => state.kernelObjects.some(o => o.id === item.objectId && o.kind === 'file'))?.fd; if (fd !== undefined) runAction({ type: 'close_fd', pid: selectedPid, fd }); return; }
    if (action === 'map-anon') { runAction({ type: 'mmap', pid: selectedPid, name: 'scratch', pageCount: 1, kind: 'anonymous', sharing: 'private' }); return; }
    if (action === 'map-file') { runAction({ type: 'mmap', pid: selectedPid, name: 'shared.data', pageCount: 1, kind: 'file', sharing: 'shared', fileKey: 'shared.data' }); return; }
    if (action === 'unmap') { const region = [...(selected?.regions ?? [])].reverse().find(r => r.id.startsWith('region-')); if (region) runAction({ type: 'munmap', pid: selectedPid, regionId: region.id }); return; }
    if (action === 'thread') { runAction({ type: 'spawn_thread', pid: selectedPid }); return; }
    if (action === 'lock') { const tid = selected?.threadIds.at(-1); if (tid !== undefined) runAction({ type: 'lock', pid: selectedPid, lockId: 'sample-lock', tid }); return; }
    if (action === 'unlock') { const lock = selected?.locks.find(item => item.ownerTid !== null && selected.threadIds.includes(item.ownerTid)); if (lock?.ownerTid !== null && lock?.ownerTid !== undefined) runAction({ type: 'unlock', pid: selectedPid, lockId: lock.id, tid: lock.ownerTid }); return; }
    if (action === 'limit') { runAction({ type: 'set_limit', bytes: chargedBytes(state) }); return; }
    if (action === 'unlimit') { runAction({ type: 'set_limit', bytes: null }); return; }
  }
  if (target.closest('#view-toggle')) { flat = !flat; localStorage.setItem('forkscape-flat', String(flat)); render(); }
  if (target.closest('#export-progress')) {
    const blob = new Blob([JSON.stringify({ version: 1, answers }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'forkscape-progress.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
root.addEventListener('input', event => {
  if ((event.target as HTMLElement).id === 'time-range') { step = Number((event.target as HTMLInputElement).value); render(); }
});
root.addEventListener('submit', event => {
  if ((event.target as HTMLElement).id !== 'prediction-form') return;
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const value = new FormData(form).get('prediction');
  if (value === null) return;
  answers = { ...answers, [moduleId]: Number(value) };
  localStorage.setItem('forkscape-progress', JSON.stringify(answers));
  render();
});

render();
