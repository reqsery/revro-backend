const ASSETS_API_BASE = 'https://apis.roblox.com/assets/v1';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_OPERATION_POLLS = 12;
const OPERATION_POLL_MS = 1000;

type RobloxAssetOperation = {
  path?: string;
  done?: boolean;
  response?: {
    assetId?: string;
    path?: string;
    moderationResult?: {
      moderationState?: string;
    };
  };
  error?: {
    code?: number;
    message?: string;
  };
};

export type RobloxAssetUploadResult = {
  status: 'processing' | 'complete';
  operation_id: string;
  asset_id?: string;
  asset_uri?: string;
  moderation_state?: string | null;
};

function getAssetsApiKey(): string {
  const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
  if (!apiKey) throw new Error('Roblox asset upload is not configured yet.');
  return apiKey;
}

function getCreator(): { userId?: string; groupId?: string } {
  const groupId = process.env.ROBLOX_ASSET_CREATOR_GROUP_ID?.trim();
  const userId = process.env.ROBLOX_ASSET_CREATOR_USER_ID?.trim();
  if (groupId && /^\d+$/.test(groupId)) return { groupId };
  if (userId && /^\d+$/.test(userId)) return { userId };
  throw new Error('Roblox asset upload creator is not configured yet.');
}

export function isRobloxAssetUploadConfigured(): boolean {
  try {
    getAssetsApiKey();
    getCreator();
    return true;
  } catch {
    return false;
  }
}

function decodeGeneratedImage(imageUrl: string): { bytes: Uint8Array; contentType: string } {
  const match = imageUrl.match(/^data:(image\/(?:png|jpeg|bmp|tga));base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) {
    throw new Error('Only Revro-generated image previews can be uploaded automatically.');
  }

  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Generated image is empty or exceeds Roblox upload limits.');
  }
  return { bytes, contentType: match[1].toLowerCase() };
}

function operationIdFromPath(path: string | undefined): string {
  const operationId = path?.match(/^operations\/([a-z0-9_-]+)$/i)?.[1];
  if (!operationId) throw new Error('Roblox did not return a valid asset upload operation.');
  return operationId;
}

function operationResult(operationId: string, operation: RobloxAssetOperation): RobloxAssetUploadResult {
  if (operation.error) {
    throw new Error(operation.error.message || `Roblox asset upload failed (${operation.error.code ?? 'unknown error'}).`);
  }
  const assetId = operation.response?.assetId ?? operation.response?.path?.match(/^assets\/(\d+)$/)?.[1];
  if (operation.done && assetId) {
    return {
      status: 'complete',
      operation_id: operationId,
      asset_id: assetId,
      asset_uri: `rbxassetid://${assetId}`,
      moderation_state: operation.response?.moderationResult?.moderationState ?? null,
    };
  }
  return { status: 'processing', operation_id: operationId };
}

export async function getRobloxAssetUploadOperation(operationId: string): Promise<RobloxAssetUploadResult> {
  if (!/^[a-z0-9_-]+$/i.test(operationId)) throw new Error('Invalid Roblox asset upload operation.');
  const response = await fetch(`${ASSETS_API_BASE}/operations/${operationId}`, {
    headers: { 'x-api-key': getAssetsApiKey() },
    cache: 'no-store',
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Roblox asset upload status failed (${response.status}): ${message.slice(0, 300)}`);
  }
  return operationResult(operationId, await response.json() as RobloxAssetOperation);
}

export async function uploadGeneratedImageToRoblox(
  imageUrl: string,
  displayName: string,
): Promise<RobloxAssetUploadResult> {
  const { bytes, contentType } = decodeGeneratedImage(imageUrl);
  const request = {
    assetType: 'Decal',
    displayName: displayName.trim().slice(0, 50) || 'Revro generated asset',
    description: 'Generated in Revro for Roblox Studio UI use.',
    creationContext: { creator: getCreator() },
  };
  const body = new FormData();
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  body.append('request', JSON.stringify(request));
  body.append('fileContent', new Blob([blobBytes.buffer], { type: contentType }), `revro-asset.${contentType === 'image/jpeg' ? 'jpg' : 'png'}`);

  const response = await fetch(`${ASSETS_API_BASE}/assets`, {
    method: 'POST',
    headers: { 'x-api-key': getAssetsApiKey() },
    body,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Roblox asset upload failed (${response.status}): ${message.slice(0, 300)}`);
  }

  const operationId = operationIdFromPath((await response.json() as RobloxAssetOperation).path);
  for (let index = 0; index < MAX_OPERATION_POLLS; index += 1) {
    const result = await getRobloxAssetUploadOperation(operationId);
    if (result.status === 'complete') return result;
    await new Promise(resolve => setTimeout(resolve, OPERATION_POLL_MS));
  }
  return { status: 'processing', operation_id: operationId };
}
