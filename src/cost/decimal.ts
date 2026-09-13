interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function normalize(fraction: Fraction): Fraction {
  if (fraction.denominator === 0n) throw new Error("decimal denominator must not be zero");
  const sign = fraction.denominator < 0n ? -1n : 1n;
  const numerator = fraction.numerator * sign;
  const denominator = fraction.denominator * sign;
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function expandExponent(value: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (match === null) return value;
  const sign = match[1] === "-" ? "-" : "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]);
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

export function decimalTextToFraction(value: string): Fraction {
  const normalizedText = expandExponent(value);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalizedText);
  if (match === null) throw new Error(`unsupported decimal '${value}'`);
  const negative = match[1] === "-";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const numerator = BigInt(`${integer}${fraction}` || "0") * (negative ? -1n : 1n);
  return normalize({ numerator, denominator: pow10(fraction.length) });
}

export function numberToFraction(value: number): Fraction {
  if (!Number.isFinite(value)) throw new Error("number must be finite");
  return decimalTextToFraction(String(value));
}

export function multiplyRate(amount: string, units: number, per: number): Fraction {
  const rate = decimalTextToFraction(amount);
  const quantity = numberToFraction(units);
  return normalize({
    numerator: rate.numerator * quantity.numerator,
    denominator: rate.denominator * quantity.denominator * BigInt(per)
  });
}

export function addFractions(left: Fraction, right: Fraction): Fraction {
  return normalize({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  });
}


export function subtractFractions(left: Fraction, right: Fraction): Fraction {
  return normalize({
    numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  });
}

export function compareFractions(left: Fraction, right: Fraction): number {
  const l = normalize(left);
  const r = normalize(right);
  const leftScaled = l.numerator * r.denominator;
  const rightScaled = r.numerator * l.denominator;
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

export function zeroFraction(): Fraction {
  return { numerator: 0n, denominator: 1n };
}

export function fractionToExactDecimal(input: Fraction): string | undefined {
  const fraction = normalize(input);
  if (fraction.numerator === 0n) return "0";

  let denominator = fraction.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n) return undefined;

  const scale = Math.max(twos, fives);
  const multiplyByTwo = scale - twos;
  const multiplyByFive = scale - fives;
  let scaled = fraction.numerator;
  if (multiplyByTwo > 0) scaled *= 2n ** BigInt(multiplyByTwo);
  if (multiplyByFive > 0) scaled *= 5n ** BigInt(multiplyByFive);

  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  let digits = absolute.toString().padStart(scale + 1, "0");
  let output: string;
  if (scale === 0) {
    output = digits;
  } else {
    const integer = digits.slice(0, -scale) || "0";
    const fractionDigits = digits.slice(-scale).replace(/0+$/, "");
    output = fractionDigits.length === 0 ? integer : `${integer}.${fractionDigits}`;
  }
  return negative ? `-${output}` : output;
}

export function numberToPlainDecimal(value: number): string {
  const exact = fractionToExactDecimal(numberToFraction(value));
  if (exact === undefined) throw new Error("number cannot be represented as a finite decimal");
  return exact;
}
