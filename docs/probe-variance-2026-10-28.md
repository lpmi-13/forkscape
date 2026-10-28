# Linux reference probe repeat: 28 October 2026

Three separate disposable Ubuntu 24.04.5 VMs ran the same probes. All reported kernel 6.1.167 and a 4 KiB base page size. The anonymous probe first touched each page, sampled its guarded VMA through `/proc/<pid>/smaps`, forked, had the child write one byte, and sampled again. `VmPTE` came from `/proc/<pid>/status` for the whole process. The cgroup-v2 probe put two Python children in a new 64 MiB group with swap disabled, allocated 35 MiB in each, and read `memory.events` and exit status. See [the anonymous probe](../scripts/reference_probe.py) and [the cgroup probe](../scripts/cgroup_oom_probe.py).

| VM sample | Parent VmPTE before mapping | Parent VmPTE increase at 16 / 128 / 512 / 1,024 pages | Private_Dirty after one child write, parent / child | Remapped file page resident |
| --- | ---: | --- | --- | --- |
| [VM 1](reference-probe-varied-2026-10-28.json) | 76 KiB | 0 / 4 / 4 / 8 KiB | 4 / 4 KiB at every size | yes |
| [VM 2](reference-probe-varied-vm2-2026-10-28.json) | 80 KiB | 0 / 0 / 4 / 8 KiB | 4 / 4 KiB at every size | yes |
| [VM 3](reference-probe-varied-vm3-2026-10-28.json) | 80 KiB | 0 / 0 / 4 / 8 KiB | 4 / 4 KiB at every size | yes |

The 128-page VmPTE difference varies even with the same kernel and nominal workload. A Python process has other mappings, and the guarded VMA can land on different page-table boundaries. The process-wide counter cannot tell us which page-table bytes belong to this VMA. It is evidence that page-table use can change with mapping size, not a calibration for Forkscape's one-root-plus-leaves charge. The file-cache check observed residency immediately after remapping; it does not establish a general eviction lifetime.

| VM sample | `memory.events max` increase | `oom` increase | `oom_kill` increase | Exited child |
| --- | ---: | ---: | ---: | --- |
| [VM 1](cgroup-oom-probe-2026-10-28.json) | 142 | 7 | 1 | `oom_score_adj=500` |
| [VM 2](cgroup-oom-probe-vm2-2026-10-28.json) | 131 | 7 | 1 | `oom_score_adj=500` |
| [VM 3](cgroup-oom-probe-vm3-2026-10-28.json) | 92 | 5 | 1 | `oom_score_adj=500` |

The event attempt counts vary. These three repetitions support that this particular pressure workload killed one child. They do not support a general victim-selection rule, nor do they make the model's mapped-page charge equivalent to `memory.current`. Forkscape keeps measured observations in a separate, labeled reference note and retains its simplified model values.

The three VMs share one image and kernel. More kernels, allocation patterns, and memory limits are needed before choosing representative distributions for replay data. Learner readability, integrated-GPU frame budget, and manual screen-reader review remain separate checks.
