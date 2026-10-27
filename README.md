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
- Pure deterministic page model with `fork`, copy-on-write fault, exclusive-frame reuse, process exit, zombie/reap, inherited descriptor IDs, and a simple per-process counter.
- Guided interactive content for Modules 1–4: prediction, explanation, key event, and on-call evidence. Answers persist in local storage and can be exported as JSON.
- Linked event timeline, RSS/PSS/USS ledger, illustrative terminal, code context, and inspector. Scrubbing selects one world-state snapshot for every view.
- Model tests for shared frames at fork, page-sized copy, exclusive reuse, PSS accounting, frame release, and deterministic replay.
- An original visual theme combining a neon dusk city palette with warm, chunky, garden-game shapes. The 3D scene uses a pixel skyline, brighter page tiles, and stacked rings to mark shared frames; the flat view uses the same shared/exclusive colors.

### Next: finish Phase 1

- Complete the kernel model: region mappings, `mmap`/`munmap`, file-backed shared pages, page-table overhead, memory limits, and OOM behavior.
- Implement the descriptor and thread/lock models, including shared file offsets and only the calling thread surviving fork.
- Expand Modules 1–4 into the full predict → act → observe → explain → connect lesson flow, including the zombie and counter interactions as learner-controlled actions rather than a fixed timeline.
- Add selectable page tiles and frame mappings in 3D, camera presets, zoom levels, reduced-motion variants, and full inspector entries for every visual element.
- Validate scene readability and frame budget with learners and an integrated GPU; add flat-mode parity checks and accessibility review.

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

The current example has six 4 KiB mapped data pages in one master. A fork adds another address space pointing to the same data frames; the first write to a shared page creates one new 4 KiB frame. The ledger counts **data pages only**. It omits page tables, kernel structures, file-backed page cache, and cgroup charges, so it must not be used to size a real deployment. The listening socket is represented by a shared descriptor ID; actual socket behavior is planned. The 3D floor layout is schematic and does not represent physical frame addresses.

The model source is [src/model.ts](src/model.ts), the interface is [src/main.ts](src/main.ts), and the three.js renderer is [src/scene.ts](src/scene.ts). Both renderers consume the same `WorldState`. Recorded runs will use that contract when the capture pipeline exists.

The visual styling is in [src/theme.css](src/theme.css). Purple tiles and stacked rings indicate shared frames; green tiles indicate an exclusive frame without a worker owner. Warm amber identifies the master, while worker colors remain distinct. Decorative dusk colors and the pixel-styled interface do not change model values or data-source labels.
