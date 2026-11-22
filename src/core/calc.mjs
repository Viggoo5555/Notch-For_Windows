// The launcher answers a sum typed into it. This is the whole of that: four
// thousand characters of parser would be a library, so it is a small recursive
// descent over + - * / ( ) and a trailing percent, and nothing is evaluated with
// `eval`. It lives outside the window so test/calc.test.mjs can hold it to its
// answers.
//
//   2+2        → 4
//   10%        → 0.1
//   2,5 * 4    → 10      (a comma is a decimal point here)
//   2*(3+4)    → 14
//   anything else, or a division by zero → null

export function calcValue(text) {
  const source = String(text || '')
    .replace(/[×✕]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/,/g, '.')
    .replace(/\s+/g, '');
  if (!source || !/[0-9]/.test(source)) return null;
  if (!/^[0-9.+\-*/()%]+$/.test(source)) return null;
  let at = 0;
  const number = () => {
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(at));
    if (!match) throw new Error('number');
    at += match[0].length;
    return Number(match[0]);
  };
  const factor = () => {
    let sign = 1;
    while (source[at] === '-' || source[at] === '+') {
      if (source[at] === '-') sign = -sign;
      at += 1;
    }
    let value;
    if (source[at] === '(') {
      at += 1;
      value = sum();
      if (source[at] !== ')') throw new Error('bracket');
      at += 1;
    } else {
      value = number();
    }
    let percent = false;
    while (source[at] === '%') {
      at += 1;
      percent = true;
    }
    return sign * (percent ? value / 100 : value);
  };
  const product = () => {
    let value = factor();
    while (source[at] === '*' || source[at] === '/') {
      const op = source[at];
      at += 1;
      const right = factor();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };
  const sum = () => {
    let value = product();
    while (source[at] === '+' || source[at] === '-') {
      const op = source[at];
      at += 1;
      const right = product();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  try {
    const value = sum();
    // A whole query has to be read, and a result has to be a number: anything
    // left over is not a sum, and infinity is not an answer.
    if (at !== source.length || !Number.isFinite(value)) return null;
    // Long decimals are noise in a launcher, not information.
    return String(Math.round(value * 1e10) / 1e10);
  } catch {
    return null;
  }
}
