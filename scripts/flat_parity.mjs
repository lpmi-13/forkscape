import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const address = server.httpServer.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/`;
let browser;

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(() => localStorage.setItem('forkscape-flat', 'true'));
  await page.reload();
  assert.equal(await page.locator('#flat-host').isVisible(), true);
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
  await page.locator('[data-page="2"][data-page-pid="4100"]').click();
  await page.locator('[data-page="2"][data-page-pid="4101"]').click();
  await page.locator('[data-lab="write"]').click();
  await page.locator('[data-page="2"][data-page-pid="4100"]').click();
  await page.locator('[data-page="2"][data-page-pid="4101"]').click();
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
  await page.locator('[data-page="6"][data-page-pid="4101"]').click();
  await page.locator('[data-case-kind="decay"][data-case-step="20"]').click();
  assert.match(await page.locator('#inspector h2').innerText(), /Virtual page 6/);
  await page.locator('[data-case-kind="leak"][data-case-step="16"]').click();
  await page.locator('#case-links-form select[name="decay"]').selectOption('decay');
  await page.locator('#case-links-form select[name="leak"]').selectOption('leak');
  await page.locator('#case-links-form select[name="evidence"]').selectOption('trend');
  await page.locator('#case-links-form button[type="submit"]').click();
  await complete('case');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-progress').click();
  const download = await downloadPromise;
  const progress = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(progress.version, 3);
  assert.equal(progress.caseStudy.viewedDecay, true);
  assert.equal(progress.caseStudy.viewedLeak, true);

  const ledger = await page.locator('#ledger').innerText();
  const event = await page.locator('#step-label').innerText();
  await page.locator('#view-toggle').click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#ledger').innerText(), ledger);
  assert.equal(await page.locator('#step-label').innerText(), event);
  assert.ok(await page.locator('#scene-host').isVisible() || await page.locator('#flat-host').isVisible());
  console.log('Flat mode completed Modules 1–4 and the case; view switch preserved ledger and timeline.');
} finally {
  await browser?.close();
  await server.close();
}
