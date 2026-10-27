import './style.css';
import './theme.css';
import { guidedHistory, memoryRows, physicalBytes, sharers, type WorldState } from './model';
import type { ForkScene } from './scene';

type ModuleId = 1 | 2 | 3 | 4;
const lessons: Record<ModuleId, { title: string; kicker: string; body: string; question: string; choices: string[]; correct: number; answer: string; onCall: string; evidence: string; focus: number }> = {
  1: { title: 'A process is more than code', kicker: '01 / PROCESS ANATOMY', body: 'A process has its own PID, address space, descriptor table, and threads. A descriptor points to an object held by the kernel. Select a deck to inspect its mappings.', question: 'Which item is the kernel object shared through a file descriptor?', choices: ['The process PID', 'The listening socket', 'The process address space'], correct: 1, answer: 'The socket lives in the kernel. The process holds a descriptor that refers to it.', onCall: 'Find the process tree with ps, memory regions in maps, descriptors in fd, and threads in task.', evidence: 'ps -o pid,ppid,rss,cmd --forest · /proc/<pid>/{maps,fd,task}', focus: 0 },
  2: { title: 'One call, two returns', kicker: '02 / FORK', body: 'The parent and child resume at the same line after fork(). The parent receives the child PID; the child receives zero. Their descriptor tables refer to the same socket.', question: 'How many times does the print after fork() run?', choices: ['Once', 'Twice', 'It depends on memory size'], correct: 1, answer: 'Both processes continue from the fork() call, so each reaches print().', onCall: 'A supervising master must reap exited children or zombies remain in the process table.', evidence: 'ps -o pid,ppid,stat,cmd --forest · waitpid()', focus: 1 },
  3: { title: 'Addresses are names', kicker: '03 / VIRTUAL MEMORY', body: 'Each deck tile is one virtual page. Its filament points through a page table to a physical frame below. The same virtual page index can later point to different frames.', question: 'Parent and child print the same address for an object. Does that prove they still share a physical frame?', choices: ['Yes', 'No', 'Only if their PIDs match'], correct: 1, answer: 'An address is meaningful inside one process. Page-table mappings decide which physical frame it reaches.', onCall: 'An identical Python id() value in two workers is not proof of shared physical memory.', evidence: '/proc/<pid>/maps · /proc/<pid>/pagemap (privilege dependent)', focus: 1 },
  4: { title: 'Copy on write', kicker: '04 / PAGE FAULT', body: 'At fork, the data pages stay shared. A first write to a shared page faults, copies the whole page, and changes only the writer’s mapping. Any process can be the writer.', question: 'A child changes one 8-byte value on a shared 4 KiB page. How many bytes are copied?', choices: ['8 bytes', '4,096 bytes', 'The entire process'], correct: 1, answer: 'The kernel copies one page: 4 KiB in this model. Later writes to that exclusive page reuse its frame.', onCall: 'Scattered small writes can grow Private_Dirty quickly; in-process changes never reach sibling workers.', evidence: '/proc/<pid>/smaps_rollup: Private_Dirty · minor faults in /proc/<pid>/stat', focus: 2 },
};

const history = guidedHistory();
const root = document.querySelector<HTMLDivElement>('#app')!;
const saved = (() => { try { return JSON.parse(localStorage.getItem('forkscape-progress') || '{}') as Record<number, number>; } catch { return {}; } })();
let answers: Record<number, number> = saved;
let moduleId: ModuleId = 1;
let step = 0;
let selectedPid = 4100;
let selectedFrame: number | null = null;
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
      <div class="scene-toolbar"><div><span class="toolbar-dot"></span> LIVE MODEL STATE <span class="toolbar-separator">/</span> <span id="scene-heading"></span></div><div class="scene-hint">Drag to orbit · click a deck</div></div>
      <div id="scene-host" class="scene-host"></div>
      <div id="flat-host" class="flat-host" hidden></div>
      <div class="scene-footer"><span>1 tile = 1 page = 4 KiB</span><span><i class="legend-swatch shared"></i> shared <i class="legend-swatch private"></i> exclusive</span><span>Physical layout is schematic</span></div>
    </section>
    <aside id="inspector" class="inspector"></aside>
    <section class="timeline-panel">
      <div class="panel-heading"><span>EVENT TIMELINE</span><span id="event-count"></span></div>
      <div class="timeline-controls"><button id="prev-step" type="button" aria-label="Previous event">◀</button><button id="next-step" type="button" aria-label="Next event">▶</button><input id="time-range" type="range" min="0" max="7" value="0" aria-label="Timeline event" /><span id="step-label"></span></div>
      <div id="event-strip" class="event-strip"></div>
    </section>
    <section class="ledger-panel"><div class="panel-heading"><span>MEMORY LEDGER</span><span>DATA PAGES · MODEL</span></div><div id="ledger"></div></section>
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
    scene.setWorld(world(), selectedPid, pid => { selectedPid = pid; selectedFrame = null; render(); });
  } catch { flat = true; render(); }
  finally { sceneLoading = false; }
}

function renderNav() {
  root.querySelector('#module-nav')!.innerHTML = ([1, 2, 3, 4] as ModuleId[]).map(id => `<button class="module-link ${moduleId === id ? 'active' : ''}" type="button" data-module="${id}"><span class="module-number">0${id}</span><span>${escapeHtml(lessons[id].title)}</span><span class="module-check">${answers[id] !== undefined ? '✓' : '↗'}</span></button>`).join('');
}

function renderLesson() {
  const lesson = lessons[moduleId];
  const answered = answers[moduleId] !== undefined;
  root.querySelector('#lesson-content')!.innerHTML = `
    <div class="lesson-kicker">${lesson.kicker}</div><h1>${escapeHtml(lesson.title)}</h1><p class="lesson-body">${escapeHtml(lesson.body)}</p>
    <div class="prediction"><div class="section-tag">PREDICT</div><p class="question">${escapeHtml(lesson.question)}</p><form id="prediction-form">${lesson.choices.map((choice, index) => `<label class="choice ${answered && answers[moduleId] === index ? 'chosen' : ''}"><input name="prediction" type="radio" value="${index}" ${answered && answers[moduleId] === index ? 'checked' : ''} ${answered ? 'disabled' : ''}/><span>${escapeHtml(choice)}</span></label>`).join('')}${answered ? '' : '<button class="primary" type="submit">Commit prediction →</button>'}</form>${answered ? `<div class="answer ${answers[moduleId] === lesson.correct ? 'correct' : 'review'}"><strong>${answers[moduleId] === lesson.correct ? 'Correct prediction' : 'Compare your prediction'}</strong><p>${escapeHtml(lesson.answer)}</p></div>` : ''}</div>
    <button id="show-event" class="event-button" type="button">${step === lesson.focus ? 'Showing key moment' : 'Show key moment →'}</button>
    <div class="on-call"><div class="section-tag">ON CALL</div><p>${escapeHtml(lesson.onCall)}</p><code>${escapeHtml(lesson.evidence)}</code></div>
  `;
}

function renderFlat(state: WorldState) {
  root.querySelector('#flat-host')!.innerHTML = `<div class="flat-title">PROCESS ADDRESS SPACES</div><div class="flat-processes">${state.processes.map(process => `<button type="button" data-pid="${process.pid}" class="flat-process ${selectedPid === process.pid ? 'selected' : ''}"><strong>${process.role.toUpperCase()} · PID ${process.pid}</strong><span>${process.status === 'zombie' ? 'ZOMBIE · mappings released' : `PPID ${process.parentPid ?? '—'} · ${process.pages.length} pages · ${process.threads} thread`}</span><span class="page-strip">${process.pages.map((id, index) => `<span title="Virtual page ${index} → frame ${id}" class="page-chip ${sharers(state, id) > 1 ? 'is-shared' : ''}">${index}→F${id}</span>`).join('')}</span></button>`).join('')}</div><div class="flat-title">PHYSICAL FRAMES</div><div class="flat-frames">${state.frames.map(frame => `<button type="button" data-frame="${frame.id}" class="flat-frame ${selectedFrame === frame.id ? 'selected' : ''}"><strong>F${frame.id}</strong><span>${escapeHtml(frame.region)}</span><small>${sharers(state, frame.id)} ${sharers(state, frame.id) === 1 ? 'mapping' : 'mappings'}</small></button>`).join('')}</div><p class="flat-note">A page chip names its virtual page and the physical frame it maps to. Shared frames have multiple mappings.</p>`;
}

function renderInspector(state: WorldState) {
  const frame = selectedFrame === null ? null : state.frames.find(f => f.id === selectedFrame);
  const process = state.processes.find(p => p.pid === selectedPid) || state.processes[0];
  const body = frame ? `<h2>Frame F${frame.id}</h2><p>${escapeHtml(frame.region)} · ${sharers(state, frame.id)} ${sharers(state, frame.id) === 1 ? 'mapping' : 'mappings'}</p><div class="inspector-rung"><span>METAPHOR</span><p>A tile on the memory floor</p></div><div class="inspector-rung"><span>MECHANISM</span><p>A physical page frame. ${sharers(state, frame.id) > 1 ? 'Several virtual pages map to it.' : 'It has one current mapping.'}</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>pagemap · /proc/kpagecount</code><small>Exact frame identity needs privileged capture on many hosts.</small></div>` : `<h2>${process.role === 'master' ? 'Master' : 'Worker'} <em>PID ${process.pid}</em></h2><p>${process.status === 'zombie' ? 'Exited · awaiting reaping' : `${process.pages.length} virtual pages · ${process.threads} thread`}</p><div class="inspector-rung"><span>METAPHOR</span><p>A glass deck with page tiles and a socket port.</p></div><div class="inspector-rung"><span>MECHANISM</span><p>Independent address space and descriptor table. ${process.role === 'worker' ? 'Fork copied its mappings; writes diverge.' : 'The parent of the worker processes.'}</p></div><div class="inspector-rung"><span>MEASUREMENT</span><code>ps -o pid,ppid,rss,cmd --forest</code><small>Regions: /proc/${process.pid}/maps<br/>Descriptors: /proc/${process.pid}/fd</small></div><div class="inspector-rung"><span>COUNTER VALUE</span><p>${process.counter} <small>in this process only</small></p></div>`;
  root.querySelector('#inspector')!.innerHTML = `<div class="panel-heading"><span>INSPECTOR</span><span>MODEL</span></div><div class="inspector-content">${body}<button id="clear-frame" type="button" class="subtle" ${frame ? '' : 'hidden'}>← Process</button></div>`;
}

function renderLedger(state: WorldState) {
  const rows = memoryRows(state);
  const totals = rows.reduce((sum, row) => ({ rss: sum.rss + row.rss, pss: sum.pss + row.pss, uss: sum.uss + row.uss }), { rss: 0, pss: 0, uss: 0 });
  root.querySelector('#ledger')!.innerHTML = `<div class="ledger-summary"><div><span>PHYSICAL DATA</span><strong>${kb(physicalBytes(state))}</strong></div><div><span>Σ RSS</span><strong>${kb(totals.rss)}</strong></div><div><span>Σ PSS</span><strong>${kb(totals.pss)}</strong></div></div><table><thead><tr><th>PROCESS</th><th>RSS</th><th>PSS</th><th>USS</th></tr></thead><tbody>${rows.map(row => `<tr class="${selectedPid === row.pid ? 'selected' : ''}" data-pid="${row.pid}"><td>${row.role === 'master' ? 'M' : 'W'} ${row.pid}${row.status === 'zombie' ? ' †' : ''}</td><td>${kb(row.rss)}</td><td>${kb(row.pss)}</td><td>${kb(row.uss)}</td></tr>`).join('')}</tbody></table><p class="ledger-note">RSS counts shared pages in every process. PSS divides each shared page among its mappers. These model figures exclude page tables, kernel memory, and page cache.</p>`;
}

function renderTimeline(state: WorldState) {
  const event = state.events.at(-1)!;
  (root.querySelector('#time-range') as HTMLInputElement).value = String(step);
  (root.querySelector('#prev-step') as HTMLButtonElement).disabled = step === 0;
  (root.querySelector('#next-step') as HTMLButtonElement).disabled = step === history.length - 1;
  root.querySelector('#step-label')!.textContent = `${step + 1} / ${history.length}`;
  root.querySelector('#event-count')!.textContent = `${history.length} STATES`;
  root.querySelector('#event-strip')!.innerHTML = history.map((item, index) => `<button type="button" data-step="${index}" class="event-tick ${index === step ? 'active' : ''}" aria-label="Step ${index + 1}: ${escapeHtml(item.events.at(-1)!.kind)}"><span class="tick-icon">${({ start: '●', fork: '⑂', cow_fault: '✦', write: '✎', exit: '×', reap: '↻' } as Record<string, string>)[item.events.at(-1)!.kind]}</span><span>${escapeHtml(item.events.at(-1)!.kind.replace('_', ' '))}</span></button>`).join('');
  root.querySelector('#terminal')!.textContent = event.terminal;
  root.querySelector('#narration')!.textContent = event.description;
  root.querySelector('#scene-heading')!.textContent = event.kind.replace('_', ' ').toUpperCase();
}

function renderCode() {
  root.querySelector('#code')!.textContent = moduleId === 2 ? `pid = os.fork()\nif pid == 0:\n    print('child: fork returned 0')\nelse:\n    print(f'parent: child is {pid}')` : moduleId === 4 ? `# Both processes begin with the same page mapping.\ncounter += 1  # 8-byte change, page-sized copy\n\n# Another process still sees its own value.` : `# Simplified process model\nmaster = Process(pid=4100)\nmaster.pages = [code, libs, heap, stack]\nmaster.fd[3] = listening_socket`;
}

function render() {
  const state = world();
  if (!state.processes.some(p => p.pid === selectedPid)) selectedPid = 4100;
  if (selectedFrame !== null && !state.frames.some(f => f.id === selectedFrame)) selectedFrame = null;
  renderNav(); renderLesson(); renderFlat(state); renderInspector(state); renderLedger(state); renderTimeline(state); renderCode();
  host.hidden = flat;
  (root.querySelector('#flat-host') as HTMLElement).hidden = !flat;
  root.querySelector('#view-toggle')!.textContent = flat ? '◈ 3D view' : '▦ Flat view';
  scene?.setWorld(state, selectedPid, pid => { selectedPid = pid; selectedFrame = null; render(); });
  void ensureScene();
}

root.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const moduleButton = target.closest<HTMLElement>('[data-module]');
  if (moduleButton) { moduleId = Number(moduleButton.dataset.module) as ModuleId; step = lessons[moduleId].focus; selectedFrame = null; render(); return; }
  const stepButton = target.closest<HTMLElement>('[data-step]');
  if (stepButton) { step = Number(stepButton.dataset.step); render(); return; }
  const pidButton = target.closest<HTMLElement>('[data-pid]');
  if (pidButton) { selectedPid = Number(pidButton.dataset.pid); selectedFrame = null; render(); return; }
  const frameButton = target.closest<HTMLElement>('[data-frame]');
  if (frameButton) { selectedFrame = Number(frameButton.dataset.frame); render(); return; }
  if (target.closest('#prev-step')) { step = Math.max(0, step - 1); render(); }
  if (target.closest('#next-step')) { step = Math.min(history.length - 1, step + 1); render(); }
  if (target.closest('#show-event')) { step = lessons[moduleId].focus; render(); }
  if (target.closest('#clear-frame')) { selectedFrame = null; render(); }
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
  step = lessons[moduleId].focus;
  render();
});

render();
