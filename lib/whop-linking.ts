import crypto from 'crypto';

export interface CheckoutTokenPayload {
  revro_user_id: string;
  expected_product_id: string;
  expected_plan?: string | null;
  expected_plan_id?: string | null;
  whop_user_id?: string | null;
  iat: number;
  exp: number;
  nonce: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function getCheckoutSecret(): string {
  return process.env.REVRO_CHECKOUT_SECRET || process.env.WHOP_WEBHOOK_SECRET || '';
}

export function createCheckoutToken(payload: CheckoutTokenPayload): string {
  const secret = getCheckoutSecret();
  if (!secret) throw new Error('Checkout signing secret is not configured');
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifyCheckoutToken(token: string): CheckoutTokenPayload | null {
  const secret = getCheckoutSecret();
  if (!secret || !token.includes('.')) return null;
  const [encodedPayload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as CheckoutTokenPayload;
    if (!payload.revro_user_id || !payload.expected_product_id || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function hashCheckoutToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createCheckoutMetadata(payload: Omit<CheckoutTokenPayload, 'iat' | 'exp' | 'nonce'>): {
  token: string;
  metadata: Record<string, string>;
} {
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload: CheckoutTokenPayload = {
    ...payload,
    iat: now,
    exp: now + 60 * 60,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const token = createCheckoutToken(tokenPayload);
  return {
    token,
    metadata: {
      revro_user_id: tokenPayload.revro_user_id,
      expected_product_id: tokenPayload.expected_product_id,
      expected_plan: tokenPayload.expected_plan ?? '',
      expected_plan_id: tokenPayload.expected_plan_id ?? '',
      whop_user_id: tokenPayload.whop_user_id ?? '',
      revro_checkout_token: token,
    },
  };
}

export function extractWhopMetadata(payload: unknown): Record<string, unknown> {
  const seen = new Set<unknown>();
  const candidates: Record<string, unknown>[] = [];

  function visit(node: unknown, depth: number): void {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 5) return;
    seen.add(node);
    const record = node as Record<string, unknown>;
    for (const key of ['metadata', 'custom_fields', 'checkout_metadata']) {
      const value = record[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        candidates.push(value as Record<string, unknown>);
      }
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') visit(value, depth + 1);
    }
  }

  visit(payload, 0);
  return candidates.find((item) => item.revro_checkout_token || item.revro_user_id) ?? {};
}

