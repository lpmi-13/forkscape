import { mappedPages, memoryRows, objectRefCount, pageCacheKey, pssBreakdown, regionForPage, residentPages, sharers, type ProcessState, type RegionState, type WorldState } from './model.ts';
import type { StructurePart } from './scene';

export const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const kb = (bytes: number) => `${Number.isInteger(bytes / 1024) ? bytes / 1024 : (bytes / 1024).toFixed(1)} KiB`;
export const regionPages = (region: RegionState) => Array.from({ length: region.pageCount }, (_, offset) => region.startPage + offset);
// A mapping's attributes as a row of tags, so they read apart from the prose that explains them.
const traitList = (traits: string[]) => `<ul class="traits">${traits.map(trait => `<li>${trait}</li>`).join('')}</ul>`;
const pageTableKiB =(state: WorldState, process: ProcessState) => process.status === 'running' ? state.pageSize * (1 + new Set(process.pages.flatMap((id, index) => id === null ? [] : [Math.floor(index / 512)])).size) : 0;

export type Selection = { pid: number; page: { pid: number; page: number } | null; frame: number | null; objectId: string | null; structure: { pid: number; part: StructurePart; index: number } | null };
// What the inspector, and the selection card over the scene, say about the current selection.
// Anything said about sharing is derived from a reference count, so it matches what the scene draws.
export type Detail = { title: string; summary: string; metaphor: string; mechanism: string; measurement: string; actions?: string };

function pageDetail(state: WorldState, process: ProcessState, page: number, region: RegionState): Detail {
  const frameId = process.pages[page] ?? null;
  const frame = frameId === null ? null : state.frames.find(item => item.id === frameId) ?? null;
  const count = frame ? sharers(state, frame.id) : 0;
  const cached = frame || region.kind !== 'file' ? undefined : state.frames.find(item => item.fileKey === pageCacheKey(region, page));
  const others = frame ? count - 1 : cached ? sharers(state, cached.id) : 0;
  const residency = frame
    ? `Resident in frame F${frame.id}${count > 1 ? `, which ${count} mappings share` : ''}.`
    : region.kind === 'anonymous' ? 'Not resident. A read would map the shared zero page, which RSS does not count.'
    : cached ? `Not resident here, but frame F${cached.id} holds it in the page cache, so a read would map it with a minor fault.`
    : 'Not resident, and not in the page cache, so a read would load it from disk with a major fault.';
  const accounting = !frame ? 'Neither RSS nor PSS counts it.'
    : count > 1 ? `RSS counts it as ${kb(state.pageSize)} in each of the ${count} mappings; PSS charges each one ${kb(state.pageSize / count)}.`
    : `Only this process maps it, so RSS and PSS both count ${kb(state.pageSize)}.`;
  const nextWrite = !region.writable ? 'A write would fail: the region is read-only.'
    : region.sharing === 'shared' ? `A write changes the page in place${others ? ', and every other mapping of it sees the change' : '; no other mapping has it'}.`
    : !frame ? region.kind === 'anonymous' ? `A write would allocate a zeroed private frame, adding ${kb(state.pageSize)} to RSS.` : 'A write would copy the file page into a private frame.'
    : frame.kind === 'file' || count > 1 ? 'A write causes a copy-on-write fault: this process gets a private copy, and its RSS stays the same.' : 'A write reuses this exclusive frame.';
  return {
    title: `Virtual page <em>${page}</em>`, summary: `PID ${process.pid} → ${frame ? `frame F${frame.id}` : 'not resident'}`,
    metaphor: `<p>${frame ? `A tile on PID ${process.pid}'s deck. Its thin line runs to frame F${frame.id} on the floor: the page-table entry that maps this page.` : 'A faint tile with no line: the address is mapped, but no frame stands behind it yet.'}</p>`,
    mechanism: `${traitList([escapeHtml(region.name), region.kind === 'file' ? 'file-backed' : 'anonymous', `${region.sharing} mapping`, region.writable ? 'writable' : 'read-only'])}<p>${residency} ${nextWrite}</p><p>${accounting}</p>${frame ? `<p>Model write revision: ${frame.revision}.</p>` : ''}`,
    measurement: `<code>/proc/${process.pid}/smaps: Rss, Private_Dirty · /proc/${process.pid}/pagemap</code><small>Residency per mapping is in smaps; the exact frame needs privileged pagemap access. This mapping is modeled.</small>`,
    actions: frame ? `<button type="button" data-frame="${frame.id}" class="subtle">Inspect frame F${frame.id}</button>` : '',
  };
}

function pssSentence(state: WorldState, process: ProcessState, rss: number, pss: number) {
  const split = pssBreakdown(state, process);
  if (!split.shared.length) return `Nothing this process maps is shared, so its RSS and PSS are both ${kb(rss)}.`;
  const shared = split.shared.reduce((sum, item) => sum + item.bytes, 0);
  return `RSS ${kb(rss)} counts ${kb(shared)} of shared pages in full. PSS ${kb(pss)} charges this process its share: ${split.shared.map(item => `${kb(item.bytes)} shared by ${item.sharers} → ${kb(item.bytes / item.sharers)}`).join('; ')}${split.exclusive ? `, plus ${kb(split.exclusive)} exclusive` : ''}.`;
}

/** processActions supplies the scene-part buttons shown under a process. */
export function selectionDetail(state: WorldState, selection: Selection, processActions: (pid: number) => string = () => ''): Detail {
  const frame = selection.frame === null ? null : state.frames.find(f => f.id === selection.frame);
  const process = state.processes.find(p => p.pid === selection.pid) || state.processes[0];
  const page = selection.page?.pid === process?.pid ? selection.page.page : null;
  const region = page === null ? null : regionForPage(process, page);
  const frameMappings = frame ? state.processes.flatMap(p => p.pages.flatMap((id, index) => id === frame.id ? [`PID ${p.pid} page ${index}`] : [])) : [];
  const object = selection.objectId === null ? null : state.kernelObjects.find(item => item.id === selection.objectId);
  const objectDescriptors = object ? state.processes.flatMap(p => p.descriptors.filter(fd => fd.objectId === object.id).map(fd => `PID ${p.pid} fd ${fd.fd}`)) : [];
  const structure = selection.structure?.pid === process.pid ? selection.structure : null;
  if (structure) {
    const fd = process.descriptors[structure.index], tid = process.threadIds[structure.index];
    if (structure.part === 'cable' && fd) {
      const target = state.kernelObjects.find(item => item.id === fd.objectId)!, holders = objectRefCount(state, target.id);
      return { title: 'Descriptor cable', summary: `PID ${process.pid} fd ${fd.fd} → ${escapeHtml(fd.objectId)}`, metaphor: '<p>A thick cable from a port on the deck to a kernel object. The thin lines are page mappings, not descriptors.</p>', mechanism: `<p>The descriptor table entry holds a reference to ${target.kind === 'file' ? 'an open-file object' : 'a socket'}. ${holders > 1 ? `${holders} descriptors share it${target.kind === 'file' ? ' and its file offset' : ''}.` : 'No other descriptor refers to it, so it is not shared.'} Fork copies descriptor table entries, not the objects they refer to.</p>`, measurement: `<code>/proc/${process.pid}/fd/${fd.fd} · fdinfo/${fd.fd}</code><small>The cable and object ID are modeled.</small>` };
    }
    if (structure.part === 'thread' && tid !== undefined) return { title: 'Thread spindle', summary: `PID ${process.pid} · TID ${tid}`, metaphor: '<p>One spindle marks one thread on this deck.</p>', mechanism: '<p>Only the thread that calls fork survives in the child. Other thread-held locks may stay held in the copied address space.</p>', measurement: `<code>/proc/${process.pid}/task</code><small>Thread IDs and locks here are model data.</small>` };
    if (structure.part === 'stack' && state.processes.length > 1) {
      const children = state.processes.filter(item => item.parentPid === process.pid).map(item => item.pid);
      return { title: 'Fork stack blocks', summary: `PID ${process.pid} · modeled call stack`, metaphor: '<p>Stacked blocks stand beside each deck after fork.</p>', mechanism: `<p>Each fork() call returns twice: in the parent with the new child’s PID, and in the child with 0. ${process.role === 'master' ? `Here it returned ${children.length === 1 ? children[0] : `${children.join(', ')}, one per child,`} to this parent.` : `Here it returned 0 to this child and ${process.pid} to its parent, PID ${process.parentPid}.`} Their stacks can diverge after returning.</p>`, measurement: `<code>strace -f -e clone,fork,wait4 · /proc/${process.pid}/stack</code><small>The blocks are schematic; user stacks require a debugger or profiler.</small>` };
    }
    if (structure.part === 'page_table') return { title: 'Page-table sheet', summary: `PID ${process.pid} · ${kb(pageTableKiB(state, process))} model charge`, metaphor: '<p>A thin sheet below the process deck routes virtual pages to frames.</p>', mechanism: '<p>Fork creates a separate page table for the child. It copies entries for anonymous memory, so those frames stay shared, and skips file pages that were never written; they fault back in on first use. This model charges one root and one leaf per occupied group of 512 resident pages.</p>', measurement: `<code>/proc/${process.pid}/status: VmPTE · /proc/${process.pid}/maps</code><small>VmPTE covers the whole process. Three Linux VM runs showed a 0–8 KiB parent increase after mapping 16–1,024 pages. This sheet and its charge are illustrative.</small>` };
  }
  if (object) {
    const holders = objectDescriptors.length, what = object.kind === 'file' ? 'open file' : 'listening socket';
    return { title: `${escapeHtml(object.kind)} <em>${escapeHtml(object.id)}</em>`, summary: `${holders} descriptor(s) point here`, metaphor: `<p>A buoy in the kernel layer with ${holders === 1 ? 'one cable from a process deck' : `${holders} cables from process decks`}.</p>`, mechanism: `<p>${objectDescriptors.join(' · ')}. ${holders > 1 ? `${holders} descriptors share this ${what}.` : `Only this descriptor refers to the ${what}, so it is not shared.`}${object.kind === 'file' ? ` ${holders > 1 ? 'Shared file offset' : 'File offset'}: ${object.offset} bytes.` : ''}</p>`, measurement: '<code>/proc/&lt;pid&gt;/fd · ss -lnp</code><small>Object identity and offset shown here are modeled.</small>' };
  }
  if (frame) return { title: `Frame F${frame.id}`, summary: `${escapeHtml(frame.region)} · ${frame.kind} · ${sharers(state, frame.id)} mapping(s)`, metaphor: '<p>A tile on the memory floor. Each thin line that lands on it is one page mapped to it.</p>', mechanism: `<p>${frameMappings.join(' · ')}. Model write revision: ${frame.revision}. ${frame.fileKey ? `Page-cache key: ${escapeHtml(frame.fileKey)}.` : 'Anonymous data frame.'}</p>`, measurement: '<code>/proc/&lt;pid&gt;/pagemap · /proc/kpagecount</code><small>Exact frame identity often needs privilege. This frame ID is modeled.</small>' };
  if (page !== null && region) return pageDetail(state, process, page, region);
  const row = memoryRows(state).find(item => item.pid === process.pid);
  return {
    title: `${process.role === 'master' ? 'Master' : 'Worker'} <em>PID ${process.pid}</em>`,
    summary: process.status === 'zombie' ? 'Exited · awaiting reaping' : `${residentPages(process)} of ${mappedPages(process)} mapped pages resident · ${process.threadIds.length} thread(s)`,
    metaphor: process.status === 'zombie' ? '<p>A faded deck with no tiles or ports: the process has exited, and only its process-table entry remains until the parent reaps it.</p>' : '<p>A deck with page tiles and descriptor ports. Faint tiles are mapped but not resident.</p>',
    mechanism: `<p>Address space: ${process.regions.map(r => `${escapeHtml(r.name)} (${regionPages(r).filter(index => process.pages[index] != null).length}/${r.pageCount} resident)`).join(', ') || 'released'}. Page tables: ${kb(pageTableKiB(state, process))}.</p>${row ? `<p>Mapped ${kb(row.mapped)} · RSS ${kb(row.rss)} (file ${kb(row.rssFile)}) · PSS ${kb(row.pss)} · USS ${kb(row.uss)}.</p>` : ''}${row && process.status === 'running' ? `<p>${pssSentence(state, process, row.rss, row.pss)}</p>` : ''}<p>Descriptors: ${process.descriptors.map(fd => { const object = state.kernelObjects.find(o => o.id === fd.objectId)!, refs = objectRefCount(state, object.id); return `fd ${fd.fd} → ${escapeHtml(object.id)} (${object.kind}, ${refs} ref${refs === 1 ? '' : 's'}${object.kind === 'file' ? `, offset ${object.offset}` : ''})`; }).join('; ') || 'none'}.</p><p>Threads: ${process.threadIds.join(', ') || 'none'}. Locks: ${process.locks.map(lock => `${escapeHtml(lock.id)} → ${lock.ownerTid ?? 'free'}${lock.ownerTid !== null && !process.threadIds.includes(lock.ownerTid) ? ' (owner absent after fork)' : ''}`).join('; ') || 'none'}.</p>`,
    measurement: `<code>ps · /proc/${process.pid}/status: VmSize, VmRSS, RssFile · smaps_rollup · fd · task</code><small>All values shown here are model data.</small>`,
    actions: processActions(process.pid),
  };
}
