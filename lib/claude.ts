import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY!,
});

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
    { "name": "Moderator", "emoji": "🛡️", "color": 3447003, "hoist": true, "mentionable": true, "permissions": "2" }
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
- permissions: "8" = Administrator, "2" = Kick Members, "4" = Ban Members, "2048" = Send Messages, "1024" = View Channels, "8192" = Manage Messages, "0" = no special permissions
- Each role MUST have an appropriate emoji field that visually represents the role
- Each channel MUST have an appropriate emoji field that visually represents the channel's purpose
- Each category MUST have an appropriate emoji field that visually represents the category's theme
- Channel type is "text" or "voice"
- Category and channel names should be lowercase with hyphens (Discord style)
- Include 3-8 roles and 3-6 categories with 2-5 channels each
- Always include a general text channel and at least one voice channel

For follow-up questions or general Discord advice (not building), respond normally without JSON.`;


/** Streaming version — returns an Anthropic MessageStream you can iterate over. */
export function streamClaude(
  model: string,
  userMessage: string,
  context: 'roblox' | 'discord' | 'bot' = 'roblox',
  conversationHistory: any[] = []
) {
  const systemPrompt = context === 'roblox' ? ROBLOX_SYSTEM_PROMPT
    : context === 'bot' ? BOT_SYSTEM_PROMPT
    : DISCORD_SYSTEM_PROMPT;
  const messages = [
    ...conversationHistory,
    { role: 'user' as const, content: userMessage },
  ];
  return anthropic.messages.stream({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });
}

export async function callClaude(
  model: string,
  userMessage: string,
  context: 'roblox' | 'discord' | 'bot' = 'roblox',
  conversationHistory: any[] = []
) {
  const systemPrompt = context === 'roblox' ? ROBLOX_SYSTEM_PROMPT
    : context === 'bot' ? BOT_SYSTEM_PROMPT
    : DISCORD_SYSTEM_PROMPT;

  // Build message history
  const messages = [
    ...conversationHistory,
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });

    return {
      content: response.content[0].type === 'text' 
        ? response.content[0].text 
        : '',
      usage: response.usage
    };
  } catch (error: any) {
    console.error('Claude API error:', error);
    throw new Error(`AI service error: ${error.message}`);
  }
}

// Model mapping — keys match PLAN_CONFIG model names, values are Anthropic API model IDs
export const MODEL_IDS: Record<string, string> = {
  'claude-haiku-4-5':   'claude-haiku-4-5',
  'claude-sonnet-4-5':  'claude-sonnet-4-5',
  'claude-sonnet-4-6':  'claude-sonnet-4-6',
  'claude-opus-4-5':    'claude-opus-4-5',
  'claude-opus-4-6':    'claude-opus-4-6',
};

export function getActualModelId(planModel: string): string {
  return MODEL_IDS[planModel as keyof typeof MODEL_IDS] || MODEL_IDS['claude-sonnet-4-5'];
}
