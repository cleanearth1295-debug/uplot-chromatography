export function fUpperTail(f: number, modelDf: number, residualDf: number): number {
  if (f === Infinity) return 0;
  if (f === 0) return 1;
  const x = 1 / (1 + (modelDf / residualDf) * f);
  return regularizedBeta(x, residualDf / 2, modelDf / 2);
}

// Lanczos approximation evaluated only at positive arguments.
function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  const shifted = value - 1;
  const sum = coefficients.reduce((acc, coefficient, index) => acc + coefficient / (shifted + index + 1), 0.9999999999998099);
  const scale = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(scale) - scale + Math.log(sum);
}

// The continued fraction uses the modified Lentz method. Symmetry keeps
// evaluation on the faster-converging side of the beta integral.
function betaFraction(x: number, a: number, b: number): number {
  const floor = (value: number) => Math.abs(value) < 1e-300 ? (value < 0 ? -1e-300 : 1e-300) : value;
  let c = 1;
  let d = 1 / floor(1 - (a + b) * x / (a + 1));
  let fraction = d;
  for (let index = 1; index <= 200; index++) {
    const twice = 2 * index;
    const even = index * (b - index) * x / ((a + twice - 1) * (a + twice));
    d = 1 / floor(1 + even * d);
    c = floor(1 + even / c);
    fraction *= d * c;

    const odd = -(a + index) * (a + b + index) * x / ((a + twice) * (a + twice + 1));
    d = 1 / floor(1 + odd * d);
    c = floor(1 + odd / c);
    const correction = d * c;
    fraction *= correction;
    if (Math.abs(correction - 1) <= 4 * Number.EPSILON) break;
  }
  return fraction;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return x;
  const logScale = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const scale = Math.exp(logScale);
  const result = x < (a + 1) / (a + b + 2) ? scale * betaFraction(x, a, b) / a :
    1 - scale * betaFraction(1 - x, b, a) / b;
  return Math.min(1, Math.max(0, result));
}
