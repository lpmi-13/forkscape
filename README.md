# Forkscape

Forkscape is an explorable explanation of what Linux `fork()` shares, what a write copies, and why process memory numbers can mislead. Its scenario library replays production problems with pre-fork servers such as Gunicorn; free exploration of the same model is secondary. It follows the [process fork visualization plan](/home/adam/projects/plan-docs/PROCESS_FORK_VISUALIZATION_PLAN.md).

## Run locally

Requires a recent Node.js release supported by Vite 7 (Node 20.19+ or 22.12+).

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:5173/**. The app is a static TypeScript/Vite site; no backend or container is needed for this first slice. Run `npm test` for model checks and `npm run build` for type checking and a production bundle. `npm run test:ui` uses system Google Chrome (or `CHROME_BIN`) to step through every scenario in flat and 3D modes. It also checks the chart (including that stepping never moves it), switching to each scenario's fix at the same step without moving the layout or the chart's scale, that stepping animates and snaps into place under reduced motion, that a step labels only what it changed, that a worker labels a lock owner fork left behind, that a zoomed camera is reframed when the mode changes, the RSS/PSS comparison, the selection card and page-to-frame tracing, inspector, ledger, and timeline, 3D canvas picking, view switching, free exploration, browser back navigation, and the phone layout.

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

Two probes check the residency model and the scenarios' Django claims. The Django probe needs an interpreter with Django and Gunicorn, for example a venv created in the VM:

```bash
labctl cp scripts/residency_probe.py <playground-id>:/tmp/forkscape-residency-probe.py
labctl ssh <playground-id> -- python3 /tmp/forkscape-residency-probe.py
labctl ssh <playground-id> -- 'sudo -n apt-get install -y -qq python3-venv && python3 -m venv /tmp/fsenv && /tmp/fsenv/bin/pip install -q "django==6.1.*" "gunicorn==26.*"'
labctl cp scripts/django_residency_probe.py <playground-id>:/tmp/forkscape-django-probe.py
labctl ssh <playground-id> -- /tmp/fsenv/bin/python /tmp/forkscape-django-probe.py
```

The [residency findings](docs/residency-findings-2026-10-29.md) summarize the results; the Django runs used Django 6.1.2 and Gunicorn 26.2.0. A mapping is not resident until touched, fork leaves never-written file pages out of the child's RSS, and a copy-on-write fault leaves the writer's RSS unchanged. Under Gunicorn, Django imports the URLconf on each worker's first request. One read-only scan of a preloaded catalog per worker added 55.2 MiB to Σ PSS and nothing to Σ RSS; the master's PSS rose 18.4 MiB though it served no requests.

The thread probe checks the thread-lock scenario. It takes one venv per interpreter, each with Gunicorn; [uv](https://docs.astral.sh/uv/) installs the interpreters:

```bash
labctl cp scripts/thread_fork_probe.py <playground-id>:/tmp/forkscape-thread-fork-probe.py
labctl ssh <playground-id> -- 'curl -LsSf https://astral.sh/uv/install.sh | sh && for v in 3.11 3.12 3.13 3.14; do ~/.local/bin/uv venv -q --python $v /tmp/py$v && ~/.local/bin/uv pip install -q --python /tmp/py$v/bin/python "gunicorn==26.*"; done'
labctl ssh <playground-id> -- python3 /tmp/forkscape-thread-fork-probe.py /tmp/py3.11 /tmp/py3.12 /tmp/py3.13 /tmp/py3.14
```

In [the checked-in run](docs/thread-fork-probe-2026-10-30.json), Python 3.12, 3.13, and 3.14 warned when a process with a second thread forked, and 3.11 did not. Under `gunicorn --preload`, the warning was attributed to Gunicorn's arbiter and reached stderr only with `PYTHONWARNINGS=default`; a fork called from `__main__` showed it under the default filters. In every version, a child forked while another thread held a lock had one thread and could not take the lock.

## Status

This repository contains a **runnable model-mode vertical slice**, centered on a library of eight scenarios. The current MVP is model-only, narrower than the original plan. All displayed memory values are explicitly illustrative model data, not Linux measurements.

### MVP boundary

The MVP does not accept uploaded telemetry or visualize recordings. The reference probes above are small, separate checks on the model's claims. This repository is not intended to generate general telemetry recordings.

After the MVP, this repository should define a versioned contract for recordings produced elsewhere, validate files uploaded through the frontend, and visualize only measurements the files support. The schema, provenance and missing-data rules, file limits, privacy handling, and visual mapping still need decisions. A future viewer should work without a GPU; the existing flat model view already covers systems without WebGL. GPU-specific features remain conditional on supported hardware.

### Done

- TypeScript/Vite app with pinned three.js, responsive layout, lazy-loaded 3D scene, orbit control, glass process decks, page tiles, filaments, kernel membrane, and physical frame floor.
- Flat, keyboard-accessible process/page/frame view using the same state as 3D. The app falls back to flat mode if WebGL initialization fails.
- Pure deterministic model with `fork`, copy-on-write fault, exclusive-frame reuse, `mmap`/`munmap`, file-backed shared mappings, simplified page-table charges, memory limits and OOM selection, process exit, and zombie/reap.
- Residency: pages are mapped before they are resident. Writing an untouched anonymous page allocates a zeroed frame; reading it maps the zero page, which RSS does not count. File pages fault in from the page cache (minor) or from disk (major). Fork copies page-table entries only for private regions that hold anonymous pages.
- Descriptor objects with inherited references and shared file offsets; threads and locks with only one thread surviving `fork` and held locks remaining held in the child.
- A scenario library opens on arrival. Six memory scenarios cover copy-on-write decay, a leak, decay reaching a memory limit, summed RSS overcounting, new-worker warm-up, and running without preload. Two more cover an inherited file offset and a lock held by a thread that does not survive fork. Each scenario names its production symptom and steps through modeled states with captions; the stepper keeps the height of its longest step, and the chart and comparison keep one scale and size, so stepping never moves the panel's layout. A chart compares RSS with PSS or with memory in use (Σ PSS), and the scene points at the page each step touched. Notes explain what to watch, the mechanism, the fix and what it costs, the production consequences, and the `/proc` evidence, with the Linux reference observation where a probe covers it. Each scenario has its own URL hash, so it can be linked directly.
- Every scenario can replay its fix: the same setup with one change, such as a flat-buffer catalog, a bounded cache, a limit sized after decay, a PSS dashboard, the URLconf imported in the master, `preload_app`, a file opened in `post_fork`, or an exporter started in `post_fork`. A switch at the top of the stepper chooses between the problem and the fix, keeps the current step, and frames the stepper in the run's colour; the chart and the RSS/PSS comparison keep one scale across both runs. On narrow screens the switch is in the expanded sheet, and the collapsed dock's top edge shows the run's colour.
- Stepping through a scenario or acting in free exploration animates the change for 600 ms along one curve, `cubic-bezier(.4, 0, .2, 1)`, which the 3D scene, flat view, chart cursor, and RSS/PSS bars share ([src/motion.ts](src/motion.ts)). Objects keep their identity across a step: a forked worker's deck, tiles, filaments, and labels come out of its parent's, a copy-on-write copy comes out of the frame it copies, and stepping back returns them there. Other new parts grow in place and travel with their deck or frame, removed ones shrink away, and colours ease between states. A step taken mid-transition continues from what is drawn. Selecting, changing scenario, mode, or view, and reduced-motion mode change the scene at once.
- On narrow screens (under 900px), the scene fills the screen and the panel is a sheet beneath it. A scenario opens collapsed, with its title, the step's caption, and Back and Next; free exploration shows the last event above its actions. Tapping or swiping the sheet's head expands it to the notes, chart, and RSS/PSS comparison, with the step's model detail under "This step", while Back and Next stay docked at the bottom. The library opens expanded, and other panels open as sheets under the scene.
- RSS versus PSS: five memory scenarios depend on the difference, are tagged in the library, and open with a callout that explains it at each step. The callout draws every process's RSS and PSS as bars of pages, in which shared pages shrink to their share in PSS, with Σ RSS, Σ PSS, and the overcount. The no-preload scenario adds a table showing that Σ RSS and Σ PSS rank preload and no preload in opposite order. Elsewhere in the memory scenarios and in free exploration, the same comparison opens on request. While it is shown, 3D decks and flat process cards carry each process's RSS and PSS. The inspector explains how RSS and PSS count a selected process or page.
- Free exploration starts from the initial master or from any scenario step and keeps its own timeline. Nothing is graded or saved; only the 3D/flat choice persists.
- Linked event timeline, mapped/RSS/PSS/USS ledger, and inspector. Scrubbing selects one world-state snapshot for every view.
- Model tests for shared frames at fork, page-sized copy, exclusive reuse, residency and faults, PSS accounting, region mapping and release, descriptor offsets, thread/lock inheritance, OOM behavior, and deterministic action walks. Scenario tests check each scenario's claim, such as flat RSS during decay.
- Selectable processes, pages, frames, and kernel objects in both 3D and flat views. A selection is explained in a card over the scene, so the scenario panel stays open, and the card opens the full inspector. A selected page traces to its frame, and a frame to every page mapped to it. The 3D camera frames the whole model in whatever space the scene has; on a tall scene it turns toward the stage's long side and looks down more steeply, so the decks sit above columns of frames. It frames it again when the scenario, mode, or view changes, when the model is reset, and when a panel opens or closes; other resizes reframe it until the reader moves the camera. Stepping, selecting, and acting never move it, and the flat view returns to its top on the same changes. The 3D view has camera presets (Overview reframes the model), zoom controls, descriptor cables, thread spindles, a page-table sheet, and a model-mode fork stack. Page-to-frame filaments are thin straight lines in the process colour; descriptor cables are thicker, sag, carry their fd number, and take their kernel object's colour. The inspector shows the modeled mechanism and related `/proc` evidence.
- An original visual theme combining a neon dusk palette with warm, chunky, garden-game shapes. The 3D scene uses brighter page tiles and stacked rings to mark shared frames on a plain backdrop; the flat view uses the same shared/exclusive colors.
- Type and accessibility: text follows a seven-step scale in rem (12–30px), so a reader's default font size applies. Prose is 16px and no text is smaller than 12px; Silkscreen appears only at 16px, where its pixels stay crisp. Panel sections are headings, keyboard focus reaches the open panel before the scene, flat page chips mark sharing by a stacked outline as well as by colour, selected items carry `aria-current`, and the 3D canvas names the flat view as its keyboard equivalent.
- The 3D or flat scene fills the window, with the 3D/flat toggle in the top-right corner. The scenario panel starts open. The other panels — inspector, event timeline, memory ledger, and camera controls and legend — are in the menu, and one panel is open at a time: beside the scene on wide screens, above it on narrow ones. Escape closes the menu or the open panel. On tall, narrow screens the 3D camera widens its field of view so the whole frame floor stays in view. While stepping through a scenario, the 3D scene labels only what the step changed from the step before — a new object, or a label whose text changed, such as a frame's sharer count, a process's RSS and PSS, a file's offset, or the locks a thread holds — plus the selected process, frame, object, or cable. A scenario's first step and free exploration label everything, and the flat view always names everything. Each thread spindle is labelled with the locks it holds; a lock whose owner did not survive fork is labelled, with a dashed outline, where that thread's spindle would stand. Scene labels stay inside the scene and never overlap: a label moves below its object when the space above is taken, and otherwise the less important label is hidden (processes, then fork returns, kernel objects, frames, and layer names). On phones, frame labels drop the sharer count.
- Cables, page-table sheets, thread spindles, and fork stack blocks have inspector explanations and keyboard-accessible flat/inspector controls. Reduced-motion mode removes hover movement and orbit damping; the scene renders on demand when idle.
- Stronger descriptor/thread invariants and action-shape checks. A reproducible Linux reference probe runs in the preferred `labctl` VM and records one fork/COW/file-cache comparison.
- Reference VM probes now cover varied anonymous mapping sizes, process-wide page-table readings, and an isolated cgroup-v2 OOM observation.
- An automated browser check steps through every scenario in flat and 3D modes, exercises canvas picking, and verifies that switching views preserves the selected state.
- Reference probes repeated on three disposable VMs show a 76–80 KiB process-wide `VmPTE` baseline and variable cgroup event counts. The app presents these as labeled Linux reference observations, separate from the model charge and victim choice.
- Residency and Django 6.1/Gunicorn 26 reference probes (29 October 2026) confirm the residency rules and each Django claim the scenarios make, including the URLconf lazy import, flat RSS during a catalog scan, and Σ RSS ranking preload above no preload while Σ PSS ranks it below.

### Next: finish the model MVP

- Probe additional kernels, allocation patterns, and memory limits to check the model's teaching claims. The three current VMs share one image and kernel.
- Validate scene readability with learners and conduct a manual screen-reader review. Check the 3D frame budget when an integrated GPU is available.

### Backlog

| Area | Remaining work |
| --- | --- |
| Concept inventory | Build a concept inventory from the plan's threshold concepts (§5.3) and misconception inventory (§5.5). Map each concept and misconception to the scenarios that address it, so gaps in the library are visible. How the inventory is used beyond that is still open. |
| Scenario library | Add scenarios for production symptoms the library does not cover yet: per-worker state such as in-memory caches and metrics counters that differ by worker, `HUP` reload with preload, worker timeouts and respawn cost, and random-number state copied by fork. A sizing walkthrough driven by Σ PSS after decay replaces the plan's sizing calculator. |
| Model | CPython heap and GC detail beyond "a read is a page write", fault-around, and page cache that outlives its last mapping, each only where a scenario needs it. |
| Quality gates | Expert fact review of every scenario claim; accessibility and performance gates. |
| Telemetry, deferred beyond MVP | Decide a recording contract and frontend validation for externally produced files, then consider upload and visualization. The repository will not contain a general recording pipeline. |
| Conditional | GPU-heavy views only where supported and justified by usability and performance checks. |
| Extensions | Celery and other prefork systems; live lab and learner recording remain outside the current scope. |

The scenario library replaces the original plan's module sequence (Modules 0–10) and incident drills D1–D3. In-app predictions and graded assessment are out of scope.

## Model boundaries

The starting example has six resident 4 KiB pages in one master: code and libraries backed by files, then heap and stack. Scenarios add a few more pages, such as a 3-page imported app or a 6-page catalog, at teaching scale rather than measured size. A fork adds another address space that points to the same anonymous frames; file pages that were never written stay out of the child until it touches them. The first write to a shared private page creates one new 4 KiB frame. Mapped size counts every page in a process's regions. RSS, PSS, and USS count **resident pages only**, so a copy-on-write copy leaves the writer's RSS unchanged. The model charge adds one root page-table page per running process and one leaf page per occupied group of 512 resident pages. A file frame stays in the model's page cache only while some process maps it, so a later touch is a major fault. The model also omits fault-around and readahead. OOM chooses the process with the most resident pages, breaking ties by the highest PID. A CPython read that updates reference counts is modeled as a page write. These are teaching simplifications, not Linux or cgroup accounting. The model omits other kernel structures and actual socket I/O, so it must not be used to size a real deployment. The 3D floor layout is schematic and does not represent physical frame addresses.

The model source is [src/model.ts](src/model.ts), the scenario library is [src/scenarios.ts](src/scenarios.ts), the interface is [src/main.ts](src/main.ts), and the three.js renderer is [src/scene.ts](src/scene.ts). A scenario is a sequence of model states with captions, so a sequence loaded from telemetry after the MVP could use the same viewer. Both model renderers consume the same `WorldState`. A future recording format and its relation to `WorldState` remain design decisions; aggregate `/proc` figures alone cannot establish exact frame mappings.

The visual styling is in [src/theme.css](src/theme.css). Purple tiles and stacked rings indicate shared frames; green tiles indicate an exclusive frame without a worker owner. Warm amber identifies the master, and worker colors are never purple. A dashed outline marks a page that is mapped but not resident. Chart color follows the metric: RSS is amber, per-process PSS magenta, and memory in use (Σ PSS) or the cgroup charge blue, a set validated for color-vision deficiency against the panel surface. In the RSS/PSS comparison, page segments reuse the scene's shared purple and exclusive green. Decorative dusk colors and the pixel-styled interface do not change model values or data-source labels.
