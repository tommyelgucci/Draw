/**
 * Unitarios de las funciones puras de selection.ts: `shapeBounds`,
 * `unionRect`, `rectCorners`. `rasterizeSelection`/`rasterizeMask` quedan
 * fuera a propósito — necesitan `document.createElement('canvas')`, y ya
 * los cubren los tests de Playwright (scripts/selection.mjs,
 * scripts/select-wand.mjs) dibujando de verdad.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shapeBounds, unionRect, rectCorners } from './selection.ts';
import { emptyRect, rectIsEmpty, type Rect } from './types.ts';

describe('shapeBounds', () => {
  test('rect: envuelve los dos puntos extremos con un píxel de holgura', () => {
    const r = shapeBounds('rect', [{ x: 10, y: 20 }, { x: 50, y: 80 }], 1000, 1000);
    assert.deepEqual(r, { x: 9, y: 19, x2: 51, y2: 81 });
  });

  test('rect: funciona igual si los puntos van en orden inverso', () => {
    const r = shapeBounds('rect', [{ x: 50, y: 80 }, { x: 10, y: 20 }], 1000, 1000);
    assert.deepEqual(r, { x: 9, y: 19, x2: 51, y2: 81 });
  });

  test('lasso: considera todos los puntos, no sólo los extremos', () => {
    const r = shapeBounds(
      'lasso',
      [{ x: 10, y: 10 }, { x: 90, y: 15 }, { x: 40, y: 5 }, { x: 20, y: 90 }],
      1000,
      1000,
    );
    assert.deepEqual(r, { x: 9, y: 4, x2: 91, y2: 91 });
  });

  test('recorta al tamaño del documento', () => {
    const r = shapeBounds('rect', [{ x: -50, y: -50 }, { x: 5, y: 5 }], 100, 100);
    assert.deepEqual(r, { x: 0, y: 0, x2: 6, y2: 6 });

    const r2 = shapeBounds('rect', [{ x: 90, y: 90 }, { x: 500, y: 500 }], 100, 100);
    assert.deepEqual(r2, { x: 89, y: 89, x2: 100, y2: 100 });
  });
});

describe('unionRect', () => {
  test('une dos rectángulos disjuntos en su envolvente', () => {
    const a: Rect = { x: 0, y: 0, x2: 10, y2: 10 };
    const b: Rect = { x: 100, y: 100, x2: 110, y2: 110 };
    assert.deepEqual(unionRect(a, b), { x: 0, y: 0, x2: 110, y2: 110 });
  });

  test('un rectángulo vacío no afecta la unión (identidad)', () => {
    const a: Rect = { x: 5, y: 5, x2: 15, y2: 15 };
    assert.deepEqual(unionRect(a, emptyRect()), a);
    assert.deepEqual(unionRect(emptyRect(), a), a);
  });

  test('rectángulos solapados dan la envolvente combinada', () => {
    const a: Rect = { x: 0, y: 0, x2: 10, y2: 10 };
    const b: Rect = { x: 5, y: 5, x2: 20, y2: 8 };
    assert.deepEqual(unionRect(a, b), { x: 0, y: 0, x2: 20, y2: 10 });
  });
});

describe('rectCorners', () => {
  test('devuelve las cuatro esquinas en orden horario desde arriba-izquierda', () => {
    const r: Rect = { x: 10, y: 20, x2: 110, y2: 220 };
    assert.deepEqual(rectCorners(r), [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 220 },
      { x: 10, y: 220 },
    ]);
  });
});

// rectIsEmpty/emptyRect no son de selection.ts, pero se usan arriba como
// utilidades — un vistazo rápido para no dar por sentado su contrato.
describe('emptyRect / rectIsEmpty (types.ts)', () => {
  test('emptyRect() se reporta vacío', () => {
    assert.ok(rectIsEmpty(emptyRect()));
  });

  test('un rectángulo con área no se reporta vacío', () => {
    assert.equal(rectIsEmpty({ x: 0, y: 0, x2: 1, y2: 1 }), false);
  });
});
