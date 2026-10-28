# Forkscape

Forkscape is a browser lab for learning what Linux `fork()` shares, what a write copies, and why process memory numbers can mislead. It follows the [process fork visualization plan](/home/adam/projects/plan-docs/PROCESS_FORK_VISUALIZATION_PLAN.md).

## Run locally

Requires a recent Node.js release supported by Vite 7 (Node 20.19+ or 22.12+).

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:5173/**. The app is a static TypeScript/Vite site; no backend or container is needed for this first slice. Run `npm test` for model checks and `npm run build` for type checking and a production bundle. `npm run test:ui` uses system Google Chrome (or `CHROME_BIN`) to complete Modules 1–4 and the case in flat and 3D modes, exercises 3D canvas picking, then checks that switching views preserves the ledger and timeline.

## Preferred Linux experiment runtime

Use an **ephemeral Ubuntu 24.04 VM from `labctl`** for the small kernel reference experiments. This keeps the host environment separate from the measured workload and gives each experiment a fresh Linux session. Check the session's expiration with `labctl playground lifetime <playground-id>`; do not persist a playground when reproducible measurements are the goal.

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

The probe emits JSON with mapping-local `/proc/<pid>/smaps` readings before and after fork and one child write, process-wide `VmPTE`, and a file-cache residency check. The [three-VM comparison](docs/probe-variance-2026-10-28.md) covers 16, 128, 512, and 1,024 touched pages; the [original 16-page sample](docs/reference-probe-2026-10-28.json) remains available. Each child write made 4 KiB private in both processes. The process-wide `VmPTE` baseline and some mapping-size differences varied between runs, so these readings cannot calibrate a page-table charge for the test mapping. A file page remained resident when remapped after all mappings and descriptors were closed in each run.

The isolated cgroup-v2 probe needs root *inside the disposable VM*. It creates its own 64 MiB cgroup, moves only two probe children into it, records `memory.events` and the child exit codes, then removes the cgroup:

```bash
labctl cp scripts/cgroup_oom_probe.py <playground-id>:/tmp/forkscape-cgroup-oom-probe.py
labctl ssh <playground-id> -- sudo -n python3 /tmp/forkscape-cgroup-oom-probe.py
```

In [all three checked-in OOM runs](docs/probe-variance-2026-10-28.md), the first child had `oom_score_adj=500` and was killed when a second child allocated memory; the cgroup's `oom_kill` counter increased by one. The other event counts varied. These samples are observations from one kernel and workload, not a general accounting or OOM victim-selection rule. They validate teaching claims; they are not replay bundles.

## Status

This repository contains a **runnable model-mode vertical slice**, centered on Modules 1–4 plus a creeping-memory case study. The current MVP is model-only, narrower than the original plan. All displayed terminal output and memory values are explicitly illustrative model data, not Linux measurements.

### MVP boundary

The MVP does not accept uploaded telemetry or visualize recordings. The reference probes above are small, separate checks on the model's claims. This repository is not intended to generate general telemetry recordings.

After the MVP, this repository should define a versioned contract for recordings produced elsewhere, validate files uploaded through the frontend, and visualize only measurements the files support. The schema, provenance and missing-data rules, file limits, privacy handling, and visual mapping still need decisions. A future viewer should work without a GPU; the existing flat model view already covers systems without WebGL. GPU-specific features remain conditional on supported hardware.

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
- An automated browser check completes the four guided exercises and case study in flat and 3D modes, exercises canvas picking, and verifies that switching views preserves the selected state.
- Reference probes repeated on three disposable VMs show a 76–80 KiB process-wide `VmPTE` baseline and variable cgroup event counts. The app presents these as labeled Linux reference observations, separate from the model charge and victim choice.

### Next: finish the model MVP

- Probe additional kernels, allocation patterns, and memory limits to check the model's teaching claims. The three current VMs share one image and kernel.
- Validate scene readability with learners and conduct a manual screen-reader review. Check the 3D frame budget when an integrated GPU is available.

### Original plan backlog, subject to rescoping

| Phase | Remaining work |
| --- | --- |
| 0 — discovery | Further kernel reference checks, renderer and metaphor tests. |
| 2 — telemetry, deferred beyond MVP | Decide a recording contract and frontend validation for externally produced files, then consider upload and visualization. The repository will not contain a general recording pipeline. |
| 3 — runtime and measurement | CPython heap/GC model, modeled request scenarios, copy-on-write decay, Module 8, Module 9, sizing calculator, and sandbox controls. Calibration from recordings is deferred. |
| 4 — drills and pilot | Modules 0 and 10, incident drills D1–D3, concept inventory/map, progress import, expert fact review, accessibility and performance gates, pilot study. |
| Conditional | GPU-heavy views only where supported and justified by usability and performance checks. |
| 5 — extensions | Celery and other prefork systems; live lab and learner recording remain outside the current scope. |

## Model boundaries

The starting example has six 4 KiB mapped data pages in one master. A fork adds another address space pointing to the same data frames; the first write to a shared private page creates one new 4 KiB frame. The case study adds a 12-page catalog before fork: one branch writes a new catalog page per request until every page has been copied, while the other retains one new private page per request. RSS, PSS, and USS count **mapped data pages only**. The model charge adds one root page-table page per running process and one leaf page per occupied group of 512 virtual pages. File-backed frames are released when their last model mapping disappears, and OOM chooses a process by mapped-page count. These are teaching simplifications, not Linux or cgroup accounting. The model omits other kernel structures and actual socket I/O, so it must not be used to size a real deployment. The 3D floor layout is schematic and does not represent physical frame addresses.

The model source is [src/model.ts](src/model.ts), the interface is [src/main.ts](src/main.ts), and the three.js renderer is [src/scene.ts](src/scene.ts). Both model renderers consume the same `WorldState`. A future recording format and its relation to `WorldState` remain design decisions; aggregate `/proc` figures alone cannot establish exact frame mappings.

The visual styling is in [src/theme.css](src/theme.css). Purple tiles and stacked rings indicate shared frames; green tiles indicate an exclusive frame without a worker owner. Warm amber identifies the master, while worker colors remain distinct. Decorative dusk colors and the pixel-styled interface do not change model values or data-source labels.
