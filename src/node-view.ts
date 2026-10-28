import './theme.css';
import './capture.css';
import './node.css';
import { NODE_STORAGE_KEY, counterRate, parseNodeCapture, type NodeCapture } from './node-capture';
import { NodeAggregateScene } from './node-scene';
import { syntheticNodeRecording } from './synthetic-node';

const root = document.querySelector<HTMLDivElement>('#node-app')!;
let capture: NodeCapture | null = null;
let selected = 0;
let aggregateScene: NodeAggregateScene | null = null;
let sceneUnavailable = false;
let flat = (() => { try { return localStorage.getItem('forkscape-flat') === 'true'; } catch { return false; } })();

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const value = (amount: number | null, format: (number: number) => string) => amount === null ? '—' : format(amount);
const mib = (bytes: number | null) => value(bytes, amount => `${(amount / 1048576).toFixed(1)} MiB`);
const cpu = (nanoCores: number | null) => value(nanoCores, amount => `${Math.round(amount / 1000000)} mCPU`);
const faults = (rate: number | null) => value(rate, amount => `${Math.round(amount).toLocaleString()} /s`);
const throughput = (rate: number | null) => value(rate, amount => `${(amount / 1024).toFixed(1)} KiB/s`);
const count = (amount: number | null) => value(amount, number => number.toLocaleString());
const percent = (amount: number | null) => value(amount, number => `${number.toFixed(2)}%`);
const time = (elapsedMs: number) => `${(elapsedMs / 1000).toFixed(2)} s`;

root.innerHTML = `
  <header class="capture-header"><a href="/" class="capture-brand"><img src="/favicon.svg" alt="" width="32" height="32" /> FORKSCAPE</a><div class="capture-header-actions"><span class="capture-badge">EC2 node telemetry</span><button id="view-toggle" class="view-toggle capture-view-toggle" type="button" hidden></button></div></header>
  <p id="node-error" class="capture-error" role="alert" hidden></p>
  <main id="node-empty" class="capture-intro"><p class="capture-kicker">Measured node telemetry</p><h1>Open a node recording</h1><p>Use the recording picker for a <code>forkscape.node.v1</code> time series or a raw Kubelet stats/summary JSON snapshot.</p><a class="capture-start" href="/#recording">Choose a recording or capture →</a></main>
  <main id="node-result" class="capture-workspace" hidden>
    <aside class="capture-rail" aria-label="Node recording timeline">
      <div class="capture-panel-heading"><span>Node telemetry</span><span id="node-count"></span></div>
      <div class="capture-rail-content">
        <a class="capture-back" href="/#recording">← Replay telemetry</a>
        <p class="capture-kicker">Measured · Kubelet summary</p>
        <h1>Node across startup</h1>
        <p class="capture-intro-text">Step through what the EC2 node reported. The 3D columns and Flat charts keep fixed scales as values move with each sample.</p>
        <p id="node-source" class="capture-provenance" hidden></p>
        <section class="capture-stepper" aria-label="Node samples">
          <div class="capture-stepper-heading"><span id="node-time"></span></div>
          <div class="capture-controls"><button id="node-prev" type="button">← Previous</button><input id="node-range" type="range" min="0" value="0" aria-label="Node sample" /><button id="node-next" type="button">Next →</button></div>
          <p id="node-summary"></p>
        </section>
        <div id="node-overview"></div>
        <section class="capture-events"><h2>Pod and collector markers</h2><div id="node-markers" class="node-marker-list"></div></section>
        <p class="capture-limit">These are sampled node and optional Pod aggregates. Page-fault counts do not identify copied pages; network bytes do not identify sockets.</p>
      </div>
    </aside>
    <section class="capture-stage" aria-label="Node visualization">
      <figure id="node-3d" class="capture-3d node-3d" aria-labelledby="node-3d-title" hidden>
        <div class="capture-3d-heading"><div><p class="capture-kicker">Measured in 3D</p><h2 id="node-3d-title">EC2 node across startup</h2></div><p>Drag to rotate · wheel or pinch to zoom</p></div>
        <div id="node-scene" class="capture-3d-host" aria-hidden="true"></div>
        <p id="node-scene-fallback" class="capture-3d-fallback" role="status" hidden>3D is unavailable in this browser. Switch to Flat view for the charts and measurements.</p>
        <div class="capture-3d-foot"><div id="node-3d-readout" class="node-3d-readout"></div><p id="node-scene-scales" class="capture-3d-scale"></p><figcaption>Each station uses its own fixed scale across the recording. A missing or stale rate leaves its column empty. These are aggregate node and Pod measurements, not individual pages or sockets.</figcaption></div>
      </figure>
      <div id="node-detail" class="node-detail"></div>
    </section>
  </main>`;

type Series = { label: string; color: string; values: (number | null)[]; format: (value: number | null) => string };
const W = 620, H = 230, L = 57, R = 18, T = 17, B = 37;

function chart(title: string, unit: string, series: Series[], view: NodeCapture, index: number): string {
  const samples = view.samples;
  const firstTime = samples[0].elapsedMs, duration = samples.at(-1)!.elapsedMs - firstTime;
  const x = (elapsed: number) => duration > 0 ? L + (elapsed - firstTime) / duration * (W - L - R) : L + (W - L - R) / 2;
  const max = Math.max(1, ...series.flatMap(item => item.values.filter((item): item is number => item !== null)));
  const ceiling = Math.ceil(max / 4) * 4;
  const y = (amount: number) => T + (1 - amount / ceiling) * (H - T - B);
  const path = (values: (number | null)[]) => {
    let d = '', open = false;
    values.forEach((amount, point) => {
      if (amount === null) { open = false; return; }
      d += `${open ? 'L' : 'M'}${x(samples[point].elapsedMs).toFixed(1)},${y(amount).toFixed(1)}`;
      open = true;
    });
    return d;
  };
  const markerLines = view.markers.filter(item => item.elapsedMs >= firstTime && item.elapsedMs <= samples.at(-1)!.elapsedMs)
    .map(item => `<line class="marker" x1="${x(item.elapsedMs)}" x2="${x(item.elapsedMs)}" y1="${T}" y2="${H - B}"><title>${escape(item.data.name)} · ${time(item.elapsedMs)}</title></line>`).join('');
  return `<figure class="node-chart"><figcaption>${escape(title)}</figcaption><ul class="node-chart-legend">${series.map(item => `<li style="--line:${item.color}"><i></i>${escape(item.label)} <strong>${item.format(item.values[index])}</strong></li>`).join('')}</ul>
    <svg viewBox="0 0 ${W} ${H}" data-chart="true" role="img" aria-label="${escape(title)} over time; click the chart to select a sample">
      ${[0, ceiling / 2, ceiling].map(amount => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(amount)}" y2="${y(amount)}"/><text class="axis" x="${L - 8}" y="${y(amount) + 4}" text-anchor="end">${Number.isInteger(amount) ? amount : amount.toFixed(1)}</text>`).join('')}
      <text class="axis" x="5" y="11">${escape(unit)}</text><text class="axis" x="${L}" y="${H - 8}">${time(firstTime)}</text><text class="axis" x="${W - R}" y="${H - 8}" text-anchor="end">${time(samples.at(-1)!.elapsedMs)}</text>
      ${markerLines}${series.map(item => `<path class="line" style="--line:${item.color}" d="${path(item.values)}"/>`).join('')}
      ${series.flatMap(item => item.values.flatMap((amount, point) => amount !== null && item.values[point - 1] == null && item.values[point + 1] == null
        ? `<circle class="single-point" style="--line:${item.color}" cx="${x(samples[point].elapsedMs)}" cy="${y(amount)}" r="3"/>` : [])).join('')}
      <line class="cursor" x1="${x(samples[index].elapsedMs)}" x2="${x(samples[index].elapsedMs)}" y1="${T}" y2="${H - B}"/>
      ${series.map(item => item.values[index] === null ? '' : `<circle class="selected-point" style="--line:${item.color}" cx="${x(samples[index].elapsedMs)}" cy="${y(item.values[index])}" r="5"/>`).join('')}
    </svg></figure>`;
}

function render() {
  root.querySelector<HTMLElement>('#node-empty')!.hidden = !!capture;
  const result = root.querySelector<HTMLElement>('#node-result')!;
  result.hidden = !capture;
  const viewToggle = root.querySelector<HTMLButtonElement>('#view-toggle')!;
  viewToggle.hidden = !capture;
  if (!capture) return;
  viewToggle.innerHTML = flat ? '<span aria-hidden="true">◈</span> 3D view' : '<span aria-hidden="true">▦</span> Flat view';
  root.querySelector<HTMLElement>('#node-3d')!.hidden = flat;
  root.querySelector<HTMLElement>('#node-detail')!.hidden = !flat;
  result.classList.toggle('is-node-flat', flat);
  const view = capture;
  selected = Math.max(0, Math.min(selected, view.samples.length - 1));
  const samples = view.samples;
  const current = samples[selected], metrics = current.data.node;
  const rate = (key: 'pageFaults' | 'majorPageFaults' | 'networkRxBytes' | 'networkTxBytes') => counterRate(samples, selected, key);
  const recentMarker = view.markers.filter(item => item.elapsedMs <= current.elapsedMs).at(-1);
  const pod = current.data.pod;
  const finish = view.end?.data.status === 'ok' ? 'Complete' : view.end?.data.status === 'error' ? 'Collector error' : 'Incomplete';
  const memoryUpdates = new Set(samples.map(item => item.data.sourceTimes.memory).filter(Boolean)).size;
  const memoryAge = current.data.sourceTimes.memory ? Math.max(0, (Date.parse(current.at) - Date.parse(current.data.sourceTimes.memory)) / 1000) : null;
  root.querySelector<HTMLElement>('#node-count')!.textContent = `${samples.length} polls · ${memoryUpdates} memory updates`;
  root.querySelector<HTMLElement>('#node-time')!.textContent = `Sample ${selected + 1} of ${samples.length} · ${time(current.elapsedMs)}${recentMarker ? ` · ${recentMarker.data.name}` : ''}`;
  root.querySelector<HTMLElement>('#node-summary')!.textContent = `Node RSS ${mib(metrics.memoryRssBytes)} · CPU ${cpu(metrics.cpuUsageNanoCores)} · faults ${faults(rate('pageFaults'))}`;
  root.querySelector<HTMLButtonElement>('#node-prev')!.disabled = selected === 0;
  root.querySelector<HTMLButtonElement>('#node-next')!.disabled = selected === samples.length - 1;
  const slider = root.querySelector<HTMLInputElement>('#node-range')!;
  slider.max = String(samples.length - 1);
  slider.value = String(selected);
  const target = view.metadata.namespace && view.metadata.podName ? `${view.metadata.namespace}/${view.metadata.podName}` : 'none';
  root.querySelector<HTMLElement>('#node-overview')!.innerHTML = `<div class="capture-meta"><div><span>Node</span><strong>${escape(view.metadata.node)}</strong></div><div><span>Context</span><strong>${escape(view.metadata.context)}</strong></div><div><span>Pod target</span><strong>${escape(target)}</strong></div><div><span>Run</span><strong>${finish} · ${samples.length} ${samples.length === 1 ? 'sample' : 'samples'}</strong></div></div><p class="capture-provenance">Source: ${escape(view.metadata.source)} · environment ${escape(view.metadata.environment)}</p>`;
  root.querySelector<HTMLElement>('#node-3d-readout')!.innerHTML = `
    <div><strong>Node memory</strong><span><i style="--bar:#ffc675"></i>RSS ${mib(metrics.memoryRssBytes)}</span><span><i style="--bar:#eaa6e8"></i>Working set ${mib(metrics.memoryWorkingSetBytes)}</span></div>
    ${samples.some(item => (item.data.pod?.memoryRssBytes ?? 0) > 0 || (item.data.pod?.memoryWorkingSetBytes ?? 0) > 0) ? `<div><strong>Target Pod memory</strong><span><i style="--bar:#8fe7b1"></i>RSS ${pod ? mib(pod.memoryRssBytes) : '—'}</span><span><i style="--bar:#71c9f4"></i>Working set ${pod ? mib(pod.memoryWorkingSetBytes) : '—'}</span></div>` : ''}
    <div><strong>CPU</strong><span><i style="--bar:#ffc675"></i>Node ${cpu(metrics.cpuUsageNanoCores)}</span><span><i style="--bar:#8fe7b1"></i>Pod ${pod ? cpu(pod.cpuUsageNanoCores) : '—'}</span></div>
    <div><strong>Page faults</strong><span><i style="--bar:#ffc675"></i>All ${faults(rate('pageFaults'))}</span><span><i style="--bar:#ff91a6"></i>Major ${faults(rate('majorPageFaults'))}</span></div>
    <div><strong>Network</strong><span><i style="--bar:#93dfff"></i>Receive ${throughput(rate('networkRxBytes'))}</span><span><i style="--bar:#8fe7b1"></i>Transmit ${throughput(rate('networkTxBytes'))}</span></div>`;
  root.querySelector<HTMLElement>('#node-markers')!.innerHTML = view.markers.length ? view.markers.map((item, markerIndex) => `<button type="button" data-marker-index="${markerIndex}" class="${item === recentMarker ? 'current' : ''}"><span>${time(item.elapsedMs)}</span>${escape(item.data.name)}${item.data.detail ? ` · ${escape(item.data.detail)}` : ''}</button>`).join('') : '<span class="node-warning">No lifecycle markers in this recording.</span>';

  const memory = chart('Memory', 'MiB', [
    { label: 'Node RSS', color: '#ffc675', values: samples.map(item => item.data.node.memoryRssBytes === null ? null : item.data.node.memoryRssBytes / 1048576), format: number => number === null ? '—' : `${number.toFixed(1)} MiB` },
    { label: 'Node working set', color: '#eaa6e8', values: samples.map(item => item.data.node.memoryWorkingSetBytes === null ? null : item.data.node.memoryWorkingSetBytes / 1048576), format: number => number === null ? '—' : `${number.toFixed(1)} MiB` },
    { label: 'Target Pod RSS', color: '#8fe7b1', values: samples.map(item => item.data.pod?.memoryRssBytes === null || item.data.pod === null ? null : item.data.pod.memoryRssBytes / 1048576), format: number => number === null ? '—' : `${number.toFixed(1)} MiB` },
  ], view, selected);
  const processor = chart('CPU', 'mCPU', [
    { label: 'Node', color: '#ffc675', values: samples.map(item => item.data.node.cpuUsageNanoCores === null ? null : item.data.node.cpuUsageNanoCores / 1000000), format: cpu => cpu === null ? '—' : `${Math.round(cpu)} mCPU` },
    { label: 'Target Pod', color: '#8fe7b1', values: samples.map(item => item.data.pod?.cpuUsageNanoCores === null || item.data.pod === null ? null : item.data.pod.cpuUsageNanoCores / 1000000), format: cpu => cpu === null ? '—' : `${Math.round(cpu)} mCPU` },
  ], view, selected);
  const pageFaults = chart('Page-fault rate', 'faults/s', [
    { label: 'All node faults', color: '#ffc675', values: samples.map((_, index) => counterRate(samples, index, 'pageFaults')), format: faults },
    { label: 'Major node faults', color: '#ff91a6', values: samples.map((_, index) => counterRate(samples, index, 'majorPageFaults')), format: faults },
  ], view, selected);
  const network = chart('Network throughput', 'KiB/s', [
    { label: 'Receive', color: '#93dfff', values: samples.map((_, index) => { const rate = counterRate(samples, index, 'networkRxBytes'); return rate === null ? null : rate / 1024; }), format: rate => rate === null ? '—' : `${rate.toFixed(1)} KiB/s` },
    { label: 'Transmit', color: '#8fe7b1', values: samples.map((_, index) => { const rate = counterRate(samples, index, 'networkTxBytes'); return rate === null ? null : rate / 1024; }), format: rate => rate === null ? '—' : `${rate.toFixed(1)} KiB/s` },
  ], view, selected);
  const cards = [
    ['Node RSS', mib(metrics.memoryRssBytes), 'resident memory'],
    ['Working set', mib(metrics.memoryWorkingSetBytes), 'recently used memory'],
    ['Node CPU', cpu(metrics.cpuUsageNanoCores), 'instantaneous usage'],
    ['Node faults', faults(rate('pageFaults')), 'difference from prior sample'],
    ['Memory pressure', percent(metrics.memoryPsiSomeAvg10), 'some, 10-second average'],
    ['Network receive', throughput(rate('networkRxBytes')), 'difference from prior sample'],
    ['Processes', count(metrics.processCount), metrics.processLimit === null ? 'limit unavailable' : `limit ${count(metrics.processLimit)}`],
    ['Target Pod RSS', pod ? mib(pod.memoryRssBytes) : '—', pod ? 'Kubelet Pod aggregate' : 'Pod not yet reported'],
  ];
  const details = [
    ['CPU measurement time', current.data.sourceTimes.cpu ?? 'Unavailable'],
    ['Memory measurement time', current.data.sourceTimes.memory ?? 'Unavailable'],
    ['Network measurement time', current.data.sourceTimes.network ?? 'Unavailable'],
    ['Collector time', current.at],
    ['Node memory use', mib(metrics.memoryUsageBytes)],
    ['Node available memory', mib(metrics.memoryAvailableBytes)],
    ['Total page faults', count(metrics.pageFaults)],
    ['Major page faults', count(metrics.majorPageFaults)],
    ['Memory PSI full', percent(metrics.memoryPsiFullAvg10)],
    ['Filesystem used', mib(metrics.fsUsedBytes)],
    ['Network transmit', throughput(rate('networkTxBytes'))],
    ['Pod CPU', pod ? cpu(pod.cpuUsageNanoCores) : '—'],
    ['Pod working set', pod ? mib(pod.memoryWorkingSetBytes) : '—'],
    ['Pod page faults', pod ? count(pod.pageFaults) : '—'],
  ];
  root.querySelector<HTMLElement>('#node-detail')!.innerHTML = `<div class="node-detail-inner"><div class="node-detail-heading"><div><p class="capture-kicker">Measured node telemetry</p><h2>${time(current.elapsedMs)} from recording start</h2></div><p>Sample ${selected + 1} / ${samples.length}</p></div>
    ${samples.length === 1 ? '<p class="node-note">This is one Kubelet snapshot. Record a time series to see changes and step through startup.</p>' : ''}
    ${memoryAge !== null && memoryAge > 1 ? `<p class="node-note">The node memory counters in this step were measured ${memoryAge.toFixed(1)} seconds before the collector received them.</p>` : ''}
    <div class="node-measurements">${cards.map(([label, amount, note]) => `<div><span>${escape(label)}</span><strong>${escape(amount)}</strong><small>${escape(note)}</small></div>`).join('')}</div>
    <div class="node-chart-grid">${memory}${processor}${pageFaults}${network}</div>
    <p class="node-note">Chart positions use collector time. Fault and network rates use the Kubelet's own measurement times; a repeated timestamp, missing value, or reset counter leaves a gap. Node measurements include other workloads.</p>
    <section class="node-data"><h3>Values at this sample</h3><dl>${details.map(([label, amount]) => `<div><dt>${escape(label)}</dt><dd>${escape(amount)}</dd></div>`).join('')}</dl></section>
  </div>`;
  if (!flat && !aggregateScene && !sceneUnavailable) mountScene();
  else if (!flat) aggregateScene?.update(selected);
}

function mountScene() {
  if (!capture) return;
  const host = root.querySelector<HTMLElement>('#node-scene')!;
  const fallback = root.querySelector<HTMLElement>('#node-scene-fallback')!;
  host.hidden = false;
  fallback.hidden = true;
  try {
    aggregateScene = new NodeAggregateScene(host, capture);
    aggregateScene.update(selected);
    root.querySelector<HTMLElement>('#node-scene-scales')!.textContent = aggregateScene.scaleText;
  } catch {
    aggregateScene?.dispose();
    aggregateScene = null;
    sceneUnavailable = true;
    host.replaceChildren();
    host.hidden = true;
    fallback.hidden = false;
    root.querySelector<HTMLElement>('#node-scene-scales')!.textContent = '';
  }
}

function load(text: string, fileName: string) {
  aggregateScene?.dispose();
  aggregateScene = null;
  sceneUnavailable = false;
  capture = parseNodeCapture(text);
  selected = 0;
  const source = root.querySelector<HTMLElement>('#node-source')!;
  source.textContent = `Loaded ${fileName}`;
  source.hidden = false;
  document.title = `${fileName} — Node telemetry — Forkscape`;
  render();
}

root.addEventListener('input', event => {
  if ((event.target as HTMLElement).id !== 'node-range') return;
  selected = Number((event.target as HTMLInputElement).value);
  render();
});
root.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (target.closest('#view-toggle')) {
    flat = !flat;
    try { localStorage.setItem('forkscape-flat', String(flat)); } catch { /* The view still switches. */ }
    render();
    return;
  }
  if (target.closest('#node-prev')) selected--;
  else if (target.closest('#node-next')) selected++;
  else {
    const marker = target.closest<HTMLElement>('[data-marker-index]');
    if (marker && capture) {
      const at = capture.markers[Number(marker.dataset.markerIndex)]?.elapsedMs;
      if (at === undefined) return;
      selected = capture.samples.findIndex(item => item.elapsedMs >= at);
      if (selected < 0) selected = capture.samples.length - 1;
    } else {
      const svg = target.closest<SVGSVGElement>('[data-chart]');
      if (!svg || !capture || capture.samples.length < 2) return;
      const rect = svg.getBoundingClientRect();
      const svgX = (event as MouseEvent).clientX - rect.left;
      const fraction = Math.max(0, Math.min(1, (svgX / rect.width * W - L) / (W - L - R)));
      const samples = capture.samples, first = samples[0].elapsedMs, last = samples.at(-1)!.elapsedMs;
      const at = first + fraction * (last - first);
      selected = samples.reduce((best, item, index) => Math.abs(item.elapsedMs - at) < Math.abs(samples[best].elapsedMs - at) ? index : best, 0);
    }
  }
  render();
});
window.addEventListener('keydown', event => {
  if (!capture || (event.target as HTMLElement)?.matches('input, textarea, select')) return;
  if (event.key === 'ArrowLeft') selected--;
  else if (event.key === 'ArrowRight') selected++;
  else return;
  event.preventDefault();
  render();
});

try {
  if (new URLSearchParams(location.search).get('sample') === 'synthetic') {
    load(syntheticNodeRecording(), 'Synthetic node startup');
  } else {
    const saved = JSON.parse(sessionStorage.getItem(NODE_STORAGE_KEY) ?? 'null') as { fileName?: unknown; text?: unknown } | null;
    if (saved && typeof saved.text === 'string' && typeof saved.fileName === 'string') load(saved.text, saved.fileName);
  }
} catch (cause) {
  const error = root.querySelector<HTMLElement>('#node-error')!;
  error.textContent = `The saved node recording could not be opened. ${cause instanceof Error ? cause.message : String(cause)}`;
  error.hidden = false;
  try { sessionStorage.removeItem(NODE_STORAGE_KEY); } catch { /* Nothing to clear. */ }
}
if (!capture) render();
