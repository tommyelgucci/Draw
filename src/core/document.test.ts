/**
 * Unitarios de document.ts (funciones puras: canales animados, cels, grupos
 * de recorte) con el runner nativo de Node, mismo criterio que math.test.ts.
 * Sólo lo que no toca `Surface`/WebGL — el resto ya lo cubren los tests de
 * Playwright que dibujan de verdad.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  channel,
  sampleChannel,
  setKeyframe,
  removeKeyframe,
  newTransform,
  transformIsIdentity,
  hasAnyKeyframes,
  pickVariant,
  newLayer,
  newDocument,
  uid,
  celAt,
  celStartFrame,
  celHoldLength,
  sortedCelFrames,
  layerIndexById,
  buildClipGroups,
  frameToTimecode,
  clampFrame,
  type Cel,
  type Layer,
} from './document.ts';

/** Cel de mentira: celAt/celStartFrame/celHoldLength sólo miran las claves
 * del Map, nunca `.surface` — evita tener que montar un `Surface` de WebGL
 * real para probar código que no lo toca. */
const stubCel = (label = ''): Cel => ({ id: uid('cel'), label }) as unknown as Cel;

describe('canales animados', () => {
  test('channel() empieza sin keyframes, con el valor base', () => {
    const ch = channel(3);
    assert.equal(ch.base, 3);
    assert.deepEqual(ch.keys, []);
  });

  describe('sampleChannel', () => {
    test('sin keyframes, devuelve siempre el valor base', () => {
      const ch = channel(7);
      assert.equal(sampleChannel(ch, 0), 7);
      assert.equal(sampleChannel(ch, 100), 7);
    });

    test('antes del primer keyframe, se mantiene en su valor', () => {
      const ch = channel(0);
      setKeyframe(ch, 10, 5);
      assert.equal(sampleChannel(ch, 0), 5);
    });

    test('después del último keyframe, se mantiene en su valor', () => {
      const ch = channel(0);
      setKeyframe(ch, 10, 5);
      assert.equal(sampleChannel(ch, 999), 5);
    });

    test('interpola en línea recta entre dos keyframes con easing lineal', () => {
      const ch = channel(0);
      setKeyframe(ch, 0, 0, 'linear');
      setKeyframe(ch, 10, 100, 'linear');
      assert.equal(sampleChannel(ch, 5), 50);
    });

    test('el easing lo decide el keyframe de salida, no el de llegada', () => {
      const ch = channel(0);
      setKeyframe(ch, 0, 0, 'easeIn'); // t*t: en t=0.5 da 0.25, no 0.5
      setKeyframe(ch, 10, 100, 'linear');
      assert.equal(sampleChannel(ch, 5), 25);
    });

    test('easing "hold" mantiene el valor de salida hasta el siguiente keyframe', () => {
      const ch = channel(0);
      setKeyframe(ch, 0, 1, 'hold');
      setKeyframe(ch, 10, 9, 'hold');
      assert.equal(sampleChannel(ch, 1), 1);
      assert.equal(sampleChannel(ch, 9), 1);
      assert.equal(sampleChannel(ch, 10), 9); // el salto ocurre justo en el keyframe siguiente
    });
  });

  describe('setKeyframe', () => {
    test('añade un keyframe nuevo y mantiene la lista ordenada', () => {
      const ch = channel(0);
      setKeyframe(ch, 10, 1);
      setKeyframe(ch, 0, 2);
      setKeyframe(ch, 5, 3);
      assert.deepEqual(
        ch.keys.map((k) => k.frame),
        [0, 5, 10],
      );
    });

    test('actualizar un keyframe existente conserva su easing anterior', () => {
      const ch = channel(0);
      setKeyframe(ch, 5, 1, 'easeIn');
      // El easing que se pasa aquí se ignora: sólo cambia el valor.
      setKeyframe(ch, 5, 2, 'linear');
      assert.equal(ch.keys.length, 1);
      assert.equal(ch.keys[0].value, 2);
      assert.equal(ch.keys[0].easing, 'easeIn');
    });
  });

  test('removeKeyframe quita el keyframe de ese fotograma y no toca los demás', () => {
    const ch = channel(0);
    setKeyframe(ch, 0, 1);
    setKeyframe(ch, 10, 2);
    removeKeyframe(ch, 0);
    assert.deepEqual(
      ch.keys.map((k) => k.frame),
      [10],
    );
  });

  test('removeKeyframe sobre un fotograma sin keyframe no hace nada', () => {
    const ch = channel(0);
    setKeyframe(ch, 10, 2);
    removeKeyframe(ch, 999);
    assert.equal(ch.keys.length, 1);
  });
});

describe('transformIsIdentity / hasAnyKeyframes', () => {
  test('un transform recién creado es identidad y no tiene keyframes', () => {
    const t = newTransform();
    assert.ok(transformIsIdentity(t, 0));
    assert.equal(hasAnyKeyframes(t), false);
  });

  test('un keyframe en cualquier canal de posición/escala/rotación rompe la identidad', () => {
    const t = newTransform();
    setKeyframe(t.rotation, 0, 0.4);
    assert.equal(transformIsIdentity(t, 0), false);
    assert.equal(hasAnyKeyframes(t), true);
  });

  test('la opacidad no cuenta para transformIsIdentity', () => {
    const t = newTransform();
    setKeyframe(t.opacity, 0, 0.3);
    assert.ok(transformIsIdentity(t, 0));
    assert.equal(hasAnyKeyframes(t), true); // pero sí cuenta como "tiene keyframes"
  });
});

describe('pickVariant', () => {
  const fakeLayer = (swap: Layer['swap']): Layer => ({ swap }) as unknown as Layer;

  test('sin catálogo de intercambio, devuelve null', () => {
    assert.equal(pickVariant(fakeLayer(undefined), 0), null);
  });

  test('con catálogo vacío, devuelve null', () => {
    assert.equal(pickVariant(fakeLayer({ variants: [], selected: channel(0) }), 0), null);
  });

  test('devuelve la variante seleccionada en ese fotograma', () => {
    const selected = channel(0);
    setKeyframe(selected, 0, 0, 'hold');
    setKeyframe(selected, 5, 1, 'hold');
    const layer = fakeLayer({
      variants: [
        { id: 'a', label: 'Ojo abierto', surface: {} as never },
        { id: 'b', label: 'Ojo cerrado', surface: {} as never },
      ],
      selected,
    });
    assert.equal(pickVariant(layer, 0)?.id, 'a');
    assert.equal(pickVariant(layer, 5)?.id, 'b');
  });

  test('un índice fuera de rango cae en la primera variante', () => {
    const selected = channel(99);
    const layer = fakeLayer({
      variants: [{ id: 'unica', label: '', surface: {} as never }],
      selected,
    });
    assert.equal(pickVariant(layer, 0)?.id, 'unica');
  });
});

describe('newLayer / newDocument / uid', () => {
  test('newLayer trae valores por defecto sensatos', () => {
    const l = newLayer('Trazo');
    assert.equal(l.name, 'Trazo');
    assert.equal(l.kind, 'draw');
    assert.equal(l.visible, true);
    assert.equal(l.locked, false);
    assert.equal(l.opacity, 1);
    assert.equal(l.blend, 'normal');
    assert.equal(l.clipToBelow, false);
    assert.equal(l.animated, true);
    assert.equal(l.cels.size, 0);
    assert.ok(transformIsIdentity(l.transform, 0));
  });

  test('newLayer respeta animated=false y el tipo de capa', () => {
    const l = newLayer('Fondo', false, 'reference');
    assert.equal(l.animated, false);
    assert.equal(l.kind, 'reference');
  });

  test('newDocument trae valores por defecto sensatos', () => {
    const doc = newDocument();
    assert.equal(doc.width, 1920);
    assert.equal(doc.height, 1080);
    assert.equal(doc.fps, 12);
    assert.equal(doc.frameCount, 24);
    assert.deepEqual(doc.layers, []);
    assert.deepEqual(doc.paper, { r: 1, g: 1, b: 1 });
    assert.equal(doc.paperAlpha, 1);
  });

  test('newDocument acepta tamaño/fps/duración explícitos', () => {
    const doc = newDocument(100, 200, 30, 60);
    assert.equal(doc.width, 100);
    assert.equal(doc.height, 200);
    assert.equal(doc.fps, 30);
    assert.equal(doc.frameCount, 60);
  });

  test('uid da ids con el prefijo pedido, únicos entre sí', () => {
    const a = uid('capa');
    const b = uid('capa');
    assert.ok(a.startsWith('capa_'));
    assert.ok(b.startsWith('capa_'));
    assert.notEqual(a, b);
  });
});

describe('cels', () => {
  test('celAt en una capa animada sin cels devuelve null', () => {
    const l = newLayer('x');
    assert.equal(celAt(l, 0), null);
  });

  test('celAt devuelve el cel más reciente en o antes del fotograma pedido', () => {
    const l = newLayer('x');
    const c0 = stubCel('inicio');
    const c10 = stubCel('diez');
    l.cels.set(0, c0);
    l.cels.set(10, c10);
    assert.equal(celAt(l, 0), c0);
    assert.equal(celAt(l, 5), c0); // se sostiene hasta el siguiente cel
    assert.equal(celAt(l, 10), c10);
    assert.equal(celAt(l, 500), c10);
  });

  test('celAt antes de cualquier cel devuelve null', () => {
    const l = newLayer('x');
    l.cels.set(10, stubCel());
    assert.equal(celAt(l, 5), null);
  });

  test('celAt en una capa no animada ignora el fotograma pedido', () => {
    const l = newLayer('fondo', false);
    const c = stubCel();
    l.cels.set(7, c); // la posición de la clave es irrelevante si animated=false
    assert.equal(celAt(l, 0), c);
    assert.equal(celAt(l, 9999), c);
  });

  test('celStartFrame refleja el fotograma del cel visible, o -1', () => {
    const l = newLayer('x');
    assert.equal(celStartFrame(l, 0), -1);
    l.cels.set(0, stubCel());
    l.cels.set(10, stubCel());
    assert.equal(celStartFrame(l, 5), 0);
    assert.equal(celStartFrame(l, 10), 10);
  });

  test('celHoldLength llega hasta el siguiente cel o el final de la animación', () => {
    const l = newLayer('x');
    l.cels.set(0, stubCel());
    l.cels.set(10, stubCel());
    assert.equal(celHoldLength(l, 0, 24), 10);
    assert.equal(celHoldLength(l, 10, 24), 14);
  });

  test('celHoldLength en una capa no animada dura la animación entera', () => {
    const l = newLayer('fondo', false);
    l.cels.set(0, stubCel());
    assert.equal(celHoldLength(l, 0, 100), 100);
  });

  test('sortedCelFrames devuelve los fotogramas en orden, sin importar cómo se insertaron', () => {
    const l = newLayer('x');
    l.cels.set(20, stubCel());
    l.cels.set(0, stubCel());
    l.cels.set(10, stubCel());
    assert.deepEqual(sortedCelFrames(l), [0, 10, 20]);
  });
});

describe('layerIndexById', () => {
  test('encuentra el índice de una capa por id', () => {
    const doc = newDocument();
    const a = newLayer('a');
    const b = newLayer('b');
    doc.layers.push(a, b);
    assert.equal(layerIndexById(doc, b.id), 1);
  });

  test('devuelve -1 si no existe', () => {
    const doc = newDocument();
    assert.equal(layerIndexById(doc, 'no-existe'), -1);
  });
});

describe('buildClipGroups', () => {
  test('sin clipToBelow, cada capa es su propio grupo', () => {
    const a = newLayer('a');
    const b = newLayer('b');
    const groups = buildClipGroups([a, b]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].clipped, []);
    assert.deepEqual(groups[1].clipped, []);
  });

  test('las capas con clipToBelow se cuelgan de la base anterior', () => {
    const base = newLayer('base');
    const clip1 = newLayer('clip1');
    clip1.clipToBelow = true;
    const clip2 = newLayer('clip2');
    clip2.clipToBelow = true;
    const other = newLayer('otra');
    const groups = buildClipGroups([base, clip1, clip2, other]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].base, base);
    assert.deepEqual(groups[0].clipped, [clip1, clip2]);
    assert.equal(groups[1].base, other);
  });

  test('una primera capa con clipToBelow, sin nada debajo, se vuelve su propia base', () => {
    const first = newLayer('primera');
    first.clipToBelow = true;
    const groups = buildClipGroups([first]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].base, first);
  });
});

describe('frameToTimecode', () => {
  test('el fotograma 0 es 00:00+00', () => {
    assert.equal(frameToTimecode(0, 24), '00:00+00');
  });

  test('cuenta minutos, segundos y fotogramas sueltos', () => {
    // 24fps, fotograma 24*65 + 5 = 1565 -> 1 min, 5 s, 5 fotogramas
    assert.equal(frameToTimecode(24 * 65 + 5, 24), '01:05+05');
  });
});

describe('clampFrame', () => {
  test('recorta por debajo de 0', () => {
    const doc = newDocument(1, 1, 12, 24);
    assert.equal(clampFrame(doc, -5), 0);
  });

  test('recorta al último fotograma válido', () => {
    const doc = newDocument(1, 1, 12, 24);
    assert.equal(clampFrame(doc, 999), 23);
  });

  test('redondea valores no enteros', () => {
    const doc = newDocument(1, 1, 12, 24);
    assert.equal(clampFrame(doc, 5.6), 6);
  });
});
