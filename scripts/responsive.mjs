import { chromium } from 'playwright';

const out = process.env.SHOT_DIR || 'shots';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

const devices = [
  { name: 'iphone', viewport: { width: 393, height: 852 }, dpr: 3, touch: true },
  { name: 'ipad', viewport: { width: 1180, height: 820 }, dpr: 2, touch: true },
];

for (const d of devices) {
  const ctx = await browser.newContext({
    viewport: d.viewport,
    deviceScaleFactor: d.dpr,
    hasTouch: d.touch,
    isMobile: d.name === 'iphone',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const box = await page.locator('.canvas-surface').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2.6;
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 50, { steps: 8 });
  await page.mouse.move(cx + 60, cy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  await page.screenshot({ path: `${out}/mobile-${d.name}.png` });

  // ¿Se desborda la página en horizontal?
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  // ¿Hay controles fuera de la pantalla?
  const offscreen = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('.icon-btn, .color-well')) {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1 || r.left < -1 || r.bottom > window.innerHeight + 1)
        bad.push(el.getAttribute('aria-label') || el.className);
    }
    return bad;
  });

  console.log(
    `${d.name.padEnd(7)} desbordamiento:${overflow ? ' SÍ' : ' no'}  controles fuera de pantalla: ${
      offscreen.length ? offscreen.join(', ') : 'ninguno'
    }  errores: ${errors.length || 'ninguno'}`,
  );
  await ctx.close();
}

await browser.close();
