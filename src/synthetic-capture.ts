import { CAPTURE_SCHEMA, type CaptureProcess, type CaptureSample } from './capture.ts';

/** Deterministic aggregate values for exercising the capture viewer. */
export function syntheticProcessCapture(): string {
  const started = Date.parse('2026-01-01T00:00:00Z');
  const process = (pid: number, role: string, pssKiB: number, ussKiB: number): CaptureProcess => ({
    pid, ppid: pid === 1 ? 0 : 1, startTicks: pid === 1 ? 100 : 150, role,
    rssKiB: 16384, pssKiB, ussKiB, privateDirtyKiB: ussKiB,
    sharedDirtyKiB: 2 * (16384 - pssKiB), vmPteKiB: 64,
    minorFaults: pid === 1 ? 200 : ussKiB > 1024 ? 1100 : 80, majorFaults: 0,
  });
  const sample = (processes: CaptureProcess[], chargeMiB: number): CaptureSample => ({
    processes, missingPids: [], sampleDurationMs: 2,
    cgroup: { memoryCurrentBytes: chargeMiB * 1048576, memoryMaxBytes: 64 * 1048576, oomCount: 0, oomKillCount: 0 },
  });
  const entries = [
    { elapsedMs: 0, type: 'metadata', data: {
      environment: 'demo', workload: 'synthetic-prefork', synthetic: true,
      kernel: 'example', architecture: 'x86_64', python: 'example', pageSizeBytes: 4096, cgroupVersion: 2,
    } },
    { elapsedMs: 0, type: 'sample', data: sample([process(1, 'master', 16384, 16384)], 20) },
    { elapsedMs: 500, type: 'marker', data: { name: 'worker_forked', pid: 7 } },
    { elapsedMs: 1000, type: 'sample', data: sample([process(1, 'master', 8192, 0), process(7, 'worker', 8192, 0)], 21) },
    { elapsedMs: 1500, type: 'marker', data: { name: 'cow_write_complete', pid: 7 } },
    { elapsedMs: 2000, type: 'sample', data: sample([process(1, 'master', 12288, 4096), process(7, 'worker', 12288, 4096)], 29) },
    { elapsedMs: 2500, type: 'marker', data: { name: 'worker_exited', pid: 7 } },
    { elapsedMs: 3000, type: 'sample', data: sample([process(1, 'master', 16384, 16384)], 20) },
    { elapsedMs: 3001, type: 'end', data: { status: 'ok' } },
  ];
  return entries.map((entry, seq) => JSON.stringify({
    schema: CAPTURE_SCHEMA, runId: 'synthetic-prefork-startup', seq,
    at: new Date(started + entry.elapsedMs).toISOString(), ...entry,
  })).join('\n') + '\n';
}
