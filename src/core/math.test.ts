/**
 * Unitarios de math.ts con el runner nativo de Node (`node --test`), sin
 * dependencia nueva: Node 22 ejecuta TypeScript directo, y estas funciones
 * son puras — ni DOM ni WebGL de por medio, así que no hace falta un
 * navegador para probarlas. Cubre justo lo que CLAUDE.md señalaba como
 * deuda ("las matemáticas de math.ts... hoy sólo se cubren de rebote").
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  lerp,
  snapAngle,
  mat3Identity,
  mat3Multiply,
  mat3FromTRS,
  mat3Invert,
  mat3Apply,
  hsvToRgb,
  rgbToHsv,
  rgbToHex,
  hexToRgb,
  OneEuroFilter,
} from './math.ts';

const closeTo = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('clamp', () => {
  test('deja pasar valores dentro del rango', () => {
    assert.equal(clamp(5, 0, 10), 5);
  });
  test('recorta por debajo', () => {
    assert.equal(clamp(-3, 0, 10), 0);
  });
  test('recorta por encima', () => {
    assert.equal(clamp(15, 0, 10), 10);
  });
});

describe('lerp', () => {
  test('t=0 da el primer valor', () => assert.equal(lerp(2, 8, 0), 2));
  test('t=1 da el segundo valor', () => assert.equal(lerp(2, 8, 1), 8));
  test('t=0.5 da el punto medio', () => assert.equal(lerp(2, 8, 0.5), 5));
  test('extrapola fuera de 0..1', () => assert.equal(lerp(0, 10, 2), 20));
});

describe('snapAngle', () => {
  test('redondea al incremento más cercano', () => {
    const step = Math.PI / 12; // 15°
    // 20° cae más cerca de 15° que de 30°.
    const twentyDeg = (20 * Math.PI) / 180;
    assert.ok(closeTo(snapAngle(twentyDeg, step), step));
  });
  test('un ángulo ya exacto no se mueve', () => {
    const step = Math.PI / 12;
    assert.ok(closeTo(snapAngle(step * 3, step), step * 3));
  });
});

describe('matrices 3x3', () => {
  test('la identidad no transforma un punto', () => {
    const p = mat3Apply(mat3Identity(), { x: 5, y: -3 });
    assert.ok(closeTo(p.x, 5) && closeTo(p.y, -3));
  });

  test('multiplicar por la identidad no cambia la matriz', () => {
    const m = mat3FromTRS(10, 20, 0.3, 2, 1.5);
    const out = mat3Multiply(m, mat3Identity());
    for (let i = 0; i < 9; i++) assert.ok(closeTo(out[i], m[i]));
  });

  test('traslación pura mueve el punto exactamente eso', () => {
    const m = mat3FromTRS(10, -5, 0, 1, 1);
    const p = mat3Apply(m, { x: 1, y: 1 });
    assert.ok(closeTo(p.x, 11) && closeTo(p.y, -4));
  });

  test('escala pura desde el origen', () => {
    const m = mat3FromTRS(0, 0, 0, 2, 3);
    const p = mat3Apply(m, { x: 4, y: 4 });
    assert.ok(closeTo(p.x, 8) && closeTo(p.y, 12));
  });

  test('rotación de 90° lleva (1,0) a (0,1)', () => {
    const m = mat3FromTRS(0, 0, Math.PI / 2, 1, 1);
    const p = mat3Apply(m, { x: 1, y: 0 });
    assert.ok(closeTo(p.x, 0) && closeTo(p.y, 1));
  });

  test('el origen de rotación no se mueve él mismo', () => {
    const m = mat3FromTRS(5, 5, Math.PI / 3, 1.4, 0.7, 100, 200);
    const p = mat3Apply(m, { x: 100, y: 200 });
    // Mat3 es un Float32Array: con coordenadas de origen grandes (100, 200)
    // el redondeo a precisión simple ronda 1e-6 en el resultado, más que el
    // eps por defecto de closeTo.
    assert.ok(closeTo(p.x, 105, 1e-3) && closeTo(p.y, 205, 1e-3));
  });

  test('invertir y aplicar deshace la transformación original', () => {
    const m = mat3FromTRS(12, -7, 0.9, 1.7, 0.6, 10, -3);
    const inv = mat3Invert(m);
    const original = { x: 33, y: -12 };
    const roundTrip = mat3Apply(inv, mat3Apply(m, original));
    assert.ok(closeTo(roundTrip.x, original.x, 1e-4));
    assert.ok(closeTo(roundTrip.y, original.y, 1e-4));
  });

  test('invertir una matriz singular no explota: devuelve la identidad', () => {
    // Escala 0 en un eje: determinante 0.
    const singular = mat3FromTRS(0, 0, 0, 0, 1);
    const inv = mat3Invert(singular);
    assert.deepEqual(Array.from(inv), Array.from(mat3Identity()));
  });
});

describe('color', () => {
  test('hsvToRgb de rojo puro', () => {
    const c = hsvToRgb(0, 1, 1);
    assert.ok(closeTo(c.r, 1) && closeTo(c.g, 0) && closeTo(c.b, 0));
  });

  test('hsvToRgb de un gris (s=0) da el mismo valor en los tres canales', () => {
    const c = hsvToRgb(0.37, 0, 0.6);
    assert.ok(closeTo(c.r, 0.6) && closeTo(c.g, 0.6) && closeTo(c.b, 0.6));
  });

  test('hsvToRgb / rgbToHsv hacen ida y vuelta', () => {
    for (const [h, s, v] of [
      [0.05, 0.8, 0.9],
      [0.5, 0.4, 0.7],
      [0.83, 1, 0.5],
    ]) {
      const rgb = hsvToRgb(h, s, v);
      const back = rgbToHsv(rgb);
      assert.ok(closeTo(back.h, h, 1e-4), `h: ${back.h} vs ${h}`);
      assert.ok(closeTo(back.s, s, 1e-4), `s: ${back.s} vs ${s}`);
      assert.ok(closeTo(back.v, v, 1e-4), `v: ${back.v} vs ${v}`);
    }
  });

  test('rgbToHsv de blanco puro no tiene saturación', () => {
    const hsv = rgbToHsv({ r: 1, g: 1, b: 1 });
    assert.equal(hsv.s, 0);
    assert.equal(hsv.v, 1);
  });

  test('rgbToHsv de negro puro no divide por cero', () => {
    const hsv = rgbToHsv({ r: 0, g: 0, b: 0 });
    assert.equal(hsv.s, 0);
    assert.equal(hsv.v, 0);
  });

  test('rgbToHex de rojo puro', () => {
    assert.equal(rgbToHex({ r: 1, g: 0, b: 0 }), '#ff0000');
  });

  test('rgbToHex recorta valores fuera de 0..1', () => {
    assert.equal(rgbToHex({ r: 2, g: -1, b: 0.5 }), '#ff0080');
  });

  test('hexToRgb de un color conocido', () => {
    const c = hexToRgb('#3366cc');
    assert.ok(closeTo(c.r, 0x33 / 255, 1e-3));
    assert.ok(closeTo(c.g, 0x66 / 255, 1e-3));
    assert.ok(closeTo(c.b, 0xcc / 255, 1e-3));
  });

  test('hexToRgb acepta sin almohadilla', () => {
    const c = hexToRgb('ff0000');
    assert.ok(closeTo(c.r, 1) && closeTo(c.g, 0) && closeTo(c.b, 0));
  });

  test('hexToRgb con formato inválido no lanza — devuelve negro', () => {
    assert.deepEqual(hexToRgb('no es un color'), { r: 0, g: 0, b: 0 });
  });

  test('rgbToHex / hexToRgb hacen ida y vuelta', () => {
    const original = { r: 0.2, g: 0.6, b: 0.9 };
    const back = hexToRgb(rgbToHex(original));
    assert.ok(closeTo(back.r, original.r, 1 / 255));
    assert.ok(closeTo(back.g, original.g, 1 / 255));
    assert.ok(closeTo(back.b, original.b, 1 / 255));
  });
});

describe('OneEuroFilter', () => {
  test('la primera muestra sale sin cambios', () => {
    const f = new OneEuroFilter();
    assert.equal(f.filter(10, 0), 10);
  });

  test('suaviza el ruido alrededor de un valor constante', () => {
    const f = new OneEuroFilter();
    let t = 0;
    let last = f.filter(10, t);
    // Ruido pequeño y constante en torno a 10, muestreado a 60 Hz.
    for (let i = 0; i < 60; i++) {
      t += 1000 / 60;
      const noisy = 10 + (i % 2 === 0 ? 0.5 : -0.5);
      last = f.filter(noisy, t);
    }
    // No elimina el ruido del todo, pero sí lo acerca mucho más a 10 de lo
    // que estaría una muestra sin filtrar (que oscila ±0.5).
    assert.ok(closeTo(last, 10, 0.3), `${last} debería rondar 10`);
  });

  test('reset() olvida el estado y la siguiente muestra vuelve a salir exacta', () => {
    const f = new OneEuroFilter();
    f.filter(10, 0);
    f.filter(50, 16);
    f.reset();
    assert.equal(f.filter(3, 100), 3);
  });

  test('sigue un salto grande sin quedarse pegado al valor anterior', () => {
    const f = new OneEuroFilter();
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += 16;
      f.filter(0, t);
    }
    let last = 0;
    for (let i = 0; i < 30; i++) {
      t += 16;
      last = f.filter(100, t);
    }
    assert.ok(last > 90, `${last} debería haber alcanzado el salto`);
  });
});
