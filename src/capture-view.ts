import './theme.css';
import './capture.css';
import { CAPTURE_STORAGE_KEY, parseCapture, type Capture, type CaptureMetadata, type CaptureSample } from './capture';
import { CaptureAggregateScene } from './capture-scene';
import { syntheticProcessCapture } from './synthetic-capture';

const root = document.querySelector<HTMLDivElement>('#capture-app')!;
let capture: Capture | null = null;
let selected = 0;
let aggregateScene: CaptureAggregateScene | null = null;
let sceneUnavailable = false;
let flat = (() => { try { return localStorage.getItem('forkscape-flat') === 'true'; } catch { return false; } })();

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const mib = (kib: number | null) => kib === null ? '—' : `${(kib / 1024).toFixed(1)} MiB`;
const total = (sample: CaptureSample, key: 'rssKiB' | 'pssKiB') => sample.processes.reduce<number | null>((sum, item) => sum === null || item[key] === null ? null : sum + item[key], 0);
const phase = (name: string) => name.replaceAll('_', ' ');
/** Where the samples came from: a pod's namespace and name, or a host when the capture names no pod. */
const provenance = (metadata: CaptureMetadata) => metadata.namespace && metadata.podName
  ? `Linux <code>/proc</code> and container cgroup · ${escape(metadata.namespace)}/${escape(metadata.podName)}`
  : `Linux <code>/proc</code> and cgroup${metadata.host ? ` · host ${escape(metadata.host)}` : ''}`;

root.innerHTML = `
  <header class="capture-header"><a href="/" class="capture-brand"><img src="/favicon.svg" alt="" width="32" height="32" /> FORKSCAPE</a><div class="capture-header-actions"><span class="capture-badge">Linux capture</span><button id="view-toggle" class="view-toggle capture-view-toggle" type="button" hidden></button></div></header>
  <p id="capture-error" class="capture-error" role="alert" hidden></p>
  <main id="capture-empty" class="capture-intro"><p class="capture-kicker">Measured process startup</p><h1>Open a capture</h1><p>Choose a <code>forkscape.capture.v1</code> file with the app's recording picker.</p><a class="capture-start" href="/#recording">Choose a recording or capture →</a></main>
  <main id="capture-result" class="capture-workspace" hidden>
    <aside class="capture-rail" aria-label="Capture timeline and measurements">
      <div class="capture-panel-heading"><span>Recorded telemetry</span><span id="capture-panel-count"></span></div>
      <div class="capture-rail-content">
        <a class="capture-back" href="/#recording">← Replay telemetry</a>
        <p class="capture-kicker">Linux memory · measured</p>
        <h1>Process memory across startup</h1>
        <p class="capture-intro-text">Step through the samples. Each raised deck is a process; its three columns show RSS, PSS, and approximate USS. The cgroup reading has its own place on the floor.</p>
        <p id="capture-source" class="capture-provenance" hidden></p>
        <section class="capture-stepper" aria-label="Capture samples">
          <div class="capture-stepper-heading"><span id="capture-3d-time"></span></div>
          <div class="capture-controls"><button id="capture-3d-prev" type="button">← Previous</button><input id="capture-3d-range" type="range" min="0" value="0" aria-label="Capture sample" /><button id="capture-3d-next" type="button">Next →</button></div>
          <p id="capture-step-summary"></p>
        </section>
        <div id="capture-chart"></div>
        <div id="capture-overview"></div>
        <section id="capture-events" class="capture-events"></section>
        <p class="capture-limit">These are aggregate measurements. This capture does not identify physical frames or count exact copy-on-write faults.</p>
      </div>
    </aside>
    <section class="capture-stage" aria-label="Capture visualization">
      <figure id="capture-3d" class="capture-3d" aria-labelledby="capture-3d-title" hidden>
        <div class="capture-3d-heading"><div><p class="capture-kicker">Measured in 3D</p><h2 id="capture-3d-title">Process memory at this sample</h2></div><p>Drag to rotate · wheel or pinch to zoom</p></div>
        <div id="capture-scene" class="capture-3d-host" aria-hidden="true"></div>
        <p id="capture-scene-fallback" class="capture-3d-fallback" role="status" hidden>3D is unavailable in this browser. Switch to Flat view for the chart and process table.</p>
        <div class="capture-3d-foot">
          <div class="capture-3d-key" aria-hidden="true"><span><i class="rss"></i>RSS</span><span><i class="pss"></i>PSS</span><span><i class="uss"></i>Approx. USS</span><span><i class="cgroup"></i>Cgroup charge</span></div>
          <div id="capture-3d-readout" class="capture-3d-readout"></div>
          <p id="capture-scene-scale" class="capture-3d-scale"></p>
          <figcaption>Heights show sampled memory on fixed scales. Cgroup charge is the container's memory usage counter, including charged process, cache, and kernel memory. On cgroup v2 this is <code>memory.current</code>. The cgroup uses its own scale. The columns do not show individual pages or exact copy-on-write faults.</figcaption>
        </div>
      </figure>
      <div id="capture-detail"></div>
    </section>
  </main>`;

function chart(view: Capture, index: number): string {
  const samples = view.samples;
  const width = 760, height = 246, left = 58, right = 20, top = 18, bottom = 39;
  const maxTime = Math.max(samples.at(-1)!.elapsedMs, 1);
  const series = [
    { name: 'Σ RSS', className: 'rss', values: samples.map(sample => total(sample.data, 'rssKiB')) },
    { name: 'Σ PSS', className: 'pss', values: samples.map(sample => total(sample.data, 'pssKiB')) },
    { name: 'Cgroup', className: 'cgroup', values: samples.map(sample => sample.data.cgroup.memoryCurrentBytes === null ? null : sample.data.cgroup.memoryCurrentBytes / 1024) },
  ];
  const maxValue = Math.max(1024, ...series.flatMap(item => item.values.filter((value): value is number => value !== null)));
  const ceiling = Math.ceil(maxValue / 1024 / 8) * 8 * 1024;
  const x = (elapsed: number) => left + elapsed / maxTime * (width - left - right);
  const y = (value: number) => top + (1 - value / ceiling) * (height - top - bottom);
  const line = (values: (number | null)[]) => values.reduce((path, value, point) => value === null ? path : `${path}${point === 0 || values[point - 1] === null ? 'M' : 'L'}${x(samples[point].elapsedMs).toFixed(1)},${y(value).toFixed(1)}`, '');
  return `<figure class="capture-chart"><figcaption>Memory across startup</figcaption><ul class="capture-chart-legend">${series.map(item => `<li><i class="capture-line-key ${item.className}"></i>${item.name}</li>`).join('')}</ul>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Summed RSS, summed PSS, and cgroup memory over time">
      ${[0, ceiling / 2, ceiling].map(value => `<line class="capture-grid" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text class="capture-axis" x="${left - 8}" y="${y(value) + 4}" text-anchor="end">${Math.round(value / 1024)}</text>`).join('')}
      <text class="capture-axis" x="7" y="11">MiB</text><text class="capture-axis" x="${left}" y="${height - 9}">0</text><text class="capture-axis" x="${width - right}" y="${height - 9}" text-anchor="end">${(maxTime / 1000).toFixed(1)} s</text>
      ${view.markers.map(marker => `<line class="capture-marker-line" x1="${x(marker.elapsedMs)}" x2="${x(marker.elapsedMs)}" y1="${top}" y2="${height - bottom}"><title>${escape(phase(marker.data.name))} · ${(marker.elapsedMs / 1000).toFixed(2)} s</title></line>`).join('')}
      ${series.map(item => `<path class="capture-series ${item.className}" d="${line(item.values)}"/>`).join('')}
      <line class="capture-cursor" x1="${x(samples[index].elapsedMs)}" x2="${x(samples[index].elapsedMs)}" y1="${top}" y2="${height - bottom}"/>
    </svg><p class="capture-chart-note">Each point samples processes at slightly different instants. Cgroup charge and summed PSS can differ in either direction: mapped pages may be charged to another cgroup, while cache and kernel allocations add charges absent from process PSS.</p>
    <details><summary>Values behind the chart</summary><div class="capture-table-scroll"><table><thead><tr><th>Time</th><th>Σ RSS</th><th>Σ PSS</th><th>Cgroup</th></tr></thead><tbody>${samples.map(sample => `<tr><td>${(sample.elapsedMs / 1000).toFixed(2)} s</td><td>${mib(total(sample.data, 'rssKiB'))}</td><td>${mib(total(sample.data, 'pssKiB'))}</td><td>${mib(sample.data.cgroup.memoryCurrentBytes === null ? null : sample.data.cgroup.memoryCurrentBytes / 1024)}</td></tr>`).join('')}</tbody></table></div></details>
  </figure>`;
}

function render() {
  const result = root.querySelector<HTMLElement>('#capture-result')!;
  root.querySelector<HTMLElement>('#capture-empty')!.hidden = !!capture;
  const viewToggle = root.querySelector<HTMLButtonElement>('#view-toggle')!;
  viewToggle.hidden = !capture;
  result.hidden = !capture;
  if (!capture) return;
  viewToggle.innerHTML = flat ? '<span aria-hidden="true">◈</span> 3D view' : '<span aria-hidden="true">▦</span> Flat view';
  root.querySelector<HTMLElement>('#capture-3d')!.hidden = flat;
  root.querySelector<HTMLElement>('#capture-detail')!.hidden = !flat;
  selected = Math.max(0, Math.min(selected, capture.samples.length - 1));
  const sample = capture.samples[selected], data = sample.data;
  const priorMarkers = capture.markers.filter(marker => marker.elapsedMs <= sample.elapsedMs);
  const recentMarker = priorMarkers.at(-1);
  const endLabel = capture.end?.data.status === 'ok' ? 'Complete' : capture.end?.data.status === 'error' ? 'Probe error' : 'Incomplete';
  root.querySelector<HTMLElement>('#capture-panel-count')!.textContent = `${capture.samples.length} samples`;
  root.querySelector<HTMLElement>('#capture-3d-time')!.textContent = `Sample ${selected + 1} of ${capture.samples.length} · ${(sample.elapsedMs / 1000).toFixed(2)} s${recentMarker ? ` · ${phase(recentMarker.data.name)}` : ''}`;
  root.querySelector<HTMLElement>('#capture-step-summary')!.textContent = `Σ RSS ${mib(total(data, 'rssKiB'))} · Σ PSS ${mib(total(data, 'pssKiB'))} · cgroup ${mib(data.cgroup.memoryCurrentBytes === null ? null : data.cgroup.memoryCurrentBytes / 1024)}`;
  root.querySelector<HTMLButtonElement>('#capture-3d-prev')!.disabled = selected === 0;
  root.querySelector<HTMLButtonElement>('#capture-3d-next')!.disabled = selected === capture.samples.length - 1;
  const sceneRange = root.querySelector<HTMLInputElement>('#capture-3d-range')!;
  sceneRange.max = String(capture.samples.length - 1);
  sceneRange.value = String(selected);
  const seen = new Set<string>();
  const allProcesses = capture.samples.flatMap(item => item.data.processes).filter(item => {
    const key = `${item.pid}/${item.startTicks}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  root.querySelector<HTMLElement>('#capture-3d-readout')!.innerHTML = `${allProcesses.map((item, index) => {
    const present = data.processes.find(process => process.pid === item.pid && process.startTicks === item.startTicks);
    return `<div><strong><b>${index + 1}</b>${escape(item.role)} · PID ${item.pid}</strong><span>${present ? `RSS ${mib(present.rssKiB)} · PSS ${mib(present.pssKiB)} · approx. USS ${mib(present.ussKiB)}` : 'Absent in this sample'}</span></div>`;
  }).join('')}<div><strong><b>${allProcesses.length + 1}</b>Cgroup charge</strong><span>${mib(data.cgroup.memoryCurrentBytes === null ? null : data.cgroup.memoryCurrentBytes / 1024)}</span></div>`;
  root.querySelector<HTMLElement>('#capture-overview')!.innerHTML = `<div class="capture-meta"><div><span>Workload</span><strong>${escape(capture.metadata.workload)}</strong></div><div><span>Environment</span><strong>${escape(capture.metadata.environment)} · ${capture.metadata.synthetic ? 'synthetic' : 'application'}</strong></div><div><span>Kernel / architecture</span><strong>${escape(capture.metadata.kernel)} · ${escape(capture.metadata.architecture)}</strong></div><div><span>Run</span><strong>${endLabel} · ${capture.samples.length} samples</strong></div></div>
    <p class="capture-provenance">Source: ${provenance(capture.metadata)} · page size ${capture.metadata.pageSizeBytes} bytes</p>`;
  root.querySelector<HTMLElement>('#capture-chart')!.innerHTML = chart(capture, selected);
  root.querySelector<HTMLElement>('#capture-detail')!.innerHTML = `<section class="capture-sample"><div class="capture-section-head"><div><p class="capture-kicker">Sample ${selected + 1} of ${capture.samples.length}</p><h2>${(sample.elapsedMs / 1000).toFixed(2)} seconds from start</h2></div><span>${recentMarker ? `${escape(phase(recentMarker.data.name))} · PID ${recentMarker.data.pid}` : 'Baseline'}</span></div>
      <div class="capture-controls"><button id="capture-prev" type="button" ${selected === 0 ? 'disabled' : ''}>← Previous</button><input id="capture-range" type="range" min="0" max="${capture.samples.length - 1}" value="${selected}" aria-label="Capture sample" /><button id="capture-next" type="button" ${selected === capture.samples.length - 1 ? 'disabled' : ''}>Next →</button></div>
      <div class="capture-stats"><div><span>Σ RSS</span><strong>${mib(total(data, 'rssKiB'))}</strong></div><div><span>Σ PSS</span><strong>${mib(total(data, 'pssKiB'))}</strong></div><div><span>Cgroup</span><strong>${mib(data.cgroup.memoryCurrentBytes === null ? null : data.cgroup.memoryCurrentBytes / 1024)}</strong></div><div><span>Limit</span><strong>${mib(data.cgroup.memoryMaxBytes === null ? null : data.cgroup.memoryMaxBytes / 1024)}</strong></div></div>
      <div class="capture-table-scroll"><table><caption>Processes in this sample</caption><thead><tr><th>Process</th><th>RSS</th><th>PSS</th><th>Approx. USS</th><th>Private dirty</th><th>Minor faults</th></tr></thead><tbody>${data.processes.map(item => `<tr><th>${escape(item.role)} ${item.pid}</th><td>${mib(item.rssKiB)}</td><td>${mib(item.pssKiB)}</td><td>${mib(item.ussKiB)}</td><td>${mib(item.privateDirtyKiB)}</td><td>${item.minorFaults ?? '—'}</td></tr>`).join('')}</tbody></table></div>
      ${data.missingPids.length ? `<p class="capture-gap">Missing during this sample: PID ${data.missingPids.join(', ')}</p>` : ''}
    </section>`;
  root.querySelector<HTMLElement>('#capture-events')!.innerHTML = `<h2>Startup markers</h2><div>${capture.markers.map(marker => `<button type="button" data-marker-seq="${marker.seq}" class="${marker === recentMarker ? 'current' : ''}"><span>${(marker.elapsedMs / 1000).toFixed(2)} s</span>${escape(phase(marker.data.name))}${marker.data.pid ? ` · PID ${marker.data.pid}` : ''}</button>`).join('')}</div>`;
  if (!flat && !aggregateScene && !sceneUnavailable) mountScene();
  else if (!flat) aggregateScene?.update(data, selected);
}

function mountScene() {
  if (!capture) return;
  const host = root.querySelector<HTMLElement>('#capture-scene')!;
  const fallback = root.querySelector<HTMLElement>('#capture-scene-fallback')!;
  host.hidden = false;
  fallback.hidden = true;
  try {
    aggregateScene = new CaptureAggregateScene(host, capture);
    aggregateScene.update(capture.samples[selected].data, selected);
    root.querySelector<HTMLElement>('#capture-scene-scale')!.textContent =
      `Process columns: 0–${aggregateScene.processCeilingMiB} MiB · Cgroup column: 0–${aggregateScene.cgroupCeilingMiB} MiB`;
    host.hidden = false;
    fallback.hidden = true;
  } catch {
    aggregateScene?.dispose();
    aggregateScene = null;
    sceneUnavailable = true;
    host.replaceChildren();
    host.hidden = true;
    fallback.hidden = false;
    root.querySelector<HTMLElement>('#capture-scene-scale')!.textContent = '';
  }
}

function loadCapture(text: string, fileName: string) {
  const parsed = parseCapture(text);
  aggregateScene?.dispose();
  aggregateScene = null;
  sceneUnavailable = false;
  capture = parsed;
  selected = 0;
  const source = root.querySelector<HTMLElement>('#capture-source')!;
  source.textContent = `Loaded ${fileName}`;
  source.hidden = false;
  document.title = `${fileName} — Forkscape`;
  render();
}

root.addEventListener('input', event => {
  if (['capture-range', 'capture-3d-range'].includes((event.target as HTMLElement).id)) {
    selected = Number((event.target as HTMLInputElement).value);
    render();
  }
});
root.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (target.closest('#view-toggle')) {
    flat = !flat;
    try { localStorage.setItem('forkscape-flat', String(flat)); } catch { /* The view still switches. */ }
    render();
    return;
  }
  if (target.closest('#capture-prev, #capture-3d-prev')) selected--;
  else if (target.closest('#capture-next, #capture-3d-next')) selected++;
  else {
    const markerButton = target.closest<HTMLElement>('[data-marker-seq]');
    if (!markerButton || !capture) return;
    const marker = capture.markers.find(item => item.seq === Number(markerButton.dataset.markerSeq));
    if (!marker) return;
    selected = capture.samples.findIndex(item => item.elapsedMs >= marker.elapsedMs);
    if (selected < 0) selected = capture.samples.length - 1;
  }
  render();
});

try {
  if (new URLSearchParams(location.search).get('sample') === 'synthetic') {
    loadCapture(syntheticProcessCapture(), 'Synthetic process startup');
  } else {
    const saved = JSON.parse(sessionStorage.getItem(CAPTURE_STORAGE_KEY) ?? 'null') as { fileName?: unknown; text?: unknown } | null;
    if (saved && typeof saved.text === 'string' && typeof saved.fileName === 'string') loadCapture(saved.text, saved.fileName);
  }
} catch (cause) {
  const error = root.querySelector<HTMLElement>('#capture-error')!;
  error.textContent = `The saved capture could not be opened. ${cause instanceof Error ? cause.message : String(cause)}`;
  error.hidden = false;
  try { sessionStorage.removeItem(CAPTURE_STORAGE_KEY); } catch { /* Nothing to clear. */ }
}
if (!capture) render();
