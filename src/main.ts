import './style.css';
import './theme.css';
import './reference.css';
import { escapeHtml, kb, regionPages, selectionDetail, type Detail } from './detail';
import { applyAction, assertInvariants, chargedBytes, initialWorld, mappedPages, memoryRows, objectRefCount, pageTableBytes, physicalBytes, pssBreakdown, regionForPage, residentPages, sharers, type Action, type ProcessState, type RegionState, type WorldState } from './model';
import { scenarioById, scenarios, scenarioStates, seriesValue, stepFocus, type ChartSeries, type Scenario } from './scenarios';
import { captureMarks, stepLinks } from './motion';
import type { ForkScene, SceneSelection, StructurePart } from './scene';

type Mode = { kind: 'library' } | { kind: 'scenario'; scenario: Scenario } | { kind: 'sandbox' };
type PanelId = 'scenarios' | 'inspector' | 'timeline' | 'ledger' | 'view';
const panelLabels: Record<PanelId, string> = { scenarios: 'Scenarios', inspector: 'Inspector', timeline: 'Event timeline', ledger: 'Memory ledger', view: 'Camera & legend' };
const groupLabels = { memory: 'Memory', handles: 'Handles & threads' } as const;

let mode: Mode = { kind: 'library' };
let history: WorldState[] = [initialWorld()];
let step = 0;
let sandboxHistory: WorldState[] = [initialWorld()];
let sandboxStep = 0;
let sandboxOrigin: { scenario: Scenario; step: number } | null = null;
// The state last drawn, so a step can link what it adds to what was there.
let shownWorld: WorldState | null = null;
const scenarioHistories = new Map<string, WorldState[]>();
let selectedPid = 4100;
let selectedFrame: number | null = null;
let selectedObjectId: string | null = null;
let selectedPage: { pid: number; page: number } | null = null;
let selectedStructure: { pid: number; part: StructurePart; index: number } | null = null;
let actionError = '';
let flat = (() => { try { return localStorage.getItem('forkscape-flat') === 'true'; } catch { return false; } })();
let scene: ForkScene | null = null;
let sceneLoading = false;
let openPanel: PanelId | null = 'scenarios';
let menuOpen = false;
let selectionCardOpen = false;
let accountingOpen = false;
// On narrow screens the scenario panel is a sheet under the scene: collapsed to its head and dock, or expanded to everything.
let sheetExpanded = false;
const narrow = matchMedia('(max-width: 899px)');

const root = document.querySelector<HTMLDivElement>('#app')!;
const world = () => history[step];
const statesFor = (scenario: Scenario) => {
  if (!scenarioHistories.has(scenario.id)) scenarioHistories.set(scenario.id, scenarioStates(scenario));
  return scenarioHistories.get(scenario.id)!;
};
// Chart colour follows the metric, so RSS is the same colour in every scenario.
const metricClass = (series: ChartSeries) => series.metric === 'rss' || series.metric === 'sumRss' ? 'metric-rss' : series.metric === 'pss' || series.metric === 'uss' ? 'metric-pss' : 'metric-memory';
const sumOf = (state: WorldState, key: 'rss' | 'pss') => memoryRows(state).reduce((sum, row) => sum + row[key], 0);
// The RSS/PSS comparison is shown when a scenario depends on it, or when the reader opens it.
const accountingVisible = () => mode.kind === 'scenario' ? !!mode.scenario.accounting || mode.scenario.group === 'memory' && accountingOpen : mode.kind === 'sandbox' && accountingOpen;
// A scenario step's 3D labels name only what it changed from the step before, so the first step names everything.
const labelBaseline = () => mode.kind === 'scenario' && step > 0 ? history[step - 1] : null;

const caret = '<svg viewBox="0 0 5 3" width="10" height="6" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M0 0h5v1H4v1H3v1H2V2H1V1H0z"/></svg>';
// The sheet's head names what the panel shows. On narrow screens it carries the sheet's expand and close buttons.
const sheetHead = (title: string, more: string) => `<div class="sheet-head"><h1 tabindex="-1">${escapeHtml(title)}</h1><button id="sheet-toggle" class="sheet-toggle" type="button" aria-expanded="${sheetExpanded}" aria-controls="scenario-content" aria-label="${more}">${caret}</button><button class="panel-close sheet-close" type="button" data-close-panel aria-label="Close scenarios">×</button></div>`;

const drawer = (id: PanelId, meta: string, body: string, className = '', metaId = '') => `<section class="drawer-panel ${className}" data-panel-id="${id}" aria-label="${escapeHtml(panelLabels[id])}" tabindex="-1" hidden><div class="panel-heading"><span>${escapeHtml(panelLabels[id])}</span><span class="panel-meta"${metaId ? ` id="${metaId}"` : ''}>${meta}</span><button class="panel-close" type="button" data-close-panel aria-label="Close ${escapeHtml(panelLabels[id].toLowerCase())}">×</button></div>${body}</section>`;

root.innerHTML = `
  <div class="menu-dock">
    <button id="menu-toggle" class="menu-toggle" type="button" aria-label="Forkscape menu" aria-expanded="false" aria-controls="panel-menu"><img class="brand-mark" src="/favicon.svg" alt="" width="32" height="32" /><span class="brand">FORKSCAPE</span>${caret.replace('<svg', '<svg class="menu-caret"')}</button>
    <nav id="panel-menu" class="panel-menu" aria-label="Panels" hidden><div class="menu-heading"><span>A process memory lab</span><span class="badge">Model</span></div>${(Object.keys(panelLabels) as PanelId[]).map(id => `<button type="button" data-panel="${id}" aria-pressed="false">${escapeHtml(panelLabels[id])}</button>`).join('')}</nav>
  </div>
  <button id="view-toggle" class="view-toggle" type="button"></button>
  <main class="workspace">
    ${drawer('scenarios', 'Model', '<section id="scenario-content" class="scenario-content"></section>', 'lesson-rail', 'scenario-meta')}
    ${drawer('inspector', 'Model', '<div id="inspector" class="inspector"></div>')}
    ${drawer('timeline', '', '<div class="timeline-controls"><button id="prev-step" type="button" aria-label="Previous state">◀</button><button id="next-step" type="button" aria-label="Next state">▶</button><input id="time-range" type="range" min="0" max="0" value="0" aria-label="Timeline state" /><span id="step-label"></span></div><div id="event-strip" class="event-strip"></div>', 'timeline-panel', 'event-count')}
    ${drawer('ledger', 'Model · page tables included in charge', '<div id="ledger"></div><details class="reference-evidence"><summary>Linux reference observations · VM probes</summary><p>Residency: a new mapping has 0 KiB RSS until touched, and reading untouched anonymous pages leaves it at 0. After fork, a child’s RSS includes anonymous pages but not file pages that were never written. Its first touch maps them from the page cache. A child’s copy-on-write write left its RSS unchanged and added 4 KiB of <code>Private_Dirty</code>.</p><p>Django 6.1 under Gunicorn with preload and 2 workers: Σ RSS 259.8–259.9 MiB at boot against Σ PSS 90.2–90.3 MiB. One read-only catalog scan per worker added 55.2 MiB of Σ PSS and no Σ RSS.</p><p>Page tables: parent <code>VmPTE</code> rose by 0–8 KiB after mapping 16–1,024 pages, from a 76–80 KiB process-wide baseline. Those readings cannot isolate a mapping’s page tables.</p><p>With a 64 MiB cgroup limit, <code>memory.events: oom_kill</code> rose by one in each run. The kernel killed the child with the higher <code>oom_score_adj</code>; the model’s victim choice is only a teaching rule.</p></details>', 'ledger-panel')}
    ${drawer('view', 'Model', '<div class="panel-body"><h2 class="section-tag">3D camera</h2><div class="camera-controls" role="group" aria-label="3D camera controls"><button type="button" data-camera="overview">Overview</button><button type="button" data-camera="process">Decks</button><button type="button" data-camera="memory">Frames</button><button type="button" data-zoom="in" aria-label="Zoom in">＋</button><button type="button" data-zoom="out" aria-label="Zoom out">−</button></div><h2 class="section-tag">Legend</h2><ul class="legend"><li>1 tile = 1 page = 4 KiB</li><li><i class="legend-swatch shared"></i>shared</li><li><i class="legend-swatch private"></i>exclusive</li><li><i class="legend-swatch absent"></i>mapped, not resident</li><li><i class="legend-line filament"></i>thin line: a page mapped to its frame</li><li><i class="legend-line cable"></i>cable: a descriptor open on a kernel object</li><li>Physical layout is schematic</li></ul></div>')}
    <section class="scene-column" aria-label="Process and memory visualization">
      <div id="scene-host" class="scene-host"></div>
      <div id="flat-host" class="flat-host" hidden></div>
      <section id="selection-card" class="selection-card" aria-label="Selection" hidden><button id="close-selection-card" class="panel-close" type="button" aria-label="Close selection details">×</button><div id="selection-card-heading" aria-live="polite"></div><div id="selection-card-detail" class="selection-detail"></div><button id="open-inspector" class="subtle" type="button">Open in inspector</button></section>
    </section>
  </main>
  <div id="narration" class="sr-only" aria-live="polite"></div>
`;

const host = root.querySelector<HTMLElement>('#scene-host')!;
const hasTimeline = () => history.length > 1;
function renderChrome() {
  if (openPanel === 'timeline' && !hasTimeline()) openPanel = null;
  const toggle = root.querySelector<HTMLButtonElement>('#menu-toggle')!;
  toggle.setAttribute('aria-expanded', String(menuOpen));
  root.querySelector<HTMLElement>('#panel-menu')!.hidden = !menuOpen;
  root.querySelector<HTMLElement>('[data-panel="timeline"]')!.hidden = !hasTimeline();
  root.querySelectorAll<HTMLElement>('[data-panel]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.panel === openPanel)));
  root.querySelectorAll<HTMLElement>('[data-panel-id]').forEach(panel => { panel.hidden = panel.dataset.panelId !== openPanel; });
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
  const focus = stepFocus(scenario, step, world());
  clearSelection();
  selectedPid = focus.pid;
  selectedPage = focus.page === null ? null : { pid: focus.pid, page: focus.page };
}
function goToStep(index: number) {
  step = Math.max(0, Math.min(history.length - 1, index));
  selectionCardOpen = false;
  if (mode.kind === 'scenario') focusScenarioStep(mode.scenario);
  else if (mode.kind === 'sandbox') sandboxStep = step;
  render(true);
}

function applyHash(userNavigation: boolean) {
  const id = decodeURIComponent(location.hash.slice(1));
  const scenario = scenarioById(id);
  actionError = ''; selectionCardOpen = false;
  if (id === 'explore') {
    mode = { kind: 'sandbox' }; history = sandboxHistory; step = sandboxStep; clearSelection();
  } else if (scenario) {
    mode = { kind: 'scenario', scenario }; history = statesFor(scenario); step = 0; focusScenarioStep(scenario);
  } else {
    mode = { kind: 'library' }; history = [initialWorld()]; step = 0; selectedPid = 4100; clearSelection();
  }
  if (userNavigation) openPanel = 'scenarios';
  // The library is a list to choose from, so its sheet opens expanded; a scenario or free exploration opens on the scene.
  sheetExpanded = mode.kind === 'library';
  render();
  resetView();
  if (userNavigation) root.querySelector<HTMLElement>('#scenario-content h1')?.focus({ preventScroll: true });
  root.querySelector('[data-panel-id="scenarios"]')!.scrollTop = 0;
}

function renderLibrary() {
  const card = (scenario: Scenario) => `<li><a class="scenario-card" href="#${scenario.id}"><strong>${escapeHtml(scenario.title)}</strong><span>${escapeHtml(scenario.symptom)}</span>${scenario.accounting ? '<em class="card-tag">RSS vs PSS</em>' : ''}</a></li>`;
  return `<div class="lesson-kicker">Scenario library</div>${sheetHead('Fork and memory problems, replayed', 'Scenario list')}
    <p class="lesson-body">Each scenario replays a production problem in a model of a Gunicorn master and its workers. Step through it and watch the scene, then select any process, page, or frame to see how it works.</p>
    ${(Object.keys(groupLabels) as (keyof typeof groupLabels)[]).map(group => `<h2 class="section-tag">${escapeHtml(groupLabels[group])}</h2><ul class="scenario-list">${scenarios.filter(scenario => scenario.group === group).map(card).join('')}</ul>`).join('')}
    <a class="sandbox-link" href="#explore"><strong>Free exploration</strong><span>Start from a master process and change the model yourself.</span></a>`;
}

function niceCeiling(value: number) {
  return [16, 32, 48, 64, 96, 128, 160, 192, 256, 384, 512, 768, 1024].find(candidate => candidate >= value * 1.05) ?? Math.ceil(value / 256) * 256;
}

function renderChart(scenario: Scenario, states: WorldState[]) {
  const chart = scenario.chart;
  if (!chart) return '';
  const width = 360, height = 154, left = 54, right = 14, top = 12, bottom = 26;
  const values = chart.series.map(series => states.map(state => { const value = seriesValue(state, series); return value === null ? null : value / 1024; }));
  const limit = chart.limit ? states.find(state => state.limitBytes !== null)?.limitBytes ?? null : null;
  const yMax = niceCeiling(Math.max(...values.flat().filter((value): value is number => value !== null), limit === null ? 0 : limit / 1024));
  const x = (index: number) => left + (states.length === 1 ? 0 : index * (width - left - right) / (states.length - 1));
  const y = (value: number) => top + (1 - value / yMax) * (height - top - bottom);
  const path = (series: (number | null)[]) => series.reduce<string>((d, value, index) => value === null ? d : `${d}${index === 0 || series[index - 1] === null ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`, '');
  const ticks = [0, yMax / 2, yMax];
  const band = states.length === 1 ? width - left - right : (width - left - right) / (states.length - 1);
  const current = values.map(series => series[step]);
  const reading = (value: number | null) => value === null ? '—' : `${value} KiB`;
  return `<figure class="chart" aria-label="${escapeHtml(chart.series.map(series => series.label).join(' and '))} by step">
    <ul class="chart-legend">${chart.series.map((series, index) => `<li><i class="line-key ${metricClass(series)}" aria-hidden="true"></i><span>${escapeHtml(series.label)}</span><strong class="legend-value">${[...new Set(values[index].map(reading))].map(text => `<span${text === reading(current[index]) ? '' : ' aria-hidden="true"'}>${text}</span>`).join('')}</strong></li>`).join('')}</ul>
    <div class="chart-plot"><svg viewBox="0 0 ${width} ${height}" role="img" aria-hidden="true">
      ${ticks.map(tick => `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}"/><text class="chart-tick" x="${left - 6}" y="${y(tick) + 4}" text-anchor="end">${tick}${tick === yMax ? ' KiB' : ''}</text>`).join('')}
      ${states.map((_, index) => `<text class="chart-tick" x="${x(index)}" y="${height - 6}" text-anchor="middle">${index + 1}</text>`).join('')}
      ${limit === null ? '' : `<line class="chart-limit" x1="${left}" x2="${width - right}" y1="${y(limit / 1024)}" y2="${y(limit / 1024)}"/><text class="chart-tick chart-limit-label" x="${width - right}" y="${y(limit / 1024) - 5}" text-anchor="end">limit ${kb(limit)}</text>`}
      <line class="chart-cursor" data-motion="chart/cursor" x1="${x(step)}" x2="${x(step)}" y1="${top}" y2="${height - bottom}"/>
      ${values.map((series, index) => `<path class="chart-line ${metricClass(chart.series[index])}" d="${path(series)}"/>`).join('')}
      ${values.map((series, index) => series[step] === null ? '' : `<circle class="chart-dot ${metricClass(chart.series[index])}" data-motion="chart/dot/${index}" cx="${x(step)}" cy="${y(series[step]!)}" r="4"/>`).join('')}
      <line class="chart-hover" x1="0" x2="0" y1="${top}" y2="${height - bottom}" hidden/>
      ${states.map((_, index) => `<rect class="chart-hit" data-chart-step="${index}" x="${x(index) - band / 2}" y="0" width="${band}" height="${height}"/>`).join('')}
    </svg><div class="chart-tip" hidden></div></div>
    <div class="sr-only"><table><caption>${escapeHtml(scenario.title)}: values by step, in KiB</caption><thead><tr><th>Step</th>${chart.series.map(series => `<th>${escapeHtml(series.label)}</th>`).join('')}</tr></thead><tbody>${states.map((_, index) => `<tr><td>${index + 1}</td>${values.map(series => `<td>${series[index] ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  </figure>`;
}

function showChartTip(target: SVGRectElement) {
  const figure = target.closest<HTMLElement>('.chart');
  if (mode.kind !== 'scenario' || !figure) return;
  const index = Number(target.dataset.chartStep), series = mode.scenario.chart!.series, state = history[index];
  const tip = figure.querySelector<HTMLElement>('.chart-tip')!, hover = figure.querySelector<SVGLineElement>('.chart-hover')!;
  const centre = Number(target.getAttribute('x')) + Number(target.getAttribute('width')) / 2;
  hover.setAttribute('x1', String(centre)); hover.setAttribute('x2', String(centre)); hover.removeAttribute('hidden');
  const heading = document.createElement('span');
  heading.className = 'chart-tip-step';
  heading.textContent = `Step ${index + 1}`;
  tip.replaceChildren(heading, ...series.map(item => {
    const row = document.createElement('span'), key = document.createElement('i'), value = document.createElement('strong'), label = document.createElement('span');
    key.className = `line-key ${metricClass(item)}`;
    const amount = seriesValue(state, item);
    value.textContent = amount === null ? '—' : kb(amount);
    label.textContent = item.label;
    row.append(key, value, label);
    return row;
  }));
  tip.hidden = false;
  tip.style.left = `${Math.min(Math.max(centre / 360 * 100, 18), 82)}%`;
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
  // One scale and one height for the whole timeline: stepping grows the bars instead of rescaling them or moving what follows.
  const slots = Math.max(running.length, ...history.map(item => item.processes.filter(process => process.status === 'running' && residentPages(process) > 0).length));
  const scale = (width - nameWidth - metricWidth - valueWidth) / Math.max(...[state, ...history].flatMap(item => memoryRows(item).map(row => row.rss)));
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
  const finals = [{ label: `<a href="#${other.id}">${escapeHtml(contrast.label)}</a>`, state: statesFor(other).at(-1)! }, { label: escapeHtml(contrast.ownLabel), state: history.at(-1)! }];
  const cell = (key: 'rss' | 'pss', index: number) => {
    const [mine, theirs] = [sumOf(finals[index].state, key), sumOf(finals[1 - index].state, key)];
    return `<td class="${mine > theirs ? 'is-higher' : ''}">${kb(mine)}${mine > theirs ? ' <small>higher</small>' : ''}</td>`;
  };
  return `<table class="contrast"><caption>Both setups after both workers load the app</caption><thead><tr><th><span class="sr-only">Setup</span></th><th>Σ RSS</th><th>Σ PSS · in use</th></tr></thead><tbody>${finals.map((item, index) => `<tr><th>${item.label}</th>${cell('rss', index)}${cell('pss', index)}</tr>`).join('')}</tbody></table>`;
}

function renderAccountingSection(scenario: Scenario | null) {
  if (scenario?.accounting) return `<section class="accounting key" aria-label="RSS versus PSS"><h2 class="section-tag">RSS vs PSS</h2><p>${escapeHtml(scenario.accounting)}</p>${scenario.contrast ? renderContrast(scenario) : ''}${renderAccounting(world())}</section>`;
  return `<details class="accounting"${accountingOpen ? ' open' : ''}><summary id="accounting-summary">Compare RSS and PSS ${scenario ? 'at this step' : 'in this state'}</summary>${renderAccounting(world())}</details>`;
}

function renderScenario(scenario: Scenario) {
  const states = history, index = scenarios.filter(item => item.group === scenario.group).indexOf(scenario) + 1;
  const total = scenarios.filter(item => item.group === scenario.group).length;
  return `<a class="back-link" href="#scenarios"><span aria-hidden="true">←</span> All scenarios</a>
    <div class="lesson-kicker">${escapeHtml(groupLabels[scenario.group])} · ${index} of ${total}</div>${sheetHead(scenario.title, 'Scenario details')}
    <p class="symptom">${escapeHtml(scenario.symptom)}</p>
    <div class="step-detail"><h2 class="section-tag">This step</h2><p>${escapeHtml(states[step].events.at(-1)!.description)}</p></div>
    <div class="stepper">
      <div class="stepper-controls"><button id="scenario-prev" type="button" ${step === 0 ? 'disabled' : ''}><span aria-hidden="true">◀</span> Back</button><span class="step-count">Step ${step + 1} / ${states.length}</span><button id="scenario-next" class="step-next" type="button" ${step === states.length - 1 ? 'disabled' : ''}>Next <span aria-hidden="true">▶</span></button></div>
      <div class="step-slides">${scenario.steps.map((item, index) => `<div class="step-slide${index === step ? ' is-current' : ''}"><p class="step-caption">${escapeHtml(item.caption)}</p><p class="step-event">${escapeHtml(states[index].events.at(-1)!.description)}</p></div>`).join('')}</div>
    </div>
    ${renderChart(scenario, states)}
    ${scenario.group === 'memory' ? renderAccountingSection(scenario) : ''}
    <div class="scenario-note"><h2 class="section-tag">What to watch</h2><p>${escapeHtml(scenario.watch)}</p></div>
    <div class="scenario-note"><h2 class="section-tag">Why</h2><p>${escapeHtml(scenario.mechanism)}</p></div>
    <div class="on-call"><h2 class="section-tag">In production</h2><p>${escapeHtml(scenario.production)}</p><code>${escapeHtml(scenario.evidence)}</code></div>
    ${scenario.reference ? `<details class="reference-evidence scenario-reference"><summary>Linux reference observation</summary><p>${escapeHtml(scenario.reference)}</p></details>` : ''}
    <button id="explore-here" class="event-button" type="button">Explore from this step</button>
    <div class="related"><h2 class="section-tag">Related</h2>${scenario.related.map(id => `<a href="#${id}">${escapeHtml(scenarioById(id)!.title)}</a>`).join('')}</div>`;
}

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
    <p class="lesson-body">${sandboxOrigin ? `Started from step ${sandboxOrigin.step + 1} of <a href="#${sandboxOrigin.scenario.id}">${escapeHtml(sandboxOrigin.scenario.title)}</a>. ` : ''}Select a process or page, then act on it. Each action adds a state to the event timeline.</p>
    <div class="lab-dock"><div class="lab-actions">${button('Fork master', 'fork', state.processes[0]?.pid === 4100 && state.processes[0].status === 'running')}${button(page === null ? 'Read a selected page' : `Read page ${page}`, 'read', !!active && page !== null)}${button(page === null ? 'Write a selected page' : `Write page ${page}`, 'write', !!active && page !== null && !!pageRegion?.writable)}${button('Exit selected worker', 'exit', !!worker && !!active)}${button('Reap selected zombie', 'reap', !!worker && !!zombie)}</div>
      <p id="action-error" class="action-error">${escapeHtml(actionError)}</p>
      <div class="scenario-note last-event"><h2 class="section-tag">Last event</h2><p>${escapeHtml(state.events.at(-1)!.description)}</p></div></div>
    <details class="model-tools"><summary>More model controls</summary><div class="lab-actions">${button('Map 2 anonymous pages', 'map-anon', !!active)}${button('Map shared file page', 'map-file', !!active)}${button('Unmap latest region', 'unmap', !!active && !!process?.regions.some(r => r.id.startsWith('region-')))}${button('Open sample file', 'open', !!active)}${button('Read 16 bytes', 'file-read', !!active && !!openFile)}${button('Close sample file', 'file-close', !!active && !!openFile)}${button('Start thread', 'thread', !!active)}${button('Lock with newest thread', 'lock', !!active && (process?.threadIds.length ?? 0) > 1)}${button('Unlock', 'unlock', !!active && !!heldLock)}${button('Set limit to current use', 'limit')}${button('Remove limit', 'unlimit')}</div></details>
    <button id="reset-model" class="subtle" type="button">Reset model</button>
    ${renderAccountingSection(null)}`;
}

function renderScenarioPanel() {
  root.querySelector('#scenario-content')!.innerHTML = mode.kind === 'scenario' ? renderScenario(mode.scenario) : mode.kind === 'sandbox' ? renderSandbox() : renderLibrary();
  root.querySelector('#scenario-meta')!.textContent = mode.kind === 'sandbox' ? 'Free exploration' : `${scenarios.length} scenarios · model`;
  document.title = mode.kind === 'scenario' ? `${mode.scenario.title} — Forkscape` : mode.kind === 'sandbox' ? 'Free exploration — Forkscape' : 'Forkscape — See what fork() really copies';
}

// A selected page traces to its frame, a frame to every page mapped to it, and a cable to its kernel object.
const tracedFrame = (state: WorldState) => selectedFrame ?? (selectedPage && state.processes.find(p => p.pid === selectedPage!.pid)?.pages[selectedPage.page]) ?? null;
const tracedObject = (state: WorldState) => selectedObjectId ?? (selectedStructure?.part === 'cable' ? state.processes.find(p => p.pid === selectedStructure!.pid)?.descriptors[selectedStructure.index]?.objectId : null) ?? null;
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
  root.querySelector('#flat-host')!.innerHTML = `<h2 class="flat-title" data-motion="flat/processes">Process address spaces</h2><div class="flat-processes">${state.processes.map(process => `<div class="flat-process ${processSelected(process.pid) ? 'selected' : ''}" data-motion="p/${process.pid}"><button type="button" data-pid="${process.pid}"${processSelected(process.pid) ? ' aria-current="true"' : ''}><strong>${process.role} · PID ${process.pid}</strong><span>${process.status === 'zombie' ? 'Zombie · mappings released' : `PPID ${process.parentPid ?? '—'} · ${residentPages(process)} of ${mappedPages(process)} pages resident · ${process.threadIds.length} thread(s)`}</span>${showAccounting && process.status === 'running' ? `<span class="flat-accounting">${accountingLabel(state, process.pid)}</span>` : ''}</button><div class="page-strip">${process.regions.flatMap(region => regionPages(region).map(index => chip(process, index, region))).join('')}</div>${process.status === 'running' ? `<div class="structure-list" role="group" aria-label="PID ${process.pid} scene parts">${structureButtons(state, process.pid)}</div>` : ''}</div>`).join('')}</div><h2 class="flat-title" data-motion="flat/frames">Physical frames</h2><div class="flat-frames">${state.frames.map(frame => `<button type="button" data-motion="f/${frame.id}" data-frame="${frame.id}"${selectedFrame === frame.id ? ' aria-current="true"' : ''} class="flat-frame ${selectedFrame === frame.id ? 'selected' : frame.id === frameTrace ? 'is-linked' : ''}"><strong>F${frame.id}</strong><span>${escapeHtml(frame.region)}</span><small>${sharers(state, frame.id)} ${sharers(state, frame.id) === 1 ? 'mapping' : 'mappings'}</small></button>`).join('')}</div><h2 class="flat-title" data-motion="flat/objects">Kernel objects</h2><div class="flat-frames">${state.kernelObjects.map(object => `<button type="button" data-motion="o/${escapeHtml(object.id)}" data-object="${escapeHtml(object.id)}"${selectedObjectId === object.id ? ' aria-current="true"' : ''} class="flat-frame ${selectedObjectId === object.id ? 'selected' : object.id === objectTrace ? 'is-linked' : ''}"><strong>${escapeHtml(object.kind)}</strong><span>${escapeHtml(object.id)}</span><small>${objectRefCount(state, object.id)} descriptor(s)${object.kind === 'file' ? ` · offset ${object.offset}` : ''}</small></button>`).join('')}</div><p class="flat-note" data-motion="flat/note">Select a page to find its frame, or a frame to find every page mapped to it. A stacked chip shares its frame with another mapping, and a dash marks a page that is mapped but not resident. Descriptors in several processes can refer to one kernel object.</p>`;
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

const eventIcons: Record<string, string> = { start: '●', fork: '⑂', cow_fault: '✦', demand_zero: '+', zero_page: '○', minor_fault: '↧', major_fault: '⇩', write: '✎', exit: '×', reap: '↻', oom_kill: '!', mmap: '▭', munmap: '−', limit: '┄' };
function renderTimeline(state: WorldState) {
  const range = root.querySelector('#time-range') as HTMLInputElement;
  range.max = String(history.length - 1);
  range.value = String(step);
  range.setAttribute('aria-valuetext', mode.kind === 'scenario' ? `Step ${step + 1} of ${history.length}` : `State ${step + 1} of ${history.length}`);
  (root.querySelector('#prev-step') as HTMLButtonElement).disabled = step === 0;
  (root.querySelector('#next-step') as HTMLButtonElement).disabled = step === history.length - 1;
  const scenario = mode.kind === 'scenario' ? mode.scenario : null;
  root.querySelector('#step-label')!.textContent = scenario ? `Step ${step + 1} / ${history.length}` : `${step + 1} / ${history.length}`;
  root.querySelector('#event-count')!.textContent = scenario ? 'Scenario · model' : `${history.length} states`;
  root.querySelector('#event-strip')!.innerHTML = history.map((item, index) => {
    const kind = item.events.at(-1)!.kind;
    const label = scenario ? `Step ${index + 1}: ${scenario.steps[index].caption}` : `State ${index + 1}: ${kind}`;
    return `<button type="button" data-step="${index}" class="event-tick ${index === step ? 'active' : ''}" aria-label="${escapeHtml(label)}"${index === step ? ' aria-current="step"' : ''}><span class="tick-icon">${eventIcons[kind] ?? '•'}</span><span>${scenario ? index + 1 : escapeHtml(kind.replace('_', ' '))}</span></button>`;
  }).join('');
  // Rewriting a live region with the same text can repeat it, so only a change is written. A failed action is announced here, once.
  const narration = actionError || (scenario ? `Step ${step + 1}. ${scenario.steps[step].caption}` : state.events.at(-1)!.description);
  const live = root.querySelector('#narration')!;
  if (live.textContent !== narration) live.textContent = narration;
}

/** Draws the current state. A step animates: marks and scene objects move from where they were drawn, and a new process comes out of its parent. */
function render(animate = false) {
  const focused = document.activeElement as HTMLElement | null;
  const focusAttributes = focused ? ['id', 'href', 'data-lab', 'data-pid', 'data-ledger-pid', 'data-page', 'data-page-pid', 'data-frame', 'data-object', 'data-structure', 'data-structure-pid', 'data-structure-index', 'data-step'].flatMap(name => focused.hasAttribute(name) ? [[name, focused.getAttribute(name)]] : []) : [];
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
  sandboxHistory = [start]; sandboxStep = 0; sandboxOrigin = origin;
  history = sandboxHistory; step = 0; actionError = '';
}

root.addEventListener('click', event => {
  const target = event.target as Element;
  if (target.closest('#menu-toggle')) { menuOpen = !menuOpen; renderChrome(); return; }
  const panelItem = target.closest<HTMLElement>('[data-panel]');
  if (panelItem) { const id = panelItem.dataset.panel as PanelId; showPanel(openPanel === id ? null : id); return; }
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
  if (target.closest('#scenario-prev')) { goToStep(step - 1); return; }
  if (target.closest('#scenario-next')) { goToStep(step + 1); return; }
  if (target.closest('#explore-here') && mode.kind === 'scenario') {
    resetSandbox(world(), { scenario: mode.scenario, step });
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
    if (action === 'fork') { runAction({ type: 'fork', parentPid: 4100 }); return; }
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
// toggle does not bubble, so listen in the capture phase. A re-rendered open <details> fires toggle again with no change.
root.addEventListener('toggle', event => {
  const details = event.target as HTMLDetailsElement;
  if (!details.matches('details.accounting') || details.open === accountingOpen) return;
  accountingOpen = details.open;
  render();
}, true);
window.addEventListener('hashchange', () => applyHash(true));

applyHash(false);
