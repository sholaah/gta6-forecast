// Launch-day Twitch curve transfer: a quantile forecast for a game launch's first UTC
// day, built from the launch-day shapes of the comparable launches in the case file.
//
// The house baseline is persistence: every hour equals hour 1, with a spread that grows
// like a random walk's. Real launch days are not flat — they climb as the big viewing
// regions wake and peak in the US evening — and the comparables in each case file carry
// that shape. This program transfers it:
//
//   1. For every comparable with a usable launch day, take the log ratio of each hour's
//      viewers to its own hour 1: l_c(h) = ln(v_c(h) / v_c(1)).
//   2. Weight each comparable by scale similarity to this case (a launch whose hour 1
//      is near this case's hour 1 behaves more like it), with a floor so every launch
//      still informs the tails.
//   3. The weighted median of l_c(h) is the day's shape L(h); the weighted median
//      absolute deviation around it, blended with the baseline's random-walk spread,
//      is the hour's uncertainty sigma(h).
//   4. q_tau(h) = p1 * exp(L(h) + z_tau * sigma(h)), p1 being hour 1's print.
//
// Everything is a pure function of the case file: no clock, no randomness, no network,
// so the grader's two runs agree byte for byte. If a case carries too few usable
// comparables, the program falls back to the persistence baseline itself rather than
// invent a shape it cannot support.
//
//   MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, and the standard normal's quantile at each. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** The baseline's spread, in natural-log units per square-root hour past hour 1. */
const BASE_SIGMA = 0.15;
/** A comparable's weight never falls below this, however far its scale is from the case. */
const WEIGHT_FLOOR = 0.15;
/** How fast scale similarity decays: a launch e^1.2 times bigger or smaller weighs 1/e. */
const SCALE_DECAY = 1.2;
/** Fewer usable comparables than this and the shape is not trustworthy: use the baseline. */
const MIN_COMPARABLES = 5;

interface HourPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  day_start: string;
  hourly: HourPoint[];
}

interface CaseFile {
  id: string;
  day_start: string;
  known: unknown;
  forecast: { hour: number }[];
  comparables: Comparable[];
}

/** Hour 1's print: `known` is one print object or a list holding it. Below 1 counts as 1. */
export function hourOnePrint(known: unknown): number {
  const rows = Array.isArray(known) ? known : [known];
  for (const row of rows) {
    const r = row as { hour?: number; viewers?: number };
    if (r && (r.hour === 1 || r.hour === undefined) && typeof r.viewers === 'number') {
      return Math.max(1, r.viewers);
    }
  }
  return 1;
}

/**
 * A comparable's launch-day viewers by hour (1..24), read from its hourly points that
 * fall inside [day_start, day_start + 24h). Missing hours are filled by interpolation
 * in log space between the nearest present neighbours, edges carried flat. Returns null
 * when hour 1 is missing or fewer than 14 of the 24 hours are present.
 */
export function launchDayCurve(comp: Comparable): number[] | null {
  const start = Date.parse(comp.day_start);
  if (!Number.isFinite(start)) return null;
  const byHour = new Map<number, number>();
  for (const p of comp.hourly || []) {
    const t = Date.parse(p.from);
    if (!Number.isFinite(t)) continue;
    const hour = Math.floor((t - start) / 3600_000) + 1;
    if (hour < 1 || hour > 24) continue;
    if (typeof p.viewers === 'number' && p.viewers > 0) byHour.set(hour, p.viewers);
  }
  if (!byHour.has(1) || byHour.size < 14) return null;
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const curve: number[] = new Array(25).fill(0);
  for (let h = 1; h <= 24; h++) {
    if (byHour.has(h)) {
      curve[h] = byHour.get(h) as number;
      continue;
    }
    let lo = 0;
    let hi = 0;
    for (const k of hours) {
      if (k < h) lo = k;
      if (k > h && hi === 0) hi = k;
    }
    if (lo && hi) {
      const a = Math.log(byHour.get(lo) as number);
      const b = Math.log(byHour.get(hi) as number);
      curve[h] = Math.exp(a + ((b - a) * (h - lo)) / (hi - lo));
    } else if (lo) {
      curve[h] = byHour.get(lo) as number;
    } else {
      curve[h] = byHour.get(hi) as number;
    }
  }
  return curve;
}

/** The weighted median of values with positive weights. */
export function weightedMedian(values: number[], weights: number[]): number {
  const pairs = values.map((v, i) => [v, weights[i]] as const).sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return pairs[pairs.length - 1][0];
}

/**
 * The transferred day shape and spread for one case: for each hour 2..24, the weighted
 * median log ratio L(h) across usable comparables and the blended sigma(h). Returns null
 * when too few comparables are usable, so the caller can fall back to the baseline.
 */
export function buildProfile(comparables: Comparable[], p1: number): { L: number[]; sigma: number[] } | null {
  const curves: { logRatio: number[]; weight: number }[] = [];
  for (const comp of comparables || []) {
    const curve = launchDayCurve(comp);
    if (!curve) continue;
    const scaleGap = Math.abs(Math.log(curve[1] / p1));
    const weight = Math.max(WEIGHT_FLOOR, Math.exp(-scaleGap / SCALE_DECAY));
    const logRatio = curve.map((v, h) => (h === 0 ? 0 : Math.log(Math.max(1, v) / curve[1])));
    curves.push({ logRatio, weight });
  }
  if (curves.length < MIN_COMPARABLES) return null;
  const L = new Array(25).fill(0);
  const sigma = new Array(25).fill(0);
  for (let h = 2; h <= 24; h++) {
    const values = curves.map((c) => c.logRatio[h]);
    const weights = curves.map((c) => c.weight);
    const med = weightedMedian(values, weights);
    L[h] = med;
    const deviations = values.map((v) => Math.abs(v - med));
    const mad = weightedMedian(deviations, weights);
    const empirical = 1.4826 * mad;
    const walk = BASE_SIGMA * Math.sqrt(h - 1);
    sigma[h] = Math.min(0.9, Math.max(0.1, 0.7 * empirical + 0.3 * walk));
  }
  return { L, sigma };
}

/** The persistence baseline's quantiles for one hour, exactly as the house defines it. */
export function baselineQuantiles(p1: number, h: number): number[] {
  const s = BASE_SIGMA * Math.sqrt(h - 1);
  return Z.map((z) => round2(p1 * Math.exp(z * s)));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Forecast one case: 23 rows for hours 2..24, five quantiles each, non-decreasing. */
export function forecastCase(caseFile: CaseFile): { hours: { hour: number; q: number[] }[] } {
  const p1 = hourOnePrint(caseFile.known);
  const profile = buildProfile(caseFile.comparables || [], p1);
  const wanted = (caseFile.forecast || []).map((f) => f.hour).filter((h) => h >= 2 && h <= 24);
  const hours = (wanted.length ? [...new Set(wanted)].sort((a, b) => a - b) : Array.from({ length: 23 }, (_, i) => i + 2)).map(
    (h) => {
      if (!profile) return { hour: h, q: baselineQuantiles(p1, h) };
      const q = Z.map((z) => round2(Math.min(1e9, Math.max(0.01, p1 * Math.exp(profile.L[h] + z * profile.sigma[h])))));
      q.sort((a, b) => a - b);
      return { hour: h, q };
    },
  );
  return { hours };
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const files = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in'));
  for (const file of files) {
    const caseFile = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
    const out = forecastCase(caseFile);
    writeFileSync(join(OUTPUT_DIR, `${caseFile.id}.out`), JSON.stringify(out));
  }
}

// Run only when executed as the entry program, not when imported by a test harness.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
