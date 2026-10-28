import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { parseCapture } from '../src/capture.ts';
import { syntheticProcessCapture } from '../src/synthetic-capture.ts';

const capturePath = process.argv[2];
const captureText = capturePath ? await readFile(capturePath, 'utf8') : syntheticProcessCapture();
const fileName = capturePath?.split('/').at(-1) ?? 'synthetic-process-capture.ndjson';
const capture = parseCapture(captureText);
const chrome = process.env.CHROME_BIN || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome');
const server = process.env.CAPTURE_BASE_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server?.listen();
  const address = server?.httpServer.address();
  if (server) assert.ok(address && typeof address !== 'string');
  const base = process.env.CAPTURE_BASE_URL ?? `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // A saved Flat view preference must still leave an obvious path to 3D.
  await page.addInitScript(() => localStorage.setItem('forkscape-flat', 'true'));
  await page.goto(base);
  assert.equal(await page.locator('.recording-link, .sandbox-link').count(), 0);
  assert.equal(await page.locator('[data-mode="recording"]').count(), 1);
  assert.equal(await page.locator('[data-mode="sandbox"]').count(), 1);
  await page.locator('#menu-toggle').click();
  if (process.env.CAPTURE_MENU_SCREENSHOT) await page.screenshot({ path: process.env.CAPTURE_MENU_SCREENSHOT });
  await page.locator('[data-mode="sandbox"]').click();
  await page.waitForURL(/#explore$/);
  await page.locator('#scenario-content h1', { hasText: 'Change the model yourself' }).waitFor();
  assert.match(await page.locator('#scenario-content h1').innerText(), /Change the model yourself/);
  assert.equal(await page.locator('#panel-menu').isVisible(), false);
  await page.locator('#menu-toggle').click();
  assert.equal(await page.locator('[data-mode="sandbox"]').getAttribute('aria-current'), 'page');
  await page.locator('[data-panel="scenarios"]').click();
  await page.waitForURL(/#scenarios$/);
  await page.locator('.scenario-card').first().waitFor();
  assert.ok(await page.locator('.scenario-card').count() > 0);
  await page.locator('#menu-toggle').click();
  await page.locator('[data-mode="recording"]').click();
  await page.waitForURL(/#recording$/);
  await page.locator('#recording-file').waitFor({ state: 'attached' });
  await page.locator('#open-sample').click();
  await page.locator('.stepper.is-recording').waitFor();
  assert.match(await page.locator('#scenario-meta').innerText(), /stages · recording/);
  await page.locator('#menu-toggle').click();
  await page.locator('[data-panel="inspector"]').click();
  await page.locator('#menu-toggle').click();
  await page.locator('[data-mode="recording"]').click();
  assert.equal(await page.locator('[data-panel-id="scenarios"]').isVisible(), true);
  assert.match(await page.locator('#scenario-meta').innerText(), /stages · recording/);
  await page.locator('#recording-file').setInputFiles({ name: fileName, mimeType: 'application/x-ndjson', buffer: Buffer.from(captureText) });
  await page.waitForURL(/\/capture\.html$/);
  await page.locator('.capture-meta').waitFor();
  assert.equal(await page.locator('#capture-file').count(), 0);
  assert.match(await page.locator('#capture-source').innerText(), /Loaded /);
  assert.ok((await page.locator('.capture-meta').innerText()).includes(capture.metadata.workload));
  assert.ok((await page.locator('.capture-meta').innerText()).includes(`Complete · ${capture.samples.length} samples`));
  assert.match(await page.locator('#view-toggle').innerText(), /3D view/);
  assert.equal(await page.locator('#capture-detail').isVisible(), true);
  assert.equal(await page.locator('#capture-3d').isVisible(), false);
  assert.equal(await page.locator('#capture-scene canvas').count(), 0);
  assert.equal(await page.locator('.capture-series').count(), 3);
  assert.equal(await page.locator('.capture-events button').count(), capture.markers.length);
  if (process.env.CAPTURE_FLAT_SCREENSHOT) await page.screenshot({ path: process.env.CAPTURE_FLAT_SCREENSHOT, fullPage: true });
  await page.locator('#capture-next').click();
  assert.ok((await page.locator('.capture-sample h2').innerText()).includes(`${(capture.samples[1].elapsedMs / 1000).toFixed(2)} seconds`));

  await page.locator('#view-toggle').click();
  await page.locator('#capture-scene canvas').waitFor({ state: 'visible' });
  assert.match(await page.locator('#view-toggle').innerText(), /Flat view/);
  assert.equal(await page.locator('#capture-detail').isVisible(), false);
  assert.equal(await page.locator('#capture-scene-fallback').isVisible(), false);
  assert.match(await page.locator('#capture-3d figcaption').innerText(), /memory\.current/);
  const layout = await page.evaluate(() => ({
    rail: document.querySelector('.capture-rail').getBoundingClientRect(),
    stage: document.querySelector('.capture-stage').getBoundingClientRect(),
  }));
  assert.ok(layout.stage.width > layout.rail.width);
  assert.ok(layout.stage.height > 700);
  assert.match(await page.locator('#capture-scene-scale').innerText(), /Process columns: 0–\d+ MiB · Cgroup column: 0–\d+ MiB/);
  assert.equal(await page.locator('#capture-scene').getAttribute('data-sample-index'), '1');
  const canvas = await page.locator('#capture-scene canvas').elementHandle();
  const firstValues = await page.locator('.capture-3d-value').allTextContents();
  await page.locator('#capture-3d-next').click();
  assert.equal(await page.locator('#capture-scene').getAttribute('data-sample-index'), '2');
  await page.locator('#capture-3d-prev').click();
  assert.equal(await page.locator('#capture-scene').getAttribute('data-sample-index'), '1');
  await page.locator('.capture-events button').last().click();
  const lastMarker = capture.markers.at(-1);
  let markerSample = capture.samples.findIndex(item => item.elapsedMs >= lastMarker.elapsedMs);
  if (markerSample < 0) markerSample = capture.samples.length - 1;
  assert.equal(await page.locator('#capture-scene').getAttribute('data-sample-index'), String(markerSample));
  assert.notDeepEqual(await page.locator('.capture-3d-value').allTextContents(), firstValues);
  await page.locator('#view-toggle').click();
  assert.equal(await page.locator('#capture-detail').isVisible(), true);
  assert.equal(await page.locator('#capture-3d').isVisible(), false);
  assert.ok((await page.locator('.capture-sample h2').innerText()).includes(`${(capture.samples[markerSample].elapsedMs / 1000).toFixed(2)} seconds`));
  assert.equal(await page.locator('.capture-sample tbody tr').count(), capture.samples[markerSample].data.processes.length);
  await page.locator('#view-toggle').click();
  assert.equal(await page.locator('#capture-scene canvas').evaluate((node, first) => node === first, canvas), true);
  if (process.env.CAPTURE_SCREENSHOT) {
    await page.screenshot({ path: process.env.CAPTURE_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 2048, height: 1230 });
    await page.locator('#capture-3d-range').evaluate(input => {
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('.capture-rail').evaluate(rail => { rail.scrollTop = 0; });
    await page.screenshot({ path: process.env.CAPTURE_SCREENSHOT.replace(/\.png$/, '-overview.png') });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#capture-scene canvas').isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
  if (process.env.CAPTURE_MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.CAPTURE_MOBILE_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);

  const emptyPage = await browser.newPage();
  await emptyPage.goto(`${base}/capture.html`);
  assert.equal(await emptyPage.locator('#capture-empty').isVisible(), true);
  assert.equal(await emptyPage.locator('#capture-file').count(), 0);
  await emptyPage.locator('.capture-start').click();
  await emptyPage.locator('#recording-file').waitFor();

  const fallbackPage = await browser.newPage();
  await fallbackPage.addInitScript(({ text, name }) => {
    sessionStorage.setItem('forkscape-measured-capture', JSON.stringify({ text, fileName: name }));
    localStorage.setItem('forkscape-flat', 'false');
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
      return getContext.call(this, kind, ...args);
    };
  }, { text: captureText, name: fileName });
  await fallbackPage.goto(`${base}/capture.html`);
  await fallbackPage.locator('#capture-scene-fallback').waitFor({ state: 'visible' });
  assert.equal(await fallbackPage.locator('#capture-detail').isVisible(), false);
  await fallbackPage.locator('#view-toggle').click();
  assert.equal(await fallbackPage.locator('.capture-sample tbody tr').count(), capture.samples[0].data.processes.length);
  assert.equal(await fallbackPage.locator('.capture-series').count(), 3);

  const demoPage = await browser.newPage();
  await demoPage.addInitScript(() => localStorage.setItem('forkscape-flat', 'true'));
  await demoPage.goto(`${base}/#recording`);
  await demoPage.locator('[data-capture-sample="synthetic"]').click();
  await demoPage.waitForURL(/\/capture\.html\?sample=synthetic$/);
  assert.match(await demoPage.locator('.capture-meta').innerText(), /synthetic-prefork/);
  await demoPage.goto(`${base}/#recording`);
  await demoPage.locator('[data-node-sample="synthetic"]').click();
  await demoPage.waitForURL(/\/node\.html\?sample=synthetic$/);
  await demoPage.locator('.node-chart').first().waitFor();
  assert.match(await demoPage.locator('#node-overview').innerText(), /Generated by Forkscape · synthetic values/);
  await demoPage.locator('#view-toggle').click();
  await demoPage.locator('#node-scene canvas').waitFor({ state: 'visible' });
  await demoPage.locator('#node-next').click();
  assert.match(await demoPage.locator('#node-time').innerText(), /Sample 2 of 6/i);

  await page.goto(`${base}/#recording`);
  await page.locator('#recording-file').setInputFiles({ name: 'broken.ndjson', mimeType: 'text/plain', buffer: Buffer.from('{broken}') });
  await page.locator('.recording-status.is-error').waitFor({ state: 'attached' });
  assert.match(await page.locator('.recording-status.is-error').textContent(), /could not be replayed/);
  console.log('Main menu, capture upload, Flat/3D views, fallback, and one-click synthetic process and node demos passed.');
} finally {
  await browser?.close();
  await server?.close();
}
