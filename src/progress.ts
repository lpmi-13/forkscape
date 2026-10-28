import { classificationItems, moduleComplete, type AddressTrace, type ExerciseProgress, type Owner } from './exercises.ts';
import { caseComplete, type CaseKind, type CaseProgress } from './caseStudy.ts';

export const MAX_PROGRESS_BYTES = 64 * 1024;
export interface ProgressFile {
  version: 3;
  answers: Record<string, number>;
  exercises: ExerciseProgress;
  caseStudy: CaseProgress;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw Error(`${path} must be true or false.`);
  return value;
}
function integer(value: unknown, path: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw Error(`${path} must be an integer of at least ${min}.`);
  return value as number;
}
function choice(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  const index = integer(value, path);
  if (index > 2) throw Error(`${path} must be a choice from 0 to 2.`);
  return index;
}
function cause(value: unknown, path: string): CaseKind | undefined {
  if (value === undefined) return undefined;
  if (value !== 'decay' && value !== 'leak') throw Error(`${path} must be decay or leak.`);
  return value;
}

export function parseProgress(text: string): ProgressFile {
  if (new TextEncoder().encode(text).length > MAX_PROGRESS_BYTES) throw Error('Progress file is larger than 64 KiB.');
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw Error('Progress file is not valid JSON.'); }
  const input = record(json, 'Progress file');
  if (input.version !== 3) throw Error('This app supports progress files with version 3.');

  const answerInput = record(input.answers, 'answers');
  const answers: Record<string, number> = {};
  for (const [key, value] of Object.entries(answerInput)) {
    if (!['1', '2', '3', '4'].includes(key)) throw Error(`Unknown answer ${key}.`);
    answers[key] = choice(value, `answers.${key}`)!;
  }

  const exerciseInput = record(input.exercises, 'exercises');
  const classificationInput = record(exerciseInput.classification, 'exercises.classification');
  const classification: Record<string, Owner> = {};
  const allowedItems = new Set<string>(classificationItems.map(item => item.id));
  for (const [key, value] of Object.entries(classificationInput)) {
    if (!allowedItems.has(key) || (value !== 'process' && value !== 'kernel')) throw Error(`Invalid classification for ${key}.`);
    classification[key] = value;
  }
  const traceInput = record(exerciseInput.trace, 'exercises.trace');
  const trace: AddressTrace = {};
  for (const key of Object.keys(traceInput)) {
    if (!['beforeParent', 'beforeChild', 'afterParent', 'afterChild'].includes(key)) throw Error(`Unknown trace value ${key}.`);
    trace[key as keyof AddressTrace] = integer(traceInput[key], `exercises.trace.${key}`);
  }
  let sizeGuess: ExerciseProgress['sizeGuess'];
  if (exerciseInput.sizeGuess !== undefined) {
    const guess = record(exerciseInput.sizeGuess, 'exercises.sizeGuess');
    sizeGuess = { forkKiB: integer(guess.forkKiB, 'exercises.sizeGuess.forkKiB'), copyBytes: integer(guess.copyBytes, 'exercises.sizeGuess.copyBytes', 1) };
  }
  const exercises: ExerciseProgress = {
    classification, classificationChecked: boolean(exerciseInput.classificationChecked, 'exercises.classificationChecked'),
    forkWalkthroughDone: boolean(exerciseInput.forkWalkthroughDone, 'exercises.forkWalkthroughDone'),
    trace, copyObserved: boolean(exerciseInput.copyObserved, 'exercises.copyObserved'),
    ...(sizeGuess ? { sizeGuess } : {}),
  };

  const caseInput = record(input.caseStudy, 'caseStudy');
  const evidence = caseInput.evidence;
  if (evidence !== undefined && !['', 'rss', 'pid', 'trend'].includes(evidence as string)) throw Error('caseStudy.evidence is invalid.');
  const prediction = choice(caseInput.prediction, 'caseStudy.prediction');
  const decayCause = cause(caseInput.decayCause, 'caseStudy.decayCause');
  const leakCause = cause(caseInput.leakCause, 'caseStudy.leakCause');
  const caseStudy: CaseProgress = {
    viewedDecay: boolean(caseInput.viewedDecay, 'caseStudy.viewedDecay'),
    viewedLeak: boolean(caseInput.viewedLeak, 'caseStudy.viewedLeak'),
    checked: boolean(caseInput.checked, 'caseStudy.checked'),
    ...(prediction === undefined ? {} : { prediction }),
    ...(decayCause === undefined ? {} : { decayCause }),
    ...(leakCause === undefined ? {} : { leakCause }),
    ...(evidence === undefined ? {} : { evidence: evidence as string }),
  };
  return { version: 3, answers, exercises, caseStudy };
}

export function completedCount(progress: ProgressFile): number {
  const { answers, exercises, caseStudy } = progress;
  return ([1, 2, 3, 4] as const).filter(id => moduleComplete(id, answers[id] !== undefined, exercises)).length
    + Number(caseComplete(caseStudy));
}
