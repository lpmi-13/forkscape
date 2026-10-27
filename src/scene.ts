import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { WorldState } from './model';
import { sharers } from './model';

const palette = [0x64debc, 0xb193fa, 0xff91a6, 0x93dfff];

export class ForkScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private controls: OrbitControls;
  private dynamic = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pickables: THREE.Object3D[] = [];
  private frame = 0;
  private labels: HTMLDivElement[] = [];
  private targets: { element: HTMLDivElement; point: THREE.Vector3 }[] = [];
  private currentWorld?: WorldState;
  private selectedPid = 4100;
  private onSelect?: (pid: number) => void;

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
    this.renderer.domElement.addEventListener('click', this.click);
    new ResizeObserver(this.resize).observe(host);
    this.resize();
    this.animate();
  }

  setWorld(world: WorldState, selectedPid: number, onSelect: (pid: number) => void) {
    this.currentWorld = world;
    this.selectedPid = selectedPid;
    this.onSelect = onSelect;
    this.clear();
    this.build();
  }

  private resize = () => {
    const width = Math.max(this.host.clientWidth, 1), height = Math.max(this.host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
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

    const framePositions = new Map<number, THREE.Vector3>();
    world.frames.forEach((frame, index) => {
      const x = (index % 6 - 2.5) * 1.22;
      const z = Math.floor(index / 6) * 1.28 - .5;
      const count = sharers(world, frame.id);
      const ownerIndex = world.processes.findIndex(p => p.pid === frame.owner);
      const color = count > 1 ? 0xb39cf3 : frame.owner === null ? 0x74dfad : palette[Math.max(ownerIndex, 0) % palette.length];
      const tile = this.makeBox(1.06, .2, 1.02, color, .97);
      tile.position.set(x, .08, z);
      const tileEdge = new THREE.LineSegments(new THREE.EdgesGeometry(tile.geometry), new THREE.LineBasicMaterial({ color: count > 1 ? 0xf1b6ff : 0xd7ffb2, transparent: true, opacity: .75 }));
      tileEdge.position.copy(tile.position);
      this.dynamic.add(tileEdge);
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
      const deck = this.makeBox(5.4, .17, 1.6, color, process.status === 'zombie' ? .23 : .38);
      deck.position.set(x, y, z);
      deck.userData.pid = process.pid;
      this.pickables.push(deck);
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(deck.geometry), new THREE.LineBasicMaterial({ color: isSelected ? 0xffecad : color, transparent: true, opacity: isSelected ? 1 : .78 }));
      border.position.copy(deck.position);
      this.dynamic.add(border);
      this.label(`${process.role.toUpperCase()} · PID ${process.pid}${process.status === 'zombie' ? ' · ZOMBIE' : ''}`, new THREE.Vector3(x, y + .3, z), isSelected ? 'label-selected' : '');
      if (process.status === 'zombie') return;
      process.pages.forEach((frameId, pageIndex) => {
        const px = x + (pageIndex - 2.5) * .79;
        const tile = this.makeBox(.62, .1, .8, sharers(world, frameId) > 1 ? 0xbdadef : color, .98);
        tile.position.set(px, y + .15, z);
        tile.userData.pid = process.pid;
        this.pickables.push(tile);
        const floor = framePositions.get(frameId);
        if (floor) this.addLine(new THREE.Vector3(px, y, z), new THREE.Vector3(floor.x, .18, floor.z), color, isSelected ? .6 : .22);
      });
    });
  }

  private click = (event: MouseEvent) => {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables)[0];
    if (hit?.object.userData.pid) this.onSelect?.(hit.object.userData.pid as number);
  };

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    this.controls.update();
    for (const { element, point } of this.targets) {
      const p = point.clone().project(this.camera);
      element.style.left = `${(p.x * .5 + .5) * this.host.clientWidth}px`;
      element.style.top = `${(-p.y * .5 + .5) * this.host.clientHeight}px`;
      element.style.display = p.z > 1 ? 'none' : '';
    }
    this.renderer.render(this.scene, this.camera);
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
    cancelAnimationFrame(this.frame);
    this.clear();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('click', this.click);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
