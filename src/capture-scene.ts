import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Capture, CaptureProcess, CaptureSample } from './capture';

type Metric = 'rssKiB' | 'pssKiB' | 'ussKiB';
type Column = { mesh: THREE.Mesh; label: CSS2DObject; metric: Metric };
type ProcessDeck = {
  process: CaptureProcess;
  group: THREE.Group;
  platform: THREE.Mesh;
  edge: THREE.LineSegments;
  label: CSS2DObject;
  columns: Column[];
};

const metrics: { key: Metric; color: number }[] = [
  { key: 'rssKiB', color: 0xffc675 },
  { key: 'pssKiB', color: 0xeaa6e8 },
  { key: 'ussKiB', color: 0x7dd9d2 },
];
const processBarHeight = 1.5;
const cgroupBarHeight = 2.2;
const identity = (process: CaptureProcess) => `${process.pid}/${process.startTicks}`;
const ceiling = (maxKiB: number) => Math.max(8, Math.ceil(maxKiB / 1024 / 8) * 8);
const valueText = (kiB: number | null) => kiB === null ? '—' : `${(kiB / 1024).toFixed(1)} MiB`;

/** The capture only has aggregate measurements. Its decks share the scenario's stage language, but contain measured columns instead of invented pages or frames. */
export class CaptureAggregateScene {
  readonly processCeilingMiB: number;
  readonly cgroupCeilingMiB: number;
  private readonly host: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, .1, 300);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private readonly decks = new Map<string, ProcessDeck>();
  private readonly cgroupColumn: THREE.Mesh;
  private readonly cgroupValue: CSS2DObject;
  private readonly stageWidth: number;
  private readonly stageDepth: number;
  private readonly direction = new THREE.Vector3(13.5, 7.3, 9.5).normalize();

  constructor(host: HTMLElement, capture: Capture) {
    this.host = host;
    const processes = new Map<string, CaptureProcess>();
    let maxProcessKiB = 0;
    let maxCgroupKiB = 0;
    for (const sample of capture.samples) {
      for (const process of sample.data.processes) {
        if (!processes.has(identity(process))) processes.set(identity(process), process);
        for (const metric of metrics) maxProcessKiB = Math.max(maxProcessKiB, process[metric.key] ?? 0);
      }
      maxCgroupKiB = Math.max(maxCgroupKiB, (sample.data.cgroup.memoryCurrentBytes ?? 0) / 1024);
    }
    this.processCeilingMiB = ceiling(maxProcessKiB);
    this.cgroupCeilingMiB = ceiling(maxCgroupKiB);
    const ordered = [...processes.values()].sort((a, b) => Number(b.role.toLowerCase() === 'master') - Number(a.role.toLowerCase() === 'master'));
    const hasMaster = ordered[0]?.role.toLowerCase() === 'master';
    const workers = hasMaster ? ordered.length - 1 : ordered.length;
    const columns = Math.min(3, Math.max(1, workers));
    const rows = Math.max(1, Math.ceil(workers / columns));
    this.stageWidth = Math.max(11.5, columns * 5.2 + .8);
    this.stageDepth = 10 + (rows - 1) * 3;

    // Construct the WebGL context first so the caller can fall back to the table if it is unavailable.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'capture-3d-canvas';
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.setAttribute('aria-label', '3D scene of raised process decks showing measured RSS, PSS, and approximate USS, with cgroup memory charge shown separately on the floor.');
    host.append(this.renderer.domElement);
    this.labels.domElement.className = 'capture-3d-label-layer';
    host.append(this.labels.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.maxPolarAngle = Math.PI * .49;
    this.controls.addEventListener('change', this.draw);

    this.scene.fog = new THREE.Fog(0x1b1838, 35, 90);
    this.scene.add(new THREE.HemisphereLight(0xc8e9ff, 0x593355, 2.3));
    const sun = new THREE.DirectionalLight(0xffdeb0, 2.5);
    sun.position.set(4, 10, 6);
    this.scene.add(sun);
    const fill = new THREE.PointLight(0x6deed4, 28, 20);
    fill.position.set(-5, 4, 2);
    this.scene.add(fill);

    const base = this.box(this.stageWidth, .25, this.stageDepth, 0x563757);
    base.position.y = -.27;
    this.scene.add(base);
    const ground = this.box(this.stageWidth - .25, .06, this.stageDepth - .25, 0x222b50);
    ground.position.y = -.12;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(1, 20, 0x54cfbd, 0x466786);
    grid.scale.set(this.stageWidth - .4, 1, this.stageDepth - .4);
    grid.position.y = -.07;
    this.scene.add(grid);
    const membrane = new THREE.Mesh(
      new THREE.BoxGeometry(this.stageWidth - .55, .035, this.stageDepth - .55),
      new THREE.MeshBasicMaterial({ color: 0xb77bee, transparent: true, opacity: .14, depthWrite: false }),
    );
    membrane.position.y = 1.6;
    this.scene.add(membrane);

    ordered.forEach((process, index) => {
      const group = new THREE.Group();
      if (hasMaster && index === 0) group.position.set(0, 3.8, -this.stageDepth / 2 + 1.4);
      else {
        const workerIndex = index - Number(hasMaster);
        const row = Math.floor(workerIndex / columns);
        const inRow = Math.min(columns, workers - row * columns);
        group.position.set((workerIndex % columns - (inRow - 1) / 2) * 5.2, 3.05, .4 - 1.5 * (rows - 1) + row * 3);
      }
      this.scene.add(group);
      const color = hasMaster && index === 0 ? 0xffc675 : [0x64debc, 0x93dfff, 0xff91a6, 0xf7bc79][index % 4];
      const platform = new THREE.Mesh(
        new THREE.BoxGeometry(4.65, .18, 1.85),
        new THREE.MeshStandardMaterial({ color, metalness: .12, roughness: .65, transparent: true, opacity: .43, depthWrite: false }),
      );
      group.add(platform);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(platform.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: .8 }));
      group.add(edge);
      const label = this.textLabel(`${process.role} · PID ${process.pid}`, 'capture-3d-deck-label');
      label.element.dataset.slot = String(index + 1);
      label.position.set(0, .36, 1.12);
      group.add(label);
      const metricColumns = metrics.map((metric, metricIndex): Column => {
        const x = (metricIndex - 1) * 1.35;
        const mesh = this.bar(metric.color, .85);
        mesh.position.x = x;
        group.add(mesh);
        const value = this.textLabel('—', 'capture-3d-value');
        value.position.set(x, .5, 0);
        group.add(value);
        return { mesh, label: value, metric: metric.key };
      });
      this.decks.set(identity(process), { process, group, platform, edge, label, columns: metricColumns });
    });

    const cgroup = new THREE.Group();
    cgroup.position.set(0, .22, this.stageDepth / 2 - 1.35);
    this.scene.add(cgroup);
    const cgroupPlatform = this.box(3.2, .2, 1.85, 0x345f69);
    cgroup.add(cgroupPlatform);
    const cgroupLabel = this.textLabel('Cgroup charge', 'capture-3d-deck-label capture-3d-cgroup-label');
    cgroupLabel.element.dataset.slot = String(ordered.length + 1);
    cgroupLabel.position.set(0, .3, 1.15);
    cgroup.add(cgroupLabel);
    this.cgroupColumn = this.bar(0x8fe7b1, 1.1);
    cgroup.add(this.cgroupColumn);
    this.cgroupValue = this.textLabel('—', 'capture-3d-value');
    cgroup.add(this.cgroupValue);

    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(host);
    this.resize();
  }

  private box(width: number, height: number, depth: number, color: number) {
    return new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color, metalness: .15, roughness: .72 }));
  }

  private bar(color: number, width: number) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, 1, .75),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .12, metalness: .14, roughness: .5 }),
    );
    mesh.visible = false;
    return mesh;
  }

  private textLabel(text: string, className: string) {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return new CSS2DObject(element);
  }

  private setColumn(mesh: THREE.Mesh, label: CSS2DObject, value: number | null, maxMiB: number, maxHeight: number) {
    mesh.visible = value !== null && value > 0;
    const height = value === null ? 0 : value / 1024 / maxMiB * maxHeight;
    mesh.scale.y = Math.max(height, .001);
    mesh.position.y = .2 + height / 2;
    label.element.textContent = valueText(value);
    label.element.hidden = value === null;
    label.position.set(mesh.position.x, .2 + height + .22, 0);
  }

  update(sample: CaptureSample, sampleIndex: number) {
    const present = new Map(sample.processes.map(process => [identity(process), process]));
    for (const [key, deck] of this.decks) {
      const process = present.get(key);
      deck.label.element.textContent = `${deck.process.role} · PID ${deck.process.pid}${process ? '' : ' · absent'}`;
      deck.label.element.classList.toggle('is-absent', !process);
      (deck.platform.material as THREE.MeshStandardMaterial).opacity = process ? .43 : .08;
      (deck.edge.material as THREE.LineBasicMaterial).opacity = process ? .8 : .22;
      for (const column of deck.columns) this.setColumn(column.mesh, column.label, process?.[column.metric] ?? null, this.processCeilingMiB, processBarHeight);
    }
    this.setColumn(this.cgroupColumn, this.cgroupValue,
      sample.cgroup.memoryCurrentBytes === null ? null : sample.cgroup.memoryCurrentBytes / 1024,
      this.cgroupCeilingMiB, cgroupBarHeight);
    this.host.dataset.sampleIndex = String(sampleIndex);
    this.draw();
  }

  private resize = () => {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    // Widen the vertical field on narrow screens, as the scenario camera does.
    const fov = 38;
    this.camera.fov = width / height >= 1.3 ? fov : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * 1.3 * height / width));
    this.camera.updateProjectionMatrix();
    const centre = new THREE.Vector3(0, 2.6, 0);
    const right = new THREE.Vector3().crossVectors(THREE.Object3D.DEFAULT_UP, this.direction).normalize();
    const up = new THREE.Vector3().crossVectors(this.direction, right);
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tanX = tanY * this.camera.aspect;
    let distance = 0;
    for (const x of [-this.stageWidth / 2, this.stageWidth / 2]) {
      for (const y of [-.4, 6.3]) {
        for (const z of [-this.stageDepth / 2, this.stageDepth / 2]) {
          const offset = new THREE.Vector3(x, y, z).sub(centre);
          distance = Math.max(distance, offset.dot(this.direction) + Math.abs(offset.dot(right)) / tanX, offset.dot(this.direction) + Math.abs(offset.dot(up)) / tanY);
        }
      }
    }
    distance *= 1.12;
    this.controls.minDistance = distance * .45;
    this.controls.maxDistance = distance * 1.6;
    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(this.direction, distance);
    this.controls.update();
    this.renderer.setSize(width, height, false);
    this.labels.setSize(width, height);
    this.draw();
  };

  private draw = () => {
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  dispose() {
    this.observer.disconnect();
    this.controls.removeEventListener('change', this.draw);
    this.controls.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        geometries.add(object.geometry);
        const material = object.material;
        if (Array.isArray(material)) material.forEach(item => materials.add(item));
        else materials.add(material);
      }
    });
    geometries.forEach(item => item.dispose());
    materials.forEach(item => item.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
