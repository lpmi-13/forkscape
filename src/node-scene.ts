import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { counterRate, type NodeCapture } from './node-capture';

type Metric = { label: string; color: number; values: (number | null)[] };
type Station = { label: string; unit: string; scale: number; metrics: Metric[]; position: [number, number] };
type DrawnStation = { station: Station; bars: { mesh: THREE.Mesh; metric: Metric }[] };
const mib = (bytes: number | null) => bytes === null ? null : bytes / 1048576;
const mcpu = (nanocores: number | null) => nanocores === null ? null : nanocores / 1000000;
const kib = (bytes: number | null) => bytes === null ? null : bytes / 1024;
const format = (value: number | null, unit: string) => value === null ? '—' : `${value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString()} ${unit}`;
const roundScale = (value: number) => {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value)) / 2;
  return Math.ceil(value / step) * step;
};

/** Five measured metric stations. Each uses its own fixed scale across the recording. */
export class NodeAggregateScene {
  readonly scaleText: string;
  private readonly host: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, .1, 300);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private readonly stations: DrawnStation[] = [];
  private readonly direction = new THREE.Vector3(13.5, 8.5, 11).normalize();

  constructor(host: HTMLElement, capture: NodeCapture) {
    this.host = host;
    const samples = capture.samples;
    const station = (label: string, unit: string, metrics: Metric[]): Station => {
      let max = 0;
      for (const metric of metrics) for (const value of metric.values) max = Math.max(max, value ?? 0);
      return { label, unit, metrics, scale: roundScale(max), position: [0, 0] };
    };
    const specs = [
      station('Node memory', 'MiB', [
        { label: 'RSS', color: 0xffc675, values: samples.map(item => mib(item.data.node.memoryRssBytes)) },
        { label: 'Working set', color: 0xeaa6e8, values: samples.map(item => mib(item.data.node.memoryWorkingSetBytes)) },
      ]),
      ...(samples.some(item => (item.data.pod?.memoryRssBytes ?? 0) > 0 || (item.data.pod?.memoryWorkingSetBytes ?? 0) > 0) ? [station('Target Pod memory', 'MiB', [
        { label: 'RSS', color: 0x8fe7b1, values: samples.map(item => mib(item.data.pod?.memoryRssBytes ?? null)) },
        { label: 'Working set', color: 0x71c9f4, values: samples.map(item => mib(item.data.pod?.memoryWorkingSetBytes ?? null)) },
      ])] : []),
      station('CPU', 'mCPU', [
        { label: 'Node', color: 0xffc675, values: samples.map(item => mcpu(item.data.node.cpuUsageNanoCores)) },
        { label: 'Target Pod', color: 0x8fe7b1, values: samples.map(item => mcpu(item.data.pod?.cpuUsageNanoCores ?? null)) },
      ]),
      station('Page faults', 'faults/s', [
        { label: 'All', color: 0xffc675, values: samples.map((_, index) => counterRate(samples, index, 'pageFaults')) },
        { label: 'Major', color: 0xff91a6, values: samples.map((_, index) => counterRate(samples, index, 'majorPageFaults')) },
      ]),
      station('Network', 'KiB/s', [
        { label: 'Receive', color: 0x93dfff, values: samples.map((_, index) => kib(counterRate(samples, index, 'networkRxBytes'))) },
        { label: 'Transmit', color: 0x8fe7b1, values: samples.map((_, index) => kib(counterRate(samples, index, 'networkTxBytes'))) },
      ]),
    ];
    const positions: [number, number][] = specs.length === 5
      ? [[-4.45, -2.1], [0, -2.1], [4.45, -2.1], [-2.2, 2], [2.2, 2]]
      : [[-3.5, -2.1], [3.5, -2.1], [-3.5, 2], [3.5, 2]];
    specs.forEach((item, index) => { item.position = positions[index]; });
    this.scaleText = specs.map(item => `${item.label}: 0–${format(item.scale, item.unit)}`).join(' · ');

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'capture-3d-canvas';
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.setAttribute('aria-label', '3D measured node telemetry: separate fixed-scale columns for node and Pod memory, CPU, page-fault rate, and network throughput.');
    host.append(this.renderer.domElement);
    this.labels.domElement.className = 'capture-3d-label-layer';
    host.append(this.labels.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.maxPolarAngle = Math.PI * .49;
    this.controls.addEventListener('change', this.draw);

    this.scene.fog = new THREE.Fog(0x1b1838, 36, 95);
    this.scene.add(new THREE.HemisphereLight(0xc8e9ff, 0x593355, 2.3));
    const sun = new THREE.DirectionalLight(0xffdeb0, 2.5);
    sun.position.set(4, 10, 6);
    this.scene.add(sun);
    const fill = new THREE.PointLight(0x6deed4, 28, 20);
    fill.position.set(-5, 4, 2);
    this.scene.add(fill);

    const base = this.box(14.4, .25, 9.4, 0x563757);
    base.position.y = -.27;
    this.scene.add(base);
    const ground = this.box(14.15, .06, 9.15, 0x222b50);
    ground.position.y = -.12;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(1, 20, 0x54cfbd, 0x466786);
    grid.scale.set(14, 1, 9);
    grid.position.y = -.07;
    this.scene.add(grid);

    specs.forEach((item, index) => {
      const group = new THREE.Group();
      group.position.set(item.position[0], 0, item.position[1]);
      this.scene.add(group);
      const platform = this.box(3.75, .18, 2.6, 0x344f67);
      platform.position.y = .13;
      group.add(platform);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(platform.geometry), new THREE.LineBasicMaterial({ color: 0xa9e5d5, transparent: true, opacity: .75 }));
      edge.position.copy(platform.position);
      group.add(edge);
      const title = this.textLabel(item.label, 'capture-3d-deck-label');
      title.element.dataset.slot = String(index + 1);
      title.position.set(0, .36, 1.04);
      group.add(title);
      const bars = item.metrics.map((metric, metricIndex) => {
        const mesh = this.box(.92, 1, .82, metric.color);
        mesh.position.x = metricIndex === 0 ? -.8 : .8;
        mesh.visible = false;
        group.add(mesh);
        return { mesh, metric };
      });
      this.stations.push({ station: item, bars });
    });
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(host);
    this.resize();
  }

  private box(width: number, height: number, depth: number, color: number) {
    return new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .1, metalness: .14, roughness: .55 }));
  }

  private textLabel(text: string, className: string) {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return new CSS2DObject(element);
  }

  update(index: number) {
    for (const { station, bars } of this.stations) for (const { mesh, metric } of bars) {
      const amount = metric.values[index];
      const height = amount === null ? 0 : amount / station.scale * 2.2;
      mesh.visible = amount !== null && amount > 0;
      mesh.scale.y = Math.max(height, .001);
      mesh.position.y = .23 + height / 2;
    }
    this.host.dataset.sampleIndex = String(index);
    this.draw();
  }

  private resize = () => {
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.fov = width / height >= 1.3 ? 38 : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(19)) * 1.3 * height / width));
    this.camera.updateProjectionMatrix();
    const centre = new THREE.Vector3(0, 1.55, 0);
    const right = new THREE.Vector3().crossVectors(THREE.Object3D.DEFAULT_UP, this.direction).normalize();
    const up = new THREE.Vector3().crossVectors(this.direction, right);
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)), tanX = tanY * this.camera.aspect;
    let distance = 0;
    for (const x of [-7.25, 7.25]) for (const y of [-.4, 3.7]) for (const z of [-4.75, 4.75]) {
      const offset = new THREE.Vector3(x, y, z).sub(centre);
      distance = Math.max(distance, offset.dot(this.direction) + Math.abs(offset.dot(right)) / tanX, offset.dot(this.direction) + Math.abs(offset.dot(up)) / tanY);
    }
    distance *= 1.08;
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
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
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
