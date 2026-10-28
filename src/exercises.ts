export const classificationItems = [
  { id: 'pid', label: 'PID', owner: 'process' },
  { id: 'address', label: 'Address space', owner: 'process' },
  { id: 'descriptors', label: 'Descriptor table', owner: 'process' },
  { id: 'threads', label: 'Thread list', owner: 'process' },
  { id: 'socket', label: 'Listening socket object', owner: 'kernel' },
  { id: 'file', label: 'Open-file object and offset', owner: 'kernel' },
] as const;

export type Owner = 'process' | 'kernel';
export type Classification = Record<string, Owner>;
export interface AddressTrace {
  beforeParent?: number;
  beforeChild?: number;
  afterParent?: number;
  afterChild?: number;
}
export interface ExerciseProgress {
  classification: Classification;
  classificationChecked: boolean;
  forkWalkthroughDone: boolean;
  trace: AddressTrace;
  sizeGuess?: { forkKiB: number; copyBytes: number };
  copyObserved: boolean;
}

export function emptyExerciseProgress(): ExerciseProgress {
  return { classification: {}, classificationChecked: false, forkWalkthroughDone: false, trace: {}, copyObserved: false };
}

export function classificationComplete(progress: ExerciseProgress): boolean {
  return progress.classificationChecked && classificationItems.every(item => progress.classification[item.id] === item.owner);
}

export function traceComplete(trace: AddressTrace): boolean {
  return trace.beforeParent !== undefined && trace.beforeParent === trace.beforeChild
    && trace.afterParent === trace.beforeParent && trace.afterChild !== undefined
    && trace.afterChild !== trace.beforeChild;
}

export function moduleComplete(id: 1 | 2 | 3 | 4, answered: boolean, progress: ExerciseProgress): boolean {
  if (!answered) return false;
  if (id === 1) return classificationComplete(progress);
  if (id === 2) return progress.forkWalkthroughDone;
  if (id === 3) return traceComplete(progress.trace);
  return progress.sizeGuess !== undefined && progress.copyObserved;
}

export function forkPageTableKiB(dataMiB: number, pageSize = 4096): number {
  const pages = dataMiB * 1024 * 1024 / pageSize;
  return (1 + Math.ceil(pages / 512)) * pageSize / 1024;
}
