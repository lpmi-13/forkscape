# Forkscape

Forkscape is an explorable explanation of what Linux `fork()` shares, what a write copies, and why process memory numbers can mislead. Its scenario library replays production problems with pre-fork servers such as Gunicorn; free exploration of the same model is secondary.

## Run locally

Requires a recent Node.js release supported by Vite 7 (Node 20.19+ or 22.12+).

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:5173/**. The app is a static TypeScript/Vite site; no backend or container is needed. Run `npm test` for model and parser checks and `npm run build` for type checking and a production bundle. `npm run test:ui` uses system Google Chrome (or `CHROME_BIN`) to step through every scenario in flat and 3D modes and replay the synthetic page trace. `python3 -m unittest discover -s examples/recording` checks the recording examples' bpftrace conversion and `pagemap` inference without root.

Open **http://127.0.0.1:5173/#recording** to choose a page trace, process capture, node recording, or raw Kubelet summary. The picker opens the right viewer and keeps files in the browser. The built-in synthetic page, process, and node examples each open in one click. A process capture opens at `/capture.html`; its [format guide](docs/capture-format.md) describes `forkscape.capture.v1`. `npm run validate:capture -- <file.ndjson>` checks a local file, and `npm run test:capture-ui` checks the viewer with generated synthetic data.

The node viewer offers 3D columns, Flat charts, and sample stepping. Open `/node.html?sample=synthetic` for its built-in example. To collect a time series, use `npm run record:node`; the [node recording guide](docs/node-recording-format.md) has the command and format. A raw Kubelet `/stats/summary` JSON file opens as one node sample.

Put real recordings, probe outputs, logs, screenshots, and investigation notes under `local/`. Git ignores that whole directory and common recording extensions elsewhere. The recorder examples and node collector use `local/captures/` for output. Files in `local/` are available for manual upload through **Replay telemetry** and are not included in the site build.

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

The probe emits JSON with mapping-local `/proc/<pid>/smaps` readings before and after fork and one child write, process-wide `VmPTE`, and a file-cache residency check. Save its output under `local/captures/probes/` when comparing runs. Process-wide `VmPTE` readings cannot calibrate a page-table charge for one test mapping.

The isolated cgroup-v2 probe needs root *inside the disposable VM*. It creates its own 64 MiB cgroup, moves only two probe children into it, records `memory.events` and the child exit codes, then removes the cgroup:

```bash
labctl cp scripts/cgroup_oom_probe.py <playground-id>:/tmp/forkscape-cgroup-oom-probe.py
labctl ssh <playground-id> -- sudo -n python3 /tmp/forkscape-cgroup-oom-probe.py
```

The cgroup probe is a local check on the model's OOM teaching rule. Save its output under `local/captures/probes/`; it is not a replay bundle or a general victim-selection rule.

Two probes check the residency model and the scenarios' Django claims. The Django probe needs an interpreter with Django and Gunicorn, for example a venv created in the VM:

```bash
labctl cp scripts/residency_probe.py <playground-id>:/tmp/forkscape-residency-probe.py
labctl ssh <playground-id> -- python3 /tmp/forkscape-residency-probe.py
labctl ssh <playground-id> -- 'sudo -n apt-get install -y -qq python3-venv && python3 -m venv /tmp/fsenv && /tmp/fsenv/bin/pip install -q "django==6.1.*" "gunicorn==26.*"'
labctl cp scripts/django_residency_probe.py <playground-id>:/tmp/forkscape-django-probe.py
labctl ssh <playground-id> -- /tmp/fsenv/bin/python /tmp/forkscape-django-probe.py
```

These probes let you check when pages become resident, what fork shares, and how a read in a preloaded Gunicorn worker can lead to copy-on-write. Keep their measured output and analysis under `local/`.

The thread probe checks the thread-lock scenario. It takes one venv per interpreter, each with Gunicorn; [uv](https://docs.astral.sh/uv/) installs the interpreters:

```bash
labctl cp scripts/thread_fork_probe.py <playground-id>:/tmp/forkscape-thread-fork-probe.py
labctl ssh <playground-id> -- 'curl -LsSf https://astral.sh/uv/install.sh | sh && for v in 3.11 3.12 3.13 3.14; do ~/.local/bin/uv venv -q --python $v /tmp/py$v && ~/.local/bin/uv pip install -q --python /tmp/py$v/bin/python "gunicorn==26.*"; done'
labctl ssh <playground-id> -- python3 /tmp/forkscape-thread-fork-probe.py /tmp/py3.11 /tmp/py3.12 /tmp/py3.13 /tmp/py3.14
```

The thread probe checks warnings across Python versions and whether a child can take a lock held by a thread that did not survive fork. Keep its output under `local/captures/probes/`.

## Status

This repository contains a **runnable model-mode vertical slice** centered on eight scenarios, a page-event recording replay, a measured process capture viewer, and a measured node telemetry viewer. The scenario values are illustrative; the recording views label their source.

### Recorded telemetry

The app replays page-event recordings. Their contract is [version 1 of the recording format](docs/recording-format.md): a Trace Event Format file, the JSON that Perfetto reads, with a Forkscape header and a small vocabulary (`exec`, `fork`, `mmap`, `mremap`, `fault`, `munmap`, descriptors, threads, exits, `memory` counters, and markers). Any recorder can write one. [`examples/recording/`](examples/recording/README.md) has four reference examples that record the same Gunicorn workload: with bpftrace as root or with an unprivileged `/proc/<pid>/pagemap` sampler, each with the workload on the host or in a container. The sampler needs no privileges, so it runs inside a restricted pod. All four replay with the same figures. Their Python markers add Gunicorn hooks, requests, and imports. The reference probes above remain small, separate checks on the model's claims.

**Replay telemetry** and **Free exploration** are separate choices in the main menu, alongside **Scenarios**. Replay telemetry contains one picker for page traces, process captures, node recordings, and raw Kubelet summaries; files can also be dropped anywhere on the page. They are read in the browser and never uploaded; a copy stays in session storage so a reload can reopen it when storage permits. The [synthetic page trace](public/recordings/synthetic-gunicorn-boot.json) opens at `#recording/sample`, and the picker also offers generated process and node time series. Real recordings stay under `local/` and can be chosen from disk.

Gzipped recordings (`.json.gz`) open directly.

- Each event is applied to an exact page-level ledger, using the same residency, fork, and copy-on-write rules as the model. The chart's Σ RSS and Σ PSS and each caption's counts come from it. `memory` and `cgroup` counters in the recording are charted as solid lines beside the ledger's dashed ones, so drift between the replay and the measurements shows.
- The ledger is projected onto tiles that drive the model engine, so the scene, flat view, ledger panel, inspector, and RSS/PSS bars work unchanged; their RSS, PSS, and USS figures come from the ledger, not from counting tiles. A tile stands for the smallest power-of-two number of pages that fits the busiest process into 24 tiles, the most a 3D deck shows; 48 and 96 are a click away. Mappings are clipped to their touched span, adjacent anonymous mappings merge as the kernel merges them, and a process with too many mappings to draw one by one is drawn in groups by kind. Faults outside every recorded mapping land in regions named “unrecorded”.
- Stages start at `exec`, `fork`, a thread, an exit, an instant marker such as a Gunicorn hook, an outermost slice such as a request or top-level import, and after a 50 ms pause. Requests, exits, or markers that come together share one stage, and an idle wake folds into the stage after it. Phases come from `phase` events, or else are Startup, Forking workers, and Workers running. The panel has a phase rail to jump between phases, the stepper, the chart, the RSS/PSS comparison, the stage's raw events, and notes on how the replay was built and what it skipped.
- Every view says whether it shows the model or a recording. More than two workers share the front row of the 3D scene at a smaller scale, and more than 64 frames spread over more columns of the floor.

Open decisions for page-event replay: the scene's layout for many workers (decks overlap from the overview camera beyond about four), whether stages should also be steppable event by event, and outcome checks against a recorder's own fault classification. The flat view covers systems without WebGL.

The separate [`forkscape.capture.v1` format](docs/capture-format.md) contains sampled process and cgroup aggregates. Choosing such a file opens `/capture.html`, where the Flat/3D button switches between a chart/table and measured 3D columns. It does not replay invented page faults. The format validates sequence, units, missing data, and file limits. A capture can come from a host, container, or pod; pod fields are optional. The app does not ingest a live stream. For page-level replay from an unprivileged pod, use the `pagemap` sampler example instead.

### Done

- TypeScript/Vite app with pinned three.js, responsive layout, lazy-loaded 3D scene, orbit control, glass process decks, page tiles, filaments, kernel membrane, and physical frame floor.
- Flat, keyboard-accessible process/page/frame view using the same state as 3D. The app falls back to flat mode if WebGL initialization fails.
- Pure deterministic model with `fork`, copy-on-write fault, exclusive-frame reuse, `mmap`/`munmap`, file-backed shared mappings, simplified page-table charges, memory limits and OOM selection, process exit, and zombie/reap.
- Residency: pages are mapped before they are resident. Writing an untouched anonymous page allocates a zeroed frame; reading it maps the zero page, which RSS does not count. File pages fault in from the page cache (minor) or from disk (major). Fork copies page-table entries only for private regions that hold anonymous pages.
- Descriptor objects with inherited references and shared file offsets; threads and locks with only one thread surviving `fork` and held locks remaining held in the child.
- A bare visit opens on the default visualization with the menu collapsed; the menu opens the scenario library, telemetry picker, and other modes. Six memory scenarios cover copy-on-write decay, a leak, decay reaching a memory limit, summed RSS overcounting, new-worker warm-up, and running without preload. Two more cover an inherited file offset and a lock held by a thread that does not survive fork. Each scenario names its production symptom and steps through modeled states with captions; the stepper keeps the height of its longest step, and the chart and comparison keep one scale and size, so stepping never moves the panel's layout. A chart compares RSS with PSS or with memory in use (Σ PSS), and the scene points at the page each step touched. Notes explain what to watch, the mechanism, the fix and what it costs, the production consequences, and the `/proc` evidence, with the Linux reference observation where a probe covers it. Each scenario has its own URL hash, so it can be linked directly.
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
- The 3D or flat scene fills the window, with the 3D/flat toggle in the top-right corner. A bare visit starts with the menu and panels collapsed. The panels — scenarios, inspector, event timeline, memory ledger, and camera controls and legend — are in the menu, and one panel is open at a time: beside the scene on wide screens, above it on narrow ones. Escape closes the menu or the open panel. On tall, narrow screens the 3D camera widens its field of view so the whole frame floor stays in view. While stepping through a scenario, the 3D scene labels only what the step changed from the step before — a new object, or a label whose text changed, such as a frame's sharer count, a process's RSS and PSS, a file's offset, or the locks a thread holds — plus the selected process, frame, object, or cable. A scenario's first step and free exploration label everything, and the flat view always names everything. Each thread spindle is labelled with the locks it holds; a lock whose owner did not survive fork is labelled, with a dashed outline, where that thread's spindle would stand. Scene labels stay inside the scene and never overlap: a label moves below its object when the space above is taken, and otherwise the less important label is hidden (processes, then fork returns, kernel objects, frames, and layer names). On phones, frame labels drop the sharer count.
- Cables, page-table sheets, thread spindles, and fork stack blocks have inspector explanations and keyboard-accessible flat/inspector controls. Reduced-motion mode removes hover movement and orbit damping; the scene renders on demand when idle.
- Stronger descriptor/thread invariants and action-shape checks. A reproducible Linux reference probe runs in the preferred `labctl` VM and records one fork/COW/file-cache comparison.
- Reference VM probes now cover varied anonymous mapping sizes, process-wide page-table readings, and an isolated cgroup-v2 OOM observation.
- An automated browser check steps through every scenario in flat and 3D modes, exercises canvas picking, and verifies that switching views preserves the selected state.
- Reference probes repeated on three disposable VMs show a 76–80 KiB process-wide `VmPTE` baseline and variable cgroup event counts. The app presents these as labeled Linux reference observations, separate from the model charge and victim choice.
- Residency and Django 6.1/Gunicorn 26 reference probes (29 October 2026) confirm the residency rules and each Django claim the scenarios make, including the URLconf lazy import, flat RSS during a catalog scan, and Σ RSS ranking preload above no preload while Σ PSS ranks it below.
- A versioned NDJSON capture contract, one-line-at-a-time validator, and Flat/3D browser views of process and cgroup aggregates. The shared recording picker, view toggle, scrub controls, and WebGL fallback are tested against generated synthetic data.

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
| Live telemetry | Stream the existing capture records from `kubectl logs` through a local bridge; add real application lifecycle markers and a canary capture before generalizing the recording format. |
| Conditional | GPU-heavy views only where supported and justified by usability and performance checks. |
| Extensions | Celery and other prefork systems; live lab and learner recording remain outside the current scope. |

The scenario library replaces the original plan's module sequence (Modules 0–10) and incident drills D1–D3. In-app predictions and graded assessment are out of scope.

## Model boundaries

The starting example has six resident 4 KiB pages in one master: code and libraries backed by files, then heap and stack. Scenarios add a few more pages, such as a 3-page imported app or a 6-page catalog, at teaching scale rather than measured size. A fork adds another address space that points to the same anonymous frames; file pages that were never written stay out of the child until it touches them. The first write to a shared private page creates one new 4 KiB frame. Mapped size counts every page in a process's regions. RSS, PSS, and USS count **resident pages only**, so a copy-on-write copy leaves the writer's RSS unchanged. The model charge adds one root page-table page per running process and one leaf page per occupied group of 512 resident pages. A file frame stays in the model's page cache only while some process maps it, so a later touch is a major fault. The model also omits fault-around and readahead. OOM chooses the process with the most resident pages, breaking ties by the highest PID. A CPython read that updates reference counts is modeled as a page write. These are teaching simplifications, not Linux or cgroup accounting. The model omits other kernel structures and actual socket I/O, so it must not be used to size a real deployment. The 3D floor layout is schematic and does not represent physical frame addresses.

The model source is [src/model.ts](src/model.ts), the scenario library is [src/scenarios.ts](src/scenarios.ts), the interface is [src/main.ts](src/main.ts), and the three.js renderer is [src/scene.ts](src/scene.ts). The page-event replay is in [src/recording.ts](src/recording.ts); it and the model renderers consume `WorldState`. The snapshot capture contract, viewer, and 3D aggregate scene are in [src/capture.ts](src/capture.ts), [src/capture-view.ts](src/capture-view.ts), and [src/capture-scene.ts](src/capture-scene.ts). They render measured aggregates separately from `WorldState`, because aggregate `/proc` figures cannot establish exact frame mappings.

The visual styling is in [src/theme.css](src/theme.css). Purple tiles and stacked rings indicate shared frames; green tiles indicate an exclusive frame without a worker owner. Warm amber identifies the master, and worker colors are never purple. A dashed outline marks a page that is mapped but not resident. Chart color follows the metric: RSS is amber, per-process PSS magenta, and memory in use (Σ PSS) or the cgroup charge blue, a set validated for color-vision deficiency against the panel surface. In the RSS/PSS comparison, page segments reuse the scene's shared purple and exclusive green. Decorative dusk colors and the pixel-styled interface do not change model values or data-source labels.
