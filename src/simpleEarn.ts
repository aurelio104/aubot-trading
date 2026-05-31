import { getAccountBalances, type AccountBalance } from "./binance.js";
import { pushLog } from "./log.js";

/** LD* en Spot = activos suscritos a Simple Earn Flexible (no operables). */
const LD_PREFIX = "LD";

interface FlexibleProduct {
  asset: string;
  productId: string;
  canPurchase?: boolean;
  canRedeem?: boolean;
}

interface FlexiblePosition {
  asset: string;
  productId: string;
  totalAmount: string;
  productName?: string;
}

import { signedRequest } from "./binance.js";

async function signedSapi(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number> = {},
): Promise<unknown> {
  return signedRequest(method, path, params, true);
}

export function isEarnLdAsset(asset: string): boolean {
  return asset.startsWith(LD_PREFIX) && asset.length > LD_PREFIX.length;
}

export function baseFromLdAsset(ldAsset: string): string {
  return ldAsset.slice(LD_PREFIX.length);
}

async function listFlexibleProducts(asset: string): Promise<FlexibleProduct[]> {
  const data = (await signedSapi("GET", "/simple-earn/flexible/list", {
    asset,
    size: 100,
  })) as { rows?: FlexibleProduct[] };
  return data.rows ?? [];
}

async function getFlexiblePositions(asset?: string): Promise<FlexiblePosition[]> {
  const params: Record<string, string | number> = { size: 100 };
  if (asset) params.asset = asset;
  const data = (await signedSapi(
    "GET",
    "/simple-earn/flexible/position",
    params,
  )) as { rows?: FlexiblePosition[] };
  return data.rows ?? [];
}

async function redeemFlexibleToSpot(
  productId: string,
  opts: { amount?: string; redeemAll?: boolean } = {},
): Promise<boolean> {
  const params: Record<string, string | number> = {
    productId,
    destAccount: "SPOT",
  };
  if (opts.redeemAll) {
    params.redeemAll = "true";
  } else if (opts.amount) {
    params.amount = opts.amount;
  } else {
    params.redeemAll = "true";
  }
  const res = (await signedSapi(
    "POST",
    "/simple-earn/flexible/redeem",
    params,
  )) as { success?: boolean };
  return res.success === true;
}

export async function disableFlexibleAutoSubscribe(
  productId: string,
): Promise<boolean> {
  const res = (await signedSapi(
    "POST",
    "/simple-earn/flexible/setAutoSubscribe",
    { productId, autoSubscribe: "false" },
  )) as { success?: boolean };
  return res.success === true;
}

function ldBalances(balances: AccountBalance[]): AccountBalance[] {
  return balances.filter(
    (b) =>
      isEarnLdAsset(b.asset) &&
      Number(b.free) + Number(b.locked) > 1e-8,
  );
}

async function resolveProductId(baseAsset: string): Promise<string | null> {
  const positions = await getFlexiblePositions(baseAsset);
  if (positions.length > 0) return positions[0]!.productId;
  const products = await listFlexibleProducts(baseAsset);
  return products[0]?.productId ?? null;
}

export interface EarnRedeemResult {
  redeemed: Array<{ asset: string; amount: string }>;
  autoSubscribeDisabled: string[];
  errors: string[];
}

/** Saca activos de Simple Earn → Spot y desactiva auto-suscripción. */
export async function ensureSpotNotEarn(
  assets?: string[],
): Promise<EarnRedeemResult> {
  const result: EarnRedeemResult = {
    redeemed: [],
    autoSubscribeDisabled: [],
    errors: [],
  };

  const balances = await getAccountBalances();
  const targets = new Set<string>();

  for (const b of ldBalances(balances)) {
    targets.add(baseFromLdAsset(b.asset));
  }
  for (const a of assets ?? []) {
    if (a && a !== "USDT") targets.add(a.toUpperCase());
  }
  targets.add("USDT");

  for (const baseAsset of targets) {
    try {
      const productId = await resolveProductId(baseAsset);
      if (!productId) continue;

      try {
        const disabled = await disableFlexibleAutoSubscribe(productId);
        if (disabled) {
          result.autoSubscribeDisabled.push(baseAsset);
          pushLog("info", `earn: autoSubscribe OFF ${baseAsset} (${productId})`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`autoSubscribe ${baseAsset}: ${msg}`);
      }

      const positions = await getFlexiblePositions(baseAsset);
      const pos = positions.find((p) => p.productId === productId);
      const total = Number(pos?.totalAmount ?? 0);
      const ldRow = balances.find((b) => b.asset === `${LD_PREFIX}${baseAsset}`);
      const ldQty = ldRow ? Number(ldRow.free) + Number(ldRow.locked) : 0;
      const amount = Math.max(total, ldQty);

      if (amount < 1e-8) continue;

      try {
        const ok = await redeemFlexibleToSpot(productId, { redeemAll: true });
        if (ok) {
          result.redeemed.push({
            asset: baseAsset,
            amount: String(amount),
          });
          pushLog(
            "info",
            `earn: redeemed ${amount} ${baseAsset} → Spot (${productId})`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("-1002") && !msg.includes("insufficient")) {
          result.errors.push(`redeem ${baseAsset}: ${msg}`);
          pushLog("warn", `earn redeem ${baseAsset}: ${msg}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${baseAsset}: ${msg}`);
    }
  }

  return result;
}

export function earnProtectionEnabled(): boolean {
  return process.env.AUBOT_KEEP_SPOT !== "false";
}
