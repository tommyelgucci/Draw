import { chromium } from 'playwright';

const out = process.env.SHOT_DIR || 'shots';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FALLA'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// Paletas viejas de una corrida anterior no deben contaminar esta prueba.
await page.evaluate(() => localStorage.removeItem('trace:paletas'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);

console.log('\n— Abrir el panel de Color —');
await page.getByTitle('Color').click();
await page.waitForTimeout(200);
check('aparece "Mis paletas"', (await page.getByText('Mis paletas').count()) > 0);
check(
  'sin paletas propias arranca con el mensaje de ayuda',
  (await page.getByText('Crea una paleta propia').count()) > 0,
);
await page.screenshot({ path: `${out}/pal-01-vacio.png` });

console.log('\n— Crear una paleta —');
await page.getByLabel('Nueva paleta').click();
await page.waitForTimeout(200);
const afterCreate = await page.evaluate(() => window.__uiStore.getState().userPalettes);
check('se crea con nombre por defecto', afterCreate.length === 1 && afterCreate[0].name === 'Paleta 1', JSON.stringify(afterCreate));
check('arranca sin colores', afterCreate[0].colors.length === 0);

console.log('\n— Renombrarla —');
const nameInput = page.locator('.user-palette__name');
await nameInput.fill('Piel y sombras');
await nameInput.blur();
await page.waitForTimeout(150);
const renamed = await page.evaluate(() => window.__uiStore.getState().userPalettes[0].name);
check('el nombre se actualiza en el store', renamed === 'Piel y sombras', renamed);

console.log('\n— Elegir un color y añadirlo —');
await page.locator('.hex-input').fill('#3366CC');
await page.locator('.hex-input').blur();
await page.waitForTimeout(150);
await page.getByLabel(/Añadir color activo/).click();
await page.waitForTimeout(150);
const afterAdd = await page.evaluate(() => window.__uiStore.getState().userPalettes[0].colors);
check('el color activo se añade a la paleta', afterAdd.length === 1, JSON.stringify(afterAdd));
await page.getByLabel(/Añadir color activo/).click();
await page.waitForTimeout(150);
const afterAdd2 = await page.evaluate(() => window.__uiStore.getState().userPalettes[0].colors.length);
check('añadir de nuevo suma otro swatch (sin deduplicar)', afterAdd2 === 2, `${afterAdd2}`);
await page.screenshot({ path: `${out}/pal-02-con-colores.png` });

console.log('\n— Tocar un swatch de la paleta cambia el color activo —');
await page.locator('.hex-input').fill('#FFFFFF');
await page.locator('.hex-input').blur();
await page.waitForTimeout(150);
await page.locator('.swatch-wrap .swatch').first().click();
await page.waitForTimeout(150);
const pickedHex = await page.locator('.hex-input').inputValue();
check('el swatch de la paleta selecciona ese color', pickedHex.toUpperCase() === '#3366CC', pickedHex);

console.log('\n— Quitar un color con la "x" —');
await page.locator('.swatch-remove').first().click();
await page.waitForTimeout(150);
const afterRemove = await page.evaluate(() => window.__uiStore.getState().userPalettes[0].colors.length);
check('el color se quita de la paleta', afterRemove === 1, `${afterRemove}`);

console.log('\n— Persistencia entre recargas —');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.getByTitle('Color').click();
await page.waitForTimeout(200);
const persisted = await page.evaluate(() => window.__uiStore.getState().userPalettes);
check(
  'la paleta sobrevive a un recargado (localStorage)',
  persisted.length === 1 && persisted[0].name === 'Piel y sombras' && persisted[0].colors.length === 1,
  JSON.stringify(persisted),
);

console.log('\n— Borrar la paleta pide confirmación —');
await page.getByLabel('Eliminar paleta').click();
await page.waitForTimeout(150);
check('aparece el aviso de confirmación', (await page.getByText(/¿Eliminar/).count()) > 0);
await page.getByRole('button', { name: 'Cancelar' }).click();
await page.waitForTimeout(150);
const stillThere = await page.evaluate(() => window.__uiStore.getState().userPalettes.length);
check('Cancelar no borra nada', stillThere === 1, `${stillThere}`);

await page.getByLabel('Eliminar paleta').click();
await page.waitForTimeout(150);
await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
await page.waitForTimeout(150);
const afterDelete = await page.evaluate(() => window.__uiStore.getState().userPalettes.length);
check('confirmar sí la borra', afterDelete === 0, `${afterDelete}`);
check('vuelve el mensaje de ayuda', (await page.getByText('Crea una paleta propia').count()) > 0);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
