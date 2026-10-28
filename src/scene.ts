import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { WorldState } from './model';
import { sharers } from './model';

const palette = [0x64debc, 0xb193fa, 0xff91a6, 0x93dfff];
export type StructurePart = 'cable' | 'page_table' | 'thread' | 'stack';
export type SceneSelection = { kind: 'process'; pid: number } | { kind: 'page'; pid: number; page: number } | { kind: 'frame'; frameId: number } | { kind: 'object'; objectId: string } | { kind: 'structure'; pid: number; part: StructurePart; index: number };

export class ForkScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private controls: OrbitControls;
  private dynamic = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pickables: THREE.Object3D[] = [];
  private resizeObserver: ResizeObserver;
  private pendingFrame = 0;
  private motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  private labels: HTMLDivElement[] = [];
  private targets: { element: HTMLDivElement; point: THREE.Vector3 }[] = [];
  private currentWorld?: WorldState;
  private selectedPid = 4100;
  private onSelect?: (selection: SceneSelection) => void;
  private selectedPage: { pid: number; page: number } | null = null;
  private selectedFrame: number | null = null;
  private selectedObjectId: string | null = null;
  private selectedStructure: { pid: number; part: StructurePart; index: number } | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    const sky = document.createElement('canvas');
    sky.width = 1024;
    sky.height = 512;
    const context = sky.getContext('2d');
    if (context) {
      const dusk = context.createLinearGradient(0, 0, 0, sky.height);
      dusk.addColorStop(0, '#252044');
      dusk.addColorStop(.55, '#47365e');
      dusk.addColorStop(1, '#193d4b');
      context.fillStyle = dusk;
      context.fillRect(0, 0, sky.width, sky.height);
      const glow = context.createRadialGradient(735, 132, 12, 735, 132, 220);
      glow.addColorStop(0, '#f7be9277');
      glow.addColorStop(1, '#f7be9200');
      context.fillStyle = glow;
      context.fillRect(470, 0, 520, 390);
      context.fillStyle = '#ffd28e9c';
      context.beginPath();
      context.arc(735, 132, 37, 0, Math.PI * 2);
      context.fill();
      const buildings = [
        [0, 78, 150], [64, 70, 110], [124, 63, 175], [184, 90, 128],
        [262, 61, 203], [321, 72, 144], [389, 81, 178], [468, 59, 120],
        [520, 91, 208], [604, 69, 147], [669, 83, 180], [747, 60, 132],
        [804, 93, 194], [889, 65, 138], [949, 79, 169],
      ];
      context.globalAlpha = .5;
      for (const [x, width, height] of buildings) {
        const top = sky.height - height;
        context.fillStyle = '#15233f';
        context.fillRect(x, top, width, height);
        context.fillStyle = '#e381bd';
        context.fillRect(x, top, width, 2);
        context.fillStyle = '#75d8d0';
        for (let wx = x + 8; wx < x + width - 5; wx += 13) {
          for (let wy = top + 12; wy < sky.height - 8; wy += 17) {
            if ((wx + wy) % 4 !== 0) context.fillRect(wx, wy, 3, 5);
          }
        }
      }
      context.globalAlpha = 1;
      const texture = new THREE.CanvasTexture(sky);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = texture;
    } else {
      this.scene.background = new THREE.Color(0x252044);
    }
    this.scene.fog = new THREE.Fog(0x1b1838, 15, 30);
    this.camera.position.set(9.5, 8.5, 13.5);
    this.camera.lookAt(0, 1.4, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.2, 0);
    this.controls.enableDamping = true;
    this.controls.enableDamping = !this.motionPreference.matches;
    this.motionPreference.addEventListener('change', this.updateMotion);
    this.controls.addEventListener('change', this.renderFrame);
    this.controls.minDistance = 8;
    this.controls.maxDistance = 25;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.update();
    this.scene.add(new THREE.HemisphereLight(0xc8e9ff, 0x593355, 2.3));
    const sun = new THREE.DirectionalLight(0xffdeb0, 2.5);
    sun.position.set(4, 10, 6);
    this.scene.add(sun);
    const neon = new THREE.PointLight(0x6deed4, 28, 16);
    neon.position.set(-5, 4, 2);
    this.scene.add(neon);
    this.scene.add(this.dynamic);
    this.raycaster.params.Line.threshold = .12;
    this.renderer.domElement.addEventListener('click', this.click);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(host);
    this.resize();
  }

  setWorld(world: WorldState, selectedPid: number, selectedPage: { pid: number; page: number } | null, selectedFrame: number | null, selectedObjectId: string | null, selectedStructure: { pid: number; part: StructurePart; index: number } | null, onSelect: (selection: SceneSelection) => void) {
    this.currentWorld = world;
    this.selectedPid = selectedPid;
    this.selectedPage = selectedPage;
    this.selectedFrame = selectedFrame;
    this.selectedObjectId = selectedObjectId;
    this.selectedStructure = selectedStructure;
    this.onSelect = onSelect;
    this.clear();
    this.build();
    this.renderFrame();
  }

  setCameraPreset(preset: 'overview' | 'process' | 'memory') {
    if (preset === 'memory') { this.camera.position.set(6, 4, 8); this.controls.target.set(0, .2, 0); }
    else if (preset === 'process') { this.camera.position.set(5, 6, 8); this.controls.target.set(0, 2.7, 0); }
    else { this.camera.position.set(9.5, 8.5, 13.5); this.controls.target.set(0, 1.2, 0); }
    this.controls.update();
  }

  setZoom(closer: boolean) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() * (closer ? .8 : 1.25), this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target.clone().add(offset.setLength(distance)));
    this.controls.update();
  }

  private resize = () => {
    const width = Math.max(this.host.clientWidth, 1), height = Math.max(this.host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderFrame();
  };

  private updateMotion = () => {
    this.controls.enableDamping = !this.motionPreference.matches;
    this.controls.update();
  };

  private makeBox(width: number, height: number, depth: number, color: number, opacity = 1) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: opacity > .8 ? .1 : .025, transparent: opacity < 1, opacity, roughness: .65, metalness: .08 }));
    this.dynamic.add(mesh);
    return mesh;
  }

  private addLine(a: THREE.Vector3, b: THREE.Vector3, color: number, opacity = .48) {
    const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    this.dynamic.add(line);
    return line;
  }

  private label(text: string, point: THREE.Vector3, className = '') {
    const element = document.createElement('div');
    element.className = `scene-label ${className}`;
    element.textContent = text;
    this.host.appendChild(element);
    this.labels.push(element);
    this.targets.push({ element, point });
  }

  private build() {
    const world = this.currentWorld;
    if (!world) return;
    const base = this.makeBox(11.3, .25, 7.8, 0x563757);
    base.position.y = -.23;
    const ground = this.makeBox(11, .08, 7.5, 0x222b50);
    ground.position.y = -.12;
    const membrane = this.makeBox(10.6, .035, 7.1, 0xb77bee, .22);
    membrane.position.y = 1.15;
    const grid = new THREE.GridHelper(10, 20, 0x54cfbd, 0x466786);
    grid.position.y = -.07;
    this.dynamic.add(grid);
    this.label('PHYSICAL FRAMES', new THREE.Vector3(-4.7, .02, 3.25), 'scene-label-small');
    this.label('KERNEL · PAGE TABLES', new THREE.Vector3(-4.65, 1.18, 3.15), 'scene-label-small');

    const objectPositions = new Map<string, THREE.Vector3>();
    world.kernelObjects.forEach((object, index) => {
      const x = -3.6 + index * 1.5, z = -3.15;
      const buoy = new THREE.Mesh(new THREE.CylinderGeometry(.28, .38, .36, 8), new THREE.MeshStandardMaterial({
        color: object.kind === 'socket' ? 0x65dfcb : 0xf7bc79,
        emissive: object.kind === 'socket' ? 0x2a9a86 : 0x9d6131,
        emissiveIntensity: this.selectedObjectId === object.id ? .6 : .18,
      }));
      buoy.position.set(x, 1.46, z);
      buoy.userData.selection = { kind: 'object', objectId: object.id } satisfies SceneSelection;
      this.dynamic.add(buoy);
      this.pickables.push(buoy);
      objectPositions.set(object.id, buoy.position.clone());
      this.label(`${object.kind.toUpperCase()} · ${object.id}`, new THREE.Vector3(x, 1.82, z), 'scene-label-small');
    });

    const framePositions = new Map<number, THREE.Vector3>();
    world.frames.forEach((frame, index) => {
      const x = (index % 6 - 2.5) * 1.22;
      const z = Math.floor(index / 6) * 1.28 - .5;
      const count = sharers(world, frame.id);
      const ownerIndex = world.processes.findIndex(p => p.pid === frame.owner);
      const color = count > 1 ? 0xb39cf3 : frame.owner === null ? 0x74dfad : palette[Math.max(ownerIndex, 0) % palette.length];
      const tile = this.makeBox(1.06, .2, 1.02, color, .97);
      tile.position.set(x, .08, z);
      tile.userData.selection = { kind: 'frame', frameId: frame.id } satisfies SceneSelection;
      this.pickables.push(tile);
      const tileEdge = new THREE.LineSegments(new THREE.EdgesGeometry(tile.geometry), new THREE.LineBasicMaterial({ color: count > 1 ? 0xf1b6ff : 0xd7ffb2, transparent: true, opacity: .75 }));
      tileEdge.position.copy(tile.position);
      this.dynamic.add(tileEdge);
      if (this.selectedFrame === frame.id) {
        const marker = new THREE.Mesh(new THREE.TorusGeometry(.59, .035, 4, 16), new THREE.MeshBasicMaterial({ color: 0xffe794 }));
        marker.rotation.x = -Math.PI / 2;
        marker.position.set(x, .23, z);
        this.dynamic.add(marker);
      }
      if (count > 1) {
        for (let ring = 0; ring < count; ring++) {
          const marker = new THREE.Mesh(new THREE.TorusGeometry(.34 + ring * .075, .018, 4, 12), new THREE.MeshBasicMaterial({ color: ring % 2 ? 0xffd37c : 0xff89d2 }));
          marker.rotation.x = -Math.PI / 2;
          marker.position.set(x, .21 + ring * .025, z);
          this.dynamic.add(marker);
        }
      }
      framePositions.set(frame.id, tile.position.clone());
      this.label(`F${frame.id} · ${count}`, new THREE.Vector3(x, .37, z), 'frame-label');
    });

    world.processes.forEach((process, processIndex) => {
      const x = process.role === 'master' ? 0 : processIndex === 1 ? -3.05 : 3.05;
      const z = process.role === 'master' ? -2.25 : 2.15;
      const y = process.role === 'master' ? 3.5 : 2.65;
      const isSelected = this.selectedPid === process.pid;
      const color = process.role === 'master' ? 0xffc66f : palette[processIndex % palette.length];
      const deck = this.makeBox(5.4, .17, 2.1, color, process.status === 'zombie' ? .23 : .38);
      deck.position.set(x, y, z);
      deck.userData.selection = { kind: 'process', pid: process.pid } satisfies SceneSelection;
      this.pickables.push(deck);
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(deck.geometry), new THREE.LineBasicMaterial({ color: isSelected ? 0xffecad : color, transparent: true, opacity: isSelected ? 1 : .78 }));
      border.position.copy(deck.position);
      this.dynamic.add(border);
      this.label(`${process.role.toUpperCase()} · PID ${process.pid}${process.status === 'zombie' ? ' · ZOMBIE' : ''}`, new THREE.Vector3(x, y + .3, z), isSelected ? 'label-selected' : '');
      if (process.status === 'zombie') return;
      const pageTableSelected = this.selectedStructure?.pid === process.pid && this.selectedStructure.part === 'page_table';
      const pageTable = this.makeBox(5.8, .025, 2.35, pageTableSelected ? 0xffd779 : 0xa686d8, pageTableSelected ? .75 : .3);
      pageTable.position.set(x, y - .15, z);
      pageTable.userData.selection = { kind: 'structure', pid: process.pid, part: 'page_table', index: 0 } satisfies SceneSelection;
      this.pickables.push(pageTable);
      process.descriptors.forEach((descriptor, index) => {
        const point = objectPositions.get(descriptor.objectId);
        if (point) {
          const cableSelected = this.selectedStructure?.pid === process.pid && this.selectedStructure.part === 'cable' && this.selectedStructure.index === index;
          const cable = this.addLine(new THREE.Vector3(x - 2.35 + index * .2, y, z - .7), point, cableSelected ? 0xffffff : 0xffd38d, cableSelected ? 1 : .7);
          cable.userData.selection = { kind: 'structure', pid: process.pid, part: 'cable', index } satisfies SceneSelection;
          this.pickables.push(cable);
        }
      });
      process.threadIds.forEach((tid, index) => {
        if (index > 3) return;
        const threadSelected = this.selectedStructure?.pid === process.pid && this.selectedStructure.part === 'thread' && this.selectedStructure.index === index;
        const spindle = new THREE.Mesh(new THREE.CylinderGeometry(threadSelected ? .08 : .045, .065, .38, 6), new THREE.MeshStandardMaterial({ color: threadSelected ? 0xffffff : 0xffe18c, emissive: 0xa46b2f, emissiveIntensity: threadSelected ? .65 : .2 }));
        spindle.position.set(x + 2.42 - index * .18, y + .29, z + .6);
        spindle.userData.selection = { kind: 'structure', pid: process.pid, part: 'thread', index } satisfies SceneSelection;
        this.dynamic.add(spindle);
        this.pickables.push(spindle);
      });
      if (world.processes.length > 1) {
        for (let layer = 0; layer < 3; layer++) {
          const stack = this.makeBox(.38, .12, .3, this.selectedStructure?.pid === process.pid && this.selectedStructure.part === 'stack' ? 0xffffff : layer === 2 ? 0xffdc89 : 0x89c7dc);
          stack.position.set(x + 2.36, y + .22 + layer * .14, z - .55);
          stack.userData.selection = { kind: 'structure', pid: process.pid, part: 'stack', index: 0 } satisfies SceneSelection;
          this.pickables.push(stack);
        }
        this.label(process.role === 'master' ? `fork() → ${world.processes.find(p => p.parentPid === process.pid)?.pid ?? 'PID'}` : 'fork() → 0',
          new THREE.Vector3(x + 2.35, y + .78, z - .55), 'scene-label-small');
      }
      const mappedPages = process.pages.flatMap((frameId, pageIndex) => frameId === null ? [] : [{ frameId, pageIndex }]);
      if (mappedPages.length > 12) this.label(`+${mappedPages.length - 12} pages · see flat view`, new THREE.Vector3(x, y + .3, z + .9), 'scene-label-small');
      mappedPages.slice(0, 12).forEach(({ frameId, pageIndex }, visualIndex) => {
        if (frameId === null) return;
        const px = x + (visualIndex % 6 - 2.5) * .79;
        const pz = z + (visualIndex < 6 ? -.45 : .45);
        const tile = this.makeBox(.62, .1, .7, sharers(world, frameId) > 1 ? 0xbdadef : color, .98);
        tile.position.set(px, y + .15, pz);
        tile.userData.selection = { kind: 'page', pid: process.pid, page: pageIndex } satisfies SceneSelection;
        this.pickables.push(tile);
        if (this.selectedPage?.pid === process.pid && this.selectedPage.page === pageIndex) {
          const edge = new THREE.LineSegments(new THREE.EdgesGeometry(tile.geometry), new THREE.LineBasicMaterial({ color: 0xffe794 }));
          edge.position.copy(tile.position);
          this.dynamic.add(edge);
        }
        const floor = framePositions.get(frameId);
        if (floor) this.addLine(new THREE.Vector3(px, y, pz), new THREE.Vector3(floor.x, .18, floor.z), color, isSelected ? .6 : .22);
      });
    });
  }

  private click = (event: MouseEvent) => {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables)[0];
    if (hit?.object.userData.selection) this.onSelect?.(hit.object.userData.selection as SceneSelection);
  };

  private renderFrame = () => {
    for (const { element, point } of this.targets) {
      const p = point.clone().project(this.camera);
      element.style.left = `${(p.x * .5 + .5) * this.host.clientWidth}px`;
      element.style.top = `${(-p.y * .5 + .5) * this.host.clientHeight}px`;
      element.style.display = p.z > 1 ? 'none' : '';
    }
    this.renderer.render(this.scene, this.camera);
    if (this.controls.enableDamping && !this.pendingFrame) {
      this.pendingFrame = requestAnimationFrame(() => { this.pendingFrame = 0; this.controls.update(); });
    }
  };

  private clear() {
    this.pickables = [];
    this.labels.forEach(label => label.remove());
    this.labels = [];
    this.targets = [];
    for (const child of [...this.dynamic.children]) {
      this.dynamic.remove(child);
      const object = child as THREE.Mesh | THREE.Line;
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material?.dispose());
    }
  }

  dispose() {
    cancelAnimationFrame(this.pendingFrame);
    this.resizeObserver.disconnect();
    this.motionPreference.removeEventListener('change', this.updateMotion);
    this.controls.removeEventListener('change', this.renderFrame);
    this.clear();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('click', this.click);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
