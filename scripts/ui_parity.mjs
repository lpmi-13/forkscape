import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const address = server.httpServer.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/`;
let browser;

async function clickScenePoint(page, x, y, z) {
  const canvas = page.locator('#scene-host canvas');
  const bounds = await canvas.boundingBox();
  assert.ok(bounds, '3D canvas must be visible');
  const aspect = bounds.width / bounds.height;
  const fov = aspect >= 1.3 ? 38 : 2 * Math.atan(Math.tan(19 * Math.PI / 180) * 1.3 / aspect) * 180 / Math.PI;
  const camera = new PerspectiveCamera(fov, aspect, 0.1, 100);
  camera.position.set(9.5, 8.5, 13.5);
  camera.lookAt(0, 1.2, 0);
  camera.updateMatrixWorld();
  const point = new Vector3(x, y, z).project(camera);
  assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1, 'scene target must be in view');
  await canvas.click({ position: { x: (point.x + 1) * bounds.width / 2, y: (1 - point.y) * bounds.height / 2 } });
}

async function openPanel(page, id) {
  if (!await page.locator(`[data-panel-id="${id}"]`).isVisible()) {
    await page.locator('#menu-toggle').click();
    await page.locator(`[data-panel="${id}"]`).click();
  }
  assert.equal(await page.locator('#panel-menu').isVisible(), false, 'choosing a panel collapses the menu');
  assert.equal(await page.locator('[data-panel-id]:visible').count(), 1, 'only one panel is open');
}

async function assertLabelsSeparate(page) {
  const hits = await page.evaluate(async () => {
    await document.fonts.ready;
    const boxes = [...document.querySelectorAll('.scene-label')].filter(label => getComputedStyle(label).visibility !== 'hidden').map(label => ({ text: label.textContent, rect: label.getBoundingClientRect() }));
    return boxes.flatMap((a, index) => boxes.slice(index + 1).filter(b => a.rect.left < b.rect.right && a.rect.right > b.rect.left && a.rect.top < b.rect.bottom && a.rect.bottom > b.rect.top).map(b => `${a.text} / ${b.text}`));
  });
  assert.deepEqual(hits, [], 'visible scene labels must not overlap');
}

async function clickPage(page, flat, pid, pageIndex) {
  if (flat) {
    await page.locator(`[data-page="${pageIndex}"][data-page-pid="${pid}"]`).click();
    return;
  }
  const master = pid === 4100;
  const x = master ? 0 : -3.05;
  const y = master ? 4 : 3.15;
  const z = master ? -2.25 : 2.15;
  await clickScenePoint(page, x + (pageIndex % 6 - 2.5) * .79, y, z + (pageIndex < 6 ? -.45 : .45));
  assert.match(await page.locator('#inspector h2').textContent(), new RegExp(`Virtual page ${pageIndex}`));
}

async function runScenario(flat) {
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(value => localStorage.setItem('forkscape-flat', String(value)), flat);
  await page.reload();
  assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('[data-panel-id]:visible').count(), 0, 'all panels start collapsed');
  assert.equal(await page.locator('#view-toggle').isVisible(), true, 'view toggle stays outside the menu');
  assert.equal(await page.locator('[data-panel="timeline"]').getAttribute('hidden'), '', 'timeline is not offered with a single state');
  if (flat) assert.equal(await page.locator('#flat-host').isVisible(), true);
  else {
    await page.locator('#scene-host canvas').waitFor();
    assert.equal(await page.locator('#flat-host').isVisible(), false);
    await assertLabelsSeparate(page);
    await clickScenePoint(page, -3.6, 2.06, -3.15);
    await openPanel(page, 'inspector');
    assert.match(await page.locator('#inspector h2').innerText(), /socket/);
    await page.locator('#clear-selection').click();
  }
  await openPanel(page, 'ledger');
  await page.locator('.reference-evidence summary').click();
  assert.match(await page.locator('.reference-evidence').innerText(), /VmPTE.*0–8 KiB/s);
  assert.equal(await page.locator('.reference-evidence').getAttribute('open'), '');
  const complete = async id => assert.match(await page.locator(`[data-module="${id}"]`).getAttribute('aria-label'), /complete$/);
  const predict = async choice => {
    await page.locator(`#prediction-form input[value="${choice}"]`).check();
    await page.locator('#prediction-form button[type="submit"]').click();
  };

  await openPanel(page, 'lesson');
  await predict(1);
  for (const [name, owner] of Object.entries({ pid: 'process', address: 'process', descriptors: 'process', threads: 'process', socket: 'kernel', file: 'kernel' })) {
    await page.locator(`#classification-form select[name="${name}"]`).selectOption(owner);
  }
  await page.locator('#classification-form button[type="submit"]').click();
  await complete(1);

  await page.locator('[data-module="2"]').click();
  await predict(1);
  for (let index = 0; index < 6; index++) await page.locator('#walk-next').click();
  await complete(2);

  await page.locator('[data-module="3"]').click();
  await predict(1);
  await page.locator('#reset-model').click();
  await page.locator('[data-lab="fork"]').click();
  await clickPage(page, flat, 4100, 2);
  await clickPage(page, flat, 4101, 2);
  await page.locator('[data-lab="write"]').click();
  await clickPage(page, flat, 4100, 2);
  await clickPage(page, flat, 4101, 2);
  await complete(3);

  await page.locator('[data-module="4"]').click();
  await predict(1);
  await page.locator('#size-form button[type="submit"]').click();
  await page.locator('#show-event').click();
  await complete(4);
  if (!flat) await assertLabelsSeparate(page);

  await page.locator('[data-module="case"]').click();
  await page.locator('#case-prediction-form input[value="1"]').check();
  await page.locator('#case-prediction-form button[type="submit"]').click();
  await page.locator('[data-case-kind="decay"][data-case-step="16"]').click();
  if (flat) {
    await clickPage(page, true, 4101, 6);
    await page.locator('[data-case-kind="decay"][data-case-step="20"]').click();
    assert.match(await page.locator('#inspector h2').textContent(), /Virtual page 6/);
  }
  await page.locator('[data-case-kind="leak"][data-case-step="16"]').click();
  await page.locator('#case-links-form select[name="decay"]').selectOption('decay');
  await page.locator('#case-links-form select[name="leak"]').selectOption('leak');
  await page.locator('#case-links-form select[name="evidence"]').selectOption('trend');
  await page.locator('#case-links-form button[type="submit"]').click();
  await complete('case');

  await openPanel(page, 'ledger');
  const ledger = await page.locator('#ledger').innerText();
  await openPanel(page, 'timeline');
  const event = await page.locator('#step-label').innerText();
  await page.locator('#view-toggle').click();
  if (flat) await page.locator('#scene-host canvas').waitFor();
  else assert.equal(await page.locator('#flat-host').isVisible(), true);
  await openPanel(page, 'ledger');
  assert.equal(await page.locator('#ledger').innerText(), ledger);
  assert.equal(await page.locator('.reference-evidence').getAttribute('open'), '');
  await openPanel(page, 'timeline');
  assert.equal(await page.locator('#step-label').innerText(), event);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-panel-id]:visible').count(), 0, 'Escape closes the open panel');

  await page.reload();
  for (const id of [1, 2, 3, 4, 'case']) await complete(id);
  await page.close();
  console.log(`${flat ? 'Flat' : '3D'} mode completed Modules 1–4 and the case; view switch and saved progress passed.`);
}

async function runPhoneCheck() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(url);
  await page.locator('#scene-host canvas').waitFor();
  const [canvas, host] = await Promise.all([page.locator('#scene-host canvas').boundingBox(), page.locator('#scene-host').boundingBox()]);
  assert.deepEqual([canvas.width, canvas.height], [host.width, host.height], 'the canvas fills the scene on high-DPI screens');
  await assertLabelsSeparate(page);
  await page.locator('#menu-toggle').click();
  await page.locator('[data-panel="lesson"]').click();
  const [panel, scene] = await Promise.all([page.locator('[data-panel-id="lesson"]').boundingBox(), page.locator('#scene-host').boundingBox()]);
  assert.ok(panel.y + panel.height <= scene.y + 1, 'on phones the open panel sits above the scene');
  await assertLabelsSeparate(page);
  await page.close();
  console.log('Phone layout kept the canvas sized to the scene, labels apart, and the panel above the scene.');
}

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  await runScenario(true);
  await runScenario(false);
  await runPhoneCheck();
} finally {
  await browser?.close();
  await server.close();
}
