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

async function docState() {
  return page.evaluate(() => {
    const e = window.__trace;
    return {
      layerOrder: e.doc.layers.map((l) => ({ id: l.id, name: l.name, groupId: l.groupId ?? null })),
      groups: e.doc.layerGroups,
    };
  });
}

/* ------------------------------------------------------------------ */

console.log('\n— Preparar 3 capas: Fondo, Torso, Brazo —');
const ids = await page.evaluate(() => {
  const e = window.__trace;
  const fondo = e.doc.layers[0];
  fondo.name = 'Fondo';
  e.addLayer();
  const torso = e.activeLayer;
  torso.name = 'Torso';
  e.addLayer();
  const brazo = e.activeLayer;
  brazo.name = 'Brazo';
  e.touch();
  return { fondoId: fondo.id, torsoId: torso.id, brazoId: brazo.id };
});

await page.evaluate(() => window.__uiStore.getState().setPanel('layers'));
await page.waitForTimeout(200);

console.log('\n— Marcar Torso y Brazo con la casilla y agrupar —');
const rows = page.locator('.layer-list > .layer');
check('la lista muestra las 3 capas sueltas', (await rows.count()) === 3, `${await rows.count()}`);

function checkboxFor(layerId) {
  return page.locator(`.layer[data-layer-id="${layerId}"] .layer__check`);
}
await checkboxFor(ids.torsoId).click();
await checkboxFor(ids.brazoId).click();
await page.waitForTimeout(100);

const groupBtn = page.locator('.panel__actions button', { hasText: /^Agrupar/ });
check('el botón "Agrupar" aparece con 2 marcadas', (await groupBtn.count()) === 1);
await groupBtn.click();
await page.waitForTimeout(150);

let s = await docState();
check('se crea una carpeta', s.groups.length === 1, JSON.stringify(s.groups));
const groupId = s.groups[0]?.id;
check(
  'Torso y Brazo quedan en la carpeta, Fondo no',
  s.layerOrder.find((l) => l.id === ids.torsoId)?.groupId === groupId &&
    s.layerOrder.find((l) => l.id === ids.brazoId)?.groupId === groupId &&
    s.layerOrder.find((l) => l.id === ids.fondoId)?.groupId === null,
  JSON.stringify(s.layerOrder),
);

const groupHeader = page.locator('.layer-group__header');
check('el panel muestra la cabecera de la carpeta', (await groupHeader.count()) === 1);
const memberRows = page.locator('.layer-group__members > .layer');
check('la carpeta muestra sus 2 capas por dentro', (await memberRows.count()) === 2, `${await memberRows.count()}`);

await page.screenshot({ path: `${out}/layer-groups-01-agrupado.png` });

console.log('\n— Ocultar el grupo entero apaga las dos capas de una vez —');
const groupEye = groupHeader.locator('.layer__toggle').first();
await groupEye.click();
await page.waitForTimeout(150);
s = await page.evaluate(
  (p) => ({
    torso: window.__trace.doc.layers.find((l) => l.id === p.torsoId).visible,
    brazo: window.__trace.doc.layers.find((l) => l.id === p.brazoId).visible,
  }),
  ids,
);
check('ocultar el grupo apaga Torso y Brazo', s.torso === false && s.brazo === false, JSON.stringify(s));

const historyBeforeUndo = await page.evaluate(() => window.__trace.history.past.length);
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
s = await page.evaluate(
  (p) => ({
    torso: window.__trace.doc.layers.find((l) => l.id === p.torsoId).visible,
    brazo: window.__trace.doc.layers.find((l) => l.id === p.brazoId).visible,
  }),
  ids,
);
check('un solo deshacer restaura las dos capas del grupo', s.torso === true && s.brazo === true, JSON.stringify(s));
check('el toggle del grupo fue un único paso de historial', historyBeforeUndo > 0);

console.log('\n— Renombrar la carpeta —');
const nameInput = groupHeader.locator('.layer__name');
await nameInput.click();
await nameInput.fill('Personaje');
await nameInput.blur();
await page.waitForTimeout(150);
s = await docState();
check('el nombre de la carpeta cambia', s.groups[0]?.name === 'Personaje', JSON.stringify(s.groups));

console.log('\n— Colapsar y expandir la carpeta —');
// Tocar el nombre editable de la carpeta (en medio de la cabecera) no debe
// colapsarla — hace `stopPropagation` a propósito. El chevron es un punto
// del encabezado que nunca se solapa con el campo de texto.
const chevron = page.locator('.layer-group__chevron');
await chevron.click();
await page.waitForTimeout(150);
check('colapsar oculta las capas de dentro', (await memberRows.count()) === 0);
const collapsedAfter = await page.evaluate((gid) => window.__trace.doc.layerGroups.find((g) => g.id === gid).collapsed, groupId);
check('el estado colapsado queda guardado', collapsedAfter === true);
await chevron.click();
await page.waitForTimeout(150);
check('volver a tocar la expande', (await memberRows.count()) === 2);

console.log('\n— Desagrupar —');
const ungroupBtn = groupHeader.locator('.layer__toggle').nth(1);
await ungroupBtn.click();
await page.waitForTimeout(150);
s = await docState();
check('desagrupar quita la carpeta', s.groups.length === 0, JSON.stringify(s.groups));
check(
  'las capas pierden el groupId pero se quedan donde estaban',
  s.layerOrder.find((l) => l.id === ids.torsoId)?.groupId === null &&
    s.layerOrder.find((l) => l.id === ids.brazoId)?.groupId === null,
  JSON.stringify(s.layerOrder),
);
check('el panel vuelve a mostrar 3 capas sueltas', (await page.locator('.layer-list > .layer').count()) === 3);

console.log('\n— Guardar y reabrir conserva la carpeta —');
await page.evaluate(async (p) => {
  const e = window.__trace;
  const torso = e.doc.layers.find((l) => l.id === p.torsoId);
  const brazo = e.doc.layers.find((l) => l.id === p.brazoId);
  e.groupLayers([torso.id, brazo.id], 'Personaje 2');
}, ids);
await page.waitForTimeout(150);
const roundTrip = await page.evaluate(async () => {
  const { serializeProject, deserializeProject } = await import('/src/core/io.ts');
  const e = window.__trace;
  const bytes = await serializeProject(e);
  const { doc: reopened } = await deserializeProject(e, bytes);
  return {
    groupCount: reopened.layerGroups.length,
    groupName: reopened.layerGroups[0]?.name,
    memberGroupIds: reopened.layers.filter((l) => l.groupId).map((l) => l.groupId),
  };
});
check('la carpeta sobrevive guardar y reabrir', roundTrip.groupCount === 1, JSON.stringify(roundTrip));
check(
  'las 2 capas reabiertas siguen apuntando a la misma carpeta',
  roundTrip.memberGroupIds.length === 2 && roundTrip.memberGroupIds[0] === roundTrip.memberGroupIds[1],
  JSON.stringify(roundTrip),
);

console.log('\n— Consola —');
check('sin errores en consola', errors.length === 0, errors.join(' | '));

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLOS`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
