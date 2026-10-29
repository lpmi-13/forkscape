import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const address = server.httpServer.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/`;
const scenarioIds = ['cow-decay', 'leak', 'decay-oom', 'rss-overcount', 'worker-warmup', 'no-preload', 'shared-offset', 'thread-lock'];
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

// Mirrors deckTileOffset in src/scene.ts for a master deck with fewer than 13 mapped pages.
async function clickMasterPage(page, flat, pageIndex) {
  if (flat) await page.locator(`#flat-host [data-page="${pageIndex}"][data-page-pid="4100"]`).click();
  else await clickScenePoint(page, (pageIndex % 6 - 2.5) * .79, 4, -2.25 + (pageIndex < 6 ? -.45 : .45));
  await openPanel(page, 'inspector');
  assert.match(await page.locator('#inspector h2').textContent(), new RegExp(`Virtual page ${pageIndex}`));
}

const stepLabel = page => page.locator('.stepper-controls span').innerText();
// Links change the URL hash; the app re-renders on the following hashchange event.
const heading = (page, text) => page.locator('#scenario-content h1', { hasText: text }).waitFor();
const legend = page => page.locator('.chart-legend').innerText();
// 3D decks and flat process cards both carry RSS and PSS while the comparison is shown.
const deckAccounting = (page, flat, pid) => flat
  ? page.locator(`.flat-process:has([data-pid="${pid}"]) .flat-accounting`).innerText()
  : page.locator('.scene-label', { hasText: `PID ${pid}` }).textContent();

async function runJourneys(flat) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.evaluate(value => localStorage.setItem('forkscape-flat', String(value)), flat);
  await page.reload();

  assert.equal(await page.locator('[data-panel-id="scenarios"]').isVisible(), true, 'the scenario library is open on arrival');
  assert.equal(await page.locator('.scenario-card').count(), scenarioIds.length);
  assert.equal(await page.locator('.sandbox-link').count(), 1, 'free exploration is offered after the scenarios');
  assert.equal(await page.locator('.card-tag').count(), 5, 'scenarios that depend on RSS vs PSS are marked in the library');
  assert.equal(await page.locator('#view-toggle').isVisible(), true, 'view toggle stays outside the menu');
  if (flat) assert.equal(await page.locator('#flat-host').isVisible(), true);
  else {
    await page.locator('#scene-host canvas').waitFor();
    assert.equal(await page.locator('#flat-host').isVisible(), false);
    await assertLabelsSeparate(page);
    await clickScenePoint(page, -3.6, 2.06, -3.15);
    await openPanel(page, 'inspector');
    assert.match(await page.locator('#inspector h2').innerText(), /socket/);
    await page.locator('#clear-selection').click();
    await openPanel(page, 'scenarios');
  }

  await page.locator('.scenario-card[href="#cow-decay"]').click();
  await heading(page, 'Memory climbs while RSS stays flat');
  assert.equal(await stepLabel(page), 'STEP 1 / 9');
  assert.match(await legend(page), /Worker 4101 RSS\s*—/);
  for (let index = 1; index < 9; index++) await page.locator('#scenario-next').click();
  assert.equal(await stepLabel(page), 'STEP 9 / 9');
  assert.equal(await page.locator('#scenario-next').isDisabled(), true);
  assert.match(await legend(page), /Worker 4101 RSS\s*40 KiB/);
  assert.match(await legend(page), /Worker 4101 PSS\s*32 KiB/);
  assert.match(await legend(page), /Memory in use \(Σ PSS\)\s*72 KiB/);
  assert.match(await page.locator('.accounting.key').innerText(), /Σ RSS\s*88 KiB\s*Σ PSS · IN USE\s*72 KiB\s*RSS OVERCOUNT\s*16 KiB/, 'the RSS vs PSS callout is shown where it is the point');
  assert.match(await deckAccounting(page, flat, 4101), /RSS 40 (KiB )?· PSS 32 KiB/);
  await page.locator('.acct-seg[data-page-pid="4100"][data-page="3"]').first().click();
  await openPanel(page, 'inspector');
  assert.match(await page.locator('#inspector h2').innerText(), /Virtual page 3/, 'a comparison segment selects its page');
  assert.match(await page.locator('#inspector').innerText(), /RSS counts it as 4 KiB in each of the 2 mappings; PSS charges each one 2 KiB/);
  await page.locator('#clear-selection').click();
  assert.match(await page.locator('#inspector').innerText(), /PSS 40 KiB charges this process its share/);
  await openPanel(page, 'scenarios');
  await page.locator('[data-chart-step="4"]').click({ force: true });
  assert.equal(await stepLabel(page), 'STEP 5 / 9');
  assert.match(await page.locator('.step-event').innerText(), /RSS is unchanged/);
  if (!flat) await assertLabelsSeparate(page);

  await openPanel(page, 'inspector');
  assert.match(await page.locator('#inspector h2').innerText(), /Virtual page 8/, 'each step points the inspector at the page it touched');
  assert.match(await page.locator('#inspector').innerText(), /exclusive frame/);
  await openPanel(page, 'ledger');
  const ledger = await page.locator('#ledger').innerText();
  assert.match(ledger, /MAPPED\s+RSS\s+PSS\s+USS/);
  await page.locator('#ledger + .reference-evidence summary').click();
  assert.match(await page.locator('#ledger + .reference-evidence').innerText(), /Django 6\.1 .*Σ RSS 259\.8–259\.9 MiB/);
  await openPanel(page, 'timeline');
  assert.equal(await page.locator('#step-label').innerText(), 'STEP 5 / 9');
  await page.locator('#next-step').click();
  assert.equal(await page.locator('#step-label').innerText(), 'STEP 6 / 9');
  await page.locator('#prev-step').click();

  await page.locator('#view-toggle').click();
  if (flat) await page.locator('#scene-host canvas').waitFor();
  else assert.equal(await page.locator('#flat-host').isVisible(), true);
  await openPanel(page, 'ledger');
  assert.equal(await page.locator('#ledger').innerText(), ledger);
  assert.equal(await page.locator('#ledger + .reference-evidence').getAttribute('open'), '');
  await openPanel(page, 'timeline');
  assert.equal(await page.locator('#step-label').innerText(), 'STEP 5 / 9');
  await page.locator('#view-toggle').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-panel-id]:visible').count(), 0, 'Escape closes the open panel');

  await openPanel(page, 'scenarios');
  await page.locator('#explore-here').click();
  await heading(page, 'Change the model yourself');
  assert.match(await page.locator('#scenario-content').innerText(), /Started from step 5 of Memory climbs while RSS stays flat/);
  await clickMasterPage(page, flat, 0);
  await openPanel(page, 'scenarios');
  await page.locator('[data-lab="fork"]').click();
  await openPanel(page, 'timeline');
  assert.equal(await page.locator('#step-label').innerText(), '2 / 2');
  assert.equal(await page.locator('#event-count').innerText(), '2 STATES');
  await openPanel(page, 'scenarios');
  assert.equal(await page.locator('[data-lab="write"]').isDisabled(), true, 'the code page is read-only');
  await page.locator('[data-lab="read"]').click();
  assert.match(await page.locator('#scenario-content').innerText(), /PID 4100 reads virtual page 0/);
  assert.equal(await page.locator('details.accounting:not([open])').count(), 1, 'free exploration offers the comparison on request');

  await page.goBack();
  await heading(page, 'Memory climbs while RSS stays flat');
  await page.locator('.back-link').click();
  await heading(page, 'Fork and memory problems, replayed');
  assert.equal(await page.locator('.scenario-card').count(), scenarioIds.length);

  await page.locator('.scenario-card[href="#leak"]').click();
  await heading(page, 'A leak grows without limit');
  assert.equal(await page.locator('details.accounting:not([open])').count(), 1, 'where RSS and PSS agree, the comparison starts closed');
  await page.locator('details.accounting summary').click();
  await page.locator('#scenario-next').click();
  assert.equal(await page.locator('details.accounting[open]').count(), 1, 'the comparison stays open while stepping');
  assert.match(await deckAccounting(page, flat, 4101), /RSS 40 (KiB )?· PSS 20 KiB/);
  await page.locator('details.accounting summary').click();

  await page.goto(`${url}#no-preload`);
  await page.locator('.contrast').waitFor();
  assert.match(await page.locator('.contrast').innerText(), /With preload\s*108 KiB higher\s*36 KiB\s*Without preload\s*96 KiB\s*48 KiB higher/, 'Σ RSS and Σ PSS rank preload opposite ways');

  for (const id of scenarioIds) {
    await page.goto(`${url}#${id}`);
    await page.locator('#scenario-prev').waitFor();
    const total = Number((await stepLabel(page)).split('/ ')[1]);
    for (let index = 1; index < total; index++) await page.locator('#scenario-next').click();
    assert.equal(await stepLabel(page), `STEP ${total} / ${total}`, `${id} reaches its last step`);
  }
  assert.deepEqual(errors, []);
  await page.close();
  console.log(`${flat ? 'Flat' : '3D'} mode stepped through all ${scenarioIds.length} scenarios; chart, RSS/PSS comparison, panels, view switch, and free exploration passed.`);
}

async function runPhoneCheck() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(`${url}#decay-oom`);
  await page.locator('#scene-host canvas').waitFor();
  const [canvas, host] = await Promise.all([page.locator('#scene-host canvas').boundingBox(), page.locator('#scene-host').boundingBox()]);
  assert.deepEqual([canvas.width, canvas.height], [host.width, host.height], 'the canvas fills the scene on high-DPI screens');
  const [panel, scene] = await Promise.all([page.locator('[data-panel-id="scenarios"]').boundingBox(), page.locator('#scene-host').boundingBox()]);
  assert.ok(panel.y + panel.height <= scene.y + 1, 'on phones the scenario panel sits above the scene');
  assert.ok(await page.locator('[data-panel-id="scenarios"]').evaluate(element => element.scrollWidth <= element.clientWidth), 'the scenario panel does not scroll sideways');
  for (let index = 0; index < 6; index++) await page.locator('#scenario-next').click();
  await assertLabelsSeparate(page);
  await page.close();
  console.log('Phone layout kept the canvas sized to the scene, labels apart, and the scenario panel above the scene without sideways scrolling.');
}

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  await runJourneys(true);
  await runJourneys(false);
  await runPhoneCheck();
} finally {
  await browser?.close();
  await server.close();
}
