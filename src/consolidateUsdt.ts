import {
  binanceBaseUrl,
  createMarketOrder,
  fetchTickerPrice,
  getAccountBalances,
  getAllWallets,
  universalTransfer,
} from "./binance.js";
import { formatQtyString, getSymbolFilters } from "./exchangeInfo.js";
import { pushLog } from "./log.js";
import {
  earnProtectionEnabled,
  ensureSpotNotEarn,
  isEarnLdAsset,
  type EarnRedeemResult,
} from "./simpleEarn.js";
import {
  convertRemainingDust,
  dustConvertEnabled,
  type DustConvertResult,
} from "./dustConvert.js";

const STABLE = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI"]);

export interface ConsolidateResult {
  sold: Array<{ asset: string; symbol: string; qty: string }>;
  fundingToSpot: string | null;
  earn: EarnRedeemResult | null;
  dust: DustConvertResult | null;
  spotUsdt: number;
  errors: string[];
}

export function consolidateEnabled(): boolean {
  return process.env.AUBOT_CONSOLIDATE_USDT !== "false";
}

/** Tras cerrar operación: Earn→Spot, vender alts, USDT Fondos→Spot. */
export async function consolidateToUsdt(): Promise<ConsolidateResult> {
  const result: ConsolidateResult = {
    sold: [],
    fundingToSpot: null,
    earn: null,
    dust: null,
    spotUsdt: 0,
    errors: [],
  };

  if (earnProtectionEnabled()) {
    result.earn = await ensureSpotNotEarn();
  }

  let balances = await getAccountBalances();
  for (const b of balances) {
    const asset = b.asset;
    if (STABLE.has(asset) || isEarnLdAsset(asset)) continue;
    const qty = Number(b.free) + Number(b.locked);
    if (qty < 1e-12) continue;
    const symbol = `${asset}USDT`;
    try {
      const filters = await getSymbolFilters(symbol, binanceBaseUrl());
      const qtyStr = formatQtyString(qty, filters.stepSize);
      const q = Number(qtyStr);
      if (q < filters.minQty) {
        continue;
      }
      const price = await fetchTickerPrice(symbol);
      const notional = q * price;
      if (notional < filters.minNotional) {
        continue;
      }
      pushLog("info", `consolidate SELL ${symbol} qty=${qtyStr} (~${notional.toFixed(2)} USDT)`);
      await createMarketOrder(symbol, "SELL", qtyStr);
      result.sold.push({ asset, symbol, qty: qtyStr });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`sell ${asset}: ${msg}`);
      pushLog("warn", `consolidate sell ${asset}: ${msg}`);
    }
  }

  if (dustConvertEnabled()) {
    result.dust = await convertRemainingDust();
    if (result.dust.errors.length) {
      result.errors.push(...result.dust.errors);
    }
  }

  try {
    const wallets = await getAllWallets();
    const fundRow = wallets.funding.find((b) => b.asset === "USDT");
    const free = Number(fundRow?.free ?? 0);
    if (free >= 0.01) {
      const amt = free.toFixed(8).replace(/\.?0+$/, "") || free.toFixed(2);
      pushLog("info", `consolidate transfer Fondos→Spot ${amt} USDT`);
      await universalTransfer("FUNDING_MAIN", "USDT", amt);
      result.fundingToSpot = amt;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`funding transfer: ${msg}`);
  }

  if (earnProtectionEnabled()) {
    const earnAfter = await ensureSpotNotEarn(["USDT"]);
    if (result.earn) {
      result.earn.redeemed.push(...earnAfter.redeemed);
      result.earn.autoSubscribeDisabled.push(
        ...earnAfter.autoSubscribeDisabled.filter(
          (a) => !result.earn!.autoSubscribeDisabled.includes(a),
        ),
      );
      result.earn.errors.push(...earnAfter.errors);
    } else {
      result.earn = earnAfter;
    }
  }

  balances = await getAccountBalances();
  const usdt = balances.find((b) => b.asset === "USDT");
  result.spotUsdt = usdt ? Number(usdt.free) + Number(usdt.locked) : 0;
  const dustNote = result.dust?.totalUsdt
    ? ` (+${result.dust.totalUsdt.toFixed(4)} polvo→USDT)`
    : "";
  pushLog("info", `consolidate done — Spot USDT ${result.spotUsdt.toFixed(4)}${dustNote}`);
  return result;
}
