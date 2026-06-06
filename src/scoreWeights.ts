import fs from "node:fs";
import path from "node:path";

export interface ScoreWeights {
  rsiStrong: number;
  rsiWeak: number;
  bbLower: number;
  bbMid: number;
  volumeMult: number;
  atrHighPenalty: number;
  atrMidPenalty: number;
  atrSweetBonus: number;
}

const DEFAULT: ScoreWeights = {
  rsiStrong: 40,
  rsiWeak: 15,
  bbLower: 35,
  bbMid: 10,
  volumeMult: 0.6,
  atrHighPenalty: 12,
  atrMidPenalty: 4,
  atrSweetBonus: 5,
};

let cached: ScoreWeights | null = null;

function weightsPath(): string {
  return (
    process.env.AUBOT_SCORE_WEIGHTS_PATH ||
    path.join(process.env.AUBOT_JOURNAL_DIR || "/tmp", "scoreWeights.json")
  );
}

export function getScoreWeights(): ScoreWeights {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(weightsPath(), "utf8");
    const j = JSON.parse(raw) as Partial<ScoreWeights>;
    cached = { ...DEFAULT, ...j };
    return cached;
  } catch {
    cached = DEFAULT;
    return cached;
  }
}

export function reloadScoreWeights(): ScoreWeights {
  cached = null;
  return getScoreWeights();
}
