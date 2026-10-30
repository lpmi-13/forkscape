import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ProcessState, WorldState } from './model';
import { mappedPages, memoryRows, sharers } from './model';
import { linkedKey, stepEase, stepLinks, stepMotion } from './motion';

/** Where a deck's nth mapped page tile sits, relative to the deck centre. Up to four rows of six. */
export function deckTileOffset(visualIndex: number, count: number) {
  const rows = Math.max(2, Math.ceil(Math.min(count, 24) / 6));
  const pitch = rows <= 2 ? .9 : Math.min(.6, 1.4 / (rows - 1));
  return { x: (visualIndex % 6 - 2.5) * .79, z: (Math.floor(visualIndex / 6) - (rows - 1) / 2) * pitch, depth: Math.min(.7, pitch - .15) };
}
/** Frames fill the floor in rows of eight, centred, compressing rows as the count grows. */
export function frameTilePosition(index: number, count: number) {
  const rows = Math.max(1, Math.ceil(count / 8));
  const pitch = Math.min(1.28, 6.2 / rows);
  return { x: (index % 8 - 3.5) * 1.22, z: (Math.floor(index / 8) - (rows - 1) / 2) * pitch, depth: Math.min(1.02, pitch - .2) };
}

// Purple marks shared frames, so no process colour is purple.
const palette = [0x64debc, 0x93dfff, 0xff91a6, 0xf7bc79];
const baseFov = 38;
const fitAspect = 1.3;
const kernelY = 1.75;
// Boxes around everything the scene can draw: the floor slab up to the kernel layer, the master's deck with its fork stack, and the worker decks. Framing fits all of them, so a scenario's later workers never need a new camera.
const stageCorners = [
  [[-5.65, -.36, -3.9], [5.65, kernelY, 3.9]],
  [[-2.9, 3.7, -3.45], [2.9, 4.7, -1.05]],
  [[-5.95, 2.85, .95], [5.95, 3.8, 3.35]],
].flatMap(([min, max]) => Array.from({ length: 8 }, (_, bits) => new THREE.Vector3(bits & 1 ? max[0] : min[0], bits & 2 ? max[1] : min[1], bits & 4 ? max[2] : min[2])));
const stageCentre = new THREE.Vector3(0, 2.17, 0);
// The overview looks down on the stage from the front right. A tall scene turns toward the stage's long side and looks down more steeply,
// so the decks sit above columns of frames and the stage fills the scene's height as well as its width. Between the two, the view blends.
const wideView = { azimuth: Math.atan2(9.5, 13.5), elevation: Math.atan2(7.3, Math.hypot(9.5, 13.5)) };
const tallView = { azimuth: THREE.MathUtils.degToRad(72), elevation: THREE.MathUtils.degToRad(38) }, tallAspect = .6;
const overviewDirection = (aspect: number) => {
  const tallness = THREE.MathUtils.clamp((fitAspect - aspect) / (fitAspect - tallAspect), 0, 1);
  const elevation = THREE.MathUtils.lerp(wideView.elevation, tallView.elevation, tallness);
  return new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elevation, THREE.MathUtils.lerp(wideView.azimuth, tallView.azimuth, tallness));
};
// Pixels kept clear between the stage and the scene's edges, and above the stage for the master deck's labels.
const edgeGap = 12, labelRoom = 24;

/** The overview camera that fits the whole stage in a width × height scene whose top `coveredTop` pixels lie under the page's controls. */
export function stageView(width: number, height: number, coveredTop = 0) {
  const aspect = width / height;
  // Widen the vertical field on tall scenes, so the camera need not back away into the fog to fit the floor's width.
  const fov = aspect >= fitAspect ? baseFov : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseFov / 2)) * fitAspect / aspect));
  const tanY = Math.tan(THREE.MathUtils.degToRad(fov / 2)), tanX = tanY * aspect;
  // The part of the scene the stage may fill, in normalised device coordinates. A scene too small for the gaps uses all of itself.
  const topGap = Math.max(coveredTop, edgeGap) + labelRoom;
  const [left, right, bottom, top] = width > 8 * edgeGap && height > 2 * (topGap + edgeGap)
    ? [-1 + 2 * edgeGap / width, 1 - 2 * edgeGap / width, -1 + 2 * edgeGap / height, 1 - 2 * topGap / height] : [-1, 1, -1, 1];
  const overview = overviewDirection(aspect);
  const across = new THREE.Vector3().crossVectors(THREE.Object3D.DEFAULT_UP, overview).normalize();
  const up = new THREE.Vector3().crossVectors(overview, across);
  const points = stageCorners.map(corner => { const offset = corner.clone().sub(stageCentre); return { x: offset.dot(across), y: offset.dot(up), toward: offset.dot(overview) }; });
  // For a camera this far back, the range of sideways or vertical shifts that keeps every corner inside the usable part of the scene.
  const shifts = (distance: number, axis: 'x' | 'y', low: number, high: number, tan: number) => points.reduce(([min, max], point) => {
    const reach = tan * (distance - point.toward);
    return [Math.max(min, point[axis] - high * reach), Math.min(max, point[axis] - low * reach)];
  }, [-Infinity, Infinity]);
  const ranges = (distance: number) => [shifts(distance, 'x', left, right, tanX), shifts(distance, 'y', bottom, top, tanY)];
  // The stage only gets easier to fit from farther back, so bisection finds the closest camera that fits.
  let near = Math.max(...points.map(point => point.toward)) + .5, far = 200;
  for (let index = 0; index < 40; index++) {
    const middle = (near + far) / 2;
    if (ranges(middle).every(([min, max]) => min <= max)) far = middle; else near = middle;
  }
  const [x, y] = ranges(far).map(([min, max]) => (min + max) / 2);
  const target = stageCentre.clone().addScaledVector(across, x).addScaledVector(up, y);
  return { fov, distance: far, target, position: target.clone().addScaledVector(overview, far) };
}
export type StructurePart = 'cable' | 'page_table' | 'thread' | 'stack';
type LabelText = { text: string; detail: string };
// A deck draws at most four thread spindles.
const spindleSlots = 4;
/** Locks a process holds through a thread it does not have, by owner: fork copies a lock's state but only the calling thread. */
function absentOwners(process: ProcessState) {
  const owners = new Map<number, string[]>();
  process.locks.forEach(lock => { if (lock.ownerTid !== null && !process.threadIds.includes(lock.ownerTid)) owners.set(lock.ownerTid, [...owners.get(lock.ownerTid) ?? [], lock.id]); });
  return owners;
}
/** What each scene label says, by the key of the object it names, so a step can tell which labels it changed. A detail is hidden on phones. */
export function labelTexts(world: WorldState, accounting: boolean) {
  const texts = new Map<string, LabelText>([['s/frames-label', { text: 'PHYSICAL FRAMES', detail: '' }], ['s/kernel-label', { text: 'KERNEL · PAGE TABLES', detail: '' }]]);
  const rows = memoryRows(world);
  world.kernelObjects.forEach(object => texts.set(`o/${object.id}/label`, { text: `${object.kind.toUpperCase()} · ${object.id}`, detail: object.kind === 'file' ? `offset ${object.offset}` : '' }));
  world.frames.forEach(frame => texts.set(`f/${frame.id}/label`, { text: `F${frame.id}`, detail: String(sharers(world, frame.id)) }));
  world.processes.forEach(process => {
    const row = accounting && process.status === 'running' ? rows.find(item => item.pid === process.pid) : undefined;
    texts.set(`p/${process.pid}/label`, { text: `${process.role.toUpperCase()} · PID ${process.pid}${process.status === 'zombie' ? ' · ZOMBIE' : ''}`, detail: row ? `RSS ${row.rss / 1024} · PSS ${+(row.pss / 1024).toFixed(1)} KiB` : '' });
    if (process.status === 'zombie') return;
    process.descriptors.forEach((descriptor, index) => texts.set(`p/${process.pid}/cable/${index}/label`, { text: `fd ${descriptor.fd}`, detail: '' }));
    const holds = (locks: string[]) => locks.length ? `holds ${locks.join(', ')}` : '';
    process.threadIds.slice(0, spindleSlots).forEach((tid, index) => texts.set(`p/${process.pid}/thread/${index}/label`, { text: `thread ${tid}`, detail: holds(process.locks.filter(lock => lock.ownerTid === tid).map(lock => lock.id)) }));
    absentOwners(process).forEach((locks, tid) => texts.set(`p/${process.pid}/absent/${tid}/label`, { text: `thread ${tid} absent`, detail: holds(locks) }));
    if (world.processes.length > 1) texts.set(`p/${process.pid}/stack/label`, { text: process.role === 'master' ? `fork() → ${world.processes.filter(p => p.parentPid === process.pid).map(p => p.pid).join(', ')}` : 'fork() → 0', detail: '' });
    if (mappedPages(process) > 24) texts.set(`p/${process.pid}/overflow-label`, { text: `+${mappedPages(process) - 24} pages · see flat view`, detail: '' });
    texts.set(`p/${process.pid}/filament-label`, { text: 'page → frame', detail: '' });
  });
  return texts;
}
type LabelBox = { left: number; top: number; right: number; bottom: number };

// A step eases each drawn object between two poses. Objects are keyed like `p/<pid>/deck`, so an object's pose carries across a step.
type Drawn = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial | THREE.MeshBasicMaterial> | THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
type Pose = { position: THREE.Vector3; size: THREE.Vector3; opacity: number; color: THREE.Color; emissive?: THREE.Color; glow?: number; points?: number[] };
// A filament's geometry holds its two endpoints, so it moves them rather than its scale.
const isFilament = (object: THREE.Object3D) => object instanceof THREE.Line && !(object instanceof THREE.LineSegments);
const geometrySize = (object: Drawn) => {
  if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
  return object.geometry.boundingBox!.getSize(new THREE.Vector3());
};
function poseOf(object: THREE.Object3D): Pose {
  const drawn = object as Drawn, material = drawn.material;
  return {
    position: drawn.position.clone(), size: geometrySize(drawn).multiply(drawn.scale), opacity: material.opacity, color: material.color.clone(),
    emissive: 'emissive' in material ? material.emissive.clone() : undefined, glow: 'emissiveIntensity' in material ? material.emissiveIntensity : undefined,
    points: isFilament(drawn) ? [...drawn.geometry.getAttribute('position').array] : undefined,
  };
}
// A new object grows from nothing in place, and a removed one shrinks away. A filament reaches down from its page or draws back into it.
const vanished = (pose: Pose): Pose => ({ ...pose, size: pose.size.clone().multiplyScalar(1e-3), opacity: pose.points ? 0 : pose.opacity, points: pose.points && [...pose.points.slice(0, 3), ...pose.points.slice(0, 3)] });
const moved = (pose: Pose, offset: THREE.Vector3): Pose => ({ ...pose, position: pose.position.clone().add(offset), points: pose.points?.map((value, index) => value + offset.getComponent(index % 3)) });
function tween(object: THREE.Object3D, from: Pose, to: Pose, restores: (() => void)[]) {
  const drawn = object as Drawn, material = drawn.material, base = geometrySize(drawn), size = new THREE.Vector3();
  // An opaque material is translucent only while it fades, so it writes depth again afterwards.
  if (from.opacity !== to.opacity && !material.transparent) {
    material.transparent = true;
    material.needsUpdate = true;
    restores.push(() => { material.transparent = false; material.needsUpdate = true; });
  }
  const endpoints = from.points && to.points && isFilament(drawn) ? drawn.geometry.getAttribute('position') : undefined;
  return (eased: number) => {
    drawn.position.lerpVectors(from.position, to.position, eased);
    if (!endpoints) {
      size.lerpVectors(from.size, to.size, eased);
      drawn.scale.set(base.x ? size.x / base.x : 1, base.y ? size.y / base.y : 1, base.z ? size.z / base.z : 1);
    }
    material.color.lerpColors(from.color, to.color, eased);
    material.opacity = THREE.MathUtils.lerp(from.opacity, to.opacity, eased);
    if ('emissive' in material && from.emissive && to.emissive) {
      material.emissive.lerpColors(from.emissive, to.emissive, eased);
      material.emissiveIntensity = THREE.MathUtils.lerp(from.glow!, to.glow!, eased);
    }
    if (endpoints) {
      from.points!.forEach((value, index) => { endpoints.array[index] = THREE.MathUtils.lerp(value, to.points![index], eased); });
      endpoints.needsUpdate = true;
      drawn.geometry.boundingSphere = null;
    }
  };
}
function disposeObject(object: THREE.Object3D) {
  const drawn = object as Drawn;
  drawn.geometry?.dispose();
  drawn.material?.dispose();
}
export type SceneSelection = { kind: 'process'; pid: number } | { kind: 'page'; pid: number; page: number } | { kind: 'frame'; frameId: number } | { kind: 'object'; objectId: string } | { kind: 'structure'; pid: number; part: StructurePart; index: number };

export class ForkScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(baseFov, 1, 0.1, 100);
  private controls: OrbitControls;
  private dynamic = new THREE.Group();
  // Objects a step removed, drawn until its transition ends.
  private leaving = new THREE.Group();
  private transitionFrame = 0;
  private settle: (() => void) | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pickables: THREE.Object3D[] = [];
  private resizeObserver: ResizeObserver;
  private pendingFrame = 0;
  private motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  private labels: HTMLDivElement[] = [];
  private targets: { key: string; element: HTMLDivElement; point: THREE.Vector3; priority: number }[] = [];
  private currentWorld?: WorldState;
  private selectedPid = 4100;
  private onSelect?: (selection: SceneSelection) => void;
  private selectedPage: { pid: number; page: number } | null = null;
  private selectedFrame: number | null = null;
  private selectedObjectId: string | null = null;
  private selectedStructure: { pid: number; part: StructurePart; index: number } | null = null;
  private pressedAt: [number, number] | null = null;
  private framed = { position: new THREE.Vector3(), target: new THREE.Vector3() };
  /** Adds each process's RSS and PSS to its label; read on the next setWorld. */
  showAccounting = false;
  /** Labels only what changed since this state, and what is selected; null labels everything. Read on the next setWorld. */
  changedSince: WorldState | null = null;
  private texts = new Map<string, LabelText>();
  private quietLabels = new Set<string>();

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The flat view is the text and keyboard equivalent of this canvas.
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.setAttribute('aria-label', '3D scene of process decks, page tiles, physical frames, and kernel objects. Switch to the flat view to reach each one by keyboard.');
    host.appendChild(this.renderer.domElement);
    this.scene.fog = new THREE.Fog(0x1b1838, 15, 30);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enableDamping = !this.motionPreference.matches;
    this.motionPreference.addEventListener('change', this.updateMotion);
    this.controls.addEventListener('change', this.renderFrame);
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.scene.add(new THREE.HemisphereLight(0xc8e9ff, 0x593355, 2.3));
    const sun = new THREE.DirectionalLight(0xffdeb0, 2.5);
    sun.position.set(4, 10, 6);
    this.scene.add(sun);
    const neon = new THREE.PointLight(0x6deed4, 28, 16);
    neon.position.set(-5, 4, 2);
    this.scene.add(neon);
    this.scene.add(this.dynamic, this.leaving);
    this.raycaster.params.Line.threshold = .12;
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.hover);
    this.renderer.domElement.addEventListener('click', this.click);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(host);
    document.fonts.addEventListener('loadingdone', this.renderFrame);
    this.fitView();
  }

  /** Draws a world state. With `animate`, each object eases from where it is drawn now, so a step taken during another step's transition carries on from there. */
  setWorld(world: WorldState, selectedPid: number, selectedPage: { pid: number; page: number } | null, selectedFrame: number | null, selectedObjectId: string | null, selectedStructure: { pid: number; part: StructurePart; index: number } | null, onSelect: (selection: SceneSelection) => void, animate = false) {
    const before = this.currentWorld;
    const drawn = animate && before && !this.motionPreference.matches ? this.drawnPoses() : null;
    this.settle?.();
    const previous = [...this.dynamic.children];
    this.dynamic.clear();
    this.pickables = [];
    this.clearLabels();
    this.currentWorld = world;
    this.selectedPid = selectedPid;
    this.selectedPage = selectedPage;
    this.selectedFrame = selectedFrame;
    this.selectedObjectId = selectedObjectId;
    this.selectedStructure = selectedStructure;
    this.onSelect = onSelect;
    this.build();
    if (drawn) this.transition(drawn, previous, stepLinks(before!, world));
    else previous.forEach(disposeObject);
    this.renderFrame();
  }

  private drawnPoses() {
    const objects = new Map<string, Pose>();
    // An object still leaving from an interrupted step can come back; one still in the scene takes precedence.
    [...this.leaving.children, ...this.dynamic.children].forEach(object => objects.set(object.userData.key, poseOf(object)));
    return { objects, labels: new Map(this.targets.map(target => [target.key, target.point.clone()])) };
  }

  // A forked process's parts come out of its parent's, and a copy grows out of the frame it copies; stepping back returns them there.
  // A part with no counterpart grows or shrinks on its process's deck or its frame's tile, travelling with it. A label follows its object, and a new one fades in.
  private transition(drawn: ReturnType<ForkScene['drawnPoses']>, previous: THREE.Object3D[], links: ReturnType<typeof stepLinks>) {
    const built = new Map(this.dynamic.children.map(object => [object.userData.key as string, object]));
    const finals = new Map([...built].map(([key, object]) => [key, poseOf(object)]));
    const enters = (key: string) => drawn.objects.get(key) ?? drawn.objects.get(linkedKey(key, links.enter) ?? '');
    const exits = (key: string) => finals.get(key) ?? finals.get(linkedKey(key, links.exit) ?? '');
    const anchor = (key: string) => { const match = /^([pf])\/(\d+)\//.exec(key); return match ? `${match[1]}/${match[2]}/${match[1] === 'p' ? 'deck' : 'tile'}` : ''; };
    const travel = (from?: Pose, to?: Pose) => from && to ? to.position.clone().sub(from.position) : new THREE.Vector3();
    const restores: (() => void)[] = [];
    const steps: ((eased: number) => void)[] = [...built].map(([key, object]) => {
      const to = finals.get(key)!, home = anchor(key);
      return tween(object, enters(key) ?? moved(vanished(to), travel(finals.get(home), enters(home))), to, restores);
    });
    for (const object of previous) {
      const key = object.userData.key as string;
      if (built.has(key)) { disposeObject(object); continue; }
      // The interrupted transition was settled to its end, so a leaving object starts from the pose it was drawn in.
      const from = drawn.objects.get(key) ?? poseOf(object), home = anchor(key);
      this.leaving.add(object);
      steps.push(tween(object, from, exits(key) ?? moved(vanished(from), travel(drawn.objects.get(home), exits(home))), restores));
    }
    for (const { key, element, point } of this.targets) {
      const home = anchor(key), from = drawn.labels.get(key) ?? drawn.labels.get(linkedKey(key, links.enter) ?? ''), to = point.clone();
      const origin = from ?? to.clone().add(travel(finals.get(home), enters(home)));
      steps.push(eased => {
        point.lerpVectors(origin, to, eased);
        if (!from) element.style.opacity = eased < 1 ? String(eased) : '';
      });
    }
    const start = performance.now();
    const frame = (now: number) => {
      const progress = Math.min((now - start) / stepMotion.duration, 1);
      if (progress === 1) { this.settle?.(); this.renderFrame(); return; }
      steps.forEach(step => step(stepEase(progress)));
      this.renderFrame();
      this.transitionFrame = requestAnimationFrame(frame);
    };
    this.settle = () => {
      cancelAnimationFrame(this.transitionFrame);
      this.transitionFrame = 0;
      this.settle = null;
      steps.forEach(step => step(1));
      restores.forEach(restore => restore());
      [...this.leaving.children].forEach(disposeObject);
      this.leaving.clear();
    };
    steps.forEach(step => step(0));
    this.transitionFrame = requestAnimationFrame(frame);
  }

  /** Frames the whole stage in the scene's current size. */
  fitView() { this.layout(true); }

  setCameraPreset(preset: 'overview' | 'process' | 'memory') {
    if (preset === 'overview') { this.fitView(); return; }
    if (preset === 'memory') { this.camera.position.set(6, 4, 8); this.controls.target.set(0, .2, 0); }
    else { this.camera.position.set(5, 6.35, 8); this.controls.target.set(0, 3.05, 0); }
    this.controls.update();
  }

  setZoom(closer: boolean) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() * (closer ? .8 : 1.25), this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target.clone().add(offset.setLength(distance)));
    this.controls.update();
  }

  // A camera the reader hasn't moved since it was framed is framed again for the scene's new size.
  private resize = () => this.layout(this.camera.position.distanceTo(this.framed.position) < 1e-4 && this.controls.target.distanceTo(this.framed.target) < 1e-4);

  private layout(refit: boolean) {
    const width = Math.max(this.host.clientWidth, 1), height = Math.max(this.host.clientHeight, 1);
    // The page's corner controls float over the top of the scene, unless the layout places the scene below them.
    const view = stageView(width, height, parseFloat(getComputedStyle(this.host).getPropertyValue('--covered-top')) || 0);
    this.camera.aspect = width / height;
    this.camera.fov = view.fov;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    if (refit) {
      // Zoom limits follow the framing, so the closest and farthest views keep their proportions on every screen.
      this.controls.minDistance = view.distance * .45;
      this.controls.maxDistance = view.distance * 1.4;
      this.camera.position.copy(view.position);
      this.controls.target.copy(view.target);
      this.controls.update();
      this.framed = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    }
    this.renderFrame();
  }

  private updateMotion = () => {
    this.controls.enableDamping = !this.motionPreference.matches;
    this.controls.update();
  };

  private add<T extends THREE.Object3D>(key: string, object: T) {
    object.userData.key = key;
    this.dynamic.add(object);
    return object;
  }

  // Translucent boxes don't write depth: three.js sorts them by centre, so a large pane like the kernel layer would otherwise hide whatever is drawn after it.
  private makeBox(key: string, width: number, height: number, depth: number, color: number, opacity = 1) {
    return this.add(key, new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: opacity > .8 ? .1 : .025, transparent: opacity < 1, depthWrite: opacity >= 1, opacity, roughness: .65, metalness: .08 })));
  }

  private addLine(key: string, a: THREE.Vector3, b: THREE.Vector3, color: number, opacity = .48) {
    const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
    return this.add(key, new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
  }

  // A descriptor is a thick, sagging cable from a port on the deck, so it never reads as one of the straight page-to-frame filaments.
  private addCable(key: string, from: THREE.Vector3, to: THREE.Vector3, color: number, highlighted: boolean) {
    const curve = new THREE.QuadraticBezierCurve3(from, from.clone().lerp(to, .5).setY((from.y + to.y) / 2 - .3 - from.distanceTo(to) * .1), to);
    const material = () => new THREE.MeshStandardMaterial({ color: highlighted ? 0xffffff : color, emissive: color, emissiveIntensity: highlighted ? .7 : .35, roughness: .45 });
    // The tube is centred on its position, so a step can move and scale it like any other object.
    const tube = new THREE.TubeGeometry(curve, 20, highlighted ? .05 : .035, 6);
    tube.computeBoundingBox();
    const centre = tube.boundingBox!.getCenter(new THREE.Vector3());
    tube.translate(-centre.x, -centre.y, -centre.z);
    const cable = this.add(key, new THREE.Mesh(tube, material()));
    cable.position.copy(centre);
    const port = this.add(`${key}/port`, new THREE.Mesh(new THREE.BoxGeometry(.17, .13, .1), material()));
    port.position.copy(from);
    // Cables converge on their object, so each is labelled near its own port.
    return { parts: [cable, port], labelPoint: curve.getPoint(.3) };
  }

  // When labels overlap on screen, the higher-priority one stays visible.
  private label(key: string, point: THREE.Vector3, priority: number, className = '') {
    const label = this.texts.get(key);
    if (!label || this.quietLabels.has(key)) return;
    const element = document.createElement('div');
    element.className = `scene-label ${className}`;
    element.textContent = label.text;
    if (label.detail) {
      const extra = document.createElement('span');
      extra.className = 'label-detail';
      extra.textContent = ` · ${label.detail}`;
      element.append(extra);
    }
    this.host.appendChild(element);
    this.labels.push(element);
    const index = this.targets.findIndex(target => target.priority < priority);
    this.targets.splice(index < 0 ? this.targets.length : index, 0, { key, element, point, priority });
  }

  private build() {
    const world = this.currentWorld;
    if (!world) return;
    const base = this.makeBox('s/base', 11.3, .25, 7.8, 0x563757);
    base.position.y = -.23;
    const ground = this.makeBox('s/ground', 11, .08, 7.5, 0x222b50);
    ground.position.y = -.12;
    const membrane = this.makeBox('s/membrane', 10.6, .035, 7.1, 0xb77bee, .22);
    membrane.position.y = kernelY;
    const grid = new THREE.GridHelper(10, 20, 0x54cfbd, 0x466786);
    grid.position.y = -.07;
    this.add('s/grid', grid);
    // A selected page traces to its frame; a selected frame traces to every page mapped to it.
    const tracedFrame = this.selectedFrame ?? (this.selectedPage && world.processes.find(p => p.pid === this.selectedPage!.pid)?.pages[this.selectedPage.page]) ?? null;
    // A scenario step labels only what it changed, and what is selected, so its changes stand out.
    this.texts = labelTexts(world, this.showAccounting);
    const before = this.changedSince && labelTexts(this.changedSince, this.showAccounting);
    const part = this.selectedStructure;
    const selected = new Set([`p/${this.selectedPid}/label`, `p/${this.selectedPid}/filament-label`, `f/${tracedFrame}/label`, `o/${this.selectedObjectId}/label`, part && (part.part === 'cable' || part.part === 'thread') ? `p/${part.pid}/${part.part}/${part.index}/label` : '']);
    this.quietLabels = new Set(before ? [...this.texts].filter(([key, { text, detail }]) => !selected.has(key) && before.get(key)?.text === text && before.get(key)?.detail === detail).map(([key]) => key) : []);
    this.label('s/frames-label', new THREE.Vector3(-4.7, .02, 3.25), 1, 'scene-label-small');
    this.label('s/kernel-label', new THREE.Vector3(-4.65, kernelY + .03, 3.15), 1, 'scene-label-small');

    const objectPositions = new Map<string, THREE.Vector3>();
    world.kernelObjects.forEach((object, index) => {
      const x = -3.6 + index * 1.5, z = -3.15;
      const buoy = new THREE.Mesh(new THREE.CylinderGeometry(.28, .38, .36, 8), new THREE.MeshStandardMaterial({
        color: object.kind === 'socket' ? 0x65dfcb : 0xf7bc79,
        emissive: object.kind === 'socket' ? 0x2a9a86 : 0x9d6131,
        emissiveIntensity: this.selectedObjectId === object.id ? .6 : .18,
      }));
      buoy.position.set(x, kernelY + .31, z);
      buoy.userData.selection = { kind: 'object', objectId: object.id } satisfies SceneSelection;
      this.add(`o/${object.id}/buoy`, buoy);
      this.pickables.push(buoy);
      objectPositions.set(object.id, buoy.position.clone());
      this.label(`o/${object.id}/label`, new THREE.Vector3(x, kernelY + .67, z), 3, 'scene-label-small');
    });

    const framePositions = new Map<number, THREE.Vector3>();
    world.frames.forEach((frame, index) => {
      const { x, z, depth } = frameTilePosition(index, world.frames.length);
      const count = sharers(world, frame.id);
      const ownerIndex = world.processes.findIndex(p => p.pid === frame.owner);
      const color = count > 1 ? 0xb39cf3 : frame.owner === null ? 0x74dfad : palette[Math.max(ownerIndex, 0) % palette.length];
      const tile = this.makeBox(`f/${frame.id}/tile`, 1.06, .2, depth, color);
      tile.position.set(x, .08, z);
      tile.userData.selection = { kind: 'frame', frameId: frame.id } satisfies SceneSelection;
      this.pickables.push(tile);
      const tileEdge = new THREE.LineSegments(new THREE.EdgesGeometry(tile.geometry), new THREE.LineBasicMaterial({ color: count > 1 ? 0xf1b6ff : 0xd7ffb2, transparent: true, opacity: .75 }));
      tileEdge.position.copy(tile.position);
      this.add(`f/${frame.id}/edge`, tileEdge);
      if (tracedFrame === frame.id) {
        const marker = new THREE.Mesh(new THREE.TorusGeometry(.59, .035, 4, 16), new THREE.MeshBasicMaterial({ color: 0xffe794 }));
        marker.rotation.x = -Math.PI / 2;
        marker.position.set(x, .23, z);
        this.add(`f/${frame.id}/trace`, marker);
      }
      if (count > 1) {
        for (let ring = 0; ring < count; ring++) {
          const marker = new THREE.Mesh(new THREE.TorusGeometry(.34 + ring * .075, .018, 4, 12), new THREE.MeshBasicMaterial({ color: ring % 2 ? 0xffd37c : 0xff89d2 }));
          marker.rotation.x = -Math.PI / 2;
          marker.position.set(x, .21 + ring * .025, z);
          this.add(`f/${frame.id}/ring/${ring}`, marker);
        }
      }
      framePositions.set(frame.id, tile.position.clone());
      this.label(`f/${frame.id}/label`, new THREE.Vector3(x, .37, z), 2, 'frame-label');
    });

    world.processes.forEach((process, processIndex) => {
      const x = process.role === 'master' ? 0 : processIndex === 1 ? -3.05 : 3.05;
      const z = process.role === 'master' ? -2.25 : 2.15;
      const y = process.role === 'master' ? 3.85 : 3;
      const isSelected = this.selectedPid === process.pid;
      const color = process.role === 'master' ? 0xffc66f : palette[processIndex % palette.length];
      const deck = this.makeBox(`p/${process.pid}/deck`, 5.4, .17, 2.1, color, process.status === 'zombie' ? .23 : .38);
      deck.position.set(x, y, z);
      deck.userData.selection = { kind: 'process', pid: process.pid } satisfies SceneSelection;
      this.pickables.push(deck);
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(deck.geometry), new THREE.LineBasicMaterial({ color: isSelected ? 0xffecad : color, transparent: true, opacity: isSelected ? 1 : .78 }));
      border.position.copy(deck.position);
      this.add(`p/${process.pid}/border`, border);
      this.label(`p/${process.pid}/label`, new THREE.Vector3(x, y + .3, z), isSelected ? 6 : 5, isSelected ? 'label-selected' : '');
      if (process.status === 'zombie') return;
      const pageTableSelected = this.selectedStructure?.pid === process.pid && this.selectedStructure.part === 'page_table';
      const pageTable = this.makeBox(`p/${process.pid}/page-table`, 5.8, .025, 2.35, pageTableSelected ? 0xffd779 : 0xa686d8, pageTableSelected ? .75 : .3);
      pageTable.position.set(x, y - .15, z);
      pageTable.userData.selection = { kind: 'structure', pid: process.pid, part: 'page_table', index: 0 } satisfies SceneSelection;
      this.pickables.push(pageTable);
      process.descriptors.forEach((descriptor, index) => {
        const point = objectPositions.get(descriptor.objectId);
        const object = world.kernelObjects.find(item => item.id === descriptor.objectId);
        if (point && object) {
          const cableSelected = this.selectedStructure?.pid === process.pid && this.selectedStructure.part === 'cable' && this.selectedStructure.index === index;
          const cable = this.addCable(`p/${process.pid}/cable/${index}`, new THREE.Vector3(x - 2.35 + index * .2, y, z - 1.1), point.clone().setY(point.y + .18), object.kind === 'socket' ? 0x65dfcb : 0xf7bc79, cableSelected || this.selectedObjectId === object.id);
          cable.parts.forEach(part => {
            part.userData.selection = { kind: 'structure', pid: process.pid, part: 'cable', index } satisfies SceneSelection;
            this.pickables.push(part);
          });
          this.label(`p/${process.pid}/cable/${index}/label`, cable.labelPoint, 3, 'scene-label-small');
        }
      });
      const spindleX = (slot: number) => x + 2.42 - slot * .18;
      process.threadIds.forEach((tid, index) => {
        if (index >= spindleSlots) return;
        const threadSelected = this.selectedStructure?.pid === process.pid && this.selectedStructure.part === 'thread' && this.selectedStructure.index === index;
        const spindle = new THREE.Mesh(new THREE.CylinderGeometry(threadSelected ? .08 : .045, .065, .38, 6), new THREE.MeshStandardMaterial({ color: threadSelected ? 0xffffff : 0xffe18c, emissive: 0xa46b2f, emissiveIntensity: threadSelected ? .65 : .2 }));
        spindle.position.set(spindleX(index), y + .29, z + .6);
        spindle.userData.selection = { kind: 'structure', pid: process.pid, part: 'thread', index } satisfies SceneSelection;
        this.add(`p/${process.pid}/thread/${index}`, spindle);
        this.pickables.push(spindle);
        this.label(`p/${process.pid}/thread/${index}/label`, new THREE.Vector3(spindleX(index), y + .55, z + .6), 3, 'scene-label-small');
      });
      // A lock whose owner did not survive fork is labelled where that thread's spindle would stand, dashed like anything else absent.
      // It is the point of the thread scenario, so it outranks the spindle labels beside it.
      [...absentOwners(process).keys()].forEach((tid, offset) =>
        this.label(`p/${process.pid}/absent/${tid}/label`, new THREE.Vector3(spindleX(Math.min(process.threadIds.length, spindleSlots) + offset), y + .55, z + .6), 4, 'scene-label-small label-absent'));
      if (world.processes.length > 1) {
        for (let layer = 0; layer < 3; layer++) {
          const stack = this.makeBox(`p/${process.pid}/stack/${layer}`, .38, .12, .3, this.selectedStructure?.pid === process.pid && this.selectedStructure.part === 'stack' ? 0xffffff : layer === 2 ? 0xffdc89 : 0x89c7dc);
          stack.position.set(x + 2.36, y + .22 + layer * .14, z - .55);
          stack.userData.selection = { kind: 'structure', pid: process.pid, part: 'stack', index: 0 } satisfies SceneSelection;
          this.pickables.push(stack);
        }
        this.label(`p/${process.pid}/stack/label`, new THREE.Vector3(x + 2.35, y + .78, z - .55), 4, 'scene-label-small');
      }
      // Every mapped page gets a tile; a page with no frame behind it is a faint tile with no filament.
      const mappedPages = process.regions.flatMap(region => Array.from({ length: region.pageCount }, (_, offset) => region.startPage + offset))
        .sort((a, b) => a - b).map(pageIndex => ({ frameId: process.pages[pageIndex] ?? null, pageIndex }));
      if (mappedPages.length > 24) this.label(`p/${process.pid}/overflow-label`, new THREE.Vector3(x, y + .3, z + .9), 0, 'scene-label-small');
      const filamentMiddles: THREE.Vector3[] = [];
      let tracedMiddle: THREE.Vector3 | undefined;
      mappedPages.slice(0, 24).forEach(({ frameId, pageIndex }, visualIndex) => {
        const offset = deckTileOffset(visualIndex, mappedPages.length);
        const px = x + offset.x;
        const pz = z + offset.z;
        const tile = frameId === null ? this.makeBox(`p/${process.pid}/page/${pageIndex}`, .62, .06, offset.depth, 0x6c6697, .1) : this.makeBox(`p/${process.pid}/page/${pageIndex}`, .62, .1, offset.depth, sharers(world, frameId) > 1 ? 0xbdadef : color);
        tile.position.set(px, y + .15, pz);
        if (frameId === null) {
          const outline = new THREE.LineSegments(new THREE.EdgesGeometry(tile.geometry), new THREE.LineDashedMaterial({ color: 0xe2dcff, dashSize: .07, gapSize: .05, transparent: true, opacity: .85 }));
          outline.computeLineDistances();
          outline.position.copy(tile.position);
          this.add(`p/${process.pid}/page/${pageIndex}/outline`, outline);
        }
        tile.userData.selection = { kind: 'page', pid: process.pid, page: pageIndex } satisfies SceneSelection;
        this.pickables.push(tile);
        const pageSelected = this.selectedPage?.pid === process.pid && this.selectedPage.page === pageIndex;
        const traced = frameId !== null && frameId === tracedFrame;
        if (pageSelected || traced) {
          const edge = new THREE.LineSegments(new THREE.EdgesGeometry(tile.geometry), new THREE.LineBasicMaterial({ color: 0xffe794 }));
          edge.position.copy(tile.position);
          this.add(`p/${process.pid}/page/${pageIndex}/edge`, edge);
        }
        const floor = frameId === null ? undefined : framePositions.get(frameId);
        if (floor) {
          const start = new THREE.Vector3(px, y, pz), end = new THREE.Vector3(floor.x, .18, floor.z);
          const filament = this.addLine(`p/${process.pid}/page/${pageIndex}/filament`, start, end, traced ? 0xffffff : color, traced ? 1 : isSelected ? .6 : .22);
          filament.userData.selection = { kind: 'page', pid: process.pid, page: pageIndex } satisfies SceneSelection;
          this.pickables.push(filament);
          const middle = start.clone().lerp(end, .5);
          filamentMiddles.push(middle);
          if (pageSelected) tracedMiddle = middle;
        }
      });
      // Name the selected process's filaments where they hang, on the traced one when a page is selected.
      if (isSelected && filamentMiddles.length) this.label(`p/${process.pid}/filament-label`, tracedMiddle ?? filamentMiddles[Math.floor(filamentMiddles.length / 2)], 3.5, 'scene-label-small');
    });
  }

  private pick(event: MouseEvent) {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables);
    // Thin filaments are easy to graze, so a solid object under the pointer wins over them.
    const hit = hits.find(item => !(item.object instanceof THREE.Line)) ?? hits[0];
    return hit?.object.userData.selection as SceneSelection | undefined;
  }

  private pointerDown = (event: PointerEvent) => { this.pressedAt = [event.clientX, event.clientY]; };
  private hover = (event: PointerEvent) => {
    if (event.buttons) return;
    this.renderer.domElement.style.cursor = this.pick(event) ? 'pointer' : '';
  };

  private click = (event: MouseEvent) => {
    // Releasing an orbit drag also fires click; only a press that stayed put selects.
    if (this.pressedAt && Math.hypot(event.clientX - this.pressedAt[0], event.clientY - this.pressedAt[1]) > 5) return;
    const selection = this.pick(event);
    if (selection) this.onSelect?.(selection);
  };

  private renderFrame = () => {
    const width = this.host.clientWidth, height = this.host.clientHeight, gap = 2;
    // Read every label size before moving any, so layout runs once per frame.
    const sizes = this.targets.map(({ element }) => [element.offsetWidth, element.offsetHeight]);
    const placed: LabelBox[] = [];
    const overlaps = (a: LabelBox, b: LabelBox) => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top;
    this.targets.forEach(({ element, point }, index) => {
      const p = point.clone().project(this.camera);
      const x = (p.x * .5 + .5) * width, y = (-p.y * .5 + .5) * height;
      const [labelWidth, labelHeight] = sizes[index];
      // Labels sit centred above their anchor, nudged inside the scene edges. If that spot is taken, try just below the anchor.
      const centre = Math.min(Math.max(x, labelWidth / 2 + gap), width - labelWidth / 2 - gap);
      const box = p.z <= 1 && x >= 0 && x <= width && y >= 0 && y <= height
        ? [Math.max(y, labelHeight + gap), Math.min(y + labelHeight + gap, height - gap)]
          .map(bottom => ({ left: centre - labelWidth / 2, top: bottom - labelHeight, right: centre + labelWidth / 2, bottom }))
          .find(candidate => !placed.some(other => overlaps(candidate, other)))
        : undefined;
      element.style.visibility = box ? '' : 'hidden';
      if (!box) return;
      placed.push(box);
      element.style.left = `${centre}px`;
      element.style.top = `${box.bottom}px`;
    });
    this.renderer.render(this.scene, this.camera);
    if (this.controls.enableDamping && !this.pendingFrame) {
      this.pendingFrame = requestAnimationFrame(() => { this.pendingFrame = 0; this.controls.update(); });
    }
  };

  private clearLabels() {
    this.labels.forEach(label => label.remove());
    this.labels = [];
    this.targets = [];
  }

  dispose() {
    cancelAnimationFrame(this.pendingFrame);
    this.settle?.();
    this.resizeObserver.disconnect();
    document.fonts.removeEventListener('loadingdone', this.renderFrame);
    this.motionPreference.removeEventListener('change', this.updateMotion);
    this.controls.removeEventListener('change', this.renderFrame);
    this.clearLabels();
    [...this.dynamic.children].forEach(disposeObject);
    this.dynamic.clear();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.removeEventListener('pointermove', this.hover);
    this.renderer.domElement.removeEventListener('click', this.click);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
