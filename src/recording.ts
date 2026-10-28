import { applyAction, emptyWorld, sharers, type Action, type EventKind, type WorldState } from './model.ts';

/**
 * Recorded telemetry, replayed through the same views as the scenarios.
 *
 * A recording is a Trace Event Format file (the JSON that Perfetto and chrome://tracing read) whose events use the vocabulary in
 * docs/recording-format.md. Replaying it takes three passes:
 *  1. Resolve each event's address to a mapping, following mappings through fork, exec, and munmap.
 *  2. Choose a tile size, so the busiest process fits the views. A tile stands for a power-of-two number of pages.
 *  3. Replay every event on an exact page ledger, which counts each page for the chart and captions, and project the ledger onto
 *     tiles through the model engine, which draws the scene. Events are grouped into stages, and stages into phases.
 */

export const RECORDING_VERSION = 1;
export const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDING_EVENTS = 2_000_000;
const MAX_LIVE_PROCESSES = 64;
/** Tiles per process. The smallest fits a 3D deck, which draws 24. */
export const TILE_BUDGETS = [24, 48, 96] as const;
const TOTAL_TILE_FACTOR = 12;
const DEFAULT_GAP_MS = 50;
const FORK_BURST_US = 1_000_000;
/** How soon after a pause a moment can still lead the stage the pause started. */
const PRELUDE_US = 10_000;
/** A stage that a pause started and that changes less than this is folded into the next stage. */
const TRIVIAL_BYTES = 64 * 1024;
/** A fault outside every recorded mapping lands in an "unrecorded" region this many pages wide, clipped to its neighbours. */
const UNRECORDED_WINDOW_PAGES = 256;
const MAX_ISSUES = 6;

export interface RecordingMeta {
  title: string; source: string; synthetic: boolean; pageSize: number; stageGapUs: number;
  /** Header facts to show, such as the kernel and capture time, as label/value pairs. */
  details: [string, string][];
}
export interface TraceEvent { index: number; ts: number; ph: string; name: string; cat: string; pid: number; tid: number | null; dur: number | null; args: Record<string, unknown> }
export interface ParsedRecording { meta: RecordingMeta; events: TraceEvent[]; processNames: Map<number, string>; issues: string[]; skipped: number; ignored: number }

export type Outcome = 'demand_zero' | 'zero_page' | 'file_fault' | 'cow_fault' | 'reuse' | 'write' | 'resident';
export type StageKind = EventKind | 'thread' | 'marker' | 'request' | 'phase' | 'activity' | 'file_fault';
export interface StageMetrics { sumRss: number; sumPss: number; processes: { pid: number; rss: number; pss: number }[] }
export interface Stage {
  caption: string;
  /** One line of figures for the stage's end: time, Σ RSS, and memory in use, with their changes. */
  figures: string;
  kind: StageKind;
  phase: number;
  /** When the stage starts, in microseconds after the recording's first event. */
  at: number;
  focus: { pid: number; page: number | null };
  events: TraceEvent[];
  state: WorldState;
  exact: StageMetrics;
  /** Σ of the latest measured counters of the processes running at the stage's end, if the recording has any. */
  measured: { sumRss: number | null; sumPss: number | null; cgroup: number | null };
  limit: number | null;
}
export interface Phase { label: string; first: number; last: number }
export interface ReplaySeries { label: string; metric: 'rss' | 'memory'; line: 'solid' | 'dashed' | 'dotted'; values: (number | null)[] }
export interface Replay {
  meta: RecordingMeta;
  tilePages: number; tileBytes: number; tileBudget: number;
  stages: Stage[]; states: WorldState[]; phases: Phase[];
  chart: { series: ReplaySeries[]; limit: number | null };
  names: Map<number, string>;
  /** How the replay was built, and what it left out. */
  notes: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const plural = (count: number, one: string, many = `${one}s`) => `${formatCount(count)} ${count === 1 ? one : many}`;
export const formatCount = (count: number) => new Intl.NumberFormat('en').format(count);
export function formatBytes(bytes: number) {
  const kib = bytes / 1024, abs = Math.abs(kib);
  if (abs < 1024) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
  if (abs < 1024 * 1024) return `${(kib / 1024).toFixed(1)} MiB`;
  return `${(kib / 1024 / 1024).toFixed(2)} GiB`;
}
const signedBytes = (bytes: number) => `${bytes < 0 ? '−' : '+'}${formatBytes(Math.abs(bytes))}`;
export const formatSeconds = (us: number) => us < 1000 ? `${Math.round(us)} µs` : us < 1_000_000 ? `${(us / 1000).toFixed(1)} ms` : `${(us / 1_000_000).toFixed(2)} s`;

// ——— Reading the file ———

/** A recording's text from a file or a download, unzipped if it is gzip-compressed (a .json.gz), which shrinks one about tenfold.
 *  The check is on the bytes, because a server may already have unzipped a .gz on the way. */
export async function recordingText(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return blob.text();
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader(), decoder = new TextDecoder(), parts: string[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RECORDING_BYTES) { await reader.cancel(); throw Error(`Unzipped, the file is larger than ${formatBytes(MAX_RECORDING_BYTES)}.`); }
    parts.push(decoder.decode(value, { stream: true }));
  }
  return parts.join('') + decoder.decode();
}

function readContainer(text: string): { events: unknown[]; otherData?: unknown } {
  const body = text.replace(/^﻿/, '').trim();
  if (!body) throw Error('The file is empty.');
  if (body.startsWith('[')) {
    // The Trace Event Format lets a writer stop without closing its array, so a trailing comma or a missing ] is accepted.
    const closed = body.endsWith(']') ? body.replace(/,\s*\]$/, ']') : `${body.replace(/,\s*$/, '')}]`;
    try {
      const value = JSON.parse(closed);
      if (Array.isArray(value)) return { events: value };
    } catch (error) { throw Error(`The trace array is not valid JSON: ${(error as Error).message}`); }
  }
  if (!body.startsWith('{')) throw Error('This is not a trace file: it should start with { or [.');
  let whole: unknown;
  try { whole = JSON.parse(body); } catch (error) {
    // Not one JSON value: read it as one event per line, as a streaming recorder writes it.
    const lines = body.split(/\r?\n/);
    try { JSON.parse(lines[0].trim().replace(/,$/, '')); } catch { throw Error(`The file is not valid JSON: ${(error as Error).message}`); }
    return { events: lines.flatMap((line, index) => {
      const trimmed = line.trim().replace(/,$/, '');
      if (!trimmed) return [];
      try { return [JSON.parse(trimmed)]; } catch { throw Error(`Line ${index + 1} is not valid JSON.`); }
    }) };
  }
  if (isRecord(whole) && Array.isArray(whole.traceEvents)) return { events: whole.traceEvents, otherData: whole.otherData };
  return { events: [whole] };
}

function headerDetails(header: Record<string, unknown>): [string, string][] {
  const labels: Record<string, string> = { captured_at: 'Captured', source: 'Source', kernel: 'Kernel', host: 'Host', runtime: 'Runtime', config: 'Config', notes: 'Notes' };
  const text = (value: unknown): string => isRecord(value) ? Object.entries(value).map(([key, item]) => `${key} ${text(item)}`).join(', ') : String(value);
  return Object.entries(labels).flatMap(([key, label]) => header[key] === undefined || header[key] === null || header[key] === '' ? [] : [[label, text(header[key]).slice(0, 240)] as [string, string]]);
}

/** Reads a recording and checks its header. Events that cannot be read are skipped and counted, so one bad line does not lose a whole recording. */
export function parseRecording(text: string, fileName = ''): ParsedRecording {
  if (text.length > MAX_RECORDING_BYTES) throw Error(`The file is larger than ${formatBytes(MAX_RECORDING_BYTES)}.`);
  const container = readContainer(text);
  if (container.events.length > MAX_RECORDING_EVENTS) throw Error(`The file has more than ${formatCount(MAX_RECORDING_EVENTS)} events.`);
  const metaEvent = container.events.find(item => isRecord(item) && item.ph === 'M' && item.name === 'forkscape') as Record<string, unknown> | undefined;
  const header = metaEvent?.args ?? (isRecord(container.otherData) ? container.otherData.forkscape : undefined);
  if (!isRecord(header)) throw Error('This trace has no Forkscape header. Add a metadata event first: {"ph":"M","name":"forkscape","pid":0,"args":{"version":1,"page_size":4096}}');
  if (header.version !== RECORDING_VERSION) throw Error(`This app reads Forkscape recordings of version ${RECORDING_VERSION}; this file has version ${JSON.stringify(header.version ?? null)}.`);
  const pageSize = header.page_size ?? 4096;
  if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1024 || pageSize > 2 ** 21 || (pageSize & (pageSize - 1)) !== 0) throw Error('page_size must be a power of two from 1024 to 2097152 bytes.');
  const gap = header.stage_gap_ms ?? DEFAULT_GAP_MS;
  if (typeof gap !== 'number' || !(gap > 0)) throw Error('stage_gap_ms must be a positive number.');
  const meta: RecordingMeta = {
    title: typeof header.title === 'string' && header.title.trim() ? header.title.trim().slice(0, 160) : fileName || 'Recorded telemetry',
    source: typeof header.source === 'string' ? header.source.slice(0, 160) : '', synthetic: header.synthetic === true,
    pageSize, stageGapUs: gap * 1000, details: headerDetails(header),
  };

  const issues: string[] = [], processNames = new Map<number, string>(), events: TraceEvent[] = [];
  let skipped = 0, ignored = 0;
  const skip = (index: number, reason: string) => { skipped++; if (issues.length < MAX_ISSUES) issues.push(`Event ${index + 1}: ${reason}`); };
  container.events.forEach((item, index) => {
    if (!isRecord(item)) return skip(index, 'it is not an object.');
    const { ph, name } = item;
    if (typeof ph !== 'string') return skip(index, 'it has no ph field.');
    if (ph === 'M') {
      if (name === 'process_name' && Number.isSafeInteger(item.pid) && isRecord(item.args) && typeof item.args.name === 'string') processNames.set(item.pid as number, item.args.name.slice(0, 80));
      return;
    }
    if (!['i', 'I', 'n', 'X', 'B', 'E', 'C'].includes(ph)) { ignored++; return; }
    if (typeof name !== 'string' || !name) { if (ph === 'E') return; return skip(index, 'it has no name.'); }
    if (typeof item.ts !== 'number' || !Number.isFinite(item.ts)) return skip(index, `${name} has no numeric ts.`);
    if (!Number.isSafeInteger(item.pid) || (item.pid as number) < 0) return skip(index, `${name} has no integer pid.`);
    if (item.args !== undefined && !isRecord(item.args)) return skip(index, `${name} has args that are not an object.`);
    events.push({ index, ts: item.ts, ph, name, cat: typeof item.cat === 'string' ? item.cat : '', pid: item.pid as number,
      tid: Number.isSafeInteger(item.tid) ? item.tid as number : null, dur: typeof item.dur === 'number' && item.dur >= 0 ? item.dur : null, args: (item.args as Record<string, unknown> | undefined) ?? {} });
  });
  // Trace events need not be written in order; a stable sort keeps the file's order for equal times.
  events.sort((a, b) => a.ts - b.ts || a.index - b.index);
  return { meta, events, processNames, issues, skipped, ignored };
}

// ——— Pass 1: resolving addresses to mappings ———

interface Lineage {
  id: number; name: string; kind: 'anonymous' | 'file'; shared: boolean; writable: boolean; fileKey: string;
  /** Page offset of the mapping's first page in its file, so the page cache is shared by every mapping of a file. 0 for anonymous memory. */
  filePage: number;
  /** The process that mapped it, and how many times that process had called exec by then. */
  creator: number; epoch: number; unrecorded: boolean;
  /** The first and last page offsets touched while recording; only that span is drawn. */
  min: number; max: number;
  /** The page offsets given to its segments so far, [low, high). A merge or an mremap that grows it takes offsets past either end,
   *  so no two pages of a mapping share an offset. */
  low: number; high: number;
  /** Where the scene draws it: its group, and the position of its first touched page in the group. Set in pass 2. */
  group: Group | null; at: number;
}
interface Segment { start: number; end: number; lineage: Lineage; base: number }
interface Piece { lineage: Lineage; from: number; to: number }
type Resolved =
  | { kind: 'exec'; ev: TraceEvent; pid: number; parent: number | null; name?: string; existing: boolean; implicit: boolean }
  | { kind: 'fork'; ev: TraceEvent; pid: number; child: number }
  | { kind: 'thread'; ev: TraceEvent; pid: number; tid: number }
  | { kind: 'mmap'; ev: TraceEvent; pid: number; lineage: Lineage; replaced: Piece[]; gone: Lineage[]; mapped: number }
  | { kind: 'unmap'; ev: TraceEvent; pid: number; pieces: Piece[]; gone: Lineage[]; advice: boolean; mapped: number }
  | { kind: 'remap'; ev: TraceEvent; pid: number; pieces: Piece[]; gone: Lineage[]; mapped: number }
  | { kind: 'fault'; ev: TraceEvent; pid: number; lineage: Lineage; offset: number; write: boolean; around: boolean; mapped: number }
  | { kind: 'open'; ev: TraceEvent; pid: number; fd: number; objectId?: string; objectKind: 'file' | 'socket'; name: string }
  | { kind: 'close'; ev: TraceEvent; pid: number; fd: number }
  | { kind: 'lock' | 'unlock'; ev: TraceEvent; pid: number; tid: number; lock: string }
  | { kind: 'exit'; ev: TraceEvent; pid: number; oom: boolean }
  | { kind: 'reap'; ev: TraceEvent; pid: number; child: number }
  | { kind: 'memory'; ev: TraceEvent; pid: number; rss: number | null; pss: number | null }
  | { kind: 'cgroup'; ev: TraceEvent; bytes: number }
  | { kind: 'limit'; ev: TraceEvent; bytes: number | null }
  | { kind: 'lost'; ev: TraceEvent; count: number }
  | { kind: 'phase'; ev: TraceEvent; label: string }
  | { kind: 'marker'; ev: TraceEvent; pid: number; label: string; boundary: boolean; request: boolean; module: string | null };
/** How a process's set of mappings changes, for sizing tiles. */
type MappingOp = { op: 'add' | 'remove'; pid: number; lineage: Lineage } | { op: 'copy'; pid: number; child: number } | { op: 'clear'; pid: number };

function address(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) { const parsed = parseInt(value, 16); return Number.isSafeInteger(parsed) ? parsed : null; }
  if (typeof value === 'string' && /^\d+$/.test(value)) { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : null; }
  return null;
}
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min ? value as number : null;
const kib = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 1024 : null;
const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;
const hex = (value: number) => `0x${value.toString(16)}`;

class Resolver {
  readonly lineages: Lineage[] = [];
  readonly resolved: Resolved[] = [];
  readonly ops: MappingOp[] = [];
  readonly issues: string[] = [];
  skipped = 0; foreign = 0; unrecordedFaults = 0; dead = 0;
  root: number | null = null;
  private maps = new Map<number, Segment[]>();
  /** When each process's open slices end, so a slice inside another one annotates it instead of starting a stage. */
  private slices = new Map<number, number[]>();
  private tracked = new Set<number>();
  private epochs = new Map<number, number>();
  private nextLineage = 1;
  private pageSize: number;
  private names: Map<number, string>;

  constructor(pageSize: number, names: Map<number, string>) { this.pageSize = pageSize; this.names = names; }

  private issue(ev: TraceEvent, reason: string) { this.skipped++; if (this.issues.length < MAX_ISSUES) this.issues.push(`Event ${ev.index + 1} (${ev.name}): ${reason}`); }

  /** The process an event acts on, starting the recording's root if nothing is running yet. */
  private alive(ev: TraceEvent, pid = ev.pid): boolean {
    if (this.maps.has(pid)) return true;
    if (this.tracked.has(pid)) { this.dead++; return false; }
    if (this.root !== null) { this.foreign++; return false; }
    this.start(ev, pid, null, true);
    return true;
  }
  private start(ev: TraceEvent, pid: number, parent: number | null, implicit: boolean, name?: string) {
    if (this.root === null) this.root = pid;
    this.tracked.add(pid);
    this.maps.set(pid, []);
    this.resolved.push({ kind: 'exec', ev, pid, parent, name: name ?? this.names.get(pid), existing: false, implicit });
  }

  /** Removes [start, end) from a process's map, returning the pieces removed and the mappings it no longer has at all.
   *  With record false, the caller records which mappings are gone, because it puts some of them back. */
  private cut(pid: number, start: number, end: number, record = true): { pieces: Piece[]; gone: Lineage[] } {
    const segments = this.maps.get(pid)!, kept: Segment[] = [], pieces: Piece[] = [];
    for (const segment of segments) {
      if (segment.end <= start || segment.start >= end) { kept.push(segment); continue; }
      const from = Math.max(start, segment.start), to = Math.min(end, segment.end);
      pieces.push({ lineage: segment.lineage, from: (from - segment.base) / this.pageSize, to: (to - segment.base) / this.pageSize });
      if (segment.start < from) kept.push({ ...segment, end: from });
      if (to < segment.end) kept.push({ ...segment, start: to });
    }
    kept.sort((a, b) => a.start - b.start);
    this.maps.set(pid, kept);
    const left = new Set(kept.map(segment => segment.lineage));
    const gone = [...new Set(pieces.map(piece => piece.lineage))].filter(lineage => !left.has(lineage));
    if (record) gone.forEach(lineage => this.ops.push({ op: 'remove', pid, lineage }));
    return { pieces, gone };
  }
  /** mremap moves [oldStart, oldEnd) to newStart and resizes it to newLength bytes. The moved pages keep their mapping and offsets,
   *  so they stay resident, as the kernel moves page-table entries without faults. A shrink drops the tail; growth extends the last mapping. */
  private remap(pid: number, oldStart: number, oldEnd: number, newStart: number, newLength: number): { pieces: Piece[]; gone: Lineage[] } {
    const moving = this.maps.get(pid)!.filter(segment => segment.end > oldStart && segment.start < oldEnd)
      .map(segment => ({ ...segment, start: Math.max(segment.start, oldStart), end: Math.min(segment.end, oldEnd) }));
    const before = new Set(this.maps.get(pid)!.map(segment => segment.lineage));
    this.cut(pid, oldStart, oldEnd, false);
    const keepEnd = oldStart + newLength, pieces: Piece[] = [];
    const kept = moving.flatMap(segment => {
      if (segment.end > keepEnd) pieces.push({ lineage: segment.lineage, from: (Math.max(segment.start, keepEnd) - segment.base) / this.pageSize, to: (segment.end - segment.base) / this.pageSize });
      return segment.start < keepEnd ? [{ ...segment, end: Math.min(segment.end, keepEnd) }] : [];
    });
    const delta = newStart - oldStart, newEnd = newStart + newLength;
    pieces.push(...this.cut(pid, newStart, newEnd, false).pieces);
    const segments = this.maps.get(pid)!;
    kept.forEach(segment => segments.push({ start: segment.start + delta, end: segment.end + delta, lineage: segment.lineage, base: segment.base + delta }));
    // Growth continues the last moved mapping if its offsets end there, and is a mapping of its own otherwise.
    const last = kept.at(-1);
    if (last && last.end + delta < newEnd) {
      const growth = (newEnd - last.end - delta) / this.pageSize, lineage = last.lineage;
      if ((last.end - last.base) / this.pageSize === lineage.high) {
        lineage.high += growth;
        segments.push({ start: last.end + delta, end: newEnd, lineage, base: last.base + delta });
      } else {
        const fresh = this.lineage({ name: lineage.name, kind: lineage.kind, shared: lineage.shared, writable: lineage.writable, fileKey: lineage.fileKey,
          filePage: lineage.filePage + (last.end - last.base) / this.pageSize, creator: pid, unrecorded: lineage.unrecorded }, growth);
        segments.push({ start: last.end + delta, end: newEnd, lineage: fresh, base: last.end + delta });
        this.ops.push({ op: 'add', pid, lineage: fresh });
      }
    }
    segments.sort((a, b) => a.start - b.start);
    const left = new Set(segments.map(segment => segment.lineage));
    const gone = [...before].filter(lineage => !left.has(lineage));
    gone.forEach(lineage => this.ops.push({ op: 'remove', pid, lineage }));
    return { pieces, gone };
  }
  private covered(pid: number, start: number, end: number): Piece[] {
    return this.maps.get(pid)!.flatMap(segment => segment.end <= start || segment.start >= end ? [] : [{ lineage: segment.lineage,
      from: (Math.max(start, segment.start) - segment.base) / this.pageSize, to: (Math.min(end, segment.end) - segment.base) / this.pageSize }]);
  }
  private lineage(fields: Omit<Lineage, 'id' | 'min' | 'max' | 'group' | 'at' | 'epoch' | 'low' | 'high'>, pages: number): Lineage {
    const lineage = { ...fields, id: this.nextLineage++, epoch: this.epochs.get(fields.creator) ?? 0, min: Infinity, max: -Infinity, low: 0, high: pages, group: null, at: 0 };
    this.lineages.push(lineage);
    return lineage;
  }
  /** Bytes a process maps, which the ledger shows as Mapped. */
  private mappedBytes(pid: number) { return this.maps.get(pid)!.reduce((sum, segment) => sum + segment.end - segment.start, 0); }
  private find(pid: number, addr: number): Segment | undefined {
    const segments = this.maps.get(pid)!;
    let low = 0, high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1, segment = segments[middle];
      if (addr < segment.start) high = middle - 1; else if (addr >= segment.end) low = middle + 1; else return segment;
    }
    return undefined;
  }
  /** A fault outside every recorded mapping, for example in memory mapped before recording began, gets a region of its own. */
  private unrecorded(pid: number, addr: number): Segment {
    const segments = this.maps.get(pid)!, window = UNRECORDED_WINDOW_PAGES * this.pageSize;
    const before = segments.filter(segment => segment.end <= addr).at(-1), after = segments.find(segment => segment.start > addr);
    const start = Math.max(Math.floor(addr / window) * window, before?.end ?? 0), end = Math.min(Math.floor(addr / window) * window + window, after?.start ?? Infinity);
    const lineage = this.lineage({ name: 'unrecorded', kind: 'file', shared: false, writable: true, fileKey: `unrecorded@${hex(start)}`, filePage: 0, creator: pid, unrecorded: true }, (end - start) / this.pageSize);
    const segment = { start, end, lineage, base: start };
    segments.push(segment);
    segments.sort((a, b) => a.start - b.start);
    this.ops.push({ op: 'add', pid, lineage });
    return segment;
  }

  add(ev: TraceEvent) {
    const { name, args, pid } = ev, page = this.pageSize;
    if (ev.ph === 'E') {
      const open = this.slices.get(pid), last = open?.lastIndexOf(Infinity) ?? -1;
      if (last >= 0) open!.splice(last, 1);
      return;
    }
    if (ev.ph === 'C') {
      if (name === 'memory') this.resolved.push({ kind: 'memory', ev, pid, rss: kib(args.rss_kib), pss: kib(args.pss_kib) });
      else if (name === 'cgroup' && kib(args.memory_current_kib) !== null) this.resolved.push({ kind: 'cgroup', ev, bytes: kib(args.memory_current_kib)! });
      return;
    }
    switch (name) {
      case 'exec': {
        const ppid = integer(args.ppid, 1), comm = typeof args.comm === 'string' ? args.comm.slice(0, 80) : this.names.get(pid);
        if (this.maps.has(pid)) {
          this.maps.set(pid, []);
          this.epochs.set(pid, (this.epochs.get(pid) ?? 0) + 1);
          this.ops.push({ op: 'clear', pid });
          this.resolved.push({ kind: 'exec', ev, pid, parent: null, name: comm, existing: true, implicit: false });
        } else if (this.tracked.has(pid)) this.dead++;
        else if (this.root === null) this.start(ev, pid, null, false, comm);
        else if (ppid !== null && this.maps.has(ppid)) this.start(ev, pid, ppid, false, comm);
        else this.foreign++;
        return;
      }
      case 'fork': {
        const child = integer(args.child ?? args.child_pid, 1);
        if (child === null) return this.issue(ev, 'args.child must be a positive integer.');
        if (!this.alive(ev)) return;
        if (this.tracked.has(child)) return this.issue(ev, `PID ${child} was already seen.`);
        if (this.maps.size >= MAX_LIVE_PROCESSES) return this.issue(ev, `more than ${MAX_LIVE_PROCESSES} processes would be running.`);
        this.tracked.add(child);
        this.maps.set(child, [...this.maps.get(pid)!]);
        this.ops.push({ op: 'copy', pid, child });
        this.resolved.push({ kind: 'fork', ev, pid, child });
        return;
      }
      case 'thread': {
        const tid = integer(args.new_tid ?? args.tid, 1);
        if (tid === null) return this.issue(ev, 'args.new_tid must be a positive integer.');
        if (this.alive(ev)) this.resolved.push({ kind: 'thread', ev, pid, tid });
        return;
      }
      case 'mmap': {
        const addr = address(args.addr), length = integer(args.len ?? args.length, 1);
        if (addr === null || length === null) return this.issue(ev, 'args.addr and args.len are required.');
        if (!this.alive(ev)) return;
        const perms = typeof args.perms === 'string' ? args.perms : '';
        const file = typeof args.file === 'string' && args.file ? args.file : null;
        const shared = perms ? perms[3] === 's' : args.shared === true;
        const writable = perms ? perms[1] === 'w' : typeof args.writable === 'boolean' ? args.writable : !file;
        const offset = integer(args.offset) ?? 0;
        const start = Math.floor(addr / page) * page, end = Math.ceil((addr + length) / page) * page;
        const { pieces, gone } = this.cut(pid, start, end);
        const label = typeof args.name === 'string' && args.name ? args.name.slice(0, 60) : file ? basename(file) : shared ? 'shared memory' : 'anonymous';
        const segments = this.maps.get(pid)!;
        // The kernel merges a private anonymous mapping into a neighbour with the same permissions, as it does for each brk and
        // for allocator arenas mapped next to each other. A merged mapping continues its neighbour's page offsets.
        const epoch = this.epochs.get(pid) ?? 0;
        const joins = (segment: Segment | undefined, edge: number) => !!segment && segment.lineage.kind === 'anonymous' && !segment.lineage.shared && !segment.lineage.unrecorded
          && segment.lineage.writable === writable && segment.lineage.name === label && segment.lineage.creator === pid && segment.lineage.epoch === epoch
          && (edge - segment.base) / page === (edge === segment.end ? segment.lineage.high : segment.lineage.low);
        const below = segments.find(segment => segment.end === start), above = segments.find(segment => segment.start === end), pages = (end - start) / page;
        const neighbour = file || shared ? undefined : joins(below, start) ? below : joins(above, end) ? above : undefined;
        if (neighbour === below && below) below.lineage.high += pages;
        else if (neighbour === above && above) above.lineage.low -= pages;
        // Shared anonymous memory lives in shmem, which behaves like a file's page cache.
        const lineage = neighbour?.lineage ?? this.lineage({ name: label,
          kind: file || shared ? 'file' : 'anonymous', shared, writable, fileKey: file ?? (shared ? `shmem#${this.nextLineage}` : ''),
          filePage: file ? Math.floor(offset / page) : 0, creator: pid, unrecorded: false }, pages);
        segments.push({ start, end, lineage, base: neighbour?.base ?? start });
        segments.sort((a, b) => a.start - b.start);
        if (!neighbour) this.ops.push({ op: 'add', pid, lineage });
        this.resolved.push({ kind: 'mmap', ev, pid, lineage, replaced: pieces, gone, mapped: this.mappedBytes(pid) });
        return;
      }
      case 'mremap': {
        const addr = address(args.addr), oldLength = integer(args.old_len, 0), newLength = integer(args.new_len, 1);
        const target = args.new_addr === undefined ? addr : address(args.new_addr);
        if (addr === null || oldLength === null || newLength === null || target === null) return this.issue(ev, 'args.addr, args.old_len, args.new_len, and args.new_addr are required.');
        if (!this.alive(ev)) return;
        const start = Math.floor(addr / page) * page, newStart = Math.floor(target / page) * page;
        const { pieces, gone } = this.remap(pid, start, start + Math.ceil(oldLength / page) * page, newStart, Math.ceil(newLength / page) * page);
        this.resolved.push({ kind: 'remap', ev, pid, pieces, gone, mapped: this.mappedBytes(pid) });
        return;
      }
      case 'munmap': case 'madvise': {
        const addr = address(args.addr), length = integer(args.len ?? args.length, 1);
        if (addr === null || length === null) return this.issue(ev, 'args.addr and args.len are required.');
        if (!this.alive(ev)) return;
        const start = Math.floor(addr / page) * page, end = Math.ceil((addr + length) / page) * page;
        if (name === 'munmap') { const { pieces, gone } = this.cut(pid, start, end); this.resolved.push({ kind: 'unmap', ev, pid, pieces, gone, advice: false, mapped: this.mappedBytes(pid) }); return; }
        // Only advice that drops pages changes what is resident.
        const advice = String(args.advice ?? '').toLowerCase().replace(/^madv_/, '');
        if (['dontneed', 'free', 'remove'].includes(advice)) this.resolved.push({ kind: 'unmap', ev, pid, pieces: this.covered(pid, start, end), gone: [], advice: true, mapped: this.mappedBytes(pid) });
        return;
      }
      case 'fault': {
        const addr = address(args.addr);
        if (addr === null) return this.issue(ev, 'args.addr is required.');
        if (!this.alive(ev)) return;
        let segment = this.find(pid, addr), mapped = -1;
        if (!segment) { segment = this.unrecorded(pid, addr); this.unrecordedFaults++; mapped = this.mappedBytes(pid); }
        else if (segment.lineage.unrecorded) this.unrecordedFaults++;
        const offset = Math.floor((addr - segment.base) / page), lineage = segment.lineage, write = args.write === true || args.write === 1;
        lineage.min = Math.min(lineage.min, offset); lineage.max = Math.max(lineage.max, offset);
        // A write to anonymous memory mapped without write permission shows that mprotect, which recordings omit, allowed it.
        if (write && lineage.kind === 'anonymous') lineage.writable = true;
        this.resolved.push({ kind: 'fault', ev, pid, lineage, offset, write, around: args.around === true, mapped });
        return;
      }
      case 'open': {
        const fd = integer(args.fd);
        if (fd === null) return this.issue(ev, 'args.fd must be a non-negative integer.');
        if (!this.alive(ev)) return;
        const objectKind = args.kind === 'socket' ? 'socket' : 'file';
        this.resolved.push({ kind: 'open', ev, pid, fd, objectKind, name: typeof args.name === 'string' ? args.name.slice(0, 80) : typeof args.object === 'string' ? args.object.slice(0, 80) : `fd ${fd}`,
          ...(typeof args.object === 'string' && args.object ? { objectId: args.object.slice(0, 80) } : {}) });
        return;
      }
      case 'close': {
        const fd = integer(args.fd);
        if (fd === null) return this.issue(ev, 'args.fd must be a non-negative integer.');
        if (this.alive(ev)) this.resolved.push({ kind: 'close', ev, pid, fd });
        return;
      }
      case 'lock': case 'unlock': {
        if (typeof args.lock !== 'string' || !args.lock) return this.issue(ev, 'args.lock must name the lock.');
        if (this.alive(ev)) this.resolved.push({ kind: name, ev, pid, tid: ev.tid ?? pid, lock: args.lock.slice(0, 60) });
        return;
      }
      case 'exit': case 'oom_kill': {
        if (!this.maps.has(pid)) { if (this.tracked.has(pid)) this.dead++; else this.foreign++; return; }
        this.maps.delete(pid);
        this.ops.push({ op: 'clear', pid });
        this.resolved.push({ kind: 'exit', ev, pid, oom: name === 'oom_kill' });
        return;
      }
      case 'reap': {
        const child = integer(args.child ?? args.child_pid, 1);
        if (child === null) return this.issue(ev, 'args.child must be a positive integer.');
        if (this.tracked.has(child)) this.resolved.push({ kind: 'reap', ev, pid, child });
        return;
      }
      case 'limit': this.resolved.push({ kind: 'limit', ev, bytes: integer(args.bytes) }); return;
      case 'lost': this.resolved.push({ kind: 'lost', ev, count: integer(args.count) ?? 1 }); return;
      case 'phase': {
        const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 60) : null;
        if (!label) return this.issue(ev, 'args.label must name the phase.');
        this.resolved.push({ kind: 'phase', ev, label });
        return;
      }
      default: {
        // Anything else is a marker. A moment (an instant event) and an outermost slice, such as a request or a top-level import, start a stage.
        // A slice inside another one of the same process annotates the stage instead.
        if (this.root !== null && !this.maps.has(pid) && pid !== 0) { this.foreign++; return; }
        const slice = ev.ph === 'X' || ev.ph === 'B', open = (this.slices.get(pid) ?? []).filter(end => end > ev.ts);
        const nested = open.length > 0;
        if (slice) open.push(ev.ph === 'X' ? ev.ts + (ev.dur ?? 0) : Infinity);
        this.slices.set(pid, open);
        const request = name === 'request', module = typeof args.module === 'string' ? args.module : null;
        const what = request ? [args.method, args.path].filter(item => typeof item === 'string').join(' ') : '';
        const label = request ? what : module ? `${name} ${module}` : ev.cat ? `${ev.cat}: ${name}` : name;
        this.resolved.push({ kind: 'marker', ev, pid, label: label.slice(0, 100), boundary: slice ? !nested : true, request, module });
      }
    }
  }
}

// ——— Pass 2: choosing how to draw ———

/** What the scene draws as one region: one mapping, or all of a process's mappings of one kind, laid end to end. */
interface Group { id: number; name: string; kind: 'anonymous' | 'file'; shared: boolean; writable: boolean; pages: number; members: number }
type Grouping = 'mapping' | 'kind';
const KIND_NAMES = { code: 'code and read-only files', data: 'private file data', heap: '[heap]', anon: 'anonymous memory', stack: '[stack]', shared: 'shared memory', unrecorded: 'unrecorded' } as const;
const touchedPages = (lineage: Lineage) => lineage.max < lineage.min ? 0 : lineage.max - lineage.min + 1;
function category(lineage: Lineage): keyof typeof KIND_NAMES {
  if (lineage.unrecorded) return 'unrecorded';
  if (lineage.shared) return 'shared';
  if (lineage.name === '[stack]') return 'stack';
  if (lineage.kind === 'anonymous') return lineage.name === '[heap]' || lineage.name === 'bss' ? 'heap' : 'anon';
  return lineage.writable ? 'data' : 'code';
}
/** Puts each touched mapping in a group, at the position after the group's earlier mappings. Untouched mappings are not drawn. */
function assignGroups(lineages: Lineage[], grouping: Grouping): Group[] {
  const groups = new Map<string, Group>(), first = new Map<Group, Lineage>();
  for (const lineage of lineages) {
    lineage.group = null; lineage.at = 0;
    if (!touchedPages(lineage)) continue;
    const kind = category(lineage), key = grouping === 'mapping' ? `${lineage.id}` : `${lineage.creator}@${lineage.epoch}:${kind}`;
    let group = groups.get(key);
    if (!group) {
      group = { id: groups.size + 1, name: grouping === 'mapping' ? lineage.name : KIND_NAMES[kind], kind: lineage.kind, shared: lineage.shared, writable: false, pages: 0, members: 0 };
      groups.set(key, group); first.set(group, lineage);
    }
    lineage.group = group; lineage.at = group.pages;
    group.pages += touchedPages(lineage); group.members++; group.writable ||= lineage.writable;
  }
  // A group of one mapping keeps that mapping's name.
  first.forEach((lineage, group) => { if (group.members === 1) group.name = lineage.name; });
  return [...groups.values()];
}

/** Tiles are cut from a group's pages; a tile can hold the end of one mapping and the start of the next. */
const tileOf = (lineage: Lineage, offset: number, size: number) => Math.floor((lineage.at + offset - lineage.min) / size);
const tileCount = (group: Group, size: number) => Math.ceil(group.pages / size);
const tileSpan = (group: Group, tile: number, size: number) => ({ from: tile * size, to: Math.min((tile + 1) * size, group.pages) });

/** The smallest tile size at which the busiest process fits the budget, or null if none does. */
function fitTiles(ops: MappingOp[], budget: number): number | null {
  for (let size = 1; size <= 2 ** 22; size *= 2) {
    const held = new Map<number, Map<Group, number>>(), counts = new Map<number, number>();
    let total = 0, peak = 0, peakTotal = 0;
    const change = (pid: number, delta: number) => { counts.set(pid, (counts.get(pid) ?? 0) + delta); total += delta; peak = Math.max(peak, counts.get(pid)!); };
    const of = (pid: number) => { let map = held.get(pid); if (!map) { map = new Map(); held.set(pid, map); } return map; };
    for (const op of ops) {
      if (op.op === 'add' || op.op === 'remove') {
        const group = op.lineage.group;
        if (!group) continue;
        const map = of(op.pid), count = map.get(group) ?? 0;
        if (op.op === 'add') { map.set(group, count + 1); if (!count) change(op.pid, tileCount(group, size)); }
        else if (count === 1) { map.delete(group); change(op.pid, -tileCount(group, size)); }
        else if (count) map.set(group, count - 1);
      } else if (op.op === 'clear') { of(op.pid).forEach((_, group) => change(op.pid, -tileCount(group, size))); of(op.pid).clear(); }
      else if (op.op === 'copy') { const map = new Map(of(op.pid)); held.set(op.child, map); change(op.child, [...map.keys()].reduce((sum, group) => sum + tileCount(group, size), 0)); }
      peakTotal = Math.max(peakTotal, total);
    }
    if (peak <= budget && peakTotal <= budget * TOTAL_TILE_FACTOR) return size;
  }
  return null;
}

/** Draws each mapping on its own when that fits with tiles no more than four times as large as grouping needs; otherwise groups them. */
function chooseLayout(lineages: Lineage[], ops: MappingOp[], budget: number): { grouping: Grouping; tile: number; groups: Group[] } {
  assignGroups(lineages, 'mapping');
  const single = fitTiles(ops, budget);
  assignGroups(lineages, 'kind');
  const grouped = fitTiles(ops, budget);
  const grouping: Grouping = single !== null && (grouped === null || single <= grouped * 4) ? 'mapping' : 'kind';
  const groups = assignGroups(lineages, grouping);
  return { grouping, tile: (grouping === 'mapping' ? single : grouped) ?? 2 ** 22, groups };
}

// ——— Pass 3: the exact page ledger ———

interface Counts { resident: number; anon: number }
/** Every page each process maps, and the frame behind it, so sharing and copies are counted exactly. */
class PageLedger {
  private frames = new Map<number, { refs: number; key: string | null }>();
  private cache = new Map<string, number>();
  private nextFrame = 1;
  readonly pages = new Map<number, Map<Lineage, Map<number, number>>>();
  readonly tiles = new Map<number, Map<Group, Map<number, Counts>>>();
  readonly resident = new Map<number, number>();
  totalResident = 0;
  private tile: number;

  constructor(tile: number) { this.tile = tile; }

  get framesInUse() { return this.frames.size; }
  start(pid: number) { this.pages.set(pid, new Map()); this.tiles.set(pid, new Map()); this.resident.set(pid, 0); }
  private countsOf(pid: number, group: Group, tile: number) {
    const byGroup = this.tiles.get(pid)!;
    let byTile = byGroup.get(group);
    if (!byTile) { byTile = new Map(); byGroup.set(group, byTile); }
    let counts = byTile.get(tile);
    if (!counts) { counts = { resident: 0, anon: 0 }; byTile.set(tile, counts); }
    return counts;
  }
  counts(pid: number, group: Group, tile: number): Counts { return this.tiles.get(pid)?.get(group)?.get(tile) ?? { resident: 0, anon: 0 }; }
  private newFrame(key: string | null) {
    const id = this.nextFrame++;
    this.frames.set(id, { refs: 0, key });
    if (key !== null) this.cache.set(key, id);
    return id;
  }
  private release(id: number) {
    const frame = this.frames.get(id)!;
    if (--frame.refs > 0) return;
    this.frames.delete(id);
    if (frame.key !== null) this.cache.delete(frame.key);
  }
  private map(pid: number, lineage: Lineage, offset: number, id: number) {
    let pages = this.pages.get(pid)!.get(lineage);
    if (!pages) { pages = new Map(); this.pages.get(pid)!.set(lineage, pages); }
    pages.set(offset, id);
    const frame = this.frames.get(id)!, counts = this.countsOf(pid, lineage.group!, tileOf(lineage, offset, this.tile));
    frame.refs++; counts.resident++; if (frame.key === null) counts.anon++;
    this.resident.set(pid, this.resident.get(pid)! + 1); this.totalResident++;
  }
  private unmap(pid: number, lineage: Lineage, offset: number) {
    const pages = this.pages.get(pid)!.get(lineage)!, id = pages.get(offset)!, counts = this.countsOf(pid, lineage.group!, tileOf(lineage, offset, this.tile));
    pages.delete(offset);
    counts.resident--; if (this.frames.get(id)!.key === null) counts.anon--;
    this.resident.set(pid, this.resident.get(pid)! - 1); this.totalResident--;
    this.release(id);
  }
  /** One recorded fault, applied with the kernel's rules: first touch, page-cache fault, copy-on-write, or reuse of an exclusive page. */
  fault(pid: number, lineage: Lineage, offset: number, write: boolean): Outcome {
    const id = this.pages.get(pid)!.get(lineage)?.get(offset);
    if (id === undefined) {
      if (lineage.kind === 'anonymous') {
        if (!write) return 'zero_page';
        this.map(pid, lineage, offset, this.newFrame(null));
        return 'demand_zero';
      }
      const key = `${lineage.fileKey}:${lineage.filePage + offset}`;
      this.map(pid, lineage, offset, this.cache.get(key) ?? this.newFrame(key));
      if (!write || lineage.shared || !lineage.writable) return 'file_fault';
      // A write to a private file page copies it out of the page cache.
      this.unmap(pid, lineage, offset);
      this.map(pid, lineage, offset, this.newFrame(null));
      return 'cow_fault';
    }
    if (!write || !lineage.writable) return 'resident';
    if (lineage.shared) return 'write';
    const frame = this.frames.get(id)!;
    if (frame.key === null && frame.refs === 1) return 'reuse';
    this.unmap(pid, lineage, offset);
    this.map(pid, lineage, offset, this.newFrame(null));
    return 'cow_fault';
  }
  drop(pid: number, lineage: Lineage, from: number, to: number) {
    const pages = this.pages.get(pid)?.get(lineage);
    if (!pages) return;
    for (const offset of [...pages.keys()]) if (offset >= from && offset < to) this.unmap(pid, lineage, offset);
  }
  dropAll(pid: number, lineage?: Lineage) {
    const byLineage = this.pages.get(pid);
    if (!byLineage) return;
    for (const [item, pages] of [...byLineage]) if (!lineage || item === lineage) for (const offset of [...pages.keys()]) this.unmap(pid, item, offset);
  }
  /** Fork copies page-table entries for private mappings that hold anonymous pages; others fault back in from the page cache. */
  fork(parent: number, child: number) {
    this.start(child);
    for (const [lineage, pages] of this.pages.get(parent)!) {
      if (lineage.shared || ![...pages.values()].some(id => this.frames.get(id)!.key === null)) continue;
      for (const [offset, id] of pages) this.map(child, lineage, offset, id);
    }
  }
  exit(pid: number) { this.dropAll(pid); this.pages.delete(pid); this.tiles.delete(pid); this.resident.delete(pid); }
  /** One process's figures in pages, in one pass. Page tables are estimated as a root page plus one leaf per 512-page run each mapping touches. */
  figures(pid: number) {
    let rss = 0, file = 0, pss = 0, uss = 0, leaves = 0;
    const bySharers = new Map<number, number>();
    for (const byOffset of this.pages.get(pid)?.values() ?? []) {
      const runs = new Set<number>();
      for (const [offset, id] of byOffset) {
        const frame = this.frames.get(id)!;
        rss++; pss += 1 / frame.refs;
        if (frame.key !== null) file++;
        if (frame.refs === 1) uss++; else bySharers.set(frame.refs, (bySharers.get(frame.refs) ?? 0) + 1);
        runs.add(Math.floor(offset / 512));
      }
      leaves += runs.size;
    }
    return { rss, file, pss, uss, bySharers, tables: rss ? 1 + leaves : 0 };
  }
}

// ——— Pass 3: replaying through the model, and grouping into stages ———

type Draft = {
  lead: Resolved | null; leadText: string; events: TraceEvent[]; start: number; last: number;
  /** Moments like the lead that came within PRELUDE_US of it, such as concurrent requests, and each one's process label. */
  together: { lead: Resolved; who: string }[];
  /** Whether a pause opened the stage, and which processes have acted in it, so a moment that follows at once can lead it. */
  gap: boolean; pids: Set<number>;
  outcomes: Map<number, Map<Outcome, number>>; mapped: Map<number, { count: number; bytes: number }>; dropped: Map<number, number>;
  opened: Map<number, string[]>; closed: Map<number, number>; remapped: Map<number, number>; around: Map<number, number>;
  slices: string[]; lost: number; focus: { pid: number; page: number | null } | null;
  before: { rss: number; pss: number }; forkShared: number;
};
const outcomeText: Record<Outcome, (count: number) => string> = {
  cow_fault: count => `${plural(count, 'copy-on-write copy', 'copy-on-write copies')}`,
  demand_zero: count => `${plural(count, 'new zeroed page')}`,
  file_fault: count => `${plural(count, 'file page')} mapped`,
  zero_page: count => `${plural(count, 'read')} of untouched memory, which ${count === 1 ? 'maps' : 'map'} the zero page`,
  reuse: count => `${plural(count, 'write fault')} on pages it already owned`,
  write: count => `${plural(count, 'write')} to shared mappings`,
  resident: count => `${plural(count, 'fault')} on pages already resident`,
};
const outcomeOrder: Outcome[] = ['cow_fault', 'demand_zero', 'file_fault', 'zero_page', 'reuse', 'write', 'resident'];
const icons: Partial<Record<Outcome, StageKind>> = { cow_fault: 'cow_fault', demand_zero: 'demand_zero', file_fault: 'file_fault', reuse: 'write', write: 'write' };
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const list = (items: string[]) => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
/** “worker 2, worker 3” reads as “workers 2 and 3”. */
const workers = (labels: string[]) => labels.every(label => /^worker \d+$/.test(label)) ? `workers ${list(labels.map(label => label.slice(7)))}` : list(labels);
/** Moments that read as one when they come together: the same marker in several processes, concurrent requests, or exits. */
const alike = (a: Resolved, b: Resolved) => (a.kind === 'exit' && b.kind === 'exit' && a.oom === b.oom)
  || (a.kind === 'marker' && b.kind === 'marker' && a.boundary && b.boundary && a.request === b.request && (a.request || (a.ev.name === b.ev.name && a.ev.cat === b.ev.cat)));

class Builder {
  world: WorldState;
  readonly ledger: PageLedger;
  readonly stages: Stage[] = [];
  readonly modelIssues: string[] = [];
  modelFailures = 0;
  /** Each process's drawn region for each group it maps, and which of the group's mappings it holds. */
  private regions = new Map<number, Map<Group, { id: string; startPage: number }>>();
  private held = new Map<number, Map<Group, Set<Lineage>>>();
  private copies = new Map<number, Map<string, number>>();
  private memory = new Map<number, { rss: number | null; pss: number | null }>();
  /** Bytes each process maps, as the resolver counted them. */
  private mapped = new Map<number, number>();
  private cgroup: number | null = null;
  private limit: number | null = null;
  private draft: Draft | null = null;
  private origin: number;
  private phaseLabels: string[] = [];
  private phase = '';
  private parsed: ParsedRecording;
  private tile: number;
  private root: number;
  private autoReap: boolean;
  private explicitPhases: boolean;
  private forkTimes: number[];
  /** The process label of the current stage's lead, as it was when the lead came. */
  private leadWho: string | null = null;

  constructor(parsed: ParsedRecording, tile: number, root: number, autoReap: boolean, explicitPhases: boolean, forkTimes: number[]) {
    this.parsed = parsed; this.tile = tile; this.root = root; this.autoReap = autoReap; this.explicitPhases = explicitPhases; this.forkTimes = forkTimes;
    this.world = emptyWorld(parsed.meta.pageSize * tile, 'recorded', tile);
    this.ledger = new PageLedger(tile);
    this.origin = parsed.events[0]?.ts ?? 0;
    this.phase = explicitPhases ? 'Start' : forkTimes.length ? 'Startup' : 'Whole recording';
  }

  get phases() { return this.phaseLabels; }
  private process(pid: number) { return this.world.processes.find(item => item.pid === pid && item.status === 'running'); }
  /** Each process's label, kept after it is reaped so a stage's caption still names the worker that just exited. */
  private labels = new Map<number, string>();
  private label(pid: number) {
    const process = this.world.processes.find(item => item.pid === pid);
    if (process) this.labels.set(pid, process.role === 'master' ? `the master (PID ${pid})` : `worker ${pid}`);
    return this.labels.get(pid) ?? `PID ${pid}`;
  }
  private act(action: Action) {
    try {
      this.world = applyAction(this.world, action);
      // A recording's states keep only their latest event, so a long replay does not copy its whole history at every step.
      this.world.events = this.world.events.slice(-1);
      return true;
    } catch (error) {
      this.modelFailures++;
      if (this.modelIssues.length < MAX_ISSUES) this.modelIssues.push(`${action.type} in PID ${'pid' in action ? action.pid : 'parentPid' in action ? action.parentPid : '?'}: ${(error as Error).message}`);
      return false;
    }
  }
  private copyCount(pid: number) { let map = this.copies.get(pid); if (!map) { map = new Map(); this.copies.set(pid, map); } return map; }

  /** Brings one tile of the model in line with the ledger: resident once half its pages are, and copied once the process has copied half of them. */
  private reconcile(pid: number, group: Group, tile: number) {
    const region = this.regions.get(pid)?.get(group), process = this.process(pid);
    if (!region || !process || !process.regions.some(item => item.id === region.id)) return;
    const page = region.startPage + tile, span = tileSpan(group, tile, this.tile), threshold = Math.ceil((span.to - span.from) / 2);
    const counts = this.ledger.counts(pid, group, tile), frameId = process.pages[page] ?? null, key = `${group.id}:${tile}`;
    const wanted = counts.resident >= threshold;
    if (wanted && frameId === null) {
      const write = group.writable && (group.kind === 'anonymous' || (!group.shared && counts.anon >= threshold));
      if (group.kind === 'anonymous' && !write) return;
      if (this.act({ type: write ? 'write' : 'read', pid, page })) this.copyCount(pid).delete(key);
      this.mark(pid, page);
    } else if (!wanted && frameId !== null) {
      this.act({ type: 'discard', pid, pages: [page] });
      this.copyCount(pid).delete(key);
    } else if (wanted && frameId !== null && group.writable && !group.shared) {
      const frame = this.world.frames.find(item => item.id === frameId)!;
      const due = frame.kind === 'file' ? counts.anon >= threshold : sharers(this.world, frameId) > 1 && (this.copyCount(pid).get(key) ?? 0) >= threshold;
      if (due && this.act({ type: 'write', pid, page })) { this.copyCount(pid).delete(key); this.mark(pid, page); }
    }
  }
  /** The tiles a run of a mapping's pages falls in, clipped to the span the scene draws. */
  private reconcileSpan(pid: number, lineage: Lineage, from: number, to: number) {
    const group = lineage.group;
    if (!group) return;
    const first = Math.max(0, tileOf(lineage, Math.max(from, lineage.min), this.tile));
    const last = Math.min(tileCount(group, this.tile) - 1, tileOf(lineage, Math.min(to - 1, lineage.max), this.tile));
    for (let tile = first; tile <= last; tile++) this.reconcile(pid, group, tile);
  }
  private reconcileAll(pid: number) {
    for (const group of this.held.get(pid)?.keys() ?? []) for (let tile = 0; tile < tileCount(group, this.tile); tile++) this.reconcile(pid, group, tile);
  }
  private mark(pid: number, page: number) { if (this.draft) this.draft.focus = { pid, page }; }
  private of<K, V>(map: Map<number, Map<K, V>>, pid: number) { let inner = map.get(pid); if (!inner) { inner = new Map(); map.set(pid, inner); } return inner; }
  /** Notes that a process maps a lineage, and draws the lineage's group in it if the process does not have that region yet. */
  private ensureRegion(pid: number, lineage: Lineage) {
    const group = lineage.group, process = this.process(pid);
    if (!group || !process) return;
    const held = this.of(this.held, pid);
    if (!held.has(group)) held.set(group, new Set());
    held.get(group)!.add(lineage);
    const regions = this.of(this.regions, pid), existing = regions.get(group);
    if (existing && process.regions.some(item => item.id === existing.id)) return;
    const startPage = process.nextPage, id = `region-${this.world.nextRegionId}`;
    // Each group is its own file to the model, so tiles share frames only through fork, where they line up.
    const ok = this.act({ type: 'mmap', pid, name: group.name, pageCount: tileCount(group, this.tile), kind: group.kind, sharing: group.shared ? 'shared' : 'private', writable: group.writable,
      ...(group.kind === 'file' ? { fileKey: `group:${group.id}`, fileOffset: 0 } : {}) });
    if (ok) regions.set(group, { id, startPage });
  }
  private unmapPieces(pid: number, pieces: Piece[], gone: Lineage[]) {
    for (const piece of pieces) {
      this.ledger.drop(pid, piece.lineage, piece.from, piece.to);
      if (!gone.includes(piece.lineage)) this.reconcileSpan(pid, piece.lineage, piece.from, piece.to);
    }
    for (const lineage of gone) {
      this.ledger.dropAll(pid, lineage);
      const group = lineage.group, members = group ? this.held.get(pid)?.get(group) : undefined;
      if (!group || !members) continue;
      members.delete(lineage);
      if (members.size) { this.reconcileSpan(pid, lineage, lineage.min, lineage.max + 1); continue; }
      // The process no longer maps anything in the group, so its region goes.
      this.held.get(pid)!.delete(group);
      const region = this.regions.get(pid)?.get(group);
      this.regions.get(pid)?.delete(group);
      if (region && this.process(pid)?.regions.some(item => item.id === region.id)) this.act({ type: 'munmap', pid, regionId: region.id });
    }
  }
  private forget(pid: number) { this.regions.delete(pid); this.held.delete(pid); }

  private boundary(item: Resolved): StageKind | null {
    if (item.kind === 'exec') return 'exec';
    if (item.kind === 'fork') return 'fork';
    if (item.kind === 'thread') return 'thread';
    if (item.kind === 'exit') return item.oom ? 'oom_kill' : 'exit';
    if (item.kind === 'phase') return 'phase';
    if (item.kind === 'marker' && item.boundary) return item.request ? 'request' : 'marker';
    return null;
  }
  private advance(lead: Resolved | null, at: number) {
    if (lead?.kind === 'phase') this.phase = lead.label;
    else if (!this.explicitPhases && this.forkTimes.length) {
      if (lead?.kind === 'fork' && this.phase === 'Startup') this.phase = 'Forking workers';
      else if (this.phase === 'Forking workers' && lead?.kind !== 'fork' && (lead?.kind === 'marker' && lead.request || at > this.forkTimes[this.forkTimes.length - 1] + FORK_BURST_US)) this.phase = 'Workers running';
    }
  }
  /** A stage a pause started that maps, frees, and opens nothing and moves Σ RSS and memory in use by less than TRIVIAL_BYTES, such as an idle master waking. */
  private trivial(draft: Draft) {
    const pages = TRIVIAL_BYTES / this.parsed.meta.pageSize;
    return draft.gap && !draft.lead && !draft.mapped.size && !draft.dropped.size && !draft.opened.size && !draft.closed.size && !draft.remapped.size && !draft.lost
      && Math.abs(this.ledger.totalResident - draft.before.rss) < pages && Math.abs(this.ledger.framesInUse - draft.before.pss) < pages;
  }
  private open(lead: Resolved | null, at: number, gap = false) {
    const previous = this.draft;
    if (previous && previous.events.length && this.trivial(previous)) {
      // Fold it into the stage that follows: that stage keeps its events and counts, and starts at its own lead.
      this.advance(lead, at);
      previous.lead = lead;
      if (lead) { previous.start = at; previous.gap = false; }
      return;
    }
    if (previous && previous.events.length) this.close();
    this.advance(lead, at);
    this.draft = { lead, leadText: '', together: [], events: [], start: at, last: at, gap, pids: new Set(), outcomes: new Map(), mapped: new Map(), dropped: new Map(), opened: new Map(), closed: new Map(), remapped: new Map(), around: new Map(), slices: [], lost: 0, focus: null,
      before: { rss: this.ledger.totalResident, pss: this.ledger.framesInUse }, forkShared: 0 };
  }
  private tally<K>(map: Map<number, K>, pid: number, fresh: () => K) { if (!map.has(pid)) map.set(pid, fresh()); return map.get(pid)!; }

  add(item: Resolved) {
    const ts = item.ev.ts, kind = this.boundary(item);
    const activity = item.kind !== 'memory' && item.kind !== 'cgroup' && item.kind !== 'limit';
    const pid = 'pid' in item ? item.pid : 0, current = this.draft;
    // A pause starts a stage; if a moment of the same process follows within PRELUDE_US, such as a request just after its
    // connection is accepted, it leads that stage instead of starting another.
    if (kind && current?.gap && !current.lead && ts - current.start <= PRELUDE_US && [...current.pids].every(other => other === pid)) { current.lead = item; this.advance(item, current.start); }
    else if (kind && current?.lead && ts - current.start <= PRELUDE_US && alike(current.lead, item)) current.together.push({ lead: item, who: this.label(pid) });
    else if (kind || !current) this.open(kind ? item : null, ts);
    else if (activity && ts - current.last > this.parsed.meta.stageGapUs && current.events.length) this.open(null, ts, true);
    const draft = this.draft!;
    draft.events.push(item.ev);
    if (activity) { draft.last = ts; if (pid) draft.pids.add(pid); }
    // A lead names its process as it was before the event, so an exit still names the worker it removes.
    const who = this.label(pid);
    if ((item.kind === 'mmap' || item.kind === 'unmap' || item.kind === 'remap' || item.kind === 'fault') && item.mapped >= 0) this.mapped.set(pid, item.mapped);
    else if (item.kind === 'fork') this.mapped.set(item.child, this.mapped.get(item.pid) ?? 0);
    else if (item.kind === 'exec' || item.kind === 'exit') this.mapped.delete(pid);
    switch (item.kind) {
      case 'exec':
        if (item.existing) { this.ledger.exit(item.pid); this.ledger.start(item.pid); }
        else this.ledger.start(item.pid);
        this.forget(item.pid);
        this.act({ type: 'exec', pid: item.pid, parentPid: item.parent, ...(item.name ? { name: item.name } : {}) });
        draft.focus = { pid: item.pid, page: null };
        break;
      case 'fork': {
        this.ledger.fork(item.pid, item.child);
        const tid = item.ev.tid !== null && this.process(item.pid)?.threadIds.includes(item.ev.tid) ? item.ev.tid : undefined;
        this.act({ type: 'fork', parentPid: item.pid, childPid: item.child, ...(tid ? { callerTid: tid } : {}) });
        this.copies.delete(item.pid); this.copies.delete(item.child);
        // The child inherits the parent's regions at the same pages, so it draws the same groups.
        this.regions.set(item.child, new Map(this.regions.get(item.pid) ?? []));
        this.held.set(item.child, new Map([...this.held.get(item.pid) ?? []].map(([group, members]) => [group, new Set(members)])));
        this.reconcileAll(item.child);
        draft.forkShared = this.ledger.resident.get(item.child) ?? 0;
        draft.focus = { pid: item.child, page: null };
        break;
      }
      case 'thread': this.act({ type: 'spawn_thread', pid, tid: item.tid }); draft.focus = { pid, page: null }; break;
      case 'mmap': {
        if (item.replaced.length) this.unmapPieces(pid, item.replaced, item.gone);
        this.ensureRegion(pid, item.lineage);
        const mapped = this.tally(draft.mapped, pid, () => ({ count: 0, bytes: 0 }));
        mapped.count++;
        mapped.bytes += (integer(item.ev.args.len ?? item.ev.args.length, 1) ?? 0);
        break;
      }
      case 'unmap': {
        const before = this.ledger.resident.get(pid) ?? 0;
        this.unmapPieces(pid, item.pieces, item.gone);
        this.tally(draft.dropped, pid, () => 0);
        draft.dropped.set(pid, draft.dropped.get(pid)! + before - (this.ledger.resident.get(pid) ?? 0));
        break;
      }
      case 'remap': {
        const before = this.ledger.resident.get(pid) ?? 0;
        this.unmapPieces(pid, item.pieces, item.gone);
        this.tally(draft.remapped, pid, () => 0);
        draft.remapped.set(pid, draft.remapped.get(pid)! + 1);
        const dropped = before - (this.ledger.resident.get(pid) ?? 0);
        if (dropped) { this.tally(draft.dropped, pid, () => 0); draft.dropped.set(pid, draft.dropped.get(pid)! + dropped); }
        break;
      }
      case 'fault': {
        if (item.lineage.unrecorded) this.ensureRegion(pid, item.lineage);
        const outcome = this.ledger.fault(pid, item.lineage, item.offset, item.write);
        const outcomes = this.tally(draft.outcomes, pid, () => new Map<Outcome, number>());
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
        if (item.around && outcome === 'file_fault') draft.around.set(pid, (draft.around.get(pid) ?? 0) + 1);
        const group = item.lineage.group;
        if (!group) break;
        const tile = tileOf(item.lineage, item.offset, this.tile);
        if (outcome === 'cow_fault') { const key = `${group.id}:${tile}`, map = this.copyCount(pid); map.set(key, (map.get(key) ?? 0) + 1); }
        this.reconcile(pid, group, tile);
        const region = this.regions.get(pid)?.get(group);
        if (region && outcome !== 'resident' && outcome !== 'zero_page') draft.focus = { pid, page: region.startPage + tile };
        break;
      }
      case 'open': {
        if (this.process(pid)?.descriptors.some(fd => fd.fd === item.fd)) this.act({ type: 'close_fd', pid, fd: item.fd });
        this.act({ type: 'open_file', pid, name: item.name, fd: item.fd, kind: item.objectKind, ...(item.objectId ? { objectId: item.objectId } : {}) });
        this.tally(draft.opened, pid, () => [] as string[]).push(item.objectKind === 'socket' ? `socket ${item.name}` : item.name);
        break;
      }
      case 'close':
        if (this.process(pid)?.descriptors.some(fd => fd.fd === item.fd)) { this.act({ type: 'close_fd', pid, fd: item.fd }); this.tally(draft.closed, pid, () => 0); draft.closed.set(pid, draft.closed.get(pid)! + 1); }
        break;
      case 'lock': case 'unlock': this.act({ type: item.kind, pid, lockId: item.lock, tid: item.tid }); break;
      case 'exit':
        this.ledger.exit(pid);
        this.forget(pid);
        this.act({ type: 'exit', pid, oom: item.oom });
        this.memory.delete(pid);
        if (this.autoReap && pid !== this.root) this.act({ type: 'reap', pid });
        draft.focus = { pid: this.world.processes.find(process => process.status === 'running')?.pid ?? pid, page: null };
        break;
      case 'reap':
        if (item.child !== this.root && this.world.processes.some(process => process.pid === item.child && process.status === 'zombie')) this.act({ type: 'reap', pid: item.child });
        break;
      case 'memory': {
        const previous = this.memory.get(pid);
        this.memory.set(pid, { rss: item.rss ?? previous?.rss ?? null, pss: item.pss ?? previous?.pss ?? null });
        break;
      }
      case 'cgroup': this.cgroup = item.bytes; break;
      case 'limit': this.limit = item.bytes; break;
      case 'lost': draft.lost += item.count; break;
      case 'marker': if (!item.boundary && draft.slices.length < 50) draft.slices.push(item.label); break;
      case 'phase': break;
    }
    if (kind && draft.lead === item) { draft.leadText = this.lead(item, who, draft); this.leadWho = who; }
    else if (kind && draft.together.length) draft.leadText = this.together(draft);
  }

  /** One sentence for a lead and the moments like it that came with it. */
  private together(draft: Draft): string {
    const lead = draft.lead!, first = this.leadWho ?? '';
    const all = [{ lead, who: first }, ...draft.together], whos = workers(all.map(item => item.who));
    if (lead.kind === 'exit') return `${capital(whos)} ${lead.oom ? 'are stopped by the OOM killer' : 'exit'}.`;
    if (lead.kind === 'marker' && lead.request) {
      const labels = all.map(item => item.lead.kind === 'marker' ? item.lead.label : '');
      return labels.every(label => label === labels[0]) ? `${capital(whos)} each handle a request${labels[0] ? `: ${labels[0]}` : ''}.`
        : `${capital(list(all.map((item, index) => `${item.who} handles ${labels[index] || 'a request'}`)))}.`;
    }
    // The same hook can run several times in one process, as the master's child_exit does for each worker.
    const distinct = [...new Set(all.map(item => item.who))];
    return lead.kind === 'marker' ? `${lead.label} in ${workers(distinct)}${distinct.length < all.length ? `, ${formatCount(all.length)} times` : ''}.` : draft.leadText;
  }

  private lead(lead: Resolved, who: string, draft: Draft): string {
    const page = this.parsed.meta.pageSize;
    if (lead.kind === 'exec') {
      const name = lead.name ? ` (${lead.name})` : '';
      return lead.existing ? `${capital(who)} calls exec${name}, which replaces its address space.`
        : lead.implicit ? `The recording begins with PID ${lead.pid}${name} already running. What it mapped before recording started is not known.`
        : lead.parent !== null ? `PID ${lead.pid}${name} starts as a child of PID ${lead.parent}. Its earlier memory was not recorded.`
        : `PID ${lead.pid}${name} starts. It is the master: every other process in this recording descends from it.`;
    }
    if (lead.kind === 'fork') return `${capital(who)} forks worker ${lead.child}. ${draft.forkShared ? `The worker’s page table points at ${plural(draft.forkShared, 'resident page')} (${formatBytes(draft.forkShared * page)}) of its parent’s, so they are shared until one side writes.` : 'The parent has no anonymous pages to share yet.'}`;
    if (lead.kind === 'thread') return `${capital(who)} starts thread ${lead.tid}.`;
    if (lead.kind === 'exit') return lead.oom ? `The OOM killer stops ${who}.` : `${capital(who)} exits.`;
    if (lead.kind === 'phase') return /[.!?]$/.test(lead.label) ? lead.label : `${lead.label}.`;
    if (lead.kind === 'marker') return lead.request ? `${capital(who)} handles ${lead.label ? `a request: ${lead.label}` : 'a request'}.`
      : lead.module && lead.ev.name === 'import' ? `${capital(who)} imports ${lead.module}.` : `${lead.label}${lead.pid ? ` in ${who}` : ''}.`;
    return '';
  }

  close() {
    const draft = this.draft;
    if (!draft) return;
    this.draft = null;
    const page = this.parsed.meta.pageSize, world = this.world;
    const running = world.processes.filter(process => process.status === 'running');
    const figures = new Map(running.map(process => [process.pid, this.ledger.figures(process.pid)]));
    const exact: StageMetrics = { sumRss: this.ledger.totalResident * page, sumPss: this.ledger.framesInUse * page,
      processes: running.map(process => ({ pid: process.pid, rss: figures.get(process.pid)!.rss * page, pss: figures.get(process.pid)!.pss * page })) };
    // The views show these exact figures; the tiles only draw where memory is.
    world.exact = { inUse: exact.sumPss, rows: world.processes.map(process => {
      const item = figures.get(process.pid);
      return { pid: process.pid, mapped: item ? this.mapped.get(process.pid) ?? 0 : 0, rss: (item?.rss ?? 0) * page, rssFile: (item?.file ?? 0) * page, pss: (item?.pss ?? 0) * page,
        uss: (item?.uss ?? 0) * page, shared: [...item?.bySharers ?? []].sort(([a], [b]) => a - b).map(([sharers, pages]) => ({ sharers, bytes: pages * page })), pageTables: (item?.tables ?? 0) * page };
    }) };
    const values = running.map(process => this.memory.get(process.pid));
    const sum = (key: 'rss' | 'pss') => values.some(value => value?.[key] !== null && value?.[key] !== undefined) ? values.reduce((total, value) => total + (value?.[key] ?? 0), 0) : null;
    if (this.phaseLabels.at(-1) !== this.phase) this.phaseLabels.push(this.phase);
    const focus = draft.focus && world.processes.some(process => process.pid === draft.focus!.pid) ? draft.focus : { pid: running[0]?.pid ?? world.processes[0]?.pid ?? 0, page: null };
    const caption = this.caption(draft);
    const rssChange = exact.sumRss - draft.before.rss * page, pssChange = exact.sumPss - draft.before.pss * page;
    const change = (bytes: number) => bytes ? ` (${signedBytes(bytes)})` : '';
    this.stages.push({
      caption, kind: this.kindOf(draft), phase: this.phaseLabels.length - 1, at: draft.start - this.origin, focus, events: draft.events, state: world, exact,
      figures: `t ${formatSeconds(draft.start - this.origin)} · Σ RSS ${formatBytes(exact.sumRss)}${change(rssChange)} · in use ${formatBytes(exact.sumPss)}${change(pssChange)}`,
      measured: { sumRss: sum('rss'), sumPss: sum('pss'), cgroup: this.cgroup }, limit: this.limit,
    });
  }

  private kindOf(draft: Draft): StageKind {
    if (draft.lead) { const kind = this.boundary(draft.lead); if (kind) return kind; }
    const totals = new Map<Outcome, number>();
    draft.outcomes.forEach(outcomes => outcomes.forEach((count, outcome) => totals.set(outcome, (totals.get(outcome) ?? 0) + count)));
    const top = [...totals].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top && icons[top]) return icons[top]!;
    if (draft.mapped.size) return 'mmap';
    if (draft.dropped.size) return 'discard';
    return 'activity';
  }

  private caption(draft: Draft): string {
    const sentences: string[] = draft.leadText ? [draft.leadText] : [], page = this.parsed.meta.pageSize;
    const pids = [...new Set([...draft.outcomes.keys(), ...draft.mapped.keys(), ...draft.remapped.keys(), ...draft.dropped.keys(), ...draft.opened.keys(), ...draft.closed.keys()])];
    const weight = (pid: number) => [...(draft.outcomes.get(pid)?.values() ?? [])].reduce((sum, count) => sum + count, 0) + (draft.mapped.get(pid)?.count ?? 0);
    pids.sort((a, b) => weight(b) - weight(a));
    pids.slice(0, 3).forEach(pid => {
      const parts: string[] = [], outcomes = draft.outcomes.get(pid), mapped = draft.mapped.get(pid), dropped = draft.dropped.get(pid);
      if (mapped) parts.push(`maps ${plural(mapped.count, 'region')} (${formatBytes(mapped.bytes)})`);
      if (draft.remapped.get(pid)) parts.push(`moves or resizes ${plural(draft.remapped.get(pid)!, 'mapping')} with mremap`);
      outcomeOrder.forEach(outcome => {
        const count = outcomes?.get(outcome), around = outcome === 'file_fault' ? draft.around.get(pid) ?? 0 : 0;
        if (count) parts.push(`${outcomeText[outcome](count)}${around ? `, ${formatCount(around)} of them by fault-around` : ''}`);
      });
      if (dropped) parts.push(`gives back ${formatBytes(dropped * page)}`);
      const opened = draft.opened.get(pid);
      if (opened) parts.push(opened.length <= 2 ? `opens ${opened.map(name => name.startsWith('/') ? `…/${name.split('/').at(-1)}` : name).join(' and ')}` : `opens ${plural(opened.length, 'descriptor')}`);
      if (draft.closed.get(pid)) parts.push(`closes ${plural(draft.closed.get(pid)!, 'descriptor')}`);
      if (parts.length) sentences.push(`${capital(this.label(pid))}: ${parts.join(', ')}.`);
    });
    if (pids.length > 3) sentences.push(`${plural(pids.length - 3, 'more process', 'more processes')} also ${pids.length - 3 === 1 ? 'acts' : 'act'}.`);
    if (draft.slices.length) sentences.push(`During ${draft.slices.slice(0, 3).join(', ')}${draft.slices.length > 3 ? ` and ${plural(draft.slices.length - 3, 'more')}` : ''}.`);
    if (draft.lost) sentences.push(`The recorder lost ${plural(draft.lost, 'event')} here, so this stage may be incomplete.`);
    if (!sentences.length) sentences.push(draft.outcomes.size ? 'Nothing resident changes.' : 'Only measurements arrive; nothing is mapped or touched.');
    return sentences.join(' ');
  }
}

/** Replays a parsed recording. tileBudget is how many tiles the busiest process may have; tiles grow until it fits. */
export function buildReplay(parsed: ParsedRecording, tileBudget: number = TILE_BUDGETS[0]): Replay {
  const resolver = new Resolver(parsed.meta.pageSize, parsed.processNames);
  for (const event of parsed.events) resolver.add(event);
  if (resolver.root === null) throw Error('The recording has no process events: add exec, fork, mmap, or fault events with a pid.');
  const { grouping, tile, groups } = chooseLayout(resolver.lineages, resolver.ops, tileBudget);
  const resolved = resolver.resolved, autoReap = !resolved.some(item => item.kind === 'reap');
  const forkTimes = resolved.flatMap(item => item.kind === 'fork' ? [item.ev.ts] : []);
  // The initial burst of forks ends when a second passes without one.
  const burst = forkTimes.filter((ts, index) => index === 0 || forkTimes.slice(0, index).every((_, before) => forkTimes[before + 1] - forkTimes[before] <= FORK_BURST_US));
  const builder = new Builder(parsed, tile, resolver.root, autoReap, resolved.some(item => item.kind === 'phase'), burst);
  for (const item of resolved) builder.add(item);
  builder.close();

  // A stage with no process yet is folded into the next one, so every stage draws something.
  const stages = builder.stages.reduce<Stage[]>((kept, stage) => {
    const previous = kept.at(-1);
    if (previous && !previous.state.processes.length) { kept[kept.length - 1] = { ...stage, events: [...previous.events, ...stage.events], at: previous.at, phase: stage.phase }; return kept; }
    kept.push(stage);
    return kept;
  }, []);
  const labels = builder.phases, phases: Phase[] = [];
  stages.forEach((stage, index) => {
    const label = labels[stage.phase];
    if (phases.at(-1)?.label === label) phases.at(-1)!.last = index; else phases.push({ label, first: index, last: index });
  });
  // Phase labels can repeat, so each stage's phase is set from the ranges.
  phases.forEach((phase, index) => { for (let item = phase.first; item <= phase.last; item++) stages[item].phase = index; });

  const pageSize = parsed.meta.pageSize, measured = stages.some(stage => stage.measured.sumRss !== null || stage.measured.sumPss !== null);
  const series: ReplaySeries[] = measured ? [
    { label: 'Σ RSS · measured', metric: 'rss', line: 'solid', values: stages.map(stage => stage.measured.sumRss) },
    { label: 'Σ PSS · measured', metric: 'memory', line: 'solid', values: stages.map(stage => stage.measured.sumPss) },
    { label: 'Σ RSS · from events', metric: 'rss', line: 'dashed', values: stages.map(stage => stage.exact.sumRss) },
    { label: 'Σ PSS · from events', metric: 'memory', line: 'dashed', values: stages.map(stage => stage.exact.sumPss) },
  ].filter(item => item.values.some(value => value !== null)) as ReplaySeries[] : [
    { label: 'Σ RSS', metric: 'rss', line: 'solid', values: stages.map(stage => stage.exact.sumRss) },
    { label: 'Memory in use (Σ PSS)', metric: 'memory', line: 'solid', values: stages.map(stage => stage.exact.sumPss) },
  ];
  if (stages.some(stage => stage.measured.cgroup !== null)) series.push({ label: 'memory.current', metric: 'memory', line: 'dotted', values: stages.map(stage => stage.measured.cgroup) });
  const limit = stages.reduce<number | null>((value, stage) => stage.limit ?? value, null);

  const notes: string[] = [];
  notes.push(tile === 1 ? 'Each tile is one page, so the scene shows every touched page.'
    : `Each tile stands for ${formatCount(tile)} pages (${formatBytes(tile * pageSize)}), so the busiest process fits in ${tileBudget} tiles. A tile is drawn resident once half its pages are, and copied once its process has copied half of them. The chart and captions count every page.`);
  if (grouping === 'kind') {
    const mapped = resolver.lineages.filter(lineage => lineage.group).length, kinds = [...new Set(groups.map(group => group.name))];
    notes.push(`The processes touch ${plural(mapped, 'mapping')}, too many to draw one by one, so each process’s mappings are drawn in ${plural(groups.length, 'group')} by kind, such as ${kinds.slice(0, 4).join(', ')}. A tile can hold the end of one mapping and the start of the next. Mappings a process makes after fork are grouped apart from those it inherited.`);
  }
  const untouched = resolver.lineages.filter(lineage => lineage.max < lineage.min && !lineage.unrecorded);
  if (untouched.length) notes.push(`${plural(untouched.length, 'mapping')} ${untouched.length === 1 ? 'was' : 'were'} never touched while recording, so ${untouched.length === 1 ? 'it is' : 'they are'} not drawn. Each drawn mapping spans only its first to last touched page.`);
  if (resolver.unrecordedFaults) notes.push(`${plural(resolver.unrecordedFaults, 'fault')} landed outside every recorded mapping, so ${plural(resolver.lineages.filter(lineage => lineage.unrecorded).length, 'region')} named “unrecorded” ${resolver.lineages.filter(lineage => lineage.unrecorded).length === 1 ? 'was' : 'were'} added for them and treated as private file mappings. Emit the existing mappings after exec to name them.`);
  if (resolver.foreign) notes.push(`${plural(resolver.foreign, 'event')} from processes outside PID ${resolver.root}’s tree ${resolver.foreign === 1 ? 'was' : 'were'} ignored.`);
  if (resolver.dead) notes.push(`${plural(resolver.dead, 'event')} for processes that had already exited ${resolver.dead === 1 ? 'was' : 'were'} ignored.`);
  if (autoReap && resolved.some(item => item.kind === 'exit')) notes.push('The recording has no reap events, so each exited process is removed as it exits.');
  const lost = resolved.reduce((sum, item) => sum + (item.kind === 'lost' ? item.count : 0), 0);
  if (lost) notes.push(`The recorder reports ${plural(lost, 'lost event')}.`);
  const skipped = parsed.skipped + resolver.skipped, issues = [...parsed.issues, ...resolver.issues].slice(0, MAX_ISSUES);
  if (skipped) notes.push(`${plural(skipped, 'event')} could not be read and ${skipped === 1 ? 'was' : 'were'} skipped. ${issues.join(' ')}`);
  const lastMeasured = [...stages].reverse().find(stage => stage.measured.sumPss !== null && stage.exact.sumPss > 0);
  if (lastMeasured && lastMeasured.measured.sumPss! < lastMeasured.exact.sumPss * 0.97) notes.push('smaps_rollup divides a page shared with processes outside the recording, such as a library’s code, among all of them, so the measured Σ PSS is lower than the replay’s, which divides it among the recorded processes only.');
  if (parsed.ignored) notes.push(`${plural(parsed.ignored, 'trace event')} of other kinds ${parsed.ignored === 1 ? 'was' : 'were'} ignored.`);
  if (builder.modelFailures) notes.push(`${plural(builder.modelFailures, 'event')} could not be applied to the scene. ${builder.modelIssues.join(' ')}`);

  const names = new Map(parsed.processNames);
  stages.forEach(stage => stage.state.processes.forEach(process => { if (process.name && !names.has(process.pid)) names.set(process.pid, process.name); }));
  return { meta: parsed.meta, tilePages: tile, tileBytes: tile * pageSize, tileBudget, stages, states: stages.map(stage => stage.state), phases, chart: { series, limit }, names, notes };
}
