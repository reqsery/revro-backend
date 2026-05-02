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

const DISCORD_SYSTEM_PROMPT = `You are an expert Discord server administrator and Revro AI assistant. Your job is to help users plan and create Discord server setups.

Key guidelines:
- Suggest well-organized channel categories and channels
- Recommend appropriate permissions for roles
- Consider server purpose and target audience
- Follow Discord best practices for moderation and organization
- Suggest useful bots when relevant (MEE6, Dyno, Carl-bot, etc.)
- Create welcome messages that are friendly and informative
- Plan verification systems when appropriate
- Consider scalability and future growth

When planning a server, provide a clear, organized blueprint that can be executed step-by-step.`;

/** Streaming version — returns an Anthropic MessageStream you can iterate over. */
export function streamClaude(
  model: string,
  userMessage: string,
  context: 'roblox' | 'discord' = 'roblox',
  conversationHistory: any[] = []
) {
  const systemPrompt = context === 'roblox' ? ROBLOX_SYSTEM_PROMPT : DISCORD_SYSTEM_PROMPT;
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
  context: 'roblox' | 'discord' = 'roblox',
  conversationHistory: any[] = []
) {
  const systemPrompt = context === 'roblox' 
    ? ROBLOX_SYSTEM_PROMPT 
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
