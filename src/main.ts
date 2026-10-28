import './style.css';
import './theme.css';
import './reference.css';
import './recording.css';
import { escapeHtml, kb, regionPages, selectionDetail, type Detail } from './detail';
import { applyAction, assertInvariants, chargedBytes, initialWorld, mappedPages, memoryRows, objectRefCount, pageTableBytes, physicalBytes, pssBreakdown, regionForPage, residentPages, sharers, type Action, type ProcessState, type RegionState, type WorldState } from './model';
import { scenarioById, scenarios, scenarioStates, seriesValue, stepFocus, type ChartSeries, type Scenario, type ScenarioRun } from './scenarios';
import { captureMarks, stepLinks } from './motion';
import { buildReplay, formatCount, formatSeconds, MAX_RECORDING_BYTES, parseRecording, recordingText, TILE_BUDGETS, type ParsedRecording, type Replay, type TraceEvent } from './recording';
import { CAPTURE_STORAGE_KEY, MAX_CAPTURE_BYTES, isCaptureText, parseCapture } from './capture';
import { NODE_STORAGE_KEY, MAX_NODE_BYTES, fromRawKubeletSummary, isKubeletSummaryText, isNodeCaptureText, parseNodeCapture } from './node-capture';
import type { ForkScene, SceneSelection, StructurePart } from './scene';

type Mode = { kind: 'library' } | { kind: 'scenario'; scenario: Scenario } | { kind: 'sandbox' } | { kind: 'recording' };
type PanelId = 'scenarios' | 'inspector' | 'timeline' | 'ledger' | 'view';
const panelLabels: Record<PanelId, string> = { scenarios: 'Scenarios', inspector: 'Inspector', timeline: 'Event timeline', ledger: 'Memory ledger', view: 'Camera & legend' };
const groupLabels = { memory: 'Memory', handles: 'Handles & threads' } as const;

let mode: Mode = { kind: 'library' };
let history: WorldState[] = [initialWorld()];
let step = 0;
let sandboxHistory: WorldState[] = [initialWorld()];
let sandboxStep = 0;
let sandboxOrigin: { title: string; href: string; step: number; fixed: boolean; stepWord: 'step' | 'stage' } | null = null;
// A recording opened in this tab, replayed. It is read here and never uploaded; a copy in session storage survives a reload.
let recording: { parsed: ParsedRecording; replay: Replay; fileName: string; sample: SampleId | null } | null = null;
let recordingStatus: { tone: 'info' | 'error'; text: string } | null = null;
let recordingAttempt = 0;
/** Synthetic recording that ships with the app, opened from the picker or by deep link. */
const SAMPLES = {
  sample: { url: '/recordings/synthetic-gunicorn-boot.json', name: 'the synthetic example' },
} as const;
type SampleId = keyof typeof SAMPLES;
const sampleId = (id: string) => id.startsWith('recording/') && id.slice(10) in SAMPLES ? id.slice(10) as SampleId : null;
const RECORDING_KEY = 'forkscape-recording';
// A scenario replays its problem, or the same setup with its fix applied.
let fixed = false;
// The state last drawn, so a step can link what it adds to what was there.
let shownWorld: WorldState | null = null;
const runHistories = new Map<ScenarioRun, WorldState[]>();
let selectedPid = 4100;
let selectedFrame: number | null = null;
let selectedObjectId: string | null = null;
let selectedPage: { pid: number; page: number } | null = null;
let selectedStructure: { pid: number; part: StructurePart; index: number } | null = null;
let actionError = '';
let flat = (() => { try { return localStorage.getItem('forkscape-flat') === 'true'; } catch { return false; } })();
let scene: ForkScene | null = null;
let sceneLoading = false;
// A bare visit opens on the visualization; an explicit deep link opens its panel.
let openPanel: PanelId | null = location.hash ? 'scenarios' : null;
let menuOpen = false;
let selectionCardOpen = false;
let accountingOpen = false;
// Disclosures in the recording panel stay as the reader left them while stepping.
const openDetails = new Set<string>();
// On narrow screens the scenario panel is a sheet under the scene: collapsed to its head and dock, or expanded to everything.
let sheetExpanded = false;
const narrow = matchMedia('(max-width: 899px)');

const root = document.querySelector<HTMLDivElement>('#app')!;
const world = () => history[step];
const statesFor = (run: ScenarioRun) => {
  if (!runHistories.has(run)) runHistories.set(run, scenarioStates(run));
  return runHistories.get(run)!;
};
const activeRun = (scenario: Scenario): ScenarioRun => fixed ? scenario.fix : scenario;
const chartOf = (scenario: Scenario) => activeRun(scenario).chart ?? scenario.chart;
// Chart colour follows the metric, so RSS is the same colour in every scenario.
const metricClass = (series: ChartSeries) => series.metric === 'rss' || series.metric === 'sumRss' ? 'metric-rss' : series.metric === 'pss' || series.metric === 'uss' || series.metric === 'sumPss' ? 'metric-pss' : 'metric-memory';
const sumOf = (state: WorldState, key: 'rss' | 'pss') => memoryRows(state).reduce((sum, row) => sum + row[key], 0);
// The RSS/PSS comparison is shown when a scenario depends on it, or when the reader opens it.
const accountingVisible = () => mode.kind === 'scenario' ? !!mode.scenario.accounting || mode.scenario.group === 'memory' && accountingOpen : mode.kind === 'recording' ? !!recording : mode.kind === 'sandbox' && accountingOpen;
// A step's 3D labels name only what it changed from the step before, so the first step names everything.
const labelBaseline = () => (mode.kind === 'scenario' || mode.kind === 'recording' && recording) && step > 0 ? history[step - 1] : null;
const replaying = () => mode.kind === 'recording' && recording ? recording.replay : null;

const caret = '<svg viewBox="0 0 5 3" width="10" height="6" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M0 0h5v1H4v1H3v1H2V2H1V1H0z"/></svg>';
// The sheet's head names what the panel shows. On narrow screens it carries the sheet's expand and close buttons.
const sheetHead = (title: string, more: string) => `<div class="sheet-head"><h1 tabindex="-1">${escapeHtml(title)}</h1><button id="sheet-toggle" class="sheet-toggle" type="button" aria-expanded="${sheetExpanded}" aria-controls="scenario-content" aria-label="${more}">${caret}</button><button class="panel-close sheet-close" type="button" data-close-panel aria-label="Close panel">×</button></div>`;

const drawer = (id: PanelId, meta: string, body: string, className = '', metaId = '') => `<section class="drawer-panel ${className}" data-panel-id="${id}" aria-label="${escapeHtml(panelLabels[id])}" tabindex="-1" hidden><div class="panel-heading"><span>${escapeHtml(panelLabels[id])}</span><span class="panel-meta"${metaId ? ` id="${metaId}"` : ''}>${meta}</span><button class="panel-close" type="button" data-close-panel aria-label="Close ${escapeHtml(panelLabels[id].toLowerCase())}">×</button></div>${body}</section>`;

root.innerHTML = `
  <div class="menu-dock">
    <button id="menu-toggle" class="menu-toggle" type="button" aria-label="Forkscape menu" aria-expanded="false" aria-controls="panel-menu"><img class="brand-mark" src="/favicon.svg" alt="" width="32" height="32" /><span class="brand">FORKSCAPE</span>${caret.replace('<svg', '<svg class="menu-caret"')}</button>
    <nav id="panel-menu" class="panel-menu" aria-label="Forkscape menu" hidden><div class="menu-heading"><span>A process memory lab</span><span class="badge">Model</span></div><button type="button" data-panel="scenarios" aria-pressed="false">Scenarios</button><a href="#recording" data-mode="recording">Replay telemetry</a><a href="#explore" data-mode="sandbox">Free exploration</a><div class="menu-divider" role="separator"></div>${(['inspector', 'timeline', 'ledger', 'view'] as PanelId[]).map(id => `<button type="button" data-panel="${id}" aria-pressed="false">${escapeHtml(panelLabels[id])}</button>`).join('')}</nav>
  </div>
  <button id="view-toggle" class="view-toggle" type="button"></button>
  <main class="workspace">
    ${drawer('scenarios', 'Model', '<section id="scenario-content" class="scenario-content"></section>', 'lesson-rail', 'scenario-meta')}
    ${drawer('inspector', 'Model', '<div id="inspector" class="inspector"></div>', '', 'inspector-meta')}
    ${drawer('timeline', '', '<div class="timeline-controls"><button id="prev-step" type="button" aria-label="Previous state">◀</button><button id="next-step" type="button" aria-label="Next state">▶</button><input id="time-range" type="range" min="0" max="0" value="0" aria-label="Timeline state" /><span id="step-label"></span></div><div id="event-strip" class="event-strip"></div>', 'timeline-panel', 'event-count')}
    ${drawer('ledger', 'Model · page tables included in charge', '<div id="ledger"></div><details class="reference-evidence"><summary>Linux reference observations · VM probes</summary><p>Residency: a new mapping has 0 KiB RSS until touched, and reading untouched anonymous pages leaves it at 0. After fork, a child’s RSS includes anonymous pages but not file pages that were never written. Its first touch maps them from the page cache. A child’s copy-on-write write left its RSS unchanged and added 4 KiB of <code>Private_Dirty</code>.</p><p>Django 6.1 under Gunicorn with preload and 2 workers: Σ RSS 259.8–259.9 MiB at boot against Σ PSS 90.2–90.3 MiB. One read-only catalog scan per worker added 55.2 MiB of Σ PSS and no Σ RSS.</p><p>Page tables: parent <code>VmPTE</code> rose by 0–8 KiB after mapping 16–1,024 pages, from a 76–80 KiB process-wide baseline. Those readings cannot isolate a mapping’s page tables.</p><p>With a 64 MiB cgroup limit, <code>memory.events: oom_kill</code> rose by one in each run. The kernel killed the child with the higher <code>oom_score_adj</code>; the model’s victim choice is only a teaching rule.</p></details>', 'ledger-panel', 'ledger-meta')}
    ${drawer('view', 'Model', '<div class="panel-body"><h2 class="section-tag">3D camera</h2><div class="camera-controls" role="group" aria-label="3D camera controls"><button type="button" data-camera="overview">Overview</button><button type="button" data-camera="process">Decks</button><button type="button" data-camera="memory">Frames</button><button type="button" data-zoom="in" aria-label="Zoom in">＋</button><button type="button" data-zoom="out" aria-label="Zoom out">−</button></div><h2 class="section-tag">Legend</h2><ul class="legend"><li id="legend-tile">1 tile = 1 page = 4 KiB</li><li><i class="legend-swatch shared"></i>shared</li><li><i class="legend-swatch private"></i>exclusive</li><li><i class="legend-swatch absent"></i>mapped, not resident</li><li><i class="legend-line filament"></i>thin line: a page mapped to its frame</li><li><i class="legend-line cable"></i>cable: a descriptor open on a kernel object</li><li>Physical layout is schematic</li></ul></div>', '', 'view-meta')}
    <section class="scene-column" aria-label="Process and memory visualization">
      <div id="scene-host" class="scene-host"></div>
      <div id="flat-host" class="flat-host" hidden></div>
      <section id="selection-card" class="selection-card" aria-label="Selection" hidden><button id="close-selection-card" class="panel-close" type="button" aria-label="Close selection details">×</button><div id="selection-card-heading" aria-live="polite"></div><div id="selection-card-detail" class="selection-detail"></div><button id="open-inspector" class="subtle" type="button">Open in inspector</button></section>
    </section>
  </main>
  <div id="narration" class="sr-only" aria-live="polite"></div>
  <div id="drop-veil" class="drop-veil" hidden><p>Drop telemetry to open it</p></div>
`;

const host = root.querySelector<HTMLElement>('#scene-host')!;
const hasTimeline = () => history.length > 1;
function renderChrome() {
  if (openPanel === 'timeline' && !hasTimeline()) openPanel = null;
  const toggle = root.querySelector<HTMLButtonElement>('#menu-toggle')!;
  toggle.setAttribute('aria-expanded', String(menuOpen));
  root.querySelector<HTMLElement>('#panel-menu')!.hidden = !menuOpen;
  root.querySelector<HTMLElement>('[data-panel="timeline"]')!.hidden = !hasTimeline();
  root.querySelectorAll<HTMLElement>('[data-panel]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.panel === openPanel && (item.dataset.panel !== 'scenarios' || mode.kind === 'scenario' || mode.kind === 'library'))));
  root.querySelectorAll<HTMLElement>('[data-mode]').forEach(item => {
    if (item.dataset.mode === mode.kind) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  root.querySelectorAll<HTMLElement>('[data-panel-id]').forEach(panel => { panel.hidden = panel.dataset.panelId !== openPanel; });
  const contentLabel = mode.kind === 'recording' ? 'Replay telemetry' : mode.kind === 'sandbox' ? 'Free exploration' : 'Scenarios';
  const contentPanel = root.querySelector<HTMLElement>('[data-panel-id="scenarios"]')!;
  contentPanel.setAttribute('aria-label', contentLabel);
  contentPanel.querySelector<HTMLElement>('.panel-heading>span')!.textContent = contentLabel;
  contentPanel.querySelector<HTMLButtonElement>('.panel-heading .panel-close')!.setAttribute('aria-label', `Close ${contentLabel.toLowerCase()}`);
  // Opening or closing a panel resizes the scene, so the camera frames the whole model again.
  const workspace = root.querySelector('.workspace')!;
  if (workspace.classList.contains('panel-open') !== (openPanel !== null)) { workspace.classList.toggle('panel-open'); scene?.fitView(); }
  root.querySelector('[data-panel-id="scenarios"]')!.classList.toggle('sheet-expanded', sheetExpanded);
  workspace.classList.toggle('sheet-expanded', openPanel === 'scenarios' && sheetExpanded);
  root.querySelector('#sheet-toggle')?.setAttribute('aria-expanded', String(sheetExpanded));
  // The inspector says everything the card does, so the card gives way to it.
  const card = root.querySelector<HTMLElement>('#selection-card')!;
  card.hidden = !selectionCardOpen || openPanel === 'inspector';
  root.querySelector('.scene-column')!.classList.toggle('card-open', !card.hidden);
  // Every view says whether it shows the model or a recording replayed through it.
  const source = world().source === 'model' ? 'Model' : 'Recording';
  root.querySelector('.menu-heading .badge')!.textContent = source;
  root.querySelector('#inspector-meta')!.textContent = source;
  root.querySelector('#view-meta')!.textContent = source;
  root.querySelector('#ledger-meta')!.textContent = `${source} · page tables included in charge`;
  const tiles = world().tilePages ?? 1;
  root.querySelector('#legend-tile')!.textContent = tiles > 1 ? `1 tile = ${formatCount(tiles)} pages = ${kb(world().pageSize)}` : `1 tile = 1 page = ${kb(world().pageSize)}`;
}
function showPanel(id: PanelId | null) {
  openPanel = id; menuOpen = false;
  if (id === 'inspector') selectionCardOpen = false;
  renderChrome();
  root.querySelector<HTMLElement>(id ? `[data-panel-id="${id}"]` : '#menu-toggle')!.focus({ preventScroll: true });
}
async function ensureScene() {
  if (scene || flat || sceneLoading) return;
  sceneLoading = true;
  try {
    const { ForkScene } = await import('./scene');
    if (flat) return;
    scene = new ForkScene(host);
    scene.showAccounting = accountingVisible();
    scene.changedSince = labelBaseline();
    scene.setWorld(world(), selectedPid, selectedPage, selectedFrame, selectedObjectId, selectedStructure, selection => { selectVisual(selection); });
  } catch { flat = true; render(); }
  finally { sceneLoading = false; }
}

// A new scenario, mode, model, or view starts from the whole model. Stepping, selecting, and acting keep the reader's camera and scroll position.
function resetView() {
  scene?.fitView();
  root.querySelector('#flat-host')!.scrollTop = 0;
}
function clearSelection() { selectedFrame = null; selectedObjectId = null; selectedPage = null; selectedStructure = null; }
function focusScenarioStep(scenario: Scenario) {
  const focus = stepFocus(activeRun(scenario), step, world());
  clearSelection();
  selectedPid = focus.pid;
  selectedPage = focus.page === null ? null : { pid: focus.pid, page: focus.page };
}
// A stage points at the process and tile its last change touched.
function focusStage(replay: Replay) {
  const { focus } = replay.stages[step];
  clearSelection();
  selectedPid = focus.pid;
  selectedPage = focus.page === null ? null : { pid: focus.pid, page: focus.page };
}
function goToStep(index: number) {
  step = Math.max(0, Math.min(history.length - 1, index));
  selectionCardOpen = false;
  const replay = replaying();
  if (mode.kind === 'scenario') focusScenarioStep(mode.scenario);
  else if (replay) focusStage(replay);
  else if (mode.kind === 'sandbox') sandboxStep = step;
  render(true);
}
// Switching between the problem and its fix keeps the step, so the same moment can be compared in both runs.
function showRun(fix: boolean) {
  if (mode.kind !== 'scenario' || fix === fixed) return;
  fixed = fix; history = statesFor(activeRun(mode.scenario)); step = Math.min(step, history.length - 1);
  selectionCardOpen = false;
  focusScenarioStep(mode.scenario);
  render();
}

function applyHash(userNavigation: boolean) {
  const id = decodeURIComponent(location.hash.slice(1));
  const scenario = scenarioById(id);
  actionError = ''; selectionCardOpen = false; fixed = false;
  if (id === 'explore') {
    mode = { kind: 'sandbox' }; history = sandboxHistory; step = sandboxStep; clearSelection();
  } else if (id === 'recording' || sampleId(id)) {
    mode = { kind: 'recording' };
    const sample = sampleId(id);
    if (sample && recording?.sample !== sample) void openSample(sample);
    else if (!recording) restoreRecording();
    showLoadedRecording();
  } else if (scenario) {
    mode = { kind: 'scenario', scenario }; history = statesFor(scenario); step = 0; focusScenarioStep(scenario);
  } else {
    mode = { kind: 'library' }; history = [initialWorld()]; step = 0; selectedPid = 4100; clearSelection();
  }
  if (userNavigation) { openPanel = 'scenarios'; menuOpen = false; }
  // The library and the recording picker are lists to choose from, so their sheets open expanded; a scenario, recording, or free exploration opens on the scene.
  sheetExpanded = mode.kind === 'library' || mode.kind === 'recording' && !recording;
  render();
  resetView();
  if (userNavigation) root.querySelector<HTMLElement>('#scenario-content h1')?.focus({ preventScroll: true });
  root.querySelector('[data-panel-id="scenarios"]')!.scrollTop = 0;
}

function renderLibrary() {
  const card = (scenario: Scenario) => `<li><a class="scenario-card" href="#${scenario.id}"><strong>${escapeHtml(scenario.title)}</strong><span>${escapeHtml(scenario.symptom)}</span>${scenario.accounting ? '<em class="card-tag">RSS vs PSS</em>' : ''}</a></li>`;
  return `<div class="lesson-kicker">Scenario library</div>${sheetHead('Fork and memory problems, replayed', 'Scenario list')}
    <p class="lesson-body">Each scenario replays a production problem in a model of a Gunicorn master and its workers. Step through it and watch the scene, then select any process, page, or frame to see how it works.</p>
    ${(Object.keys(groupLabels) as (keyof typeof groupLabels)[]).map(group => `<h2 class="section-tag">${escapeHtml(groupLabels[group])}</h2><ul class="scenario-list">${scenarios.filter(scenario => scenario.group === group).map(card).join('')}</ul>`).join('')}`;
}

function niceCeiling(value: number) {
  return [16, 32, 48, 64, 96, 128, 160, 192, 256, 384, 512, 768, 1024].find(candidate => candidate >= value * 1.05) ?? Math.ceil(value / 256) * 256;
}

// The problem and the fix share one scale, so switching runs redraws the lines against the same axis.
function chartScale(scenario: Scenario) {
  return niceCeiling(Math.max(...[scenario, scenario.fix].flatMap(run => {
    const chart = (run.chart ?? scenario.chart)!;
    return statesFor(run).flatMap(state => [...chart.series.map(series => seriesValue(state, series) ?? 0), chart.limit ? state.limitBytes ?? 0 : 0]);
  })) / 1024);
}

/** A chart of byte values by step: a scenario's series, or a recording's. The scale is fixed for the whole run, so stepping never rescales it. */
type ChartSpec = { title: string; stepWord: 'Step' | 'Stage'; series: { label: string; className: string; values: (number | null)[] }[]; limit: number | null; max: number; unit: 'KiB' | 'MiB' };
let shownChart: ChartSpec | null = null;
function scenarioChart(scenario: Scenario, states: WorldState[]): ChartSpec | null {
  const chart = chartOf(scenario);
  if (!chart) return null;
  return { title: scenario.title, stepWord: 'Step', unit: 'KiB', max: chartScale(scenario) * 1024,
    series: chart.series.map(series => ({ label: series.label, className: metricClass(series), values: states.map(state => seriesValue(state, series)) })),
    limit: chart.limit ? states.find(state => state.limitBytes !== null)?.limitBytes ?? null : null };
}
// Recordings reach MiB, so their axis takes a 1–2–2.5–5 ceiling in whichever unit reads best.
function recordingChart(replay: Replay): ChartSpec {
  const peak = Math.max(1024, replay.chart.limit ?? 0, ...replay.chart.series.flatMap(series => series.values.map(value => value ?? 0)));
  const unit = peak >= 4 * 1048576 ? 'MiB' : 'KiB', size = unit === 'MiB' ? 1048576 : 1024;
  const scaled = peak * 1.05 / size, power = 10 ** Math.floor(Math.log10(scaled));
  const max = unit === 'KiB' ? niceCeiling(peak / 1024) * 1024 : ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(step => step * power >= scaled)! * power) * size;
  return { title: replay.meta.title, stepWord: 'Stage', unit, max, limit: replay.chart.limit,
    series: replay.chart.series.map(series => ({ label: series.label, className: `${series.metric === 'rss' ? 'metric-rss' : 'metric-memory'}${series.line === 'solid' ? '' : ` line-${series.line}`}`, values: series.values })) };
}
const inUnit = (spec: ChartSpec, bytes: number) => spec.unit === 'KiB' ? bytes / 1024 : +(bytes / 1048576).toFixed(spec.max >= 20 * 1048576 ? 0 : 1);

function renderChart(spec: ChartSpec | null) {
  shownChart = spec;
  if (!spec) return '';
  const count = spec.series[0]?.values.length ?? 1;
  const width = 360, height = 154, left = 54, right = 14, top = 12, bottom = 26;
  const values = spec.series.map(series => series.values.map(value => value === null ? null : inUnit(spec, value)));
  const limit = spec.limit, yMax = inUnit(spec, spec.max);
  const x = (index: number) => left + (count === 1 ? 0 : index * (width - left - right) / (count - 1));
  const y = (value: number) => top + (1 - value / yMax) * (height - top - bottom);
  const path = (series: (number | null)[]) => series.reduce<string>((d, value, index) => value === null ? d : `${d}${index === 0 || series[index - 1] === null ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`, '');
  const ticks = [0, yMax / 2, yMax];
  const band = count === 1 ? width - left - right : (width - left - right) / (count - 1);
  // A long run labels every nth step, so the numbers stay apart.
  const every = Math.ceil(count / 12);
  const current = values.map(series => series[step]);
  const reading = (value: number | null) => value === null ? '—' : `${value} ${spec.unit}`;
  return `<figure class="chart" aria-label="${escapeHtml(spec.series.map(series => series.label).join(' and '))} by ${spec.stepWord.toLowerCase()}">
    <ul class="chart-legend">${spec.series.map((series, index) => `<li><i class="line-key ${series.className}" aria-hidden="true"></i><span>${escapeHtml(series.label)}</span><strong class="legend-value">${[...new Set(values[index].map(reading))].map(text => `<span${text === reading(current[index]) ? '' : ' aria-hidden="true"'}>${text}</span>`).join('')}</strong></li>`).join('')}</ul>
    <div class="chart-plot"><svg viewBox="0 0 ${width} ${height}" role="img" aria-hidden="true">
      ${ticks.map(tick => `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}"/><text class="chart-tick" x="${left - 6}" y="${y(tick) + 4}" text-anchor="end">${+tick.toFixed(2)}${tick === yMax ? ` ${spec.unit}` : ''}</text>`).join('')}
      ${values[0].map((_, index) => index % every && index !== count - 1 ? '' : `<text class="chart-tick" x="${x(index)}" y="${height - 6}" text-anchor="middle">${index + 1}</text>`).join('')}
      ${limit === null ? '' : `<line class="chart-limit" x1="${left}" x2="${width - right}" y1="${y(inUnit(spec, limit))}" y2="${y(inUnit(spec, limit))}"/><text class="chart-tick chart-limit-label" x="${width - right}" y="${y(inUnit(spec, limit)) - 5}" text-anchor="end">limit ${kb(limit)}</text>`}
      <line class="chart-cursor" data-motion="chart/cursor" x1="${x(step)}" x2="${x(step)}" y1="${top}" y2="${height - bottom}"/>
      ${values.map((series, index) => `<path class="chart-line ${spec.series[index].className}" d="${path(series)}"/>`).join('')}
      ${values.map((series, index) => series[step] === null || series[step] === undefined ? '' : `<circle class="chart-dot ${spec.series[index].className}" data-motion="chart/dot/${index}" cx="${x(step)}" cy="${y(series[step]!)}" r="4"/>`).join('')}
      <line class="chart-hover" x1="0" x2="0" y1="${top}" y2="${height - bottom}" hidden/>
      ${values[0].map((_, index) => `<rect class="chart-hit" data-chart-step="${index}" x="${x(index) - band / 2}" y="0" width="${band}" height="${height}"/>`).join('')}
    </svg><div class="chart-tip" hidden></div></div>
    <div class="sr-only"><table><caption>${escapeHtml(spec.title)}: values by ${spec.stepWord.toLowerCase()}, in ${spec.unit}</caption><thead><tr><th>${spec.stepWord}</th>${spec.series.map(series => `<th>${escapeHtml(series.label)}</th>`).join('')}</tr></thead><tbody>${values[0].map((_, index) => `<tr><td>${index + 1}</td>${values.map(series => `<td>${series[index] ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  </figure>`;
}

function showChartTip(target: SVGRectElement) {
  const figure = target.closest<HTMLElement>('.chart'), spec = shownChart;
  if (!spec || !figure) return;
  const index = Number(target.dataset.chartStep);
  const tip = figure.querySelector<HTMLElement>('.chart-tip')!, hover = figure.querySelector<SVGLineElement>('.chart-hover')!;
  const centre = Number(target.getAttribute('x')) + Number(target.getAttribute('width')) / 2;
  hover.setAttribute('x1', String(centre)); hover.setAttribute('x2', String(centre)); hover.removeAttribute('hidden');
  const heading = document.createElement('span');
  heading.className = 'chart-tip-step';
  heading.textContent = `${spec.stepWord} ${index + 1}`;
  tip.replaceChildren(heading, ...spec.series.map(item => {
    const row = document.createElement('span'), key = document.createElement('i'), value = document.createElement('strong'), label = document.createElement('span');
    key.className = `line-key ${item.className}`;
    const amount = item.values[index];
    value.textContent = amount === null || amount === undefined ? '—' : kb(amount);
    label.textContent = item.label;
    row.append(key, value, label);
    return row;
  }));
  tip.hidden = false;
  // The tip centres on the step but stays inside the plot, however wide its labels make it.
  const plot = tip.parentElement!.clientWidth, half = tip.offsetWidth / 2;
  tip.style.left = `${half * 2 >= plot ? plot / 2 : Math.min(Math.max(centre / 360 * plot, half), plot - half)}px`;
}
function hideChartTip(figure: Element) {
  figure.querySelector<HTMLElement>('.chart-tip')!.hidden = true;
  figure.querySelector('.chart-hover')!.setAttribute('hidden', '');
}

// One bar pair per process: RSS draws every resident page at full width; PSS shrinks each shared page to its share.
function renderAccounting(state: WorldState) {
  const running = state.processes.filter(process => process.status === 'running' && residentPages(process) > 0);
  if (!running.length) return '<p class="accounting-empty">No running process has resident pages.</p>';
  const rows = memoryRows(state);
  const width = 360, nameWidth = 64, metricWidth = 36, valueWidth = 76, bar = 14, rowGap = 4, groupGap = 14;
  // One scale and one height for the whole timeline, and for both of a scenario's runs: stepping or switching runs grows the bars instead of rescaling them or moving what follows.
  const timeline = mode.kind === 'scenario' ? [...statesFor(mode.scenario), ...statesFor(mode.scenario.fix)] : replaying()?.states ?? history;
  const slots = Math.max(running.length, ...timeline.map(item => item.processes.filter(process => process.status === 'running' && residentPages(process) > 0).length));
  const scale = (width - nameWidth - metricWidth - valueWidth) / Math.max(...[state, ...timeline].flatMap(item => memoryRows(item).map(row => row.rss)));
  const group = 2 * bar + rowGap, height = slots * group + (slots - 1) * groupGap + 2;
  const svg = running.map((process, index) => {
    const top = 1 + index * (group + groupGap), row = rows.find(item => item.pid === process.pid)!;
    const pages = process.pages.flatMap((id, page) => id === null ? [] : [{ page, id, count: sharers(state, id) }]).sort((a, b) => a.count - b.count || a.page - b.page);
    const bars = (['RSS', 'PSS'] as const).map((metric, line) => {
      const y = top + line * (bar + rowGap);
      let x = nameWidth + metricWidth;
      const segments = pages.map(({ page, id, count }) => {
        const bytes = metric === 'RSS' ? state.pageSize : state.pageSize / count, w = bytes * scale;
        const selected = selectedPage?.pid === process.pid && selectedPage.page === page ? ' selected' : '';
        const rect = `<rect class="acct-seg ${count > 1 ? 'shared' : 'exclusive'}${selected}" data-motion="p/${process.pid}/acct/${metric}/${page}" data-page="${page}" data-page-pid="${process.pid}" x="${x.toFixed(2)}" y="${y}" width="${Math.max(w - (w > 3 ? 1 : 0), .6).toFixed(2)}" height="${bar}"><title>PID ${process.pid} page ${page} · frame F${id} · ${count > 1 ? `shared by ${count}` : 'exclusive'} · ${metric} counts ${kb(bytes)}</title></rect>`;
        x += w;
        return rect;
      }).join('');
      return `<text class="acct-metric" x="${nameWidth}" y="${y + bar - 3}">${metric}</text>${segments}<text class="acct-value" x="${width}" y="${y + bar - 3}" text-anchor="end">${kb(metric === 'RSS' ? row.rss : row.pss)}</text>`;
    }).join('');
    return `<text class="acct-name" x="0" y="${top + bar - 3}">${process.role === 'master' ? 'M' : 'W'} ${process.pid}</text>${bars}`;
  }).join('');
  const sumRss = sumOf(state, 'rss'), sumPss = sumOf(state, 'pss');
  return `<div class="acct-figure">
    <ul class="acct-legend"><li><i class="legend-swatch private"></i>exclusive page</li><li><i class="legend-swatch shared"></i>shared page: full size in each RSS, split among its sharers in PSS</li></ul>
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${svg}</svg>
    <div class="acct-totals"><div><span>Σ RSS</span><strong>${kb(sumRss)}</strong></div><div><span>Σ PSS · in use</span><strong>${kb(sumPss)}</strong></div><div class="overcount"><span>RSS overcount</span><strong>${kb(sumRss - sumPss)}</strong></div></div>
    <div class="sr-only"><table><caption>RSS and PSS by process at this step</caption><thead><tr><th>Process</th><th>RSS</th><th>PSS</th><th>Exclusive</th><th>Shared</th></tr></thead><tbody>${running.map(process => { const row = rows.find(item => item.pid === process.pid)!, split = pssBreakdown(state, process); return `<tr><td>PID ${process.pid}</td><td>${kb(row.rss)}</td><td>${kb(row.pss)}</td><td>${kb(split.exclusive)}</td><td>${split.shared.map(item => `${kb(item.bytes)} shared by ${item.sharers}`).join(', ') || 'none'}</td></tr>`; }).join('')}</tbody></table></div>
  </div>`;
}

function renderContrast(scenario: Scenario) {
  const contrast = scenario.contrast!, other = scenarioById(contrast.scenario)!;
  const finals = [{ label: `<a href="#${other.id}">${escapeHtml(contrast.label)}</a>`, state: statesFor(other).at(-1)! }, { label: escapeHtml(contrast.ownLabel), state: statesFor(scenario).at(-1)! }];
  const cell = (key: 'rss' | 'pss', index: number) => {
    const [mine, theirs] = [sumOf(finals[index].state, key), sumOf(finals[1 - index].state, key)];
    return `<td class="${mine > theirs ? 'is-higher' : ''}">${kb(mine)}${mine > theirs ? ' <small>higher</small>' : ''}</td>`;
  };
  return `<table class="contrast"><caption>Both setups after both workers load the app</caption><thead><tr><th><span class="sr-only">Setup</span></th><th>Σ RSS</th><th>Σ PSS · in use</th></tr></thead><tbody>${finals.map((item, index) => `<tr><th>${item.label}</th>${cell('rss', index)}${cell('pss', index)}</tr>`).join('')}</tbody></table>`;
}

function renderAccountingSection(scenario: Scenario | null) {
  const replay = replaying();
  if (replay) return `<section class="accounting key" aria-label="RSS versus PSS"><h2 class="section-tag">RSS vs PSS</h2><p>RSS counts every resident page a process maps, shared or not, so Σ RSS counts a shared page once per process. PSS splits each shared page among the processes that map it, so Σ PSS is the memory in use.${replay.tilePages > 1 ? ` These bars count tiles of ${formatCount(replay.tilePages)} pages; the chart counts every page.` : ''}</p>${renderAccounting(world())}</section>`;
  if (scenario?.accounting) return `<section class="accounting key" aria-label="RSS versus PSS"><h2 class="section-tag">RSS vs PSS</h2><p>${escapeHtml(scenario.accounting)}</p>${scenario.contrast ? renderContrast(scenario) : ''}${renderAccounting(world())}</section>`;
  return `<details class="accounting"${accountingOpen ? ' open' : ''}><summary id="accounting-summary">Compare RSS and PSS ${scenario ? 'at this step' : 'in this state'}</summary>${renderAccounting(world())}</details>`;
}

function renderScenario(scenario: Scenario) {
  const states = history, index = scenarios.filter(item => item.group === scenario.group).indexOf(scenario) + 1;
  const total = scenarios.filter(item => item.group === scenario.group).length;
  const runButton = (run: 'problem' | 'fix', label: string) => `<button type="button" data-run="${run}" aria-pressed="${(run === 'fix') === fixed}">${label}</button>`;
  // Both runs' steps share one grid cell, so switching runs moves nothing below the stepper either.
  const slides = [scenario, scenario.fix].flatMap(run => run.steps.map((item, index) => `<div class="step-slide${run === activeRun(scenario) && index === step ? ' is-current' : ''}"><p class="step-caption">${escapeHtml(item.caption)}</p><p class="step-event">${escapeHtml(statesFor(run)[index].events.at(-1)!.description)}</p></div>`));
  return `<a class="back-link" href="#scenarios"><span aria-hidden="true">←</span> All scenarios</a>
    <div class="lesson-kicker">${escapeHtml(groupLabels[scenario.group])} · ${index} of ${total}</div>${sheetHead(scenario.title, 'Scenario details')}
    <p class="symptom">${escapeHtml(scenario.symptom)}</p>
    <div class="step-detail"><h2 class="section-tag">This step</h2><p>${escapeHtml(states[step].events.at(-1)!.description)}</p></div>
    <div class="stepper${fixed ? ' is-fix' : ''}">
      <div class="run-toggle" role="group" aria-label="Replay">${runButton('problem', 'The problem')}${runButton('fix', 'The fix')}</div>
      <div class="stepper-controls"><button id="scenario-prev" type="button" ${step === 0 ? 'disabled' : ''}><span aria-hidden="true">◀</span> Back</button><span class="step-count">Step ${step + 1} / ${states.length}</span><button id="scenario-next" class="step-next" type="button" ${step === states.length - 1 ? 'disabled' : ''}>Next <span aria-hidden="true">▶</span></button></div>
      <div class="step-slides">${slides.join('')}</div>
    </div>
    ${renderChart(scenarioChart(scenario, states))}
    ${scenario.group === 'memory' ? renderAccountingSection(scenario) : ''}
    <div class="scenario-note"><h2 class="section-tag">What to watch</h2><p>${escapeHtml(activeRun(scenario).watch)}</p></div>
    <div class="scenario-note"><h2 class="section-tag">Why</h2><p>${escapeHtml(scenario.mechanism)}</p></div>
    <div class="scenario-note fix-note"><h2 class="section-tag">The fix</h2><p>${escapeHtml(scenario.fix.change)}</p><p>${escapeHtml(scenario.fix.cost)}</p></div>
    <div class="on-call"><h2 class="section-tag">In production</h2><p>${escapeHtml(scenario.production)}</p><code>${escapeHtml(scenario.evidence)}</code></div>
    ${scenario.reference ? `<details class="reference-evidence scenario-reference"><summary>Linux reference observation</summary><p>${escapeHtml(scenario.reference)}</p></details>` : ''}
    <button id="explore-here" class="event-button" type="button">Explore from this step</button>
    <div class="related"><h2 class="section-tag">Related</h2>${scenario.related.map(id => `<a href="#${id}">${escapeHtml(scenarioById(id)!.title)}</a>`).join('')}</div>`;
}

const masterOf = (state: WorldState) => state.processes.find(process => process.role === 'master' && process.status === 'running');
function renderSandbox() {
  const state = world();
  const process = state.processes.find(p => p.pid === selectedPid);
  const active = process?.status === 'running';
  const zombie = process?.status === 'zombie';
  const worker = process?.role === 'worker';
  const openFile = process?.descriptors.find(fd => state.kernelObjects.some(o => o.id === fd.objectId && o.kind === 'file'));
  const heldLock = process?.locks.find(lock => lock.ownerTid !== null && process.threadIds.includes(lock.ownerTid));
  const page = selectedPage?.pid === selectedPid ? selectedPage.page : null;
  const pageRegion = process && page !== null ? regionForPage(process, page) : undefined;
  const button = (label: string, action: string, enabled = true) => `<button type="button" data-lab="${action}" ${enabled ? '' : 'disabled'}>${label}</button>`;
  return `<a class="back-link" href="#scenarios"><span aria-hidden="true">←</span> All scenarios</a>
    <div class="lesson-kicker">Free exploration</div>${sheetHead('Change the model yourself', 'Model controls and notes')}
    <p class="lesson-body">${sandboxOrigin ? `Started from ${sandboxOrigin.stepWord} ${sandboxOrigin.step + 1} of <a href="${sandboxOrigin.href}">${escapeHtml(sandboxOrigin.title)}</a>${sandboxOrigin.fixed ? ', with the fix' : ''}. ` : ''}Select a process or page, then act on it. Each action adds a state to the event timeline.</p>
    <div class="lab-dock"><div class="lab-actions">${button('Fork master', 'fork', !!masterOf(state))}${button(page === null ? 'Read a selected page' : `Read page ${page}`, 'read', !!active && page !== null)}${button(page === null ? 'Write a selected page' : `Write page ${page}`, 'write', !!active && page !== null && !!pageRegion?.writable)}${button('Exit selected worker', 'exit', !!worker && !!active)}${button('Reap selected zombie', 'reap', !!worker && !!zombie)}</div>
      <p id="action-error" class="action-error">${escapeHtml(actionError)}</p>
      <div class="scenario-note last-event"><h2 class="section-tag">Last event</h2><p>${escapeHtml(state.events.at(-1)!.description)}</p></div></div>
    <details class="model-tools"><summary>More model controls</summary><div class="lab-actions">${button('Map 2 anonymous pages', 'map-anon', !!active)}${button('Map shared file page', 'map-file', !!active)}${button('Unmap latest region', 'unmap', !!active && !!process?.regions.some(r => r.id.startsWith('region-')))}${button('Open sample file', 'open', !!active)}${button('Read 16 bytes', 'file-read', !!active && !!openFile)}${button('Close sample file', 'file-close', !!active && !!openFile)}${button('Start thread', 'thread', !!active)}${button('Lock with newest thread', 'lock', !!active && (process?.threadIds.length ?? 0) > 1)}${button('Unlock', 'unlock', !!active && !!heldLock)}${button('Set limit to current use', 'limit')}${button('Remove limit', 'unlimit')}</div></details>
    <button id="reset-model" class="subtle" type="button">Reset model</button>
    ${renderAccountingSection(null)}`;
}

// ——— Recorded telemetry ———

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
// A copy in session storage lets a reload, such as a dev-server refresh, replay the same file. A large file is not kept.
function rememberRecording(text: string, fileName: string, sample: SampleId | null) {
  try {
    if (sample) sessionStorage.setItem(RECORDING_KEY, JSON.stringify({ sample }));
    else if (text.length <= 4_000_000) sessionStorage.setItem(RECORDING_KEY, JSON.stringify({ fileName, text }));
    else sessionStorage.removeItem(RECORDING_KEY);
  } catch { /* The recording still replays; it will not survive a reload. */ }
}
function forgetRecording() { try { sessionStorage.removeItem(RECORDING_KEY); } catch { /* Nothing was kept. */ } }
function loadRecording(text: string, fileName: string, sample: SampleId | null, remember = true) {
  const parsed = parseRecording(text, fileName.replace(/\.[^.]+$/, ''));
  recording = { parsed, replay: buildReplay(parsed, TILE_BUDGETS[0]), fileName, sample };
  recordingStatus = null;
  if (remember) rememberRecording(text, fileName, sample);
}
function restoreRecording() {
  let saved: { sample?: string | boolean; fileName?: string; text?: string } | null = null;
  try { saved = JSON.parse(sessionStorage.getItem(RECORDING_KEY) ?? 'null'); } catch { return; }
  if (saved?.sample) { void openSample(typeof saved.sample === 'string' && saved.sample in SAMPLES ? saved.sample as SampleId : 'sample'); return; }
  if (typeof saved?.text !== 'string') return;
  try { loadRecording(saved.text, saved.fileName ?? 'recording.json', null, false); }
  catch (error) { forgetRecording(); recordingStatus = { tone: 'error', text: `The recording kept in this tab no longer replays. ${errorText(error)}` }; }
}
/** Shows the loaded recording from its first stage, or the picker when none is loaded. */
function showLoadedRecording() {
  if (recording) { history = recording.replay.states; step = 0; focusStage(recording.replay); }
  else { history = [initialWorld()]; step = 0; selectedPid = 4100; clearSelection(); }
}
// A load can finish after the reader has gone elsewhere; it brings them to the recording.
function openLoadedRecording() {
  const hash = recording?.sample ? `#recording/${recording.sample}` : '#recording';
  if (mode.kind !== 'recording') { location.hash = hash; return; }
  if (location.hash !== hash) window.history.replaceState(null, '', hash);
  showLoadedRecording();
  sheetExpanded = false; selectionCardOpen = false;
  render(); resetView();
  root.querySelector<HTMLElement>('#scenario-content h1')?.focus({ preventScroll: true });
  root.querySelector('[data-panel-id="scenarios"]')!.scrollTop = 0;
}
function showRecordingStatus(tone: 'info' | 'error', text: string) {
  recordingStatus = { tone, text };
  if (mode.kind === 'recording') renderScenarioPanel();
  else if (tone === 'error') location.hash = 'recording';
}
async function openSample(id: SampleId) {
  const attempt = ++recordingAttempt, sample = SAMPLES[id];
  showRecordingStatus('info', `Opening ${sample.name}…`);
  try {
    const response = await fetch(sample.url);
    if (!response.ok) throw Error(`The server answered ${response.status}.`);
    const text = await recordingText(await response.blob());
    if (attempt !== recordingAttempt) return;
    loadRecording(text, sample.url.split('/').at(-1)!, id);
    openLoadedRecording();
  } catch (error) { if (attempt === recordingAttempt) showRecordingStatus('error', `${sample.name.charAt(0).toUpperCase()}${sample.name.slice(1)} could not be opened. ${errorText(error)}`); }
}
async function readRecordingFile(file: File) {
  const attempt = ++recordingAttempt;
  if (file.size > MAX_RECORDING_BYTES) { showRecordingStatus('error', `${file.name} is ${kb(file.size)}. A recording can be up to ${kb(MAX_RECORDING_BYTES)}.`); return; }
  showRecordingStatus('info', `Reading ${file.name}…`);
  try {
    const text = await recordingText(file);
    // Let the status paint before a long replay holds the page.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (attempt !== recordingAttempt) return;
    if (isCaptureText(text)) {
      // A gzipped file's size is not the capture's, so the unzipped text is what is measured.
      if (text.length > MAX_CAPTURE_BYTES) throw Error('A measured capture can be up to 10 MiB.');
      parseCapture(text);
      try { sessionStorage.setItem(CAPTURE_STORAGE_KEY, JSON.stringify({ fileName: file.name, text })); }
      catch { throw Error('This browser could not hold the capture for the measured viewer. Try a smaller file or enable session storage.'); }
      window.location.assign('/capture.html');
      return;
    }
    if (isNodeCaptureText(text) || isKubeletSummaryText(text)) {
      const nodeText = isNodeCaptureText(text) ? text : fromRawKubeletSummary(text);
      if (new TextEncoder().encode(nodeText).length > MAX_NODE_BYTES) throw Error('A node recording can be up to 10 MiB.');
      parseNodeCapture(nodeText);
      try { sessionStorage.setItem(NODE_STORAGE_KEY, JSON.stringify({ fileName: file.name, text: nodeText })); }
      catch { throw Error('This browser could not hold the node recording. Try a smaller file or enable session storage.'); }
      window.location.assign('/node.html');
      return;
    }
    loadRecording(text, file.name.replace(/\.gz$/, ''), null);
    openLoadedRecording();
  } catch (error) { if (attempt === recordingAttempt) showRecordingStatus('error', `${file.name} could not be replayed. ${errorText(error)}`); }
}

function renderRecordingLoader(another: boolean) {
  const status = recordingStatus ? `<p class="recording-status is-${recordingStatus.tone}" role="${recordingStatus.tone === 'error' ? 'alert' : 'status'}">${escapeHtml(recordingStatus.text)}</p>` : '';
  return `<label class="recording-drop${another ? ' is-another' : ''}"><input id="recording-file" class="sr-only" type="file" accept=".json,.ndjson,.jsonl,.gz,application/json,application/x-ndjson,application/gzip"><strong>${another ? 'Open another recording' : 'Choose a recording or capture'}</strong>${another ? '' : '<span>or drop a page trace, process capture, or node recording anywhere on the page</span>'}</label>${status}`;
}
const formatSummary = () => `<details class="recording-format"${openDetails.has('recording-format') ? ' open' : ''}><summary>What a recording contains</summary>
  <p>A recording is a Trace Event Format file, the JSON that Perfetto reads: an object with <code>traceEvents</code>, an array, or one event per line. It starts with a header:</p>
  <pre><code>{"ph":"M","name":"forkscape","pid":0,"args":{"version":1,"page_size":4096}}</code></pre>
  <p>Instant events (<code>"ph":"i"</code>) follow, each with a <code>ts</code> in microseconds and the <code>pid</code> that acts:</p>
  <ul><li><code>exec</code> starts a process, <code>fork</code> with <code>args.child</code> forks one, and <code>exit</code>, <code>oom_kill</code>, and <code>reap</code> end one.</li>
  <li><code>mmap</code> and <code>munmap</code> take <code>addr</code> and <code>len</code>; an <code>mmap</code> may name a <code>file</code> and its <code>perms</code>, such as <code>rw-p</code>.</li>
  <li><code>fault</code> takes <code>addr</code> and <code>write</code>, once for every page fault.</li>
  <li><code>open</code>, <code>close</code>, and <code>thread</code> track descriptors and threads.</li>
  <li><code>memory</code> counters (<code>"ph":"C"</code>) with <code>rss_kib</code> and <code>pss_kib</code> are charted against the replay.</li>
  <li>Any other event is a marker. An instant, or an outermost slice such as a request or an import, starts a stage.</li></ul>
  <p>A <code>forkscape.capture.v1</code> NDJSON file contains measured process and cgroup snapshots. The same picker opens it in a measured viewer with Flat and 3D views, because snapshots do not identify pages or physical frames.</p>
  <p>A <code>forkscape.node.v1</code> NDJSON file contains measured node samples. The same picker opens 3D columns or Flat charts for memory, CPU, page-fault rate, and network throughput with sample stepping. A raw Kubelet stats/summary JSON file opens as one sample.</p>
  <p>The trace format is in <code>docs/recording-format.md</code> in the repository.</p></details>`;

function renderPhaseRail(replay: Replay) {
  const stage = replay.stages[step], phase = replay.phases[stage.phase];
  const now = `<p class="phase-now">Phase ${stage.phase + 1} of ${replay.phases.length}: <strong>${escapeHtml(phase.label)}</strong>, stages ${phase.first + 1}–${phase.last + 1}</p>`;
  if (replay.phases.length < 2) return `<nav class="phase-rail" aria-label="Phases">${now}</nav>`;
  // Each phase's segment is as wide as its share of the stages, and the current one marks where this stage falls in it.
  const segments = replay.phases.map((item, index) => {
    const count = item.last - item.first + 1, current = index === stage.phase;
    const at = current ? `;--at:${((step - item.first + .5) / count * 100).toFixed(1)}%` : '';
    return `<button type="button" class="phase-segment${current ? ' is-current' : ''}" data-phase="${index}" style="flex-grow:${count}${at}" aria-label="${escapeHtml(`${item.label}, stages ${item.first + 1} to ${item.last + 1}`)}"${current ? ' aria-current="true"' : ''}><span>${escapeHtml(item.label)}</span></button>`;
  }).join('');
  return `<nav class="phase-rail" aria-label="Phases"><div class="phase-track">${segments}</div>${now}</nav>`;
}

const eventFields = ['child', 'comm', 'addr', 'len', 'write', 'file', 'perms', 'offset', 'fd', 'object', 'kind', 'name', 'module', 'method', 'path', 'new_tid', 'lock', 'advice', 'label', 'count', 'rss_kib', 'pss_kib', 'memory_current_kib'];
function renderStageEvents(stage: Replay['stages'][number]) {
  const origin = stage.events[0].ts - stage.at, shown = stage.events.slice(0, 200);
  const fields = (event: TraceEvent) => eventFields.flatMap(key => event.args[key] === undefined ? [] : [`${key} ${typeof event.args[key] === 'object' ? JSON.stringify(event.args[key]) : String(event.args[key])}`]).join(', ');
  const rows = shown.map(event => `<tr><td>${formatSeconds(event.ts - origin)}</td><td>${event.pid}</td><td>${escapeHtml(event.cat ? `${event.cat}: ${event.name}` : event.name)}</td><td>${escapeHtml(fields(event).slice(0, 160))}</td></tr>`).join('');
  return `<details class="stage-events"${openDetails.has('stage-events') ? ' open' : ''}><summary>Recorded events in this stage (${formatCount(stage.events.length)})</summary><div class="stage-events-scroll"><table><thead><tr><th>Time</th><th>PID</th><th>Event</th><th>Fields</th></tr></thead><tbody>${rows}</tbody></table></div>${stage.events.length > shown.length ? `<p class="stage-events-more">Showing the first ${shown.length} of ${formatCount(stage.events.length)}.</p>` : ''}</details>`;
}

function renderRecording() {
  if (!recording) return `<div class="lesson-kicker">Recorded telemetry</div>${sheetHead('Replay a recording', 'Recording details')}
    <p class="lesson-body">Open a page trace to step through forks, imports, requests, and page faults. Measured process captures open in the Linux capture viewer; node recordings open in 3D columns or Flat charts with sample stepping and Pod markers. A raw Kubelet summary opens as one node sample. Files stay in this browser.</p>
    ${renderRecordingLoader(false)}
    <div class="sample-buttons"><button id="open-sample" class="subtle" type="button" data-sample="sample">Open the synthetic page trace</button><button class="subtle" type="button" data-capture-sample="synthetic">Open synthetic process telemetry</button><button class="subtle" type="button" data-node-sample="synthetic">Open synthetic node telemetry</button></div>
    ${formatSummary()}`;
  const { replay } = recording, stage = replay.stages[step], last = replay.stages.length - 1;
  // Every stage's text shares one grid cell, as a scenario's steps do; a very long recording draws only the current one.
  const slide = (item: typeof stage, index: number) => `<div class="step-slide${index === step ? ' is-current' : ''}"><p class="step-phase">${escapeHtml(replay.phases[item.phase].label)}</p><p class="step-caption">${escapeHtml(item.caption)}</p><p class="step-event">${escapeHtml(item.figures)}</p></div>`;
  const slides = slide(stage, step);
  const tiles = replay.tilePages > 1 || replay.tileBudget !== TILE_BUDGETS[0]
    ? `<p class="tile-label" id="tile-label">Tiles per process. A 3D deck shows 24; the flat view shows them all.</p><div class="run-toggle tile-toggle" role="group" aria-labelledby="tile-label">${TILE_BUDGETS.map(budget => `<button type="button" data-tiles="${budget}" aria-pressed="${budget === replay.tileBudget}">${budget}</button>`).join('')}</div>` : '';
  const facts = replay.meta.details.filter(([label]) => label !== 'Source');
  return `<div class="lesson-kicker">Recorded telemetry${replay.meta.synthetic ? ' · synthetic' : ''}</div>${sheetHead(replay.meta.title, 'Recording details')}
    <div class="recording-loader recording-loader-top">${renderRecordingLoader(true)}<button id="close-recording" class="subtle" type="button">Close recording</button></div>
    <p class="recording-source">${escapeHtml(replay.meta.source || recording.fileName)}</p>
    <div class="step-detail"><h2 class="section-tag">This stage</h2><p>${escapeHtml(stage.figures)}</p></div>
    ${renderPhaseRail(replay)}
    <div class="stepper is-recording">
      <div class="stepper-controls"><button id="scenario-prev" type="button" ${step === 0 ? 'disabled' : ''}><span aria-hidden="true">◀</span> Back</button><span class="step-count">Stage ${step + 1} / ${last + 1}</span><button id="scenario-next" class="step-next" type="button" ${step === last ? 'disabled' : ''}>Next <span aria-hidden="true">▶</span></button></div>
      <div class="step-slides is-single" tabindex="0" aria-label="Stage description">${slides}</div>
    </div>
    ${renderChart(recordingChart(replay))}
    ${renderAccountingSection(null)}
    ${renderStageEvents(stage)}
    <div class="scenario-note replay-notes"><h2 class="section-tag">How this replay was built</h2>${tiles}<ul>${replay.notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul></div>
    ${facts.length ? `<dl class="recording-facts">${facts.map(([label, value]) => `<div${value.length > 60 ? ' class="is-long"' : ''}><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}
    <button id="explore-here" class="event-button" type="button">Explore from this stage</button>`;
}

function renderScenarioPanel() {
  root.querySelector('#scenario-content')!.innerHTML = mode.kind === 'scenario' ? renderScenario(mode.scenario) : mode.kind === 'sandbox' ? renderSandbox() : mode.kind === 'recording' ? renderRecording() : renderLibrary();
  root.querySelector('#scenario-meta')!.textContent = mode.kind === 'sandbox' ? 'Free exploration' : mode.kind === 'recording' ? (recording ? `${formatCount(recording.replay.stages.length)} stages · recording` : 'Recording') : `${scenarios.length} scenarios · model`;
  document.title = mode.kind === 'scenario' ? `${mode.scenario.title} — Forkscape` : mode.kind === 'sandbox' ? 'Free exploration — Forkscape' : mode.kind === 'recording' ? `${recording ? recording.replay.meta.title : 'Replay a recording'} — Forkscape` : 'Forkscape — See what fork() really copies';
}

// A selected page traces to its frame, a frame to every page mapped to it, and a cable to its kernel object.
const tracedFrame = (state: WorldState) => selectedFrame ?? (selectedPage && state.processes.find(p => p.pid === selectedPage!.pid)?.pages[selectedPage.page]) ?? null;
const tracedObject = (state: WorldState) => selectedObjectId ?? (selectedStructure?.part === 'cable' ? state.processes.find(p => p.pid === selectedStructure!.pid)?.descriptors[selectedStructure.index]?.objectId : null) ?? null;
const nameOf = (process: ProcessState) => replaying()?.names.get(process.pid) ?? process.name;
const accountingLabel = (state: WorldState, pid: number) => { const row = memoryRows(state).find(item => item.pid === pid)!; return `RSS ${kb(row.rss)} · PSS ${kb(row.pss)}`; };
function renderFlat(state: WorldState) {
  const showAccounting = accountingVisible();
  const frameTrace = tracedFrame(state), objectTrace = tracedObject(state);
  const chip = (process: ProcessState, index: number, region: RegionState) => {
    const id = process.pages[index] ?? null;
    const selected = selectedPage?.pid === process.pid && selectedPage.page === index ? 'selected' : id !== null && id === frameTrace ? 'is-linked' : '';
    const current = selected === 'selected' ? ' aria-current="true"' : '';
    const motion = `data-motion="p/${process.pid}/page/${index}"`;
    if (id === null) return `<button type="button" ${motion} data-page="${index}" data-page-pid="${process.pid}" aria-label="PID ${process.pid} virtual page ${index}, ${escapeHtml(region.name)}, not resident"${current} class="page-chip is-absent ${selected}">${index} · —<small>${escapeHtml(region.name)}</small></button>`;
    const count = sharers(state, id);
    return `<button type="button" ${motion} data-page="${index}" data-page-pid="${process.pid}" aria-label="PID ${process.pid} virtual page ${index}, ${escapeHtml(region.name)}, frame ${id}, ${count > 1 ? `shared by ${count}` : 'exclusive'}"${current} class="page-chip ${count > 1 ? 'is-shared' : ''} ${selected}">${index}→F${id}<small>${escapeHtml(region.name)}</small></button>`;
  };
  const processSelected = (pid: number) => selectedPid === pid && selectedPage === null && selectedStructure === null && selectedFrame === null && selectedObjectId === null;
  root.querySelector('#flat-host')!.innerHTML = `<h2 class="flat-title" data-motion="flat/processes">Process address spaces</h2><div class="flat-processes">${state.processes.map(process => `<div class="flat-process ${processSelected(process.pid) ? 'selected' : ''}" data-motion="p/${process.pid}"><button type="button" data-pid="${process.pid}"${processSelected(process.pid) ? ' aria-current="true"' : ''}><strong>${process.role} · PID ${process.pid}</strong><span>${process.status === 'zombie' ? 'Zombie · mappings released' : `${nameOf(process) ? `${escapeHtml(nameOf(process)!)} · ` : ''}PPID ${process.parentPid ?? '—'} · ${residentPages(process)} of ${mappedPages(process)} ${(state.tilePages ?? 1) > 1 ? 'tiles' : 'pages'} resident · ${process.threadIds.length} thread(s)`}</span>${showAccounting && process.status === 'running' ? `<span class="flat-accounting">${accountingLabel(state, process.pid)}</span>` : ''}</button><div class="page-strip">${process.regions.flatMap(region => regionPages(region).map(index => chip(process, index, region))).join('')}</div>${process.status === 'running' ? `<div class="structure-list" role="group" aria-label="PID ${process.pid} scene parts">${structureButtons(state, process.pid)}</div>` : ''}</div>`).join('')}</div><h2 class="flat-title" data-motion="flat/frames">Physical frames</h2><div class="flat-frames">${state.frames.map(frame => `<button type="button" data-motion="f/${frame.id}" data-frame="${frame.id}"${selectedFrame === frame.id ? ' aria-current="true"' : ''} class="flat-frame ${selectedFrame === frame.id ? 'selected' : frame.id === frameTrace ? 'is-linked' : ''}"><strong>F${frame.id}</strong><span>${escapeHtml(frame.region)}</span><small>${sharers(state, frame.id)} ${sharers(state, frame.id) === 1 ? 'mapping' : 'mappings'}</small></button>`).join('')}</div><h2 class="flat-title" data-motion="flat/objects">Kernel objects</h2><div class="flat-frames">${state.kernelObjects.map(object => `<button type="button" data-motion="o/${escapeHtml(object.id)}" data-object="${escapeHtml(object.id)}"${selectedObjectId === object.id ? ' aria-current="true"' : ''} class="flat-frame ${selectedObjectId === object.id ? 'selected' : object.id === objectTrace ? 'is-linked' : ''}"><strong>${escapeHtml(object.kind)}</strong><span>${escapeHtml(object.id)}</span><small>${objectRefCount(state, object.id)} descriptor(s)${object.kind === 'file' ? ` · offset ${object.offset}` : ''}</small></button>`).join('')}</div><p class="flat-note" data-motion="flat/note">Select a page to find its frame, or a frame to find every page mapped to it. A stacked chip shares its frame with another mapping, and a dash marks a page that is mapped but not resident. Descriptors in several processes can refer to one kernel object.</p>`;
}

function structureButtons(state: WorldState, pid: number): string {
  const process = state.processes.find(item => item.pid === pid);
  if (!process || process.status !== 'running') return '';
  const objectTrace = tracedObject(state);
  const button = (part: StructurePart, index: number, label: string, linked = false) => `<button type="button" ${selectedStructure?.pid === pid && selectedStructure.part === part && selectedStructure.index === index ? 'class="selected" aria-current="true"' : `class="${linked ? 'is-linked' : ''}"`} data-structure="${part}" data-structure-pid="${pid}" data-structure-index="${index}" aria-label="Inspect PID ${pid} ${escapeHtml(label)}">${escapeHtml(label)}</button>`;
  return button('page_table', 0, 'Page-table sheet') + process.descriptors.map((fd, index) => button('cable', index, `fd ${fd.fd} cable`, fd.objectId === objectTrace)).join('') + process.threadIds.map((tid, index) => button('thread', index, `Thread ${tid} spindle`)).join('') + (state.processes.length > 1 ? button('stack', 0, 'Fork stack blocks') : '');
}

const rung = (name: string, body: string) => `<div class="inspector-rung"><h3>${name}</h3>${body}</div>`;

function renderInspector(detail: Detail) {
  const nested = selectedFrame !== null || selectedObjectId !== null || selectedPage?.pid === selectedPid || selectedStructure?.pid === selectedPid;
  root.querySelector('#inspector')!.innerHTML = `<div class="inspector-content"><h2>${detail.title}</h2><p>${detail.summary}</p>${rung('Metaphor', detail.metaphor)}${rung('Mechanism', detail.mechanism)}${rung('Measurement', detail.measurement)}${detail.actions ?? ''}<button id="clear-selection" type="button" class="subtle" ${nested ? '' : 'hidden'}><span aria-hidden="true">←</span> Back to process</button></div>`;
}

// The card keeps a selection's explanation beside the scene while the scenario panel stays open. Only changed text is written, so the live region announces each new selection once.
const shownSelection = { heading: '', mechanism: '' };
function renderSelectionCard(detail: Detail) {
  const heading = `<h2>${detail.title}</h2><p class="selection-summary">${detail.summary}</p>`;
  if (shownSelection.heading !== heading) root.querySelector('#selection-card-heading')!.innerHTML = shownSelection.heading = heading;
  if (shownSelection.mechanism !== detail.mechanism) root.querySelector('#selection-card-detail')!.innerHTML = shownSelection.mechanism = detail.mechanism;
}

function renderLedger(state: WorldState) {
  const rows = memoryRows(state);
  const totals = rows.reduce((sum, row) => ({ rss: sum.rss + row.rss, pss: sum.pss + row.pss }), { rss: 0, pss: 0 });
  root.querySelector('#ledger')!.innerHTML = `<div class="ledger-summary"><div><span>Memory in use</span><strong>${kb(physicalBytes(state))}</strong></div><div><span>Page tables</span><strong>${kb(pageTableBytes(state))}</strong></div><div><span>Model charge</span><strong>${kb(chargedBytes(state))}</strong></div></div><div class="ledger-meta">Σ RSS ${kb(totals.rss)} · Σ PSS ${kb(totals.pss)} · limit ${state.limitBytes === null ? 'none' : kb(state.limitBytes)}</div><table><thead><tr><th>Process</th><th>Mapped</th><th>RSS</th><th>PSS</th><th>USS</th></tr></thead><tbody>${rows.map(row => `<tr class="${selectedPid === row.pid ? 'selected' : ''}" data-pid="${row.pid}"><td><button type="button" class="ledger-row-select" data-ledger-pid="${row.pid}"${selectedPid === row.pid ? ' aria-current="true"' : ''}>${row.role === 'master' ? 'Master' : 'Worker'} ${row.pid}${row.status === 'zombie' ? '<span aria-hidden="true"> †</span><span class="sr-only">, zombie</span>' : ''}</button></td><td>${kb(row.mapped)}</td><td>${kb(row.rss)}</td><td>${kb(row.pss)}</td><td>${kb(row.uss)}</td></tr>`).join('')}</tbody></table><p class="ledger-note">Mapped counts every page in a process’s regions. RSS, PSS, and USS count resident pages only: RSS counts each shared page in full, PSS splits it among its sharers, and USS counts exclusive pages. Memory in use is every resident frame, which equals Σ PSS. The model charge adds simplified page tables; it excludes other kernel memory and page cache that no process maps. † marks a zombie: a process that has exited but that its parent has not reaped. Values are illustrative.</p>`;
}

const eventIcons: Record<string, string> = { start: '●', exec: '●', fork: '⑂', cow_fault: '✦', demand_zero: '+', zero_page: '○', minor_fault: '↧', major_fault: '⇩', file_fault: '↧', write: '✎', exit: '×', reap: '↻', oom_kill: '!', mmap: '▭', munmap: '−', discard: '−', limit: '┄', thread: '≋', marker: '◆', request: '↯', phase: '▸', activity: '·' };
function renderTimeline(state: WorldState) {
  const range = root.querySelector('#time-range') as HTMLInputElement;
  range.max = String(history.length - 1);
  range.value = String(step);
  range.setAttribute('aria-valuetext', mode.kind === 'scenario' ? `Step ${step + 1} of ${history.length}` : `State ${step + 1} of ${history.length}`);
  (root.querySelector('#prev-step') as HTMLButtonElement).disabled = step === 0;
  (root.querySelector('#next-step') as HTMLButtonElement).disabled = step === history.length - 1;
  const run = mode.kind === 'scenario' ? activeRun(mode.scenario) : null, replay = replaying();
  root.querySelector('#step-label')!.textContent = run ? `Step ${step + 1} / ${history.length}` : replay ? `Stage ${step + 1} / ${history.length}` : `${step + 1} / ${history.length}`;
  root.querySelector('#event-count')!.textContent = run ? `${fixed ? 'The fix' : 'Scenario'} · model` : replay ? 'Recording' : `${history.length} states`;
  root.querySelector('#event-strip')!.innerHTML = history.map((item, index) => {
    const kind = replay ? replay.stages[index].kind : item.events.at(-1)!.kind;
    const label = run ? `Step ${index + 1}: ${run.steps[index].caption}` : replay ? `Stage ${index + 1}: ${replay.stages[index].caption}` : `State ${index + 1}: ${kind}`;
    return `<button type="button" data-step="${index}" class="event-tick ${index === step ? 'active' : ''}" aria-label="${escapeHtml(label)}"${index === step ? ' aria-current="step"' : ''}><span class="tick-icon">${eventIcons[kind] ?? '•'}</span><span>${run || replay ? index + 1 : escapeHtml(kind.replace('_', ' '))}</span></button>`;
  }).join('');
  // Rewriting a live region with the same text can repeat it, so only a change is written. A failed action is announced here, once.
  const narration = actionError || (run ? `Step ${step + 1}. ${run.steps[step].caption}` : replay ? `Stage ${step + 1}. ${replay.stages[step].caption}` : state.events.at(-1)!.description);
  const live = root.querySelector('#narration')!;
  if (live.textContent !== narration) live.textContent = narration;
}

/** Draws the current state. A step animates: marks and scene objects move from where they were drawn, and a new process comes out of its parent. */
function render(animate = false) {
  const focused = document.activeElement as HTMLElement | null;
  const focusAttributes = focused ? ['id', 'href', 'data-run', 'data-lab', 'data-phase', 'data-tiles', 'data-pid', 'data-ledger-pid', 'data-page', 'data-page-pid', 'data-frame', 'data-object', 'data-structure', 'data-structure-pid', 'data-structure-index', 'data-step'].flatMap(name => focused.hasAttribute(name) ? [[name, focused.getAttribute(name)]] : []) : [];
  const state = world();
  if (!state.processes.some(p => p.pid === selectedPid)) selectedPid = state.processes[0]?.pid ?? 4100;
  if (selectedFrame !== null && !state.frames.some(f => f.id === selectedFrame)) selectedFrame = null;
  if (selectedObjectId !== null && !state.kernelObjects.some(o => o.id === selectedObjectId)) selectedObjectId = null;
  if (selectedPage && !state.processes.some(p => p.pid === selectedPage!.pid && regionForPage(p, selectedPage!.page))) selectedPage = null;
  if (selectedStructure) {
    const process = state.processes.find(p => p.pid === selectedStructure!.pid && p.status === 'running');
    if (!process || selectedStructure.part === 'cable' && !process.descriptors[selectedStructure.index]
      || selectedStructure.part === 'thread' && process.threadIds[selectedStructure.index] === undefined
      || selectedStructure.part === 'stack' && state.processes.length < 2) selectedStructure = null;
  }
  const detail = selectionDetail(state, { pid: selectedPid, page: selectedPage, frame: selectedFrame, objectId: selectedObjectId, structure: selectedStructure }, pid => `<div class="structure-list" aria-label="Inspect scene parts">${structureButtons(state, pid)}</div>`);
  const playMarks = animate ? captureMarks(root) : null;
  renderChrome(); renderScenarioPanel(); renderFlat(state); renderInspector(detail); renderSelectionCard(detail); renderLedger(state); renderTimeline(state);
  host.hidden = flat;
  (root.querySelector('#flat-host') as HTMLElement).hidden = !flat;
  root.querySelector('#view-toggle')!.innerHTML = flat ? '<span aria-hidden="true">◈</span> 3D view' : '<span aria-hidden="true">▦</span> Flat view';
  root.querySelectorAll<HTMLButtonElement>('.camera-controls button').forEach(button => { button.disabled = flat; });
  if (scene) { scene.showAccounting = accountingVisible(); scene.changedSince = labelBaseline(); }
  scene?.setWorld(state, selectedPid, selectedPage, selectedFrame, selectedObjectId, selectedStructure, selection => { selectVisual(selection); }, animate);
  playMarks?.(stepLinks(shownWorld ?? state, state).enter);
  shownWorld = state;
  if (focused && !focused.isConnected && focusAttributes.length) {
    const replacement = [...root.querySelectorAll<HTMLElement>(focused.tagName.toLowerCase())].find(element => focusAttributes.every(([name, value]) => element.getAttribute(name!) === value));
    replacement?.focus({ preventScroll: true });
  }
  void ensureScene();
}

function selectVisual(selection: SceneSelection) {
  selectedFrame = selection.kind === 'frame' ? selection.frameId : null;
  selectedObjectId = selection.kind === 'object' ? selection.objectId : null;
  selectedStructure = selection.kind === 'structure' ? { pid: selection.pid, part: selection.part, index: selection.index } : null;
  if (selection.kind === 'process' || selection.kind === 'page' || selection.kind === 'structure') selectedPid = selection.pid;
  selectedPage = selection.kind === 'page' ? { pid: selection.pid, page: selection.page } : null;
  selectionCardOpen = true;
  // A selection is shown in the scene, so an expanded sheet makes way for it.
  if (narrow.matches) sheetExpanded = false;
  render();
}

function runAction(action: Action): boolean {
  try {
    const next = applyAction(world(), action);
    assertInvariants(next);
    sandboxHistory.splice(step + 1, sandboxHistory.length - step - 1, next);
    step = sandboxStep = sandboxHistory.length - 1;
    actionError = '';
  } catch (error) { actionError = error instanceof Error ? error.message : String(error); render(); return false; }
  render(true);
  return true;
}

function resetSandbox(start: WorldState, origin: typeof sandboxOrigin) {
  // Free exploration changes tiles, so it counts them from the start rather than a recording's exact figures.
  if (start.exact) start = { ...start, exact: undefined };
  sandboxHistory = [start]; sandboxStep = 0; sandboxOrigin = origin;
  history = sandboxHistory; step = 0; actionError = '';
}

root.addEventListener('click', event => {
  const target = event.target as Element;
  if (target.closest('#menu-toggle')) { menuOpen = !menuOpen; renderChrome(); return; }
  const modeItem = target.closest<HTMLElement>('[data-mode]');
  if (modeItem) {
    event.preventDefault();
    const chosen = modeItem.dataset.mode;
    menuOpen = false;
    if (chosen === mode.kind) {
      if (openPanel !== 'scenarios') showPanel('scenarios');
      else renderChrome();
    } else location.hash = chosen === 'recording' ? 'recording' : 'explore';
    return;
  }
  const panelItem = target.closest<HTMLElement>('[data-panel]');
  if (panelItem) {
    const id = panelItem.dataset.panel as PanelId;
    if (id === 'scenarios' && (mode.kind === 'recording' || mode.kind === 'sandbox')) {
      menuOpen = false;
      location.hash = 'scenarios';
    } else showPanel(openPanel === id ? null : id);
    return;
  }
  if (target.closest('[data-close-panel]')) { showPanel(null); return; }
  if (target.closest('.sheet-head') && narrow.matches) { if (!sheetSwiped) { sheetExpanded = !sheetExpanded; renderChrome(); } return; }
  if (target.closest('#close-selection-card')) { selectionCardOpen = false; renderChrome(); return; }
  if (target.closest('#open-inspector')) { showPanel('inspector'); return; }
  if (menuOpen && !target.closest('.menu-dock')) { menuOpen = false; renderChrome(); }
  const camera = target.closest<HTMLElement>('[data-camera]');
  if (camera) { scene?.setCameraPreset(camera.dataset.camera as 'overview' | 'process' | 'memory'); return; }
  const zoom = target.closest<HTMLElement>('[data-zoom]');
  if (zoom) { scene?.setZoom(zoom.dataset.zoom === 'in'); return; }
  const chartStep = target.closest<SVGElement>('[data-chart-step]');
  if (chartStep) { goToStep(Number(chartStep.dataset.chartStep)); return; }
  const runButton = target.closest<HTMLElement>('[data-run]');
  if (runButton) { showRun(runButton.dataset.run === 'fix'); return; }
  if (target.closest('#scenario-prev')) { goToStep(step - 1); return; }
  if (target.closest('#scenario-next')) { goToStep(step + 1); return; }
  const phaseButton = target.closest<HTMLElement>('[data-phase]');
  if (phaseButton && replaying()) { goToStep(replaying()!.phases[Number(phaseButton.dataset.phase)].first); return; }
  const tilesButton = target.closest<HTMLElement>('[data-tiles]');
  if (tilesButton && recording) {
    // Tiles change only how the recording is drawn; its stages stay the same, so the reader keeps their place.
    recording.replay = buildReplay(recording.parsed, Number(tilesButton.dataset.tiles));
    history = recording.replay.states; step = Math.min(step, history.length - 1); focusStage(recording.replay);
    render();
    return;
  }
  const sampleButton = target.closest<HTMLElement>('[data-sample]');
  if (sampleButton && sampleButton.dataset.sample! in SAMPLES) { void openSample(sampleButton.dataset.sample as SampleId); return; }
  if (target.closest('[data-capture-sample="synthetic"]')) { window.location.assign('/capture.html?sample=synthetic'); return; }
  if (target.closest('[data-node-sample="synthetic"]')) { window.location.assign('/node.html?sample=synthetic'); return; }
  if (target.closest('#close-recording')) {
    recording = null; recordingStatus = null; recordingAttempt++; forgetRecording();
    showLoadedRecording(); sheetExpanded = true; selectionCardOpen = false;
    render(); resetView();
    root.querySelector<HTMLElement>('#scenario-content h1')?.focus({ preventScroll: true });
    return;
  }
  if (target.closest('#explore-here') && mode.kind === 'scenario') {
    resetSandbox(world(), { title: mode.scenario.title, href: `#${mode.scenario.id}`, step, fixed, stepWord: 'step' });
    location.hash = 'explore';
    return;
  }
  if (target.closest('#explore-here') && replaying()) {
    resetSandbox(world(), { title: replaying()!.meta.title, href: '#recording', step, fixed: false, stepWord: 'stage' });
    location.hash = 'explore';
    return;
  }
  const stepButton = target.closest<HTMLElement>('[data-step]');
  if (stepButton) { goToStep(Number(stepButton.dataset.step)); return; }
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
  if (target.closest('#prev-step')) { goToStep(step - 1); return; }
  if (target.closest('#next-step')) { goToStep(step + 1); return; }
  if (target.closest('#reset-model')) { resetSandbox(initialWorld(), null); selectedPid = 4100; clearSelection(); selectionCardOpen = false; render(); resetView(); return; }
  if (target.closest('#clear-selection')) { clearSelection(); render(); return; }
  const actionButton = target.closest<HTMLElement>('[data-lab]');
  if (actionButton && !actionButton.hasAttribute('disabled') && mode.kind === 'sandbox') {
    const state = world(), selected = state.processes.find(p => p.pid === selectedPid);
    const page = selectedPage?.pid === selectedPid ? selectedPage.page : null;
    const action = actionButton.dataset.lab;
    if (action === 'fork') { const master = masterOf(state); if (master) runAction({ type: 'fork', parentPid: master.pid }); return; }
    if ((action === 'read' || action === 'write') && page !== null) { runAction({ type: action, pid: selectedPid, page }); return; }
    if (action === 'exit' || action === 'reap') { runAction({ type: action, pid: selectedPid }); return; }
    if (action === 'open') { runAction({ type: 'open_file', pid: selectedPid, name: 'sample.log' }); return; }
    if (action === 'file-read') { const fd = selected?.descriptors.find(item => state.kernelObjects.some(o => o.id === item.objectId && o.kind === 'file'))?.fd; if (fd !== undefined) runAction({ type: 'read_file', pid: selectedPid, fd, bytes: 16 }); return; }
    if (action === 'file-close') { const fd = selected?.descriptors.find(item => state.kernelObjects.some(o => o.id === item.objectId && o.kind === 'file'))?.fd; if (fd !== undefined) runAction({ type: 'close_fd', pid: selectedPid, fd }); return; }
    if (action === 'map-anon') { runAction({ type: 'mmap', pid: selectedPid, name: 'scratch', pageCount: 2, kind: 'anonymous', sharing: 'private' }); return; }
    if (action === 'map-file') { runAction({ type: 'mmap', pid: selectedPid, name: 'shared.data', pageCount: 1, kind: 'file', sharing: 'shared', fileKey: 'shared.data' }); return; }
    if (action === 'unmap') { const region = [...(selected?.regions ?? [])].reverse().find(r => r.id.startsWith('region-')); if (region) runAction({ type: 'munmap', pid: selectedPid, regionId: region.id }); return; }
    if (action === 'thread') { runAction({ type: 'spawn_thread', pid: selectedPid }); return; }
    if (action === 'lock') { const tid = selected?.threadIds.at(-1); if (tid !== undefined) runAction({ type: 'lock', pid: selectedPid, lockId: 'sample-lock', tid }); return; }
    if (action === 'unlock') { const lock = selected?.locks.find(item => item.ownerTid !== null && selected.threadIds.includes(item.ownerTid)); if (lock?.ownerTid !== null && lock?.ownerTid !== undefined) runAction({ type: 'unlock', pid: selectedPid, lockId: lock.id, tid: lock.ownerTid }); return; }
    if (action === 'limit') { runAction({ type: 'set_limit', bytes: chargedBytes(state) }); return; }
    if (action === 'unlimit') { runAction({ type: 'set_limit', bytes: null }); return; }
  }
  if (target.closest('#view-toggle')) { flat = !flat; try { localStorage.setItem('forkscape-flat', String(flat)); } catch { /* the view still switches */ } render(); resetView(); }
});
// Swiping the sheet's head up or down expands or collapses it, as dragging a handle would. The click that can follow a swipe is ignored.
let sheetSwipeStart: number | null = null, sheetSwiped = false;
root.addEventListener('pointerdown', event => {
  sheetSwiped = false;
  sheetSwipeStart = narrow.matches && (event.target as Element).closest('.sheet-head') ? event.clientY : null;
});
root.addEventListener('pointerup', event => {
  if (sheetSwipeStart === null) return;
  const distance = event.clientY - sheetSwipeStart;
  sheetSwipeStart = null;
  if (Math.abs(distance) < 24) return;
  sheetSwiped = true;
  sheetExpanded = distance < 0;
  renderChrome();
});
root.addEventListener('pointerover', event => {
  const target = (event.target as Element).closest<SVGRectElement>('[data-chart-step]');
  if (target) showChartTip(target);
});
root.addEventListener('pointerout', event => {
  const figure = (event.target as Element).closest('.chart');
  if (figure && !figure.contains(event.relatedTarget as Node | null)) hideChartTip(figure);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  // A chart tooltip is dismissed before anything else closes.
  const tip = root.querySelector<HTMLElement>('.chart-tip:not([hidden])');
  if (tip) hideChartTip(tip.closest('.chart')!);
  else if (menuOpen) { menuOpen = false; renderChrome(); root.querySelector<HTMLElement>('#menu-toggle')!.focus(); }
  else if (selectionCardOpen && openPanel !== 'inspector') { selectionCardOpen = false; renderChrome(); }
  else if (narrow.matches && openPanel === 'scenarios' && sheetExpanded) { sheetExpanded = false; renderChrome(); }
  else if (openPanel) showPanel(null);
});
root.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'time-range') goToStep(Number(input.value));
});
root.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.id !== 'recording-file') return;
  const file = input.files?.[0];
  input.value = '';
  if (file) void readRecordingFile(file);
});
// A trace or measured capture dropped anywhere on the page opens through the same loader.
const dropVeil = root.querySelector<HTMLElement>('#drop-veil')!;
let dragDepth = 0;
const carriesFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', event => { if (!carriesFiles(event)) return; event.preventDefault(); dragDepth++; dropVeil.hidden = false; });
window.addEventListener('dragover', event => { if (!carriesFiles(event)) return; event.preventDefault(); event.dataTransfer!.dropEffect = 'copy'; });
window.addEventListener('dragleave', event => { if (!carriesFiles(event) || --dragDepth > 0) return; dragDepth = 0; dropVeil.hidden = true; });
window.addEventListener('drop', event => {
  if (!carriesFiles(event)) return;
  event.preventDefault(); dragDepth = 0; dropVeil.hidden = true;
  const file = event.dataTransfer?.files[0];
  if (file) void readRecordingFile(file);
});
// toggle does not bubble, so listen in the capture phase. A re-rendered open <details> fires toggle again with no change.
root.addEventListener('toggle', event => {
  const details = event.target as HTMLDetailsElement;
  for (const name of ['stage-events', 'recording-format']) if (details.matches(`details.${name}`)) { if (details.open) openDetails.add(name); else openDetails.delete(name); }
  if (!details.matches('details.accounting') || details.open === accountingOpen) return;
  accountingOpen = details.open;
  render();
}, true);
window.addEventListener('hashchange', () => applyHash(true));

applyHash(false);
