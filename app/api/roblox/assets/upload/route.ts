import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  getRobloxAssetUploadOperation,
  isRobloxAssetUploadConfigured,
  uploadGeneratedImageToRoblox,
} from '@/lib/roblox-assets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  const operationId = request.nextUrl.searchParams.get('operation_id');
  if (!operationId) {
    return NextResponse.json({ configured: isRobloxAssetUploadConfigured() });
  }

  try {
    return NextResponse.json(await getRobloxAssetUploadOperation(operationId));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to check Roblox asset upload.';
    console.warn('[Roblox/assets] Operation check failed', { userId: user.id, message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  if (!isRobloxAssetUploadConfigured()) {
    return NextResponse.json(
      { error: 'Roblox asset upload is not configured yet. Download the preview and upload it to Roblox manually for now.' },
      { status: 503 },
    );
  }

  try {
    const body = await request.json();
    const imageUrl = typeof body.image_url === 'string' ? body.image_url : '';
    const displayName = typeof body.display_name === 'string' ? body.display_name : 'Revro generated asset';
    const result = await uploadGeneratedImageToRoblox(imageUrl, displayName);
    console.info('[Roblox/assets] Upload requested', {
      userId: user.id,
      operationId: result.operation_id,
      status: result.status,
      assetId: result.asset_id ?? null,
    });
    return NextResponse.json(result, { status: result.status === 'complete' ? 200 : 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to upload generated image to Roblox.';
    console.warn('[Roblox/assets] Upload failed', { userId: user.id, message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
