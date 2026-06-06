export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface CandleSeries {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  times: number[];
}

export function toSeries(klines: Kline[]): CandleSeries {
  return {
    closes: klines.map((k) => k.close),
    highs: klines.map((k) => k.high),
    lows: klines.map((k) => k.low),
    volumes: klines.map((k) => k.volume),
    times: klines.map((k) => k.openTime),
  };
}

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      out.push(values[0]);
      continue;
    }
    const prev = out[i - 1];
    out.push(values[i] * k + prev * (1 - k));
  }
  return out;
}

export function stddev(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(NaN);
      continue;
    }
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance =
      slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    out.push(Math.sqrt(variance));
  }
  return out;
}

export function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function bollinger(
  closes: number[],
  period: number,
  stdMult: number,
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = sma(closes, period);
  const sd = stddev(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (Number.isNaN(middle[i]) || Number.isNaN(sd[i])) {
      upper.push(NaN);
      lower.push(NaN);
    } else {
      upper.push(middle[i] + stdMult * sd[i]);
      lower.push(middle[i] - stdMult * sd[i]);
    }
  }
  return { upper, middle, lower };
}

export function macd(
  closes: number[],
): { macd: number[]; signal: number[]; hist: number[] } {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal = ema(macdLine, 9);
  const hist = macdLine.map((v, i) => v - signal[i]);
  return { macd: macdLine, signal, hist };
}

export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number[] {
  const tr: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      tr.push(highs[i] - lows[i]);
    } else {
      tr.push(
        Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1]),
        ),
      );
    }
  }
  return sma(tr, period);
}
