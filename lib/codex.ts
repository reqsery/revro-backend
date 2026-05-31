import OpenAI from 'openai';

type RevroContext = 'roblox' | 'discord' | 'bot';
type ConversationMessage = {
  role?: string;
  content?: unknown;
};

type AICompatibleUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
};

type AISelection = {
  provider: 'openai' | 'gemini';
  logicalModel: string;
  actualModel: string;
};

type AICompatibleStreamEvent =
  | {
      type: 'message_start';
      message: { usage: AICompatibleUsage };
    }
  | {
      type: 'content_block_delta';
      delta: { type: 'text_delta'; text: string };
    }
  | {
      type: 'message_delta';
      usage: AICompatibleUsage;
    };

const HISTORY_WINDOW = 8;
const OLDER_SUMMARY_WINDOW = 8;
const OLDER_SUMMARY_CHARS = 160;
const MAX_OUTPUT_TOKENS_BY_MODEL: Record<string, number> = {
  'codex-mini-latest': 2048,
  'gpt-5.1-codex': 4096,
  'gemini-3.1-flash-lite': 1536,
  'gemini-2.5-flash': 2048,
  'gemini-2.5-flash-lite': 1536,
};
let openaiClient: OpenAI | null = null;

// System prompts (you can load these from files later)
const ROBLOX_SYSTEM_PROMPT = `You are an expert Roblox Lua developer and Revro AI assistant. Your job is to help users create Roblox scripts, UI elements, and game systems.

Key guidelines:
- Write clean, efficient, modern Lua code following Roblox best practices
- Use proper indentation and comments
- Always check for nil values and handle errors
- Use CollectionService for tagging when appropriate
- For RemoteEvents/Functions, always validate inputs on the server
- When creating UI, use modern UICorner, UIStroke, and proper scaling
- Keep responses concise and execution-oriented. Do not write long tutorials, setup essays, or manual assembly instructions unless the user explicitly asks.
- Do not invent a Roblox Studio explorer tree or describe what it would probably contain. Revro reads the live tree through the Studio plugin before explorer questions and existing-game edits reach you.
- When a prompt includes a [Live Roblox Studio explorer tree], treat it as the source of truth. Reuse and update named existing objects with APPLY_PROPERTIES or upserted script/UI tasks instead of creating duplicate systems.
- Return exactly one revro_studio_tasks manifest for an assembly. Do not repeat a previous manifest unless the requested Studio changes require it.
- If generating a full system, break it into organized modules
- For systems such as rebirth, shop, simulator mechanics, inventory, quests, or currency, generate Studio-ready structure instead of tiny snippets
- Label each Lua/Luau code block with its intended target service and script type, such as ServerScriptService Script, StarterGui LocalScript, ReplicatedStorage ModuleScript, and ReplicatedStorage RemoteEvent
- Include needed folders, RemoteEvents, ModuleScripts, server scripts, client scripts, and UI wiring so Revro can insert the pieces through the Studio plugin
- Keep each code block focused on one Studio object and name it clearly
- When the user asks for UI, assets, or a complete system, include a JSON code block with a "revro_studio_tasks" array before any Lua blocks. The frontend will hide this manifest and use it to insert the system.
- Studio task item shape: { "task_type": "CREATE_UI|INSERT_SCRIPT|CREATE_FOLDER|CREATE_REMOTE_EVENT|CREATE_MODULE_SCRIPT|INSERT_INSTANCE|APPLY_PROPERTIES|READ_EXPLORER|START_PLAYTEST|STOP_PLAYTEST|READ_OUTPUT|APPLY_IMAGE", "data": { ... } }
- For UI requests, prefer a CREATE_UI task that creates a ScreenGui under StarterGui with nested Frame, TextLabel, TextButton, ImageLabel, UICorner, UIStroke, UIPadding, and layout objects. Add a LocalScript controller in the same CREATE_UI task when needed.
- If the user says "use this image" or references an uploaded icon, create ImageLabels/ImageButtons and wire the UI. If they supplied a numeric Roblox asset ID, use that real rbxassetid value. Otherwise use a placeholder such as "rbxassetid://REPLACE_WITH_UPLOADED_ASSET_ID". Clearly tell the user when they must publish the preview to Roblox and replace the placeholder. Never claim a placeholder image was inserted.
- If the user asks to implement an existing image preview as UI, build the placeholder-backed Studio UI assembly. Do not generate another image unless the user explicitly requests another image.
- For systems, include CREATE_FOLDER for ReplicatedStorage folders, CREATE_REMOTE_EVENT for remotes, CREATE_MODULE_SCRIPT or INSERT_SCRIPT with data.script_type="ModuleScript" for shared logic, INSERT_SCRIPT with data.script_type="Script" or "LocalScript" for server/client scripts, and CREATE_UI for StarterGui UI when useful.
- After the manifest, provide a short "What will be inserted" summary in at most 3 bullets and only the code blocks that map directly to Studio tasks.
- Do not explain how to manually create folders, remotes, scripts, or UI when a revro_studio_tasks manifest can create them.
- Do not say the user needs to copy/paste files into Studio when the plugin manifest is present.
- Prefer action/result language like "Ready to insert into Studio" over tutorial language like "follow these steps".

When the user asks to create something, generate the complete, working code ready to be inserted into Roblox Studio.`;

const BOT_SYSTEM_PROMPT = `You are an expert Discord bot developer and Revro AI assistant. Your job is to generate working Discord bot code in Node.js using discord.js v14.

When generating a bot, always produce:
1. A short explanation of what the bot does (2-3 sentences)
2. A complete, working index.js file in a code block:

\`\`\`javascript
// Bot code here
\`\`\`

Guidelines:
- Use discord.js v14 with slash commands (REST API registration)
- Include a ready event that logs the bot username
- Handle interactionCreate for slash commands
- Use process.env.TOKEN for the bot token
- Add a .env.example block in a comment at the top showing required env vars
- Write clean, well-commented code
- For complex bots, split into logical sections with comments
- Always include basic error handling

After the code block, add setup instructions in a brief numbered list.`;

const DISCORD_SYSTEM_PROMPT = `You are an expert Discord server administrator and Revro AI assistant. Your job is to help users plan and automatically build Discord server setups.

When the user asks you to set up, create, or plan a Discord server, you MUST respond with:
1. A short execution summary (1 sentence) of what will be built. Do not write a long blueprint explanation and do not describe unsupported manual work.
2. Then a JSON block in this EXACT format:

\`\`\`json
{
  "roles": [
    { "name": "Admin", "emoji": "🛡️", "color": 15158332, "hoist": true, "mentionable": false, "permissions": "11264" },
    { "name": "Moderator", "emoji": "🔨", "color": 3447003, "hoist": true, "mentionable": true, "permissions": "11270" },
    { "name": "Member", "emoji": "👤", "color": 3066993, "hoist": false, "mentionable": false, "permissions": "3072" }
  ],
  "categories": [
    {
      "name": "INFORMATION",
      "emoji": "📢",
      "channels": [
        { "name": "rules", "type": "text", "emoji": "📌", "topic": "Server rules and guidelines" },
        { "name": "announcements", "type": "text", "emoji": "📢", "topic": "Important announcements" }
      ]
    },
    {
      "name": "GENERAL",
      "emoji": "💬",
      "channels": [
        { "name": "general", "type": "text", "emoji": "💬", "topic": "General chat" },
        { "name": "community-help", "type": "text", "emoji": "❓", "topic": "Questions and help threads" },
        { "name": "voice-chat", "type": "voice", "emoji": "🔊" }
      ]
    }
  ]
}
\`\`\`

Rules for the JSON:
- Output exactly one valid JSON object in one json code block. The deployer only builds what is inside the JSON.
- Role colors are decimal integers (e.g. red=15158332, blue=3447003, green=3066993, purple=10181046, orange=15105570)
- permissions is a Discord decimal bitfield. Combine every permission the role needs in one decimal string.
- Common permission values: "3072" = View Channels + Send Messages; "11264" = View Channels + Send Messages + Manage Messages; "11270" = View Channels + Send Messages + Manage Messages + Kick Members + Ban Members; "0" = no special permissions
- Do not use Administrator permission ("8"). Revro strips it for safety.
- Never give a moderator only "2" or "4". Moderation roles that work in channels need the combined channel bits too unless the user asks for a restricted role.
- Each role MUST have an appropriate emoji field that visually represents the role
- Each channel MUST have an appropriate emoji field that visually represents the channel's purpose
- Each category MUST have an appropriate emoji field that visually represents the category's theme
- Channel type is "text" or "voice". Use normal text channels for announcements, rules, forums, support, tickets, patch notes, and community channels.
- For private/paywalled channels, add "allowed_roles": ["Exact Role Name"] on the channel. The builder will deny @everyone and allow those roles.
- For channels a role must not see, add "denied_roles": ["Exact Role Name"].
- For read-only channels, add "read_only": true. The builder will deny Send Messages while keeping View Channel.
- Do not promise channel-level access, paywalls, or read-only behavior unless the matching allowed_roles, denied_roles, or read_only fields are in the JSON.
- Do not use marketing phrases like "meticulously structured", "complete blueprint", or "ready for deployment" unless the JSON is valid and contains the requested roles, permissions, categories, and channels.
- Do not use special Discord channel types like "announcement" or "forum"; the builder creates safe normal text channels instead.
- Category and channel names should be lowercase with hyphens (Discord style). Add emoji fields; the builder renders channels like "📢・announcements", "📜・rules", "💬・general", "🎫・support", "🏆・vip".
- Include 3-8 roles and 3-6 categories with 2-5 channels each
- Always include a general text channel and at least one voice channel

For follow-up questions or general Discord advice (not building), respond normally without JSON.`;

function getSystemPrompt(context: RevroContext): string {
  if (context === 'bot') return BOT_SYSTEM_PROMPT;
  if (context === 'discord') return DISCORD_SYSTEM_PROMPT;
  return ROBLOX_SYSTEM_PROMPT;
}

function getOpenAIClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('AI service is not configured (OPENAI_API_KEY missing)');
  }

  openaiClient ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  return openaiClient;
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizeRole(role: string | undefined): 'user' | 'assistant' {
  return role === 'assistant' ? 'assistant' : 'user';
}

function buildInput(userMessage: string, conversationHistory: ConversationMessage[] = []) {
  const history = conversationHistory
    .map((message) => ({
      role: normalizeRole(message.role),
      content: normalizeContent(message.content),
    }))
    .filter((message) => message.content.trim().length > 0);
  const recent = history.slice(-HISTORY_WINDOW);
  const older = history.slice(-(HISTORY_WINDOW + OLDER_SUMMARY_WINDOW), -HISTORY_WINDOW);
  const olderSummary = older
    .map((message) => `${message.role}: ${message.content.replace(/\s+/g, ' ').slice(0, OLDER_SUMMARY_CHARS)}`)
    .join('\n');

  return [
    ...(olderSummary ? [{
      role: 'user' as const,
      content: `[Older conversation summary]\n${olderSummary}`,
    }] : []),
    ...recent,
    { role: 'user' as const, content: userMessage },
  ];
}

function normalizeUsage(usage: any): AICompatibleUsage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    total_tokens: usage?.total_tokens,
  };
}

function getMaxOutputTokens(model: string): number {
  return MAX_OUTPUT_TOKENS_BY_MODEL[model] ?? 2048;
}

function getResponseOptions(model: string, context: RevroContext) {
  if (context === 'discord') {
    return {
      max_output_tokens: Math.min(getMaxOutputTokens(model), 4096),
      reasoning: { effort: 'low' as const },
    };
  }

  return { max_output_tokens: getMaxOutputTokens(model) };
}

function getOutputText(response: any): string {
  if (typeof response.output_text === 'string') return response.output_text;

  return (response.output ?? [])
    .flatMap((item: any) => item?.content ?? [])
    .map((content: any) => content?.text ?? '')
    .filter(Boolean)
    .join('');
}

export async function* streamAI(
  selection: AISelection,
  userMessage: string,
  context: RevroContext = 'roblox',
  conversationHistory: ConversationMessage[] = []
): AsyncGenerator<AICompatibleStreamEvent> {
  if (selection.provider === 'gemini') {
    const result = await callGemini(selection.actualModel, userMessage, context, conversationHistory);
    yield { type: 'message_start', message: { usage: { input_tokens: result.usage.input_tokens, output_tokens: 0 } } };
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: result.content } };
    yield { type: 'message_delta', usage: result.usage };
    return;
  }

  try {
    const stream = await getOpenAIClient().responses.create({
      model: selection.actualModel,
      instructions: getSystemPrompt(context),
      input: buildInput(userMessage, conversationHistory),
      ...getResponseOptions(selection.actualModel, context),
      stream: true,
      stream_options: { include_obfuscation: false },
    });

    for await (const event of stream) {
      if (event.type === 'response.created') {
        yield {
          type: 'message_start',
          message: { usage: normalizeUsage(event.response.usage) },
        };
      } else if (event.type === 'response.output_text.delta') {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: event.delta },
        };
      } else if (event.type === 'response.completed') {
        yield {
          type: 'message_delta',
          usage: normalizeUsage(event.response.usage),
        };
      } else if (event.type === 'response.failed') {
        throw new Error(event.response.error?.message ?? 'OpenAI response failed');
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  } catch (error: any) {
    console.error('OpenAI stream error:', error);
    throw new Error(`AI service error: ${error.message}`);
  }
}

export async function callAI(
  selection: AISelection,
  userMessage: string,
  context: RevroContext = 'roblox',
  conversationHistory: ConversationMessage[] = []
) {
  if (selection.provider === 'gemini') {
    return callGemini(selection.actualModel, userMessage, context, conversationHistory);
  }

  try {
    const response = await getOpenAIClient().responses.create({
      model: selection.actualModel,
      instructions: getSystemPrompt(context),
      input: buildInput(userMessage, conversationHistory),
      ...getResponseOptions(selection.actualModel, context),
    });

    const content = getOutputText(response);
    if (!content.trim()) {
      const incompleteReason = response.incomplete_details?.reason;
      console.error('OpenAI empty text output:', {
        context,
        model: selection.actualModel,
        status: response.status,
        incompleteReason,
        outputTypes: (response.output ?? []).map((item: any) => item?.type).filter(Boolean),
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      });
      throw new Error(
        incompleteReason
          ? `OpenAI response incomplete (${incompleteReason})`
          : 'OpenAI returned no text output'
      );
    }

    return {
      content,
      usage: normalizeUsage(response.usage),
    };
  } catch (error: any) {
    console.error('OpenAI API error:', error);
    throw new Error(`AI service error: ${error.message}`);
  }
}

export const MODEL_IDS: Record<string, string> = {
  'codex-mini': 'codex-mini-latest',
  'codex-standard': 'gpt-5.1-codex',
  'codex-advanced': 'gpt-5.1-codex',
  'codex-premium': 'gpt-5.1-codex',
  'codex-max': 'gpt-5.1-codex',
};

export function getActualModelId(planModel: string): string {
  return MODEL_IDS[planModel as keyof typeof MODEL_IDS] || MODEL_IDS['codex-mini'];
}

function isAdvancedCodingTask(context: RevroContext, prompt: string): boolean {
  if (context === 'bot') return true;
  if (context === 'discord') return false;
  return /\b(script|module|datastore|remoteevent|remotefunction|server|client|pathfinding|npc|combat|inventory|system|bug|debug|optimi[sz]e|refactor|lua|code)\b/i.test(prompt);
}

function isLowCostModelTier(planModel: string): boolean {
  return planModel === 'codex-mini' || planModel === 'codex-standard';
}

function getGeminiModel(planModel: string): string {
  if (isLowCostModelTier(planModel)) {
    return process.env.GEMINI_LOW_TIER_MODEL || 'gemini-2.5-flash-lite';
  }

  return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
}

export function selectAIModel(planModel: string, context: RevroContext, prompt: string): AISelection {
  const geminiConfigured = !!process.env.GEMINI_API_KEY;
  const forceGeminiForLowTier = isLowCostModelTier(planModel);
  const useGemini = geminiConfigured && (forceGeminiForLowTier || !isAdvancedCodingTask(context, prompt));

  return useGemini
    ? { provider: 'gemini', logicalModel: 'gemini-flash', actualModel: getGeminiModel(planModel) }
    : { provider: 'openai', logicalModel: planModel, actualModel: getActualModelId(planModel) };
}

export function getAIRoutingDebug(context: RevroContext, prompt: string, planModel?: string) {
  return {
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    advancedCodingTask: isAdvancedCodingTask(context, prompt),
    forceGeminiForLowTier: planModel ? isLowCostModelTier(planModel) : undefined,
  };
}

export function estimateInputTokens(prompt: string, history: ConversationMessage[] = []): number {
  const chars = buildInput(prompt, history).reduce((count, item) => count + item.content.length, 0);
  return Math.ceil(chars / 4);
}

async function callGemini(
  model: string,
  userMessage: string,
  context: RevroContext,
  conversationHistory: ConversationMessage[] = []
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini is not configured (GEMINI_API_KEY missing)');

  const fallbackModels = [
    model,
    process.env.GEMINI_FALLBACK_MODEL,
    model === 'gemini-2.5-flash' ? 'gemini-2.5-flash-lite' : 'gemini-2.5-flash',
  ].filter((item, index, arr): item is string => !!item && arr.indexOf(item) === index);

  let lastError = '';
  for (const candidateModel of fallbackModels) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${candidateModel}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: getSystemPrompt(context) }] },
        contents: buildInput(userMessage, conversationHistory).map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        generationConfig: { maxOutputTokens: getMaxOutputTokens(candidateModel), temperature: 0.4 },
      }),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastError = data?.error?.message ?? `Gemini error ${response.status}`;
      const retryable = response.status === 429 || response.status >= 500 || /demand|overload|temporar/i.test(lastError);
      if (retryable && candidateModel !== fallbackModels[fallbackModels.length - 1]) {
        console.warn('[Gemini] Retrying with fallback model', {
          from: candidateModel,
          to: fallbackModels[fallbackModels.indexOf(candidateModel) + 1],
          status: response.status,
        });
        continue;
      }
      throw new Error(lastError);
    }
    const content = (data?.candidates?.[0]?.content?.parts ?? [])
      .map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('');
    if (!content.trim()) throw new Error('Gemini returned no text output');
    return {
      content,
      usage: {
        input_tokens: data?.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: data?.usageMetadata?.totalTokenCount,
      },
    };
  }
  throw new Error(lastError || 'Gemini generation failed');
}
