import { PLAN_CONFIG } from '@/lib/credits';

export type PlanKey = keyof typeof PLAN_CONFIG;
export type BillingInterval = 'monthly' | 'annual';
export type ProductPlan = { plan: PlanKey; interval: BillingInterval };

export const PLAN_ID_MAP: Record<string, ProductPlan> = {
  // Legacy Starter IDs now grant the new Dev entitlement.
  plan_yCxCQdTcuq3PB: { plan: 'dev', interval: 'monthly' },
  plan_A3XtiQtFwUQO2: { plan: 'dev', interval: 'annual' },
  plan_X2F8Ukz2xXIkE: { plan: 'pro', interval: 'monthly' },
  plan_TF2t36B0XIYCy: { plan: 'pro', interval: 'annual' },
  plan_NJdBfHx3gQxCF: { plan: 'studio', interval: 'monthly' },
  plan_Ynaroe3Otw4QK: { plan: 'studio', interval: 'annual' },
};

export const LEGACY_TOPUP_PRODUCTS: Record<string, number> = {
  prod_bQhlR7Fonc4Oy: 5,
  prod_ii4z8el4KTeXA: 10,
  prod_ykaAhgAMdOI7Y: 25,
};

export function buildProductMap(): Record<string, ProductPlan> {
  const map: Record<string, ProductPlan> = { ...PLAN_ID_MAP };
  const entries: [string, PlanKey, BillingInterval][] = [
    ['WHOP_PRODUCT_DEV', 'dev', 'monthly'],
    ['WHOP_PRODUCT_DEV_ANNUAL', 'dev', 'annual'],
    ['WHOP_PRODUCT_STARTER', 'dev', 'monthly'],
    ['WHOP_PRODUCT_STARTER_ANNUAL', 'dev', 'annual'],
    ['WHOP_PRODUCT_PRO', 'pro', 'monthly'],
    ['WHOP_PRODUCT_PRO_ANNUAL', 'pro', 'annual'],
    ['WHOP_PRODUCT_STUDIO', 'studio', 'monthly'],
    ['WHOP_PRODUCT_STUDIO_ANNUAL', 'studio', 'annual'],
  ];
  for (const [envKey, plan, interval] of entries) {
    const productId = process.env[envKey];
    if (productId) map[productId] = { plan, interval };
  }
  return map;
}

export function buildTopupMap(): Record<string, number> {
  const map = { ...LEGACY_TOPUP_PRODUCTS };
  const entries: [string, number][] = [
    ['WHOP_TOPUP_5', 5],
    ['WHOP_TOPUP_10', 10],
    ['WHOP_TOPUP_25', 25],
    ['WHOP_TOPUP_50', 50],
    // Keep existing production env names valid during Whop product migration.
    ['WHOP_PACK_SMALL', 5],
    ['WHOP_PACK_MEDIUM', 10],
    ['WHOP_PACK_LARGE', 25],
  ];
  for (const [envKey, walletUsd] of entries) {
    const productId = process.env[envKey];
    if (productId) map[productId] = walletUsd;
  }
  return map;
}

export function productPlan(productId: string | null | undefined): ProductPlan | null {
  if (!productId) return null;
  return buildProductMap()[productId] ?? null;
}

export function topupAmount(productId: string | null | undefined): number | null {
  if (!productId) return null;
  return buildTopupMap()[productId] ?? null;
}

