# Forkscape

Forkscape is a browser lab for learning what Linux `fork()` shares, what a write copies, and why process memory numbers can mislead. It follows the [process fork visualization plan](/home/adam/projects/plan-docs/PROCESS_FORK_VISUALIZATION_PLAN.md).

## Run locally

Requires a recent Node.js release supported by Vite 7 (Node 20.19+ or 22.12+).

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:5173/**. The app is a static TypeScript/Vite site; no backend or container is needed for this first slice. Run `npm test` for model checks and `npm run build` for type checking and a production bundle. `npm run test:ui` uses system Google Chrome (or `CHROME_BIN`) to complete Modules 1–4 and the case in flat mode, then checks that switching views preserves the ledger and timeline.

## Preferred Linux experiment runtime

Use an **ephemeral Ubuntu 24.04 VM from `labctl`** for kernel experiments and, later, for generating memory-usage telemetry. This keeps the host environment separate from the measured workload and gives each experiment a fresh Linux session. Check the session's expiration with `labctl playground lifetime <playground-id>`; do not persist a playground when reproducible measurements are the goal.

```bash
labctl playground start ubuntu-24-04 --title forkscape-reference
labctl playground status <playground-id>
labctl ssh <playground-id> -- uname -a
```

The local Vite app remains the development UI. To run the current reference probe in the VM:

```bash
labctl cp scripts/reference_probe.py <playground-id>:/tmp/forkscape-reference-probe.py
labctl ssh <playground-id> -- python3 /tmp/forkscape-reference-probe.py
```

The probe emits JSON with mapping-local `/proc/<pid>/smaps` readings before and after fork and one child write, process-wide `VmPTE`, and a file-cache residency check. The [varied-size VM sample](docs/reference-probe-varied-2026-10-28.json) covers 16, 128, 512, and 1,024 touched pages; the [original 16-page sample](docs/reference-probe-2026-10-28.json) remains available. In the varied sample, each child write made 4 KiB private in both processes. Parent `VmPTE` rose by 0, 4, 4, and 8 KiB respectively from the pre-mapping reading. It is a process-wide counter, so those differences cannot be assigned solely to the test mapping. A file page remained resident when remapped after all mappings and descriptors were closed.

The isolated cgroup-v2 probe needs root *inside the disposable VM*. It creates its own 64 MiB cgroup, moves only two probe children into it, records `memory.events` and the child exit codes, then removes the cgroup:

```bash
labctl cp scripts/cgroup_oom_probe.py <playground-id>:/tmp/forkscape-cgroup-oom-probe.py
labctl ssh <playground-id> -- sudo -n python3 /tmp/forkscape-cgroup-oom-probe.py
```

In the [checked-in OOM sample](docs/cgroup-oom-probe-2026-10-28.json), the first child had `oom_score_adj=500` and was killed when a second child allocated memory; the cgroup's `oom_kill` counter increased by one. These samples are observations from one kernel and workload, not a general accounting or OOM victim-selection rule. Future telemetry bundles should record the kernel, page size, workload, sampling method, and `/proc` and cgroup sources alongside every measurement.

## Status

This repository contains a **runnable model-mode vertical slice**, centered on Modules 1–4 plus a creeping-memory case study. It is not the full MVP described in the plan. All displayed terminal output and memory values are explicitly illustrative model data, not Linux measurements.

### Done

- TypeScript/Vite app with pinned three.js, responsive layout, lazy-loaded 3D scene, orbit control, glass process decks, page tiles, filaments, kernel membrane, and physical frame floor.
- Flat, keyboard-accessible process/page/frame view using the same state as 3D. The app falls back to flat mode if WebGL initialization fails.
- Pure deterministic model with `fork`, copy-on-write fault, exclusive-frame reuse, `mmap`/`munmap`, file-backed shared mappings, simplified page-table charges, memory limits and OOM selection, process exit, and zombie/reap.
- Descriptor objects with inherited references and shared file offsets; threads and locks with only one thread surviving `fork` and held locks remaining held in the child.
- Guided content for Modules 1–4 with predict → act → observe → explain → connect stages. Learners can fork, write, compare counters, exit, reap, inspect mappings and descriptors, and branch the timeline from an earlier state. Answers persist in local storage and can be exported as JSON.
- Linked event timeline, RSS/PSS/USS ledger, illustrative terminal, code context, and inspector. Scrubbing selects one world-state snapshot for every view.
- Model tests for shared frames at fork, page-sized copy, exclusive reuse, PSS accounting, region mapping and release, descriptor offsets, thread/lock inheritance, OOM behavior, and deterministic action walks.
- Selectable processes, pages, frames, and kernel objects in both 3D and flat views. The 3D view has camera presets, zoom controls, descriptor cables, thread spindles, a page-table sheet, and a model-mode fork stack. The inspector shows the modeled mechanism and related `/proc` evidence.
- An original visual theme combining a neon dusk city palette with warm, chunky, garden-game shapes. The 3D scene uses a pixel skyline, brighter page tiles, and stacked rings to mark shared frames; the flat view uses the same shared/exclusive colors.
- Module 1–4 exercises now include process/kernel classification, a fork code walkthrough through zombie/reap, a before/after virtual-address trace, and logarithmic fork/write size predictions. Each has an explicit completion check; results persist and appear in progress export.
- Cables, page-table sheets, thread spindles, and fork stack blocks have inspector explanations and keyboard-accessible flat/inspector controls. Reduced-motion mode removes hover movement and orbit damping; the scene renders on demand when idle.
- Stronger descriptor/thread invariants and action-shape checks. A reproducible Linux reference probe runs in the preferred `labctl` VM and records one fork/COW/file-cache comparison.
- A creeping-memory case study contrasts finite copy-on-write decay with a retained-page leak across 24 modeled requests. Learners predict, inspect both histories in the same timeline/scene/ledger, and connect each curve to a mechanism and evidence. Completion persists and appears in progress export. It is a teaching comparison, not a calibrated CPython or Linux recording.
- Reference VM probes now cover varied anonymous mapping sizes, process-wide page-table readings, and an isolated cgroup-v2 OOM observation.
- An automated browser check completes the four guided exercises and case study in flat mode and verifies that switching views preserves the selected state.

### Next: finish Phase 1

- Repeat the reference probes across fresh VMs and workloads to establish variance, then decide how the model should display page-table and cgroup evidence. The single-VM observations cannot calibrate a deployment model.
- Validate scene readability and frame budget with learners and an integrated GPU; expand automated interaction checks to the 3D scene and conduct a manual screen-reader review.

### Later phases from the plan

| Phase | Remaining work |
| --- | --- |
| 0 — discovery | Reference Linux VM; capture/effect-size spikes; renderer and metaphor tests; optional eBPF and flame-graph feasibility decisions. |
| 2 — capture and replay | Reference Django/Gunicorn/PostgreSQL workload, `/proc` sampler, versioned capture bundles, replay engine, Modules 5–7, real terminal and configuration panes. |
| 3 — runtime and measurement | CPython heap/GC model, calibrated request scenarios, copy-on-write decay, Module 8, Module 9, sizing calculator, and sandbox controls. |
| 4 — drills and pilot | Modules 0 and 10, incident drills D1–D3, concept inventory/map, progress import, expert fact review, accessibility and performance gates, pilot study. |
| Conditional | eBPF trace replay and 4D flame graph only if the plan's S5/S6 spikes justify them. |
| 5 — extensions | Live lab, learner application recording, Celery and other prefork systems. |

## Model boundaries

The starting example has six 4 KiB mapped data pages in one master. A fork adds another address space pointing to the same data frames; the first write to a shared private page creates one new 4 KiB frame. The case study adds a 12-page catalog before fork: one branch writes a new catalog page per request until every page has been copied, while the other retains one new private page per request. RSS, PSS, and USS count **mapped data pages only**. The model charge adds one root page-table page per running process and one leaf page per occupied group of 512 virtual pages. File-backed frames are released when their last model mapping disappears, and OOM chooses a process by mapped-page count. These are teaching simplifications, not Linux or cgroup accounting. The model omits other kernel structures and actual socket I/O, so it must not be used to size a real deployment. The 3D floor layout is schematic and does not represent physical frame addresses.

The model source is [src/model.ts](src/model.ts), the interface is [src/main.ts](src/main.ts), and the three.js renderer is [src/scene.ts](src/scene.ts). Both renderers consume the same `WorldState`. Recorded runs will use that contract when the capture pipeline exists.

The visual styling is in [src/theme.css](src/theme.css). Purple tiles and stacked rings indicate shared frames; green tiles indicate an exclusive frame without a worker owner. Warm amber identifies the master, while worker colors remain distinct. Decorative dusk colors and the pixel-styled interface do not change model values or data-source labels.
