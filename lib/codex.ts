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

const MAX_OUTPUT_TOKENS = 4096;
const DISCORD_MAX_OUTPUT_TOKENS = 8192;
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
- Explain your code briefly after generating it
- If generating a full system, break it into organized modules

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
1. A short friendly explanation (2-4 sentences) of what you're creating
2. Then a JSON block in this EXACT format:

\`\`\`json
{
  "roles": [
    { "name": "Admin", "emoji": "👑", "color": 15158332, "hoist": true, "mentionable": false, "permissions": "8" },
    { "name": "Moderator", "emoji": "🛡️", "color": 3447003, "hoist": true, "mentionable": true, "permissions": "11270" },
    { "name": "Member", "emoji": "🎮", "color": 3066993, "hoist": false, "mentionable": false, "permissions": "3072" }
  ],
  "categories": [
    {
      "name": "INFORMATION",
      "emoji": "📢",
      "channels": [
        { "name": "rules", "type": "text", "emoji": "📌", "topic": "Server rules and guidelines" },
        { "name": "announcements", "type": "text", "emoji": "📣", "topic": "Important announcements" }
      ]
    },
    {
      "name": "GENERAL",
      "emoji": "💬",
      "channels": [
        { "name": "general", "type": "text", "emoji": "💬", "topic": "General chat" },
        { "name": "voice-chat", "type": "voice", "emoji": "🔊" }
      ]
    }
  ]
}
\`\`\`

Rules for the JSON:
- Role colors are decimal integers (e.g. red=15158332, blue=3447003, green=3066993, purple=10181046, orange=15105570)
- permissions is a Discord decimal bitfield. Combine every permission the role needs in one decimal string.
- Common permission values: "8" = Administrator; "3072" = View Channels + Send Messages; "11264" = View Channels + Send Messages + Manage Messages; "11270" = View Channels + Send Messages + Manage Messages + Kick Members + Ban Members; "0" = no special permissions
- Never give a moderator only "2" or "4". Moderation roles that work in channels need the combined channel bits too unless the user asks for a restricted role.
- Each role MUST have an appropriate emoji field that visually represents the role
- Each channel MUST have an appropriate emoji field that visually represents the channel's purpose
- Each category MUST have an appropriate emoji field that visually represents the category's theme
- Channel type is "text" or "voice"
- Category and channel names should be lowercase with hyphens (Discord style)
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

  return [
    ...history,
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

function getResponseOptions(context: RevroContext) {
  if (context === 'discord') {
    return {
      max_output_tokens: DISCORD_MAX_OUTPUT_TOKENS,
      reasoning: { effort: 'low' as const },
    };
  }

  return { max_output_tokens: MAX_OUTPUT_TOKENS };
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
  model: string,
  userMessage: string,
  context: RevroContext = 'roblox',
  conversationHistory: ConversationMessage[] = []
): AsyncGenerator<AICompatibleStreamEvent> {
  try {
    const stream = await getOpenAIClient().responses.create({
      model,
      instructions: getSystemPrompt(context),
      input: buildInput(userMessage, conversationHistory),
      ...getResponseOptions(context),
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
  model: string,
  userMessage: string,
  context: RevroContext = 'roblox',
  conversationHistory: ConversationMessage[] = []
) {
  try {
    const response = await getOpenAIClient().responses.create({
      model,
      instructions: getSystemPrompt(context),
      input: buildInput(userMessage, conversationHistory),
      ...getResponseOptions(context),
    });

    const content = getOutputText(response);
    if (!content.trim()) {
      const incompleteReason = response.incomplete_details?.reason;
      console.error('OpenAI empty text output:', {
        context,
        model,
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
};

export function getActualModelId(planModel: string): string {
  return MODEL_IDS[planModel as keyof typeof MODEL_IDS] || MODEL_IDS['codex-standard'];
}
