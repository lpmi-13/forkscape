# Residency reference probes: 29 October 2026

These probes check the assumptions behind Forkscape's residency model and its scenarios. The Linux probe ran in one disposable Ubuntu 24.04.5 VM from `labctl` with kernel 6.1.167, 4 KiB pages, and transparent huge pages set to `madvise`. The Django probe ran in a second fresh VM from the same image and kernel, with Python 3.12.3, Django 6.1.2, Gunicorn 26.2.0, and two sync workers. See [the Linux probe](../scripts/residency_probe.py), [the Django probe](../scripts/django_residency_probe.py), the [Linux readings](residency-probe-2026-10-29.json), and Django runs [a](django-residency-probe-2026-10-29-a.json), [b](django-residency-probe-2026-10-29-b.json), and [c](django-residency-probe-2026-10-29-c.json). The Linux probe gave identical `Rss`, `Pss`, `Private_Dirty`, and `Shared_Clean` values in three runs.

## Linux: which pages count in RSS

Each case maps 64 pages (256 KiB) and reads the mapping's own `smaps` entry.

| Mapping | After `mmap` | After the parent touches it | Child right after fork | Child after touching one page | Child after touching every page |
| --- | ---: | ---: | ---: | ---: | ---: |
| Private anonymous; parent reads, then writes every page | 0 KiB | 0 KiB after reads, 256 KiB after writes | 256 KiB (Pss 128) | 256 KiB after a write; `Private_Dirty` 4 KiB | — |
| Private read-only file, cold page cache | 0 KiB | 256 KiB | 0 KiB | 64 KiB | 256 KiB (Pss 128) |
| Private writable file; parent wrote one page | 0 KiB | 256 KiB | 256 KiB | 256 KiB | 256 KiB |
| Shared file | 0 KiB | 256 KiB | 0 KiB | 64 KiB | 256 KiB (Pss 128) |

- A mapping uses no resident memory until a page is touched. Reading untouched anonymous pages maps the shared zero page, which RSS does not count. Writing them allocates frames.
- Fork copies page-table entries for private mappings that already hold anonymous pages. It skips file-backed mappings with no copied pages and shared mappings. Those pages appear in the child's RSS only after the child touches them.
- A copy-on-write fault replaces a shared resident page with a private one. The writer's RSS stays the same; `Private_Dirty` grows by one page.
- Reading the cold file took 3 major faults in the parent. The child's later reads took none: the pages were already in the page cache.
- One child fault on a cached file page made 16 pages (64 KiB) resident. This is fault-around, and the model omits it.

## Django and Gunicorn: preload, first request, reads, and retained objects

The generated project builds a 150,000-entry catalog at import time. Its URLconf imports a views module that builds a 20,000-entry route table. Values are ranges over three runs, in MiB, summed over the master and both workers unless a worker is named.

| Measurement | `preload_app` | `preload_app` + URLconf imported in master | No preload |
| --- | ---: | ---: | ---: |
| Σ RSS at boot | 259.8–259.9 | 281.2–281.3 | 206.2–206.4 |
| Σ PSS at boot | 90.2–90.3 | 97.4 | 174.4 |
| Each worker's RSS / PSS at boot | 84.7–84.8 / 29.1–29.2 | 91.8–91.9 / 31.5–31.6 | 88.9–89.0 / 78.7 |
| `RssFile` at boot, master / each worker | 11.0–11.1 / 5.0–5.1 | 11.0–11.1 / 5.1 | 10.3 / 8.5 |
| `RssAnon` at boot, master / each worker | 79.3 / 79.2 | 86.5 / 86.4 | 18.0 / 80.2 |
| Each worker's first request: `RssFile` / `RssAnon` growth | 1.0–1.1 / 6.8 | 0.8–1.0 / 0.0 | 0.2–0.3 / 6.6 |
| Each worker's first request: `Private_Dirty` growth | 10.5–10.6 | 2.4 | 7.1 |
| First requests: Σ RSS / Σ PSS growth | 14.6–14.7 / 20.4 | 0.9–1.1 / 4.3–4.4 | 13.6 / 14.1 |
| One catalog scan per worker: Σ RSS / Σ PSS growth | 0 / 55.2 | 0 / 55.3 | 0 / 0.0 |
| The same scans: each worker's / the master's PSS growth | 18.4 / 18.4 | 18.4 / 18.4 | 0.0 / 0.0 |
| Σ RSS / Σ PSS after the scans | 274.5–274.6 / 165.9 | 282.2–282.4 / 157.0 | 219.8–220.0 / 188.5–188.6 |

- Gunicorn's `post_fork` and `post_worker_init` hooks found `probe_site.urls` absent from `sys.modules` in every worker unless the master imported it. Django imports the URLconf and its views on a worker's first request.
- A worker's catalog scan only read values. Its RSS did not change, while its `Private_Dirty` grew by 27.6 MiB and its minor-fault count grew by 7,070–7,081 (27.6 MiB ÷ 4 KiB). CPython's reference counting turns those reads into page writes. Without preload, the catalog was already private, so the same scan copied nothing.
- PSS moved in a process that did nothing. The catalog started out shared by three processes. As each worker copied it, the master's share grew, and after both scans the master's PSS had risen 18.4 MiB, as much as each worker's, though the master served no requests.
- Σ RSS and Σ PSS ranked the configurations in opposite order. Σ RSS was higher with preload, at boot and after the scans, while Σ PSS was lower. RSS counts every shared page once per process, and preload shares more.
- The first requests raised Σ PSS by more than Σ RSS with preload. Part of the growth copied shared heap pages, which leaves RSS unchanged.
- Requests that each retained a new 256 KiB object grew a worker's `Private_Dirty` by about the retained size, for example 9.5 MiB for 9.75 MiB retained. RSS grew by somewhat less, 9.1 MiB, because the allocator reused already-resident pages.
- Importing the URLconf in the master moved about 7.2 MiB of boot memory into the shared heap and cut the first requests' Σ PSS growth from 20.4 MiB to 4.3–4.4 MiB. These measurements do not cover import-time side effects, which are a separate risk of preloading.
- Earlier runs on the same VM image with Django 5.2.18 and Gunicorn 23.0.0 agreed with these within 5 MiB on every row and gave the same results in every bullet above. The Django 6.1 runs replace them.

## How the model uses these results

The model now separates mapped pages from resident pages. `mmap` creates pages that are mapped but not resident. A read of an untouched anonymous page maps the zero page, and a write allocates a frame. A file page faults in from the page cache as a minor fault, or from disk as a major fault if no process has it resident. Fork copies entries only for private regions that hold anonymous pages, and a copy-on-write fault leaves the writer's RSS unchanged.

The model's PSS divides each resident frame among the processes that map it, so Σ PSS equals memory in use. A copy raises the PSS of the process that copies and of every process that keeps the original, as the master's PSS rose in the Django scans. The scenarios that depend on this difference show RSS and PSS side by side.

The model leaves out fault-around, readahead, allocator reuse, and page-cache pages that remain after the last mapping goes away. A file frame is released when no process maps it. Scenario sizes are teaching scales, a few 4 KiB pages, not the MiB-scale Django measurements above. One VM, one kernel, and one small project cannot set general sizes for real services.
