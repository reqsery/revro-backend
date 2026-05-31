import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  canGenerateImages,
  deductCredits,
  getAllowedRequestedModel,
  hasCredits,
  incrementImageCount,
  estimateTokenCostUsd,
  CREDIT_COSTS,
} from '@/lib/credits';
// CREDIT_COSTS is only used for IMAGE; everything else is token-based
import { callAI, streamAI, selectAIModel, estimateInputTokens, getAIRoutingDebug } from '@/lib/codex';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConversationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('local_') || value.startsWith('pending_')) return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

type ImagePrompt = {
  label: string;
  prompt: string;
};

function parseImagePrompts(raw: string, userPrompt: string): ImagePrompt[] {
  const jsonText = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;

  try {
    const parsed = JSON.parse(jsonText);
    const prompts = Array.isArray(parsed?.prompts) ? parsed.prompts : [];
    const normalized = prompts
      .map((item: any, index: number) => ({
        label: typeof item?.label === 'string' && item.label.trim()
          ? item.label.trim().slice(0, 40)
          : `Asset ${index + 1}`,
        prompt: typeof item?.prompt === 'string' ? item.prompt.trim() : '',
      }))
      .filter((item: ImagePrompt) => item.prompt.length > 0)
      .slice(0, 3);

    if (normalized.length > 0) return normalized;
  } catch {}

  return [{
    label: 'Roblox asset',
    prompt: raw.trim() || userPrompt,
  }];
}

function normalizeImagePrompts(value: unknown, fallbackPrompt: string): ImagePrompt[] {
  if (!Array.isArray(value)) {
    return [{ label: 'Roblox asset', prompt: fallbackPrompt.trim() }].filter(item => item.prompt);
  }

  return value
    .map((item: any, index: number) => ({
      label: typeof item?.label === 'string' && item.label.trim()
        ? item.label.trim().slice(0, 40)
        : `Asset ${index + 1}`,
      prompt: typeof item?.prompt === 'string' ? item.prompt.trim() : '',
    }))
    .filter((item: ImagePrompt) => item.prompt.length > 0)
    .slice(0, 3);
}

const ICON_STYLE = 'Roblox simulator UI icon, mobile-game UI style, thick chunky shapes, clear silhouette, bold outline, simple cartoon shading, high contrast, centered composition, minimal details, readable at 64x64, no text, transparent background if supported';
const IMAGE_PROMPT_SLOP = /\b(cinematic|epic|highly detailed|complex|realistic|crystal heart|magical fantasy scene|dramatic lighting|8k|ultra detailed|concept art|photoreal|photorealistic)\b/gi;

function isGuiIconRequest(prompt: string): boolean {
  return /\b(icon|gui icon|ui icon|button icon|simulator icon)\b/i.test(prompt);
}

function simulatorIconPrompt(userPrompt: string): ImagePrompt {
  if (/\brebirth\b/i.test(userPrompt)) {
    return {
      label: 'Rebirth icon',
      prompt: 'Roblox simulator rebirth button icon, mobile-game UI style, thick chunky shapes, extremely clear silhouette, two bold golden circular arrows spinning around a bright yellow star, simple cartoon shading, high contrast, centered composition, minimal details, readable at 64x64, polished Roblox simulator art style, clean edges, no text, transparent background, not realistic, not cinematic, not detailed concept art.',
    };
  }

  const subject = userPrompt
    .replace(IMAGE_PROMPT_SLOP, '')
    .replace(/\b(make|create|generate|draw|please|a|an|the|for|roblox|gui|ui|simulator|icon)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || 'game item';

  return {
    label: 'GUI icon',
    prompt: `${ICON_STYLE}, ${subject}.`,
  };
}

async function refineImagePrompt(
  planModel: string,
  userPrompt: string
): Promise<{ prompts: ImagePrompt[]; cost: number }> {
  if (isGuiIconRequest(userPrompt)) {
    return { prompts: [simulatorIconPrompt(userPrompt)], cost: 0 };
  }

  const selection = selectAIModel(planModel, 'roblox', userPrompt);
  const result = await callAI(
    selection,
    `Plan Roblox image assets for this request: ${userPrompt}

Return JSON only in this exact shape:
{"prompts":[{"label":"Icon","prompt":"..."},{"label":"Menu","prompt":"..."}]}

Rules:
- Produce 1 prompt for one deliverable, 2 prompts when the user asks for separate assets such as "icon and menu", and never more than 3 prompts.
- Default to ordinary Roblox game assets and practical Roblox GUI pieces.
- Keep every prompt short and production-oriented. Do not make the prompt longer than the user's request needs.
- Never turn a GUI icon into a thumbnail, poster, scene, screenshot, or concept-art illustration.
- Avoid cinematic, epic, highly detailed, complex, realistic, crystal heart, magical fantasy scene, dramatic lighting, 8k, ultra detailed, concept art, sci-fi dashboards, holograms, metal frames, and photoreal lighting unless the user explicitly asks for them.
- For a GUI icon use: Roblox simulator UI icon, mobile-game UI style, thick chunky shapes, clear silhouette, bold outline, simple cartoon shading, high contrast, centered composition, minimal details, readable at 64x64, no text, transparent background if supported.
- For a menu/panel, request a general Roblox in-game GUI panel with a clear header, bright buttons, rounded sections, simple strokes, and practical layout. A shop may use a themed custom panel background matching the shop subject.
- Keep menus as UI assets, not placed inside a 3D Roblox world screenshot.
- Do not put the requested icon inside a menu render unless the user explicitly asks for one combined image.
- Keep each prompt short, concrete, and faithful to the user's subject, colors, and style clues.`,
    'roblox',
    []
  );
  return {
    prompts: parseImagePrompts(result.content, userPrompt).map((item) => ({
      ...item,
      prompt: item.prompt.replace(IMAGE_PROMPT_SLOP, '').replace(/\s+/g, ' ').trim(),
    })),
    cost: estimateTokenCostUsd(
      selection.actualModel,
      result.usage?.input_tokens ?? 0,
      result.usage?.output_tokens ?? 0,
    ),
  };
}

function getImageOptions(asset: ImagePrompt) {
  const label = asset.label.toLowerCase();
  const prompt = asset.prompt.toLowerCase();
  const isIcon = label.includes('icon') || prompt.includes('icon');
  const isMenu = label.includes('menu') || label.includes('panel') || prompt.includes('menu');

  return {
    background: isIcon ? 'transparent' : 'auto',
    size: isMenu ? '1536x1024' : '1024x1024',
  };
}

async function generateImage(asset: ImagePrompt): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Image generation is not configured (OPENAI_API_KEY missing)');
  const options = getImageOptions(asset);

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-image-1.5',
      prompt: asset.prompt,
      n: 1,
      size: options.size,
      background: options.background,
      output_format: 'png',
      quality: 'medium',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any)?.error?.message ?? `OpenAI error ${res.status}`);
  }

  const data: any = await res.json();
  const image = data?.data?.[0];
  if (image?.b64_json) return `data:image/png;base64,${image.b64_json}`;
  if (image?.url) return image.url;
  throw new Error('No image output returned from OpenAI');
}

async function saveMessages(
  userId: string,
  conversationId: string | undefined,
  prompt: string,
  responseText: string,
  planModel: string,
  cost: number,
): Promise<{ convId: string | null; messageId: string | null }> {
  let convId: string | null = conversationId ?? null;

  if (!convId) {
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .insert({ user_id: userId, title: prompt.substring(0, 50), type: 'roblox' })
      .select('id')
      .single();

    if (convErr) {
      console.error('[Roblox chat] Failed to create conversation:', convErr.message);
      throw convErr;
    }
    convId = conv?.id ?? null;

  }

  let messageId: string | null = null;
  if (convId) {
    const { error: userMessageErr } = await supabaseAdmin.from('messages').insert({
      conversation_id: convId,
      role: 'user',
      content: prompt,
    });

    if (userMessageErr) {
      console.error('[Roblox chat] Failed to save user message:', userMessageErr.message);
      throw userMessageErr;
    }

    const { data: assistantMsg, error: assistantMessageErr } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'assistant',
        content: responseText,
        credits_cost: Math.ceil(cost),
        model_used: planModel,
      })
      .select('id')
      .single();

    if (assistantMessageErr) {
      console.error('[Roblox chat] Failed to save assistant message:', assistantMessageErr.message);
      throw assistantMessageErr;
    }

    const { error: touchErr } = await supabaseAdmin
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', convId)
      .eq('user_id', userId);

    if (touchErr) {
      console.error('[Roblox chat] Failed to update conversation timestamp:', touchErr.message);
      throw touchErr;
    }

    messageId = assistantMsg?.id ?? null;
  }

  return { convId, messageId };
}

type CollectedAIResponse = {
  content: string;
  inputTokens: number;
  outputTokens: number;
};

async function collectAIResponse(
  selection: Parameters<typeof streamAI>[0],
  prompt: string,
  history: any[],
  isCancelled: () => boolean,
): Promise<CollectedAIResponse> {
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const chunk of streamAI(selection, prompt, 'roblox', history)) {
    if (isCancelled()) break;
    if (chunk.type === 'message_start') {
      inputTokens = chunk.message?.usage?.input_tokens ?? 0;
    } else if (chunk.type === 'message_delta') {
      inputTokens = chunk.usage?.input_tokens || inputTokens;
      outputTokens = chunk.usage?.output_tokens ?? 0;
    } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      content += chunk.delta.text;
    }
  }

  return { content, inputTokens, outputTokens };
}

function expectsStudioAssembly(type: string, prompt: string): boolean {
  return type === 'ui_component'
    || /\b(system|script|module|leaderstats|remote\s*event|remoteevent|coin|pickup|counter|shop|inventory|rebirth|simulator|ui|gui|image|icon)\b/i.test(prompt);
}

function studioAssemblyIssue(content: string, type: string, prompt: string): string | null {
  if (!content.trim()) return 'empty_text';
  if (expectsStudioAssembly(type, prompt) && !/"revro_studio_tasks"\s*:/i.test(content)) {
    return 'missing_studio_manifest';
  }
  return null;
}

function strictStudioRetryPrompt(prompt: string): string {
  return `Create a Roblox Studio-ready result for this request:
${prompt}

Your previous result was empty or missing the required Studio assembly.
Return a short visible summary, then a JSON code block with a non-empty "revro_studio_tasks" array.
Include every needed folder, remote, server/client script, module, and CREATE_UI task.
Scripts must include complete Luau source in "code". UI tasks must include visible children with Size, Position, Text, and colors.
Do not return a tutorial. Do not return an empty response.`;
}

function studioAssemblyResponse(summary: string, tasks: any[]): string {
  return `${summary}

\`\`\`json
${JSON.stringify({ revro_studio_tasks: tasks }, null, 2)}
\`\`\``;
}

function coinPickupFallback(): string {
  const serverCode = `local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local remote = ReplicatedStorage:WaitForChild("RevroCoinSystem"):WaitForChild("Remotes"):WaitForChild("CoinsUpdated")

local function setupPlayer(player)
    local leaderstats = player:FindFirstChild("leaderstats") or Instance.new("Folder")
    leaderstats.Name = "leaderstats"
    leaderstats.Parent = player
    local coins = leaderstats:FindFirstChild("Coins") or Instance.new("IntValue")
    coins.Name = "Coins"
    coins.Parent = leaderstats
end

local function connectPickup(part)
    if not part:IsA("BasePart") or part:GetAttribute("RevroCoinConnected") then return end
    part:SetAttribute("RevroCoinConnected", true)
    part.Touched:Connect(function(hit)
        local player = Players:GetPlayerFromCharacter(hit.Parent)
        local coins = player and player:FindFirstChild("leaderstats") and player.leaderstats:FindFirstChild("Coins")
        if not coins or not part.CanTouch then return end
        part.CanTouch = false
        coins.Value += part:GetAttribute("CoinValue") or 1
        remote:FireClient(player, coins.Value)
        part:Destroy()
    end)
end

Players.PlayerAdded:Connect(setupPlayer)
for _, player in Players:GetPlayers() do setupPlayer(player) end
for _, child in workspace:GetDescendants() do
    if child.Name == "CoinPickup" then connectPickup(child) end
end
workspace.DescendantAdded:Connect(function(child)
    if child.Name == "CoinPickup" then connectPickup(child) end
end)`;
  const clientCode = `local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local player = Players.LocalPlayer
local label = script.Parent:WaitForChild("Counter")
local remote = ReplicatedStorage:WaitForChild("RevroCoinSystem"):WaitForChild("Remotes"):WaitForChild("CoinsUpdated")

local function render(value)
    label.Text = "Coins: " .. tostring(value)
end

remote.OnClientEvent:Connect(render)
local coins = player:WaitForChild("leaderstats"):WaitForChild("Coins")
render(coins.Value)
coins.Changed:Connect(render)`;

  return studioAssemblyResponse(
    'Prepared a Studio-ready coin pickup system with leaderstats Coins, a RemoteEvent, a server pickup script, and a visible UI counter.',
    [
      { type: 'CREATE_FOLDER', data: { name: 'RevroCoinSystem', parent: 'ReplicatedStorage' } },
      { type: 'CREATE_FOLDER', data: { name: 'Remotes', parent: 'ReplicatedStorage.RevroCoinSystem' } },
      { type: 'CREATE_REMOTE_EVENT', data: { name: 'CoinsUpdated', parent: 'ReplicatedStorage.RevroCoinSystem.Remotes' } },
      { type: 'INSERT_SCRIPT', data: { name: 'CoinPickupServer', parent: 'ServerScriptService', scriptType: 'Script', code: serverCode } },
      {
        type: 'CREATE_UI',
        data: {
          name: 'CoinCounterGui',
          parent: 'StarterGui',
          children: [{
            className: 'TextLabel',
            name: 'Counter',
            properties: {
              Size: '{0, 220}, {0, 56}',
              Position: '{0, 24}, {0, 24}',
              BackgroundColor3: 'Color3.fromRGB(20, 24, 34)',
              TextColor3: 'Color3.fromRGB(255, 221, 64)',
              Text: 'Coins: 0',
              TextScaled: true,
            },
          }],
          code: clientCode,
        },
      },
    ],
  );
}

function imageUiFallback(): string {
  return studioAssemblyResponse(
    'Prepared a StarterGui image UI with an easy-to-replace placeholder. Roblox asset upload is not implemented yet: upload your generated image to Roblox, then replace REPLACE_WITH_ROBLOX_ASSET_ID with the resulting asset ID.',
    [{
      type: 'CREATE_UI',
      data: {
        name: 'GeneratedAssetGui',
        parent: 'StarterGui',
        children: [{
          className: 'ImageButton',
          name: 'GeneratedAssetButton',
          properties: {
            Size: '{0, 160}, {0, 160}',
            Position: '{0.5, -80}, {0.5, -80}',
            BackgroundTransparency: 1,
            Image: 'rbxassetid://REPLACE_WITH_ROBLOX_ASSET_ID',
          },
        }],
      },
    }],
  );
}

function genericStudioFallback(prompt: string): string {
  if (/\b(coin|leaderstats|pickup|counter)\b/i.test(prompt)) return coinPickupFallback();
  if (/\b(image|icon|asset|ui|gui|shop)\b/i.test(prompt)) return imageUiFallback();

  return studioAssemblyResponse(
    'Prepared a Studio-ready starter script so the requested Roblox workflow can be inserted and extended safely.',
    [{
      type: 'INSERT_SCRIPT',
      data: {
        name: 'RevroGeneratedSystem',
        parent: 'ServerScriptService',
        scriptType: 'Script',
        code: `-- Revro fallback assembly\n-- Requested system: ${prompt.replace(/\r?\n/g, ' ').slice(0, 180)}\nwarn("Revro starter system inserted. Continue refining this system in Revro chat.")`,
      },
    }],
  );
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (user instanceof NextResponse) return user;

  try {
    const body = await request.json();
    const prompt: string  = body.prompt ?? body.message ?? '';
    const type: string    = body.type   ?? 'script';
    const step: string    = body.step   ?? 'generate';
    const conversationId = getConversationId(body.conversation_id ?? body.conversationId);

    const imagePrompts = normalizeImagePrompts(body.prompts, prompt);

    if (!prompt && !(type === 'image' && step === 'generate' && imagePrompts.length > 0)) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const planModel = getAllowedRequestedModel(user.plan, body.model);
    const selection = selectAIModel(planModel, 'roblox', prompt);

    let history: any[] = [];
    if (conversationId) {
      const { data: conversation, error: conversationErr } = await supabaseAdmin
        .from('conversations')
        .select('id, type')
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (conversationErr) throw conversationErr;
      if (!conversation) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }
      const { data: msgs } = await supabaseAdmin
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(16);
      history = (msgs ?? []).reverse();
    }

    // ── Image: refine ─────────────────────────────────────────────────────────
    if (type === 'image' && step === 'refine') {
      const { prompts: refinedPrompts, cost } = await refineImagePrompt(planModel, prompt);
      console.info('[AI generation]', {
        route: 'roblox_image_refine',
        provider: isGuiIconRequest(prompt) ? 'deterministic' : selection.provider,
        model: isGuiIconRequest(prompt) ? 'simulator_icon_template' : selection.actualModel,
        selectedModelTier: planModel,
        ...getAIRoutingDebug('roblox', prompt, planModel),
        inputTokens: null,
        outputTokens: null,
        imageCost: null,
        fileContextCost: null,
        estimatedRealUsdCost: cost,
        deductedWalletAmount: cost,
        userId: user.id,
      });
      const promptSummary = refinedPrompts.map(item => `${item.label}: ${item.prompt}`).join('\n\n');
      const { convId, messageId } = await saveMessages(
        user.id,
        conversationId,
        prompt,
        promptSummary,
        planModel,
        cost,
      );
      const creditResult = await deductCredits(user.id, cost, 'image_refine', {
        model: selection.logicalModel,
        actualModel: selection.actualModel,
        provider: selection.provider,
        image_cost: null,
        file_context_cost: null,
        estimated_real_usd_cost: cost,
      });

      return NextResponse.json({
        response: {
          refined_prompt: refinedPrompts[0]?.prompt,
          refined_prompts: refinedPrompts,
          image_count: refinedPrompts.length,
          explanation: refinedPrompts.length > 1
            ? `Prepared ${refinedPrompts.length} Roblox assets. Review them, then generate.`
            : 'Prepared a Roblox asset prompt. Review it, then generate.',
          credits_used: cost,
          credits_remaining: creditResult.creditsRemaining,
        },
        conversation_id: convId,
        message_id: messageId,
      });
    }

    // ── Image: generate ───────────────────────────────────────────────────────
    if (type === 'image' && step === 'generate') {
      const prompts = imagePrompts.length > 0
        ? imagePrompts
        : [{ label: 'Roblox asset', prompt }];
      const imageAllowance = await canGenerateImages(user.id, prompts.length);
      if (!imageAllowance.allowed) {
        return NextResponse.json({ error: imageAllowance.reason }, { status: 402 });
      }

      const cost = CREDIT_COSTS.IMAGE * prompts.length;
      if (!(await hasCredits(user.id, cost))) {
        return NextResponse.json({ error: 'Insufficient AI Wallet balance' }, { status: 402 });
      }

      const imageUrls = await Promise.all(prompts.map(item => generateImage(item)));
      console.info('[AI generation]', {
        route: 'roblox_image_generate',
        provider: 'openai',
        model: 'gpt-image-1.5',
        selectedModelTier: planModel,
        geminiConfigured: !!process.env.GEMINI_API_KEY,
        inputTokens: null,
        outputTokens: null,
        imageCost: cost,
        fileContextCost: null,
        estimatedRealUsdCost: cost,
        deductedWalletAmount: cost,
        userId: user.id,
      });
      const { convId, messageId } = await saveMessages(
        user.id,
        conversationId,
        prompt || prompts.map(item => item.prompt).join('\n\n'),
        `Generated ${prompts.length} Roblox image preview${prompts.length === 1 ? '' : 's'}. Roblox asset upload is not implemented yet; upload the image to Roblox and replace placeholder rbxassetid values before inserting it into a Studio UI.`,
        planModel,
        cost,
      );
      const creditResult = await deductCredits(user.id, cost, 'image_generation', {
        model: 'gpt-image-1.5',
        actualModel: 'gpt-image-1.5',
        provider: 'openai',
        image_cost: cost,
        file_context_cost: null,
        estimated_real_usd_cost: cost,
      });
      await incrementImageCount(user.id, prompts.length);

      return NextResponse.json({
        response: {
          image_url: imageUrls[0],
          image_urls: imageUrls,
          image_count: imageUrls.length,
          explanation: `Generated ${imageUrls.length} Roblox image preview${imageUrls.length === 1 ? '' : 's'}. Roblox asset upload is not implemented yet; upload the image to Roblox and replace placeholder rbxassetid values before inserting it into a Studio UI.`,
          credits_used: cost,
          credits_remaining: creditResult.creditsRemaining,
        },
        conversation_id: convId,
        message_id: messageId,
      });
    }

    // ── Script / UI: streaming SSE with token-based billing ───────────────────

    // Pre-flight: user must have a positive AI Wallet balance.
    const { data: creditCheck } = await supabaseAdmin
      .from('users')
      .select('monthly_wallet_balance, extra_wallet_balance')
      .eq('id', user.id)
      .single();

    if (!creditCheck || (Number(creditCheck.monthly_wallet_balance ?? 0) + Number(creditCheck.extra_wallet_balance ?? 0)) <= 0) {
      return NextResponse.json({ error: 'Insufficient AI Wallet balance' }, { status: 402 });
    }

    const encoder = new TextEncoder();
    let clientCancelled = false;

    const readable = new ReadableStream({
      async start(controller) {
        let fullContent  = '';
        let inputTokens  = 0;
        let outputTokens = 0;
        let responseSource: 'provider' | 'retry' | 'fallback' = 'provider';
        let emptyResponseCause: string | null = null;

        try {
          console.info('[AI route]', {
            route: 'roblox_stream',
            provider: selection.provider,
            model: selection.actualModel,
            selectedModelTier: planModel,
            ...getAIRoutingDebug('roblox', prompt, planModel),
            inputTokenEstimate: estimateInputTokens(prompt, history),
          });
          const firstResponse = await collectAIResponse(selection, prompt, history, () => clientCancelled);
          fullContent = firstResponse.content;
          inputTokens = firstResponse.inputTokens;
          outputTokens = firstResponse.outputTokens;

          // Client cancelled mid-stream — don't charge, don't save
          if (clientCancelled) {
            controller.close();
            return;
          }

          // Calculate token-based cost
          emptyResponseCause = studioAssemblyIssue(fullContent, type, prompt);
          if (emptyResponseCause) {
            console.warn('[Roblox stream] Empty or incomplete response', {
              route: 'roblox_stream',
              provider: selection.provider,
              model: selection.actualModel,
              selectedModelTier: planModel,
              cause: emptyResponseCause,
              attempt: 1,
              inputTokens,
              outputTokens,
              userId: user.id,
            });

            try {
              const retryResponse = await callAI(selection, strictStudioRetryPrompt(prompt), 'roblox', history);
              fullContent = retryResponse.content;
              inputTokens = retryResponse.usage?.input_tokens ?? 0;
              outputTokens = retryResponse.usage?.output_tokens ?? 0;
              responseSource = 'retry';
              emptyResponseCause = studioAssemblyIssue(fullContent, type, prompt);
            } catch (retryError: any) {
              emptyResponseCause = `retry_error:${retryError.message}`;
              console.error('[Roblox stream] Strict retry failed', {
                route: 'roblox_stream',
                provider: selection.provider,
                model: selection.actualModel,
                cause: emptyResponseCause,
                userId: user.id,
              });
            }
          }

          if (emptyResponseCause) {
            fullContent = genericStudioFallback(prompt);
            inputTokens = 0;
            outputTokens = 0;
            responseSource = 'fallback';
            console.warn('[Roblox stream] Using deterministic Studio fallback', {
              route: 'roblox_stream',
              provider: selection.provider,
              model: selection.actualModel,
              cause: emptyResponseCause,
              userId: user.id,
            });
          }

          if (!fullContent.trim()) {
            throw new Error('Roblox generation failed after retry and fallback');
          }

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: fullContent })}\n\n`)
          );

          const totalTokens = inputTokens + outputTokens;
          const tokenCost = responseSource === 'fallback'
            ? 0
            : estimateTokenCostUsd(selection.actualModel, inputTokens, outputTokens);

          const { convId, messageId } = await saveMessages(
            user.id,
            conversationId,
            prompt,
            fullContent,
            planModel,
            tokenCost,
          );

          const creditResult = tokenCost > 0
            ? await deductCredits(user.id, tokenCost, `${type}_generation`, {
                model: selection.logicalModel,
                actualModel: selection.actualModel,
                provider: selection.provider,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: totalTokens,
                image_cost: null,
                file_context_cost: null,
                estimated_real_usd_cost: tokenCost,
              })
            : {
                creditsRemaining: Number(creditCheck.monthly_wallet_balance ?? 0)
                  + Number(creditCheck.extra_wallet_balance ?? 0),
              };
          console.info('[AI generation]', {
            route: 'roblox_stream',
            provider: selection.provider,
            model: selection.actualModel,
            selectedModelTier: planModel,
            ...getAIRoutingDebug('roblox', prompt, planModel),
            inputTokenEstimate: estimateInputTokens(prompt, history),
            inputTokens,
            outputTokens,
            imageCost: null,
            fileContextCost: null,
            estimatedRealUsdCost: tokenCost,
            deductedWalletAmount: tokenCost,
            responseSource,
            emptyResponseCause,
            userId: user.id,
          });

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'done',
                credits_used: tokenCost,
                credits_remaining: creditResult.creditsRemaining,
                conversation_id: convId,
                message_id: messageId,
                tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
              })}\n\n`
            )
          );

        } catch (err: any) {
          if (!clientCancelled) {
            console.error('[Roblox stream] Error:', err.message);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'error', error: err.message || 'Internal server error' })}\n\n`
              )
            );
          }
        } finally {
          controller.close();
        }
      },

      // Called when the client disconnects (fetch aborted)
      cancel() {
        clientCancelled = true;
        console.log('[Roblox stream] Client disconnected — not charging credits');
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error: any) {
    console.error('[Roblox chat] Error:', error);
    if (error.message === 'Insufficient AI Wallet balance') {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
