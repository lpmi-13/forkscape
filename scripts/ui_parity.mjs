import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  const camera = new PerspectiveCamera(38, bounds.width / bounds.height, 0.1, 100);
  camera.position.set(9.5, 8.5, 13.5);
  camera.lookAt(0, 1.2, 0);
  camera.updateMatrixWorld();
  const point = new Vector3(x, y, z).project(camera);
  assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1, 'scene target must be in view');
  await canvas.click({ position: { x: (point.x + 1) * bounds.width / 2, y: (1 - point.y) * bounds.height / 2 } });
}

async function clickPage(page, flat, pid, pageIndex) {
  if (flat) {
    await page.locator(`[data-page="${pageIndex}"][data-page-pid="${pid}"]`).click();
    return;
  }
  const master = pid === 4100;
  const x = master ? 0 : -3.05;
  const y = master ? 3.65 : 2.8;
  const z = master ? -2.25 : 2.15;
  await clickScenePoint(page, x + (pageIndex % 6 - 2.5) * .79, y, z + (pageIndex < 6 ? -.45 : .45));
  assert.match(await page.locator('#inspector h2').innerText(), new RegExp(`Virtual page ${pageIndex}`));
}

async function runScenario(flat) {
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(value => localStorage.setItem('forkscape-flat', String(value)), flat);
  await page.reload();
  if (flat) assert.equal(await page.locator('#flat-host').isVisible(), true);
  else {
    await page.locator('#scene-host canvas').waitFor();
    assert.equal(await page.locator('#flat-host').isVisible(), false);
    await clickScenePoint(page, -3.6, 1.46, -3.15);
    assert.match(await page.locator('#inspector h2').innerText(), /socket/);
    await page.locator('#clear-selection').click();
  }
  await page.locator('.reference-evidence summary').click();
  assert.match(await page.locator('.reference-evidence').innerText(), /VmPTE.*0–8 KiB/s);
  assert.equal(await page.locator('.reference-evidence').getAttribute('open'), '');
  const complete = async id => assert.match(await page.locator(`[data-module="${id}"]`).getAttribute('aria-label'), /complete$/);
  const predict = async choice => {
    await page.locator(`#prediction-form input[value="${choice}"]`).check();
    await page.locator('#prediction-form button[type="submit"]').click();
  };

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

  await page.locator('[data-module="case"]').click();
  await page.locator('#case-prediction-form input[value="1"]').check();
  await page.locator('#case-prediction-form button[type="submit"]').click();
  await page.locator('[data-case-kind="decay"][data-case-step="16"]').click();
  if (flat) {
    await clickPage(page, true, 4101, 6);
    await page.locator('[data-case-kind="decay"][data-case-step="20"]').click();
    assert.match(await page.locator('#inspector h2').innerText(), /Virtual page 6/);
  }
  await page.locator('[data-case-kind="leak"][data-case-step="16"]').click();
  await page.locator('#case-links-form select[name="decay"]').selectOption('decay');
  await page.locator('#case-links-form select[name="leak"]').selectOption('leak');
  await page.locator('#case-links-form select[name="evidence"]').selectOption('trend');
  await page.locator('#case-links-form button[type="submit"]').click();
  await complete('case');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-progress').click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const progress = JSON.parse(await readFile(downloadPath, 'utf8'));
  assert.equal(progress.version, 3);
  assert.equal(progress.caseStudy.viewedDecay, true);
  assert.equal(progress.caseStudy.viewedLeak, true);

  const ledger = await page.locator('#ledger').innerText();
  const event = await page.locator('#step-label').innerText();
  await page.locator('#view-toggle').click();
  if (flat) await page.locator('#scene-host canvas').waitFor();
  else assert.equal(await page.locator('#flat-host').isVisible(), true);
  assert.equal(await page.locator('#ledger').innerText(), ledger);
  assert.equal(await page.locator('#step-label').innerText(), event);
  assert.equal(await page.locator('.reference-evidence').getAttribute('open'), '');

  await page.locator('#progress-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  assert.match(await page.locator('#import-status').innerText(), /not valid JSON/);
  assert.equal(await page.locator('#import-review').isVisible(), false);
  await page.evaluate(() => {
    localStorage.removeItem('forkscape-progress');
    localStorage.removeItem('forkscape-exercises');
    localStorage.removeItem('forkscape-case');
  });
  await page.reload();
  assert.match(await page.locator('[data-module="1"]').getAttribute('aria-label'), /incomplete$/);
  await page.locator('#progress-file').setInputFiles(downloadPath);
  assert.match(await page.locator('#import-summary').innerText(), /5 of 5 activities complete/);
  assert.match(await page.locator('[data-module="1"]').getAttribute('aria-label'), /incomplete$/);
  await page.locator('#apply-import').click();
  for (const id of [1, 2, 3, 4, 'case']) await complete(id);
  await page.reload();
  for (const id of [1, 2, 3, 4, 'case']) await complete(id);
  await page.close();
  console.log(`${flat ? 'Flat' : '3D'} mode completed Modules 1–4 and the case; view switch and progress import passed.`);
}

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  await runScenario(true);
  await runScenario(false);
} finally {
  await browser?.close();
  await server.close();
}
