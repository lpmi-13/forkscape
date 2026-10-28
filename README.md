# Forkscape

Forkscape is a browser lab for learning what Linux `fork()` shares, what a write copies, and why process memory numbers can mislead. It follows the [process fork visualization plan](/home/adam/projects/plan-docs/PROCESS_FORK_VISUALIZATION_PLAN.md).

## Run locally

Requires a recent Node.js release supported by Vite 7 (Node 20.19+ or 22.12+).

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:5173/**. The app is a static TypeScript/Vite site; no backend or container is needed for this first slice. Run `npm test` for model checks and `npm run build` for type checking and a production bundle.

## Status

This repository contains a **runnable model-mode vertical slice**, centered on Modules 1–4. It is not the full MVP described in the plan. All displayed terminal output and memory values are explicitly illustrative model data, not Linux measurements.

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

### Next: finish Phase 1

- Deepen the Module 1–4 exercises: the process-versus-kernel classification, step-through fork code, address-following task, and copy-size prediction controls described in the plan. Add explicit completion checks for each exercise.
- Add inspector entries and keyboard alternatives for the remaining decorative and structural scene elements, including cables, page-table sheets, thread spindles, and stack blocks. Extend reduced-motion behavior beyond orbit damping.
- Validate model simplifications against a reference Linux VM, particularly file-cache lifetime, page-table allocation, and OOM selection. Add stronger property checks for descriptor and thread operations.
- Validate scene readability and frame budget with learners and an integrated GPU; add flat-mode parity checks and an accessibility review.

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

The starting example has six 4 KiB mapped data pages in one master. A fork adds another address space pointing to the same data frames; the first write to a shared private page creates one new 4 KiB frame. RSS, PSS, and USS count **mapped data pages only**. The model charge adds one root page-table page per running process and one leaf page per occupied group of 512 virtual pages. File-backed frames are released when their last model mapping disappears, and OOM chooses a process by mapped-page count. These are teaching simplifications, not Linux or cgroup accounting. The model omits other kernel structures and actual socket I/O, so it must not be used to size a real deployment. The 3D floor layout is schematic and does not represent physical frame addresses.

The model source is [src/model.ts](src/model.ts), the interface is [src/main.ts](src/main.ts), and the three.js renderer is [src/scene.ts](src/scene.ts). Both renderers consume the same `WorldState`. Recorded runs will use that contract when the capture pipeline exists.

The visual styling is in [src/theme.css](src/theme.css). Purple tiles and stacked rings indicate shared frames; green tiles indicate an exclusive frame without a worker owner. Warm amber identifies the master, while worker colors remain distinct. Decorative dusk colors and the pixel-styled interface do not change model values or data-source labels.
