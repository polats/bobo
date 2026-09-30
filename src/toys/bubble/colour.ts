// Thin-film interference colour of a soap film as a function of its thickness, precomputed once.
// A free-standing film (n = 1.33 in air) reflects two main beams, one off each face; the front one
// flips phase, so a film much thinner than the wavelength cancels itself out (black film). We use
// the exact Airy sum for the symmetric film (the two-beam term plus its tiny multiple-bounce
// correction), integrate it over the visible spectrum under a 6500 K light with the CIE 1931
// observer (Wyman, Sloan & Shirley's analytic fit) and convert to linear sRGB.

export const FILM_N = 1.33;
/** Thickness range covered by the lookup texture, micrometres. */
export const LUT_MAX_UM = 3;
export const LUT_SIZE = 1024;

// Multi-lobe Gaussian fit to the CIE 1931 2° observer: [amplitude, mean nm, 1/width below, 1/width above].
const XF = [[0.362, 442.0, 0.0624, 0.0374], [1.056, 599.8, 0.0264, 0.0323], [-0.065, 501.1, 0.049, 0.0382]];
const YF = [[0.821, 568.8, 0.0213, 0.0247], [0.286, 530.9, 0.0613, 0.0322]];
const ZF = [[1.217, 437.0, 0.0845, 0.0278], [0.681, 459.0, 0.0385, 0.0725]];
function lobes(f: number[][], l: number) {
  let s = 0;
  for (const [a, m, g, d] of f) {
    const t = (l - m) * (l < m ? g : d);
    s += a * Math.exp(-0.5 * t * t);
  }
  return s;
}

/** Relative spectral power of a 6500 K blackbody (a stand-in for daylight through a window). */
function planck(lnm: number, T = 6500) {
  const l = lnm * 1e-9;
  return 1 / (l ** 5 * (Math.exp(1.4388e-2 / (l * T)) - 1));
}

/** Reflectance of the film at one wavelength: Airy sum with amplitude r at each face. */
export function filmReflectance(dNm: number, lNm: number, cosT = 1) {
  const r = (1 - FILM_N) / (1 + FILM_N);
  const r2 = r * r;
  const delta = (4 * Math.PI * FILM_N * dNm * cosT) / lNm;
  const c = Math.cos(delta);
  return (2 * r2 * (1 - c)) / (1 + r2 * r2 - 2 * r2 * c);
}

/** Linear-sRGB reflected colour of a film `dNm` thick, normalised so a perfect mirror is (1,1,1). */
export function filmRGB(dNm: number): [number, number, number] {
  let X = 0, Y = 0, Z = 0, N = 0;
  for (let l = 380; l <= 780; l += 4) {
    const s = planck(l);
    const R = filmReflectance(dNm, l);
    const y = lobes(YF, l);
    X += R * s * lobes(XF, l);
    Y += R * s * y;
    Z += R * s * lobes(ZF, l);
    N += s * y;
  }
  X /= N;
  Y /= N;
  Z /= N;
  // XYZ -> linear sRGB (D65 white; the 6500 K blackbody is close enough to leave unadapted).
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
}

/** RGBA16F-ready table over 0..LUT_MAX_UM: rgb = reflected colour, a = luminance. */
export function buildLut(): Float32Array {
  const out = new Float32Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const d = (i / (LUT_SIZE - 1)) * LUT_MAX_UM * 1000;
    const [r, g, b] = filmRGB(d);
    out.set([r, g, b, 0.2126 * r + 0.7152 * g + 0.0722 * b], i * 4);
  }
  return out;
}
