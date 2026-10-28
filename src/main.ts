import './style.css';
import './theme.css';
import './reference.css';
import { applyAction, assertInvariants, chargedBytes, guidedHistory, initialWorld, memoryRows, pageTableBytes, physicalBytes, regionForPage, sharers, objectRefCount, type Action, type WorldState } from './model';
import { classificationComplete, classificationItems, emptyExerciseProgress, forkPageTableKiB, moduleComplete, traceComplete, type ExerciseProgress, type Owner } from './exercises';
import { CASE_REQUESTS, CATALOG_PAGES, caseComplete, caseHistories, caseMetrics, type CaseKind, type CaseProgress } from './caseStudy';
import type { ForkScene, SceneSelection, StructurePart } from './scene';

type ModuleId = 1 | 2 | 3 | 4 | 'case';
type CoreModuleId = Exclude<ModuleId, 'case'>;
const lessons: Record<CoreModuleId, { title: string; kicker: string; body: string; question: string; choices: string[]; correct: number; answer: string; onCall: string; evidence: string; focus: number }> = {
  1: { title: 'A process is more than code', kicker: '01 / PROCESS ANATOMY', body: 'A process has its own PID, address space, descriptor table, and threads. A descriptor points to an object held by the kernel. Select a deck to inspect its mappings.', question: 'Which item is the kernel object shared through a file descriptor?', choices: ['The process PID', 'The listening socket', 'The process address space'], correct: 1, answer: 'The socket lives in the kernel. The process holds a descriptor that refers to it.', onCall: 'Find the process tree with ps, memory regions in maps, descriptors in fd, and threads in task.', evidence: 'ps -o pid,ppid,rss,cmd --forest · /proc/<pid>/{maps,fd,task}', focus: 0 },
  2: { title: 'One call, two returns', kicker: '02 / FORK', body: 'The parent and child resume at the same line after fork(). The parent receives the child PID; the child receives zero. Their descriptor tables refer to the same socket.', question: 'How many times does the print after fork() run?', choices: ['Once', 'Twice', 'It depends on memory size'], correct: 1, answer: 'Both processes continue from the fork() call, so each reaches print().', onCall: 'A supervising master must reap exited children or zombies remain in the process table.', evidence: 'ps -o pid,ppid,stat,cmd --forest · waitpid()', focus: 1 },
  3: { title: 'Addresses are names', kicker: '03 / VIRTUAL MEMORY', body: 'Each deck tile is one virtual page. Its filament points through a page table to a physical frame below. The same virtual page index can later point to different frames.', question: 'Parent and child print the same address for an object. Does that prove they still share a physical frame?', choices: ['Yes', 'No', 'Only if their PIDs match'], correct: 1, answer: 'An address is meaningful inside one process. Page-table mappings decide which physical frame it reaches.', onCall: 'An identical Python id() value in two workers is not proof of shared physical memory.', evidence: '/proc/<pid>/maps · /proc/<pid>/pagemap (privilege dependent)', focus: 1 },
  4: { title: 'Copy on write', kicker: '04 / PAGE FAULT', body: 'At fork, the data pages stay shared. A first write to a shared page faults, copies the whole page, and changes only the writer’s mapping. Any process can be the writer.', question: 'A child changes one 8-byte value on a shared 4 KiB page. How many bytes are copied?', choices: ['8 bytes', '4,096 bytes', 'The entire process'], correct: 1, answer: 'The kernel copies one page: 4 KiB in this model. Later writes to that exclusive page reuse its frame.', onCall: 'Scattered small writes can grow Private_Dirty quickly; in-process changes never reach sibling workers.', evidence: '/proc/<pid>/smaps_rollup: Private_Dirty · minor faults in /proc/<pid>/stat', focus: 2 },
};

let history: WorldState[] = [initialWorld()];
let labHistory: WorldState[] | null = null;
let labStep = 0;
let labSelection: { pid: number; frame: number | null; object: string | null; page: { pid: number; page: number } | null; structure: { pid: number; part: StructurePart; index: number } | null } | null = null;
const caseStates = caseHistories();
let caseKind: CaseKind = 'decay';
const savedCase = (() => { try { return JSON.parse(localStorage.getItem('forkscape-case') || '{}') as Partial<CaseProgress>; } catch { return {}; } })();
let caseProgress: CaseProgress = { viewedDecay: false, viewedLeak: false, checked: false, ...savedCase };
const saveCase = () => localStorage.setItem('forkscape-case', JSON.stringify(caseProgress));
const root = document.querySelector<HTMLDivElement>('#app')!;
const saved = (() => { try { return JSON.parse(localStorage.getItem('forkscape-progress') || '{}') as Record<string, number>; } catch { return {}; } })();
let answers: Record<string, number> = saved;
const storedExercise = (() => { try { return JSON.parse(localStorage.getItem('forkscape-exercises') || '{}') as Partial<ExerciseProgress>; } catch { return {}; } })();
let exercise: ExerciseProgress = { ...emptyExerciseProgress(), ...storedExercise, classification: storedExercise.classification ?? {}, trace: storedExercise.trace ?? {} };
const observedModules: Record<string, boolean> = {};
let moduleId: ModuleId = 1;
let step = 0;
let walkStep = -1;
let selectedPid = 4100;
let selectedFrame: number | null = null;
let selectedObjectId: string | null = null;
let selectedPage: { pid: number; page: number } | null = null;
let selectedStructure: { pid: number; part: StructurePart; index: number } | null = null;
let actionError = '';
let flat = localStorage.getItem('forkscape-flat') === 'true';
let scene: ForkScene | null = null;
let sceneLoading = false;

const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const kb = (bytes: number) => `${Number.isInteger(bytes / 1024) ? bytes / 1024 : (bytes / 1024).toFixed(1)} KiB`;
const world = () => history[step];
const saveExercise = () => localStorage.setItem('forkscape-exercises', JSON.stringify(exercise));
const forkGuesses = [0, 4, 8, 16, 32, 64, 128, 256, 404, 512, 1024, 2048, 4096, 8192, 32768, 204800];
const copyGuesses = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 65536, 209715200];
const walkLabels = [
  'Before fork(): only the master exists.',
  'fork() returns in both processes. The parent receives the child PID; the child receives 0.',
  'The parent follows the nonzero branch and prints the child PID.',
  'The child follows the zero branch and prints its own message.',
  'The child exits and remains as a zombie until its parent waits.',
  'The parent calls waitpid(); the zombie is reaped.',
];

root.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true">✦</span><span>FORKSCAPE</span><span class="brand-sub">A PROCESS MEMORY LAB</span></div>
    <div class="top-actions"><span class="badge">MODEL</span><button id="view-toggle" class="subtle" type="button"></button><button id="export-progress" class="subtle" type="button" title="Export your answers as JSON">Export progress</button></div>
  </header>
  <main class="workspace">
    <aside class="lesson-rail">
      <div class="rail-heading"><span>GUIDED LAB</span><span>01—04 + CASE</span></div>
      <nav id="module-nav" aria-label="Modules"></nav>
      <section id="lesson-content"></section>
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
    <section class="ledger-panel"><div class="panel-heading"><span>MEMORY LEDGER</span><span>MODEL · PAGE TABLES INCLUDED IN CHARGE</span></div><div id="ledger"></div><details class="reference-evidence"><summary>Linux reference observations · 3 VM runs</summary><p>In 16–1,024 page probes, one child write made 4 KiB private in each process. Parent <code>VmPTE</code> rose by 0–8 KiB after mapping, with a 76–80 KiB process-wide baseline. These readings cannot isolate the test mapping’s page tables.</p><p>With a 64 MiB cgroup limit, <code>memory.events: oom_kill</code> rose by one in each run. The higher <code>oom_score_adj</code> child was killed in this workload; the model’s victim choice is only a teaching rule.</p></details></section>
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
    scene.setWorld(world(), selectedPid, selectedPage, selectedFrame, selectedObjectId, selectedStructure, selection => { selectVisual(selection); });
  } catch { flat = true; render(); }
  finally { sceneLoading = false; }
}

function renderNav() {
  root.querySelector('#module-nav')!.innerHTML = ([1, 2, 3, 4] as CoreModuleId[]).map(id => { const complete = moduleComplete(id, answers[id] !== undefined, exercise); return `<button class="module-link ${moduleId === id ? 'active' : ''}" type="button" data-module="${id}" aria-current="${moduleId === id ? 'page' : 'false'}" aria-label="Module ${id}: ${escapeHtml(lessons[id].title)}, ${complete ? 'complete' : 'incomplete'}"><span class="module-number">0${id}</span><span>${escapeHtml(lessons[id].title)}</span><span class="module-check" aria-hidden="true">${complete ? '✓' : '↗'}</span></button>`; }).join('')
    + `<button class="module-link ${moduleId === 'case' ? 'active' : ''}" type="button" data-module="case" aria-current="${moduleId === 'case' ? 'page' : 'false'}" aria-label="Case study: creeping memory, ${caseComplete(caseProgress) ? 'complete' : 'incomplete'}"><span class="module-number">◇</span><span>Creeping memory case</span><span class="module-check" aria-hidden="true">${caseComplete(caseProgress) ? '✓' : '↗'}</span></button>`;
}

function renderExercise(): string {
  if (moduleId === 'case') return '';
  if (answers[moduleId] === undefined) return '<p class="exercise-lock">Commit a prediction to unlock this exercise.</p>';
  if (moduleId === 1) {
    const correct = classificationComplete(exercise);
    return `<div class="lesson-stage exercise"><div class="section-tag">EXERCISE · SORT THE PARTS</div><p>Choose where each item belongs. A process owns references to kernel objects.</p><form id="classification-form"><div class="sort-list">${classificationItems.map(item => `<label><span>${escapeHtml(item.label)}</span><select name="${item.id}" aria-label="${escapeHtml(item.label)} belongs to"><option value="">Choose…</option><option value="process" ${exercise.classification[item.id] === 'process' ? 'selected' : ''}>Process</option><option value="kernel" ${exercise.classification[item.id] === 'kernel' ? 'selected' : ''}>Kernel</option></select></label>`).join('')}</div><button class="primary" type="submit">Check classification</button></form>${exercise.classificationChecked ? `<p class="exercise-feedback" role="status">${correct ? 'All six are placed correctly. Exercise complete.' : 'Some placements need another look. The descriptor table belongs to a process; the object it refers to lives in the kernel.'}</p>` : ''}</div>`;
  }
  if (moduleId === 2) {
    return `<div class="lesson-stage exercise"><div class="section-tag">EXERCISE · FOLLOW BOTH RETURNS</div><p>${walkStep < 0 ? 'Start at the fork line, then advance through each branch, child exit, and parent reap.' : escapeHtml(walkLabels[walkStep])}</p><p class="exercise-feedback" role="status">${exercise.forkWalkthroughDone ? 'Walkthrough complete.' : walkStep < 0 ? '0 of 6 code states visited.' : `${walkStep + 1} of 6 code states visited.`}</p><button type="button" class="event-button" id="walk-next" ${walkStep === 5 ? 'disabled' : ''}>${walkStep < 0 ? 'Start code walkthrough' : 'Next code step →'}</button><p class="exercise-note">Starting the walkthrough loads a fresh model run. The event timeline remains available for reviewing states.</p></div>`;
  }
  if (moduleId === 3) {
    const trace = exercise.trace;
    const value = (n?: number) => n === undefined ? '—' : `F${n}`;
    return `<div class="lesson-stage exercise"><div class="section-tag">EXERCISE · FOLLOW ONE ADDRESS</div><p>Fork the master. Select virtual page 2 in the parent and child before a write. Write page 2 in the child, then select page 2 in each process again. Use the flat view or scene tiles.</p><table class="trace-table"><thead><tr><th></th><th>Before write</th><th>After write</th></tr></thead><tbody><tr><th>Parent page 2</th><td>${value(trace.beforeParent)}</td><td>${value(trace.afterParent)}</td></tr><tr><th>Child page 2</th><td>${value(trace.beforeChild)}</td><td>${value(trace.afterChild)}</td></tr></tbody></table><p class="exercise-feedback" role="status">${traceComplete(trace) ? 'Same virtual page, different frame after the child writes. Exercise complete.' : 'Trace both mappings before and after the write to complete this exercise.'}</p></div>`;
  }
  const guess = exercise.sizeGuess;
  const observed = exercise.copyObserved;
  const forkIndex = Math.max(0, forkGuesses.indexOf(guess?.forkKiB ?? 204800));
  const copyIndex = Math.max(0, copyGuesses.indexOf(guess?.copyBytes ?? 8));
  return `<div class="lesson-stage exercise"><div class="section-tag">EXERCISE · PREDICT THE SIZES</div><p>For a 200 MiB private mapping, estimate extra memory immediately after fork. Then estimate how much a first 8-byte write copies. Move both logarithmic sliders and commit.</p><form id="size-form"><label class="range-label">Fork overhead <strong id="fork-guess-label">${kb(forkGuesses[forkIndex] * 1024)}</strong><input name="fork-size" type="range" min="0" max="${forkGuesses.length - 1}" value="${forkIndex}" ${guess ? 'disabled' : ''}></label><label class="range-label">First write copies <strong id="copy-guess-label">${copyGuesses[copyIndex].toLocaleString()} bytes</strong><input name="copy-size" type="range" min="0" max="${copyGuesses.length - 1}" value="${copyIndex}" ${guess ? 'disabled' : ''}></label>${guess ? '' : '<button class="primary" type="submit">Commit size predictions</button>'}</form>${guess ? `<p class="exercise-feedback">You predicted ${kb(guess.forkKiB * 1024)} at fork and ${guess.copyBytes.toLocaleString()} bytes on write. This page-table model adds about ${kb(forkPageTableKiB(200) * 1024)} at fork for 200 MiB of mapped data. A first shared-page write copies ${world().pageSize.toLocaleString()} bytes.</p><p class="exercise-feedback" role="status">${observed ? 'Fork and copy-on-write observed. Exercise complete.' : 'Now fork and write page 2 in a child to observe the model outcome.'}</p>` : ''}</div>`;
}

function renderCaseLesson() {
  const predicted = caseProgress.prediction !== undefined;
  const samples = [0, 4, 8, 12, 16, 20, 24];
  const base = caseMetrics(caseStates.decay[0]).physical;
  const chart = (kind: CaseKind, title: string) => `<div class="case-curve"><div class="case-curve-title"><strong>${title}</strong><span>${caseProgress[kind === 'decay' ? 'viewedDecay' : 'viewedLeak'] ? 'inspected' : 'inspect request 16 or later'}</span></div><div class="case-bars">${samples.map(request => {
    const growth = (caseMetrics(caseStates[kind][request]).physical - base) / 1024;
    return `<button type="button" data-case-kind="${kind}" data-case-step="${request}" aria-pressed="${caseKind === kind && step === request}" aria-label="${title}, request ${request}, physical growth ${growth} KiB"><span class="case-bar" style="height:${10 + growth / 96 * 55}px"></span><small>${request}</small></button>`;
  }).join('')}</div></div>`;
  const metrics = caseMetrics(world());
  const growth = (metrics.physical - base) / 1024;
  const correct = caseComplete(caseProgress);
  root.querySelector('#lesson-content')!.innerHTML = `
    <div class="lesson-kicker">CASE STUDY / MODEL</div><h1>Creeping memory</h1>
    <p class="lesson-body">A worker serves ${CASE_REQUESTS} requests after inheriting a ${CATALOG_PAGES}-page catalog. In one run it gradually writes catalog pages. In the other it keeps a new page after every request. Each request here stands for one page operation, not a timed Linux sample.</p>
    <div class="prediction"><div class="section-tag">PREDICT</div><p class="question">Physical use rises during the first eight requests. Is that enough to call it a persistent leak?</p><form id="case-prediction-form">${['Yes, rising use proves objects are retained.', 'No, loss of sharing can also make use rise at first.', 'Only if worker RSS rises too.'].map((choice, index) => `<label class="choice ${caseProgress.prediction === index ? 'chosen' : ''}"><input name="prediction" type="radio" value="${index}" ${caseProgress.prediction === index ? 'checked' : ''} ${predicted ? 'disabled' : ''}><span>${choice}</span></label>`).join('')}${predicted ? '' : '<button class="primary" type="submit">Commit prediction →</button>'}</form>${predicted ? `<div class="answer ${caseProgress.prediction === 1 ? 'correct' : 'review'}"><p>Both histories add one physical page per request at first. Follow them beyond the shared catalog to see where they diverge.</p></div>` : ''}</div>
    ${predicted ? `<div class="lesson-stage exercise"><div class="section-tag">ACT · COMPARE THE CURVES</div><p>Choose a bar to load that request into the timeline, scene, and ledger. Bars show physical growth above the common post-fork baseline, in KiB. The early bars overlap.</p><div class="case-curves">${chart('decay', 'Catalog writes')}${chart('leak', 'Retained allocations')}</div><p class="exercise-feedback" role="status">${caseKind === 'decay' ? 'Catalog writes' : 'Retained allocations'} · request ${step}: physical growth ${growth} KiB · worker USS ${kb(metrics.workerUss)} · worker RSS ${kb(metrics.workerRss)}. ${step > CATALOG_PAGES && caseKind === 'decay' ? 'All catalog pages have already been copied, so further writes reuse worker frames.' : ''}</p></div>
    <div class="lesson-stage exercise"><div class="section-tag">BUILD THE CAUSAL LINKS</div><p>Inspect request 16 or later in both histories, then match each curve to its cause and choose the strongest evidence.</p><form id="case-links-form"><label class="case-select">Catalog writes <select name="decay" aria-label="Cause of catalog write curve"><option value="">Choose cause…</option><option value="decay" ${caseProgress.decayCause === 'decay' ? 'selected' : ''}>Previously shared pages become private</option><option value="leak" ${caseProgress.decayCause === 'leak' ? 'selected' : ''}>New pages stay allocated each request</option></select></label><label class="case-select">Retained allocations <select name="leak" aria-label="Cause of retained allocation curve"><option value="">Choose cause…</option><option value="decay" ${caseProgress.leakCause === 'decay' ? 'selected' : ''}>Previously shared pages become private</option><option value="leak" ${caseProgress.leakCause === 'leak' ? 'selected' : ''}>New pages stay allocated each request</option></select></label><label class="case-select">Best distinguishing evidence <select name="evidence" aria-label="Best distinguishing evidence"><option value="">Choose evidence…</option><option value="rss" ${caseProgress.evidence === 'rss' ? 'selected' : ''}>One worker RSS snapshot</option><option value="pid" ${caseProgress.evidence === 'pid' ? 'selected' : ''}>The worker PID alone</option><option value="trend" ${caseProgress.evidence === 'trend' ? 'selected' : ''}>Memory trend and private growth over repeated requests</option></select></label><button class="primary" type="submit">Check links</button></form>${caseProgress.checked ? `<p class="exercise-feedback" role="status">${correct ? 'Case complete. You connected each curve to its cause.' : 'Review the two curves and their page operations, then revise the links.'}</p>` : ''}</div>
    <div class="on-call"><div class="section-tag">CONNECT · ON CALL</div><p>Catalog writes → copy on write → private pages grow → growth stops when this finite catalog is fully copied. Retained allocations → new pages remain mapped → physical use keeps growing in this run.</p><p>In a real service, compare cgroup memory, summed PSS, Private_Dirty, request volume, and retained heap evidence over enough time. A short plateau or rising RSS alone cannot settle the diagnosis; allocator behavior and recycling can change the shape.</p><code>/proc/&lt;pid&gt;/smaps_rollup · memory.current · allocation profiler</code></div>` : ''}
  `;
}

function renderLesson() {
  if (moduleId === 'case') { renderCaseLesson(); return; }
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
    ${renderExercise()}
    <div class="lesson-stage"><div class="section-tag">ACT</div><p>Choose a process or page, then change the model. Each action adds a state to the timeline.</p><div class="lab-actions">${actions}</div><button id="show-event" class="event-button" type="button" ${answered ? '' : 'disabled'}>Load guided example</button><button id="reset-model" class="subtle" type="button">Reset model</button><p id="action-error" class="action-error" role="alert">${escapeHtml(actionError)}</p></div>
    <details class="model-tools"><summary>More model controls</summary><div class="lab-actions">${button('Map anonymous page', 'map-anon', !!active)}${button('Map shared file', 'map-file', !!active)}${button('Unmap latest region', 'unmap', !!active && !!process?.regions.some(r => r.id.startsWith('region-')))}${button('Start thread', 'thread', !!active)}${button('Lock with newest thread', 'lock', !!active && (process?.threadIds.length ?? 0) > 1)}${button('Unlock', 'unlock', !!active && !!heldLock)}${button('Set limit to current use', 'limit')}${button('Remove limit', 'unlimit')}</div></details>
    <div class="lesson-stage"><div class="section-tag">OBSERVE</div><p>${escapeHtml(state.events.at(-1)!.description)}</p><p>Selected PID: ${selectedPid} · physical frames: ${state.frames.length} · counters: ${state.processes.map(p => `${p.pid}=${p.counter}`).join(', ')}</p></div>
    <div class="lesson-stage"><div class="section-tag">EXPLAIN</div><p>${observedModules[moduleId] ? escapeHtml(lesson.answer) : 'Commit a prediction, then use the model controls to reveal the explanation.'}</p></div>
    ${observedModules[moduleId] ? `<div class="on-call"><div class="section-tag">CONNECT · ON CALL</div><p>${escapeHtml(lesson.onCall)}</p><code>${escapeHtml(lesson.evidence)}</code></div>` : ''}
  `;
}

function renderFlat(state: WorldState) {
  root.querySelector('#flat-host')!.innerHTML = `<div class="flat-title">PROCESS ADDRESS SPACES</div><div class="flat-processes">${state.processes.map(process => `<div class="flat-process ${selectedPid === process.pid && selectedPage === null && selectedStructure === null ? 'selected' : ''}"><button type="button" data-pid="${process.pid}"><strong>${process.role.toUpperCase()} · PID ${process.pid}</strong><span>${process.status === 'zombie' ? 'ZOMBIE · mappings released' : `PPID ${process.parentPid ?? '—'} · ${process.pages.filter(id => id !== null).length} pages · ${process.threadIds.length} thread(s)`}</span></button><div class="page-strip">${process.pages.map((id, index) => id === null ? '' : `<button type="button" data-page="${index}" data-page-pid="${process.pid}" aria-label="PID ${process.pid} virtual page ${index}, frame ${id}" class="page-chip ${sharers(state, id) > 1 ? 'is-shared' : ''} ${selectedPage?.pid === process.pid && selectedPage.page === index ? 'selected' : ''}">${index}→F${id}<small>${escapeHtml(regionForPage(process, index)?.name ?? '')}</small></button>`).join('')}</div>${process.status === 'running' ? `<div class="structure-list" aria-label="PID ${process.pid} scene parts">${structureButtons(state, process.pid)}</div>` : ''}</div>`).join('')}</div><div class="flat-title">PHYSICAL FRAMES</div><div class="flat-frames">${state.frames.map(frame => `<button type="button" data-frame="${frame.id}" class="flat-frame ${selectedFrame === frame.id ? 'selected' : ''}"><strong>F${frame.id}</strong><span>${escapeHtml(frame.region)}</span><small>${sharers(state, frame.id)} ${sharers(state, frame.id) === 1 ? 'mapping' : 'mappings'}</small></button>`).join('')}</div><div class="flat-title">KERNEL OBJECTS</div><div class="flat-frames">${state.kernelObjects.map(object => `<button type="button" data-object="${escapeHtml(object.id)}" class="flat-frame ${selectedObjectId === object.id ? 'selected' : ''}"><strong>${escapeHtml(object.kind)}</strong><span>${escapeHtml(object.id)}</span><small>${objectRefCount(state, object.id)} descriptor(s)${object.kind === 'file' ? ` · offset ${object.offset}` : ''}</small></button>`).join('')}</div><p class="flat-note">Select a page to trace its mapping. Shared frames have multiple mappings; descriptors can refer to one kernel object.</p>`;
}

function structureButtons(state: WorldState, pid: number): string {
  const process = state.processes.find(item => item.pid === pid);
  if (!process || process.status !== 'running') return '';
  const button = (part: StructurePart, index: number, label: string) => `<button type="button" data-structure="${part}" data-structure-pid="${pid}" data-structure-index="${index}" aria-label="Inspect PID ${pid} ${escapeHtml(label)}">${escapeHtml(label)}</button>`;
  return button('page_table', 0, 'Page-table sheet') + process.descriptors.map((fd, index) => button('cable', index, `fd ${fd.fd} cable`)).join('') + process.threadIds.map((tid, index) => button('thread', index, `Thread ${tid} spindle`)).join('') + (state.processes.length > 1 ? button('stack', 0, 'Fork stack blocks') : '');
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
  const structure = selectedStructure?.pid === process.pid ? selectedStructure : null;
  const structureBody = structure ? (() => {
    const fd = process.descriptors[structure.index], tid = process.threadIds[structure.index];
    if (structure.part === 'cable' && fd) return `<h2>Descriptor cable</h2><p>PID ${process.pid} fd ${fd.fd} → ${escapeHtml(fd.objectId)}</p><div class="inspector-rung"><span>METAPHOR</span><p>A cable joins a process port to a kernel object.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>The descriptor table holds a reference. Fork copies the table entries, so both processes can refer to the same open object and file offset.</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>/proc/${process.pid}/fd/${fd.fd} · fdinfo/${fd.fd}</code><small>The cable and object ID are modeled.</small></div>`;
    if (structure.part === 'thread' && tid !== undefined) return `<h2>Thread spindle</h2><p>PID ${process.pid} · TID ${tid}</p><div class="inspector-rung"><span>METAPHOR</span><p>One spindle marks one thread on this deck.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>Only the thread that calls fork survives in the child. Other thread-held locks may stay held in the copied address space.</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>/proc/${process.pid}/task</code><small>Thread IDs and locks here are model data.</small></div>`;
    if (structure.part === 'stack' && state.processes.length > 1) return `<h2>Fork stack blocks</h2><p>PID ${process.pid} · modeled call stack</p><div class="inspector-rung"><span>METAPHOR</span><p>Stacked blocks stand beside each deck after fork.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>Both processes resume from the same fork() call. ${process.role === 'master' ? 'The parent receives the child PID.' : 'The child receives 0.'} Their stacks can diverge after returning.</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>strace -f -e clone,fork,wait4 · /proc/${process.pid}/stack</code><small>The blocks are schematic; user stacks require a debugger or profiler.</small></div>`;
    if (structure.part === 'page_table') return `<h2>Page-table sheet</h2><p>PID ${process.pid} · ${kb(state.pageSize * (1 + new Set(process.pages.flatMap((id, index) => id === null ? [] : [Math.floor(index / 512)])).size))} model charge</p><div class="inspector-rung"><span>METAPHOR</span><p>A thin sheet below the process deck routes virtual pages to frames.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>Fork creates a separate page table for the child while initially keeping data frames shared. This model charges one root and one leaf per occupied group of 512 pages.</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>/proc/${process.pid}/status: VmPTE · /proc/${process.pid}/maps</code><small>VmPTE covers the whole process. Three Linux VM runs showed a 0–8 KiB parent increase after mapping 16–1,024 pages. This sheet and its charge are illustrative.</small></div>`;
    return '';
  })() : '';
  const body = structureBody || (object
    ? `<h2>${escapeHtml(object.kind)} <em>${escapeHtml(object.id)}</em></h2><p>${objectRefCount(state, object.id)} descriptor(s) point here</p><div class="inspector-rung"><span>METAPHOR</span><p>A buoy in the kernel layer with cables from process decks.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>${objectDescriptors.join(' · ')}. ${object.kind === 'file' ? `Shared file offset: ${object.offset} bytes.` : 'One listening socket is shared.'}</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>/proc/&lt;pid&gt;/fd · ss -lnp</code><small>Object identity and offset shown here are modeled.</small></div>`
    : frame
    ? `<h2>Frame F${frame.id}</h2><p>${escapeHtml(frame.region)} · ${frame.kind} · ${sharers(state, frame.id)} mapping(s)</p><div class="inspector-rung"><span>METAPHOR</span><p>A tile on the memory floor.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>${frameMappings.join(' · ')}. Model write revision: ${frame.revision}. ${frame.fileKey ? `File cache key: ${escapeHtml(frame.fileKey)}.` : 'Anonymous data frame.'}</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>/proc/&lt;pid&gt;/pagemap · /proc/kpagecount</code><small>Exact frame identity often needs privilege. This frame ID is modeled.</small></div>`
    : page !== null && pageFrame && region
      ? `<h2>Virtual page <em>${page}</em></h2><p>PID ${process.pid} → frame F${pageFrame.id}</p><div class="inspector-rung"><span>METAPHOR</span><p>A tile on PID ${process.pid}'s deck; its filament points to the floor.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>${escapeHtml(region.name)} · ${region.kind} · ${region.sharing} · ${region.writable ? 'writable' : 'read-only'}. ${sharers(state, pageFrame.id)} mapping(s) reach this frame. Model write revision: ${pageFrame.revision}.</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>/proc/${process.pid}/maps · smaps_rollup</code><small>Virtual page to exact frame requires privileged pagemap access. This mapping is modeled.</small></div><button type="button" data-frame="${pageFrame.id}" class="subtle">Inspect frame F${pageFrame.id}</button>`
      : `<h2>${process.role === 'master' ? 'Master' : 'Worker'} <em>PID ${process.pid}</em></h2><p>${process.status === 'zombie' ? 'Exited · awaiting reaping' : `${process.pages.filter(id => id !== null).length} mapped pages · ${process.threadIds.length} thread(s)`}</p><div class="inspector-rung"><span>METAPHOR</span><p>A deck with page tiles and descriptor ports.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>Address space: ${process.regions.map(r => `${escapeHtml(r.name)} (${r.pageCount}p)`).join(', ') || 'released'}. Page tables: ${kb(process.status === 'running' ? state.pageSize * (1 + new Set(process.pages.flatMap((id, index) => id === null ? [] : [Math.floor(index / 512)])).size) : 0)}.</p><p>Descriptors: ${process.descriptors.map(fd => { const object = state.kernelObjects.find(o => o.id === fd.objectId)!; return `fd ${fd.fd} → ${escapeHtml(object.id)} (${object.kind}, ${objectRefCount(state, object.id)} refs${object.kind === 'file' ? `, offset ${object.offset}` : ''})`; }).join('; ') || 'none'}.</p><p>Threads: ${process.threadIds.join(', ') || 'none'}. Locks: ${process.locks.map(lock => `${escapeHtml(lock.id)} → ${lock.ownerTid ?? 'free'}${lock.ownerTid !== null && !process.threadIds.includes(lock.ownerTid) ? ' (owner absent after fork)' : ''}`).join('; ') || 'none'}.</p><p>Counter: ${process.counter} in this process.</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>ps · /proc/${process.pid}/maps · fd · task</code><small>All values shown here are model data.</small></div><div class="structure-list" aria-label="Inspect scene parts">${structureButtons(state, process.pid)}</div>`);
  root.querySelector('#inspector')!.innerHTML = `<div class="panel-heading"><span>INSPECTOR</span><span>MODEL</span></div><div class="inspector-content">${body}<button id="clear-selection" type="button" class="subtle" ${object || frame || page !== null || structure ? '' : 'hidden'}>← Process</button></div>`;
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
  root.querySelector('#step-label')!.textContent = moduleId === 'case' ? `REQUEST ${step} / ${CASE_REQUESTS}` : `${step + 1} / ${history.length}`;
  root.querySelector('#event-count')!.textContent = moduleId === 'case' ? `${caseKind.toUpperCase()} · MODEL` : `${history.length} STATES`;
  root.querySelector('#event-strip')!.innerHTML = moduleId === 'case'
    ? [0, 4, 8, 12, 16, 20, 24].map(index => `<button type="button" data-step="${index}" class="event-tick ${index === step ? 'active' : ''}" aria-label="Request ${index}"><span class="tick-icon">${index === 0 ? '⑂' : '•'}</span><span>${index}</span></button>`).join('')
    : history.map((item, index) => `<button type="button" data-step="${index}" class="event-tick ${index === step ? 'active' : ''}" aria-label="Step ${index + 1}: ${escapeHtml(item.events.at(-1)!.kind)}"><span class="tick-icon">${({ start: '●', fork: '⑂', cow_fault: '✦', write: '✎', exit: '×', reap: '↻', oom_kill: '!', mmap: '+', munmap: '−' } as Record<string, string>)[item.events.at(-1)!.kind] ?? '•'}</span><span>${escapeHtml(item.events.at(-1)!.kind.replace('_', ' '))}</span></button>`).join('');
  root.querySelector('#terminal')!.textContent = event.terminal;
  root.querySelector('#narration')!.textContent = event.description;
  root.querySelector('#scene-heading')!.textContent = event.kind.replace('_', ' ').toUpperCase();
}

function renderCode() {
  const code = root.querySelector('#code')!;
  if (moduleId === 'case') {
    code.textContent = caseKind === 'decay'
      ? `# Teaching model: finite preloaded catalog\npage = catalog[(request - 1) % ${CATALOG_PAGES}]\nwrite(page)  # first touch copies a shared page\n# Later writes reuse the worker's private frame.`
      : `# Teaching model: retained allocation\nretained.append(new_page())\n# One more private mapped page remains after each request.`;
    return;
  }
  if (moduleId === 2) {
    const activeLine = walkStep <= 1 ? 0 : walkStep === 3 ? 2 : walkStep === 4 ? 3 : walkStep === 5 ? 6 : 5;
    const lines = ['pid = os.fork()', 'if pid == 0:', "    print('child: fork returned 0')", '    os._exit(0)', 'else:', "    print(f'parent: child is {pid}')", '    os.waitpid(pid, 0)  # parent reaps child'];
    code.innerHTML = lines.map((line, index) => `<span class="code-line ${walkStep >= 0 && index === activeLine ? 'code-active' : ''}">${escapeHtml(line)}</span>`).join('') + (walkStep >= 0 ? `<span class="code-caption">${escapeHtml(walkLabels[walkStep])}</span>` : '');
    return;
  }
  code.textContent = moduleId === 4 ? `# Both processes begin with the same page mapping.\ncounter += 1  # 8-byte change, page-sized copy\n\n# Another process still sees its own value.` : `# Simplified process model\nmaster = Process(pid=4100)\nmaster.pages = [code, libs, heap, stack]\nmaster.fd[3] = listening_socket`;
}

function render() {
  const focused = document.activeElement as HTMLElement | null;
  const focusAttributes = focused ? ['id', 'data-module', 'data-lab', 'data-pid', 'data-page', 'data-page-pid', 'data-frame', 'data-object', 'data-structure', 'data-structure-pid', 'data-structure-index', 'data-step'].flatMap(name => focused.hasAttribute(name) ? [[name, focused.getAttribute(name)]] : []) : [];
  const state = world();
  if (!state.processes.some(p => p.pid === selectedPid)) selectedPid = state.processes[0]?.pid ?? 4100;
  if (selectedFrame !== null && !state.frames.some(f => f.id === selectedFrame)) selectedFrame = null;
  if (selectedObjectId !== null && !state.kernelObjects.some(o => o.id === selectedObjectId)) selectedObjectId = null;
  if (selectedPage && !state.processes.some(p => p.pid === selectedPage!.pid && p.pages[selectedPage!.page] !== null && p.pages[selectedPage!.page] !== undefined)) selectedPage = null;
  if (selectedStructure) {
    const process = state.processes.find(p => p.pid === selectedStructure!.pid && p.status === 'running');
    if (!process || selectedStructure.part === 'cable' && !process.descriptors[selectedStructure.index]
      || selectedStructure.part === 'thread' && process.threadIds[selectedStructure.index] === undefined
      || selectedStructure.part === 'stack' && state.processes.length < 2) selectedStructure = null;
  }
  renderNav(); renderLesson(); renderFlat(state); renderInspector(state); renderLedger(state); renderTimeline(state); renderCode();
  host.hidden = flat;
  (root.querySelector('#flat-host') as HTMLElement).hidden = !flat;
  root.querySelector('#view-toggle')!.textContent = flat ? '◈ 3D view' : '▦ Flat view';
  scene?.setWorld(state, selectedPid, selectedPage, selectedFrame, selectedObjectId, selectedStructure, selection => { selectVisual(selection); });
  if (focused && !focused.isConnected && focusAttributes.length) {
    const replacement = [...root.querySelectorAll<HTMLElement>(focused.tagName.toLowerCase())].find(element => focusAttributes.every(([name, value]) => element.getAttribute(name!) === value));
    replacement?.focus({ preventScroll: true });
  }
  void ensureScene();
}

function selectVisual(selection: SceneSelection) {
  if (answers[moduleId] !== undefined && (moduleId === 1 || moduleId === 3) && selection.kind !== 'process') observedModules[moduleId] = true;
  selectedFrame = selection.kind === 'frame' ? selection.frameId : null;
  selectedObjectId = selection.kind === 'object' ? selection.objectId : null;
  selectedStructure = selection.kind === 'structure' ? { pid: selection.pid, part: selection.part, index: selection.index } : null;
  if (selection.kind === 'process' || selection.kind === 'page' || selection.kind === 'structure') selectedPid = selection.pid;
  selectedPage = selection.kind === 'page' ? { pid: selection.pid, page: selection.page } : null;
  if (moduleId === 3 && selection.kind === 'page' && selection.page === 2) {
    const state = world(), parent = state.processes.find(p => p.pid === 4100), child = state.processes.find(p => p.parentPid === 4100);
    if (parent && child && (selection.pid === parent.pid || selection.pid === child.pid)) {
      const before = parent.pages[2] === child.pages[2];
      const key = `${before ? 'before' : 'after'}${selection.pid === parent.pid ? 'Parent' : 'Child'}` as keyof typeof exercise.trace;
      const frame = state.processes.find(p => p.pid === selection.pid)?.pages[2];
      if (frame !== null && frame !== undefined) { exercise.trace[key] = frame; saveExercise(); }
    }
  }
  render();
}

function runAction(action: Action): boolean {
  try {
    const next = applyAction(world(), action);
    assertInvariants(next);
    history.splice(step + 1, history.length - step - 1, next);
    step = history.length - 1;
    actionError = '';
    if (answers[moduleId] !== undefined && (moduleId !== 4 || action.type === 'write')) observedModules[moduleId] = true;
    if (moduleId === 4 && exercise.sizeGuess && history.some(item => item.events.at(-1)?.kind === 'fork') && history.some(item => item.events.at(-1)?.kind === 'cow_fault' && item.events.at(-1)?.pid !== 4100)) {
      exercise.copyObserved = true; saveExercise();
    }
  } catch (error) { actionError = error instanceof Error ? error.message : String(error); render(); return false; }
  render();
  return true;
}

function selectCase(kind: CaseKind, request: number) {
  const changedHistory = history !== caseStates[kind];
  caseKind = kind;
  history = caseStates[kind];
  step = Math.max(0, Math.min(CASE_REQUESTS, request));
  if (changedHistory) {
    selectedPid = 4101; selectedFrame = null; selectedObjectId = null; selectedPage = null; selectedStructure = null;
  }
  if (step >= 16) {
    caseProgress[kind === 'decay' ? 'viewedDecay' : 'viewedLeak'] = true;
    saveCase();
  }
  render();
}

root.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const camera = target.closest<HTMLElement>('[data-camera]');
  if (camera) { scene?.setCameraPreset(camera.dataset.camera as 'overview' | 'process' | 'memory'); return; }
  const zoom = target.closest<HTMLElement>('[data-zoom]');
  if (zoom) { scene?.setZoom(zoom.dataset.zoom === 'in'); return; }
  const moduleButton = target.closest<HTMLElement>('[data-module]');
  if (moduleButton) {
    const nextModule = moduleButton.dataset.module === 'case' ? 'case' : Number(moduleButton.dataset.module) as CoreModuleId;
    if (nextModule === 'case' && moduleId !== 'case') {
      labHistory = history; labStep = step;
      labSelection = { pid: selectedPid, frame: selectedFrame, object: selectedObjectId, page: selectedPage, structure: selectedStructure };
      moduleId = 'case'; selectCase(caseKind, 0); return;
    }
    if (nextModule !== 'case' && moduleId === 'case' && labHistory) {
      history = labHistory; step = labStep; labHistory = null;
      if (labSelection) {
        selectedPid = labSelection.pid; selectedFrame = labSelection.frame; selectedObjectId = labSelection.object;
        selectedPage = labSelection.page; selectedStructure = labSelection.structure; labSelection = null;
      }
      moduleId = nextModule; walkStep = -1; render(); return;
    }
    moduleId = nextModule; walkStep = -1; selectedFrame = null; selectedObjectId = null; selectedPage = null; selectedStructure = null; render(); return;
  }
  const caseButton = target.closest<HTMLElement>('[data-case-kind][data-case-step]');
  if (caseButton && moduleId === 'case') { selectCase(caseButton.dataset.caseKind as CaseKind, Number(caseButton.dataset.caseStep)); return; }
  const stepButton = target.closest<HTMLElement>('[data-step]');
  if (stepButton) { if (moduleId === 'case') selectCase(caseKind, Number(stepButton.dataset.step)); else { step = Number(stepButton.dataset.step); render(); } return; }
  const pidButton = target.closest<HTMLElement>('[data-pid]');
  if (pidButton) { selectVisual({ kind: 'process', pid: Number(pidButton.dataset.pid) }); return; }
  const pageButton = target.closest<HTMLElement>('[data-page]');
  if (pageButton) { selectVisual({ kind: 'page', pid: Number(pageButton.dataset.pagePid), page: Number(pageButton.dataset.page) }); return; }
  const frameButton = target.closest<HTMLElement>('[data-frame]');
  if (frameButton) { selectVisual({ kind: 'frame', frameId: Number(frameButton.dataset.frame) }); return; }
  const objectButton = target.closest<HTMLElement>('[data-object]');
  if (objectButton) { selectVisual({ kind: 'object', objectId: objectButton.dataset.object! }); return; }
  const structureButton = target.closest<HTMLElement>('[data-structure]');
  if (structureButton) { selectVisual({ kind: 'structure', pid: Number(structureButton.dataset.structurePid), part: structureButton.dataset.structure as StructurePart, index: Number(structureButton.dataset.structureIndex) }); return; }
  if (target.closest('#prev-step')) { if (moduleId === 'case') selectCase(caseKind, step - 1); else { step = Math.max(0, step - 1); render(); } }
  if (target.closest('#next-step')) { if (moduleId === 'case') selectCase(caseKind, step + 1); else { step = Math.min(history.length - 1, step + 1); render(); } }
  if (target.closest('#walk-next')) {
    if (walkStep < 0) {
      history.splice(0, history.length, initialWorld()); step = 0; selectedPid = 4100; selectedFrame = null; selectedObjectId = null; selectedPage = null; selectedStructure = null; actionError = ''; walkStep = 0;
    } else if (walkStep === 0) { if (!runAction({ type: 'fork', parentPid: 4100 })) return; walkStep = 1; }
    else if (walkStep === 1) { selectedPid = 4100; walkStep = 2; }
    else if (walkStep === 2) { selectedPid = 4101; walkStep = 3; }
    else if (walkStep === 3) { if (!runAction({ type: 'exit', pid: 4101 })) return; walkStep = 4; }
    else if (walkStep === 4) { if (!runAction({ type: 'reap', pid: 4101 })) return; walkStep = 5; exercise.forkWalkthroughDone = true; saveExercise(); }
    observedModules[2] = walkStep > 0; render(); return;
  }
  if (target.closest('#show-event') && moduleId !== 'case') { history.splice(0, history.length, ...guidedHistory()); step = Math.min(lessons[moduleId].focus, history.length - 1); selectedPid = 4100; selectedFrame = null; selectedObjectId = null; selectedPage = null; selectedStructure = null; actionError = ''; walkStep = -1; observedModules[moduleId] = true; if (moduleId === 4 && exercise.sizeGuess) { exercise.copyObserved = true; saveExercise(); } render(); return; }
  if (target.closest('#reset-model')) { history.splice(0, history.length, initialWorld()); step = 0; selectedPid = 4100; selectedFrame = null; selectedObjectId = null; selectedPage = null; selectedStructure = null; actionError = ''; walkStep = -1; if (!traceComplete(exercise.trace)) { exercise.trace = {}; saveExercise(); } render(); return; }
  if (target.closest('#clear-selection')) { selectedFrame = null; selectedObjectId = null; selectedPage = null; selectedStructure = null; render(); return; }
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
    const blob = new Blob([JSON.stringify({ version: 3, answers, exercises: exercise, caseStudy: caseProgress }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'forkscape-progress.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
root.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'time-range') { if (moduleId === 'case') selectCase(caseKind, Number(input.value)); else { step = Number(input.value); render(); } }
  if (input.name === 'fork-size') root.querySelector('#fork-guess-label')!.textContent = kb(forkGuesses[Number(input.value)] * 1024);
  if (input.name === 'copy-size') root.querySelector('#copy-guess-label')!.textContent = `${copyGuesses[Number(input.value)].toLocaleString()} bytes`;
});
root.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (form.id === 'case-prediction-form') {
    event.preventDefault();
    const value = new FormData(form).get('prediction');
    if (value !== null) { caseProgress.prediction = Number(value); saveCase(); render(); }
    return;
  }
  if (form.id === 'case-links-form') {
    event.preventDefault();
    const values = new FormData(form);
    const decay = values.get('decay'), leak = values.get('leak');
    caseProgress.decayCause = decay === 'decay' || decay === 'leak' ? decay : undefined;
    caseProgress.leakCause = leak === 'decay' || leak === 'leak' ? leak : undefined;
    caseProgress.evidence = String(values.get('evidence') ?? '');
    caseProgress.checked = true; saveCase(); render(); return;
  }
  if (form.id === 'classification-form') {
    event.preventDefault();
    const values = new FormData(form);
    exercise.classification = Object.fromEntries(classificationItems.flatMap(item => { const owner = values.get(item.id); return owner === 'process' || owner === 'kernel' ? [[item.id, owner as Owner]] : []; }));
    exercise.classificationChecked = true; saveExercise(); render(); return;
  }
  if (form.id === 'size-form') {
    event.preventDefault();
    const values = new FormData(form);
    exercise.sizeGuess = { forkKiB: forkGuesses[Number(values.get('fork-size'))], copyBytes: copyGuesses[Number(values.get('copy-size'))] };
    saveExercise(); render(); return;
  }
  if (form.id !== 'prediction-form') return;
  event.preventDefault();
  const value = new FormData(form).get('prediction');
  if (value === null) return;
  answers = { ...answers, [moduleId]: Number(value) };
  localStorage.setItem('forkscape-progress', JSON.stringify(answers));
  render();
});

render();
