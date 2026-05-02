# Revro API Documentation

Complete API reference for Revro backend endpoints.

**Base URL:** `https://revro.dev`

---

## Authentication

Revro supports two authentication methods:

### 1. JWT Token (Web Dashboard)
Include in Authorization header:
```
Authorization: Bearer your_jwt_token
```

### 2. API Key (Roblox Plugin)
Include in custom header:
```
x-api-key: your_api_key
```

---

## Table of Contents

- [Authentication Endpoints](#authentication-endpoints)
- [User Endpoints](#user-endpoints)
- [AI Chat Endpoints](#ai-chat-endpoints)
- [Plugin Endpoints](#plugin-endpoints)
- [Error Responses](#error-responses)

---

## Authentication Endpoints

### POST /api/auth/signup

Create a new user account.

**Request Body:**
```json
{
 "email": "user@example.com",
 "password": "securepassword123",
 "displayName": "John Doe" // Optional
}
```

**Success Response (201):**
```json
{
 "message": "Account created successfully",
 "user": {
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe"
 },
 "apiKey": "k8x2P9mT4vL7nQ3wR6yB5cE1aF8dH0j"
}
```

**Error Responses:**
- `400` - Email and password required
- `400` - Password must be at least 8 characters
- `400` - User already exists
- `500` - Failed to create user profile

**Notes:**
- Automatically generates API key
- Sends welcome email with API key
- User starts on Free plan (25 credits)

---

### POST /api/auth/login

Login to existing account.

**Request Body:**
```json
{
 "email": "user@example.com",
 "password": "securepassword123"
}
```

**Success Response (200):**
```json
{
 "message": "Login successful",
 "user": {
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe"
 },
 "session": {
  "access_token": "jwt_token_here",
  "refresh_token": "refresh_token_here",
  "expires_at": 1234567890
 }
}
```

**Error Responses:**
- `400` - Email and password required
- `401` - Invalid credentials
- `500` - Internal server error

---

## User Endpoints

### GET /api/user/me

Get current user information.

**Authentication:** Required (JWT or API Key)

**Success Response (200):**
```json
{
 "user": {
  "id": "uuid",
  "email": "user@example.com",
  "display_name": "John Doe",
  "plan": "free",
  "credits_total": 25,
  "credits_used": 5,
  "images_generated": 0,
  "billing_cycle_start": "2026-03-01T00:00:00Z",
  "created_at": "2026-03-01T00:00:00Z"
 }
}
```

**Error Responses:**
- `401` - Unauthorized (missing or invalid token/API key)
- `404` - User not found
- `500` - Internal server error

---

### GET /api/user/usage

Get user's usage statistics.

**Authentication:** Required (JWT or API Key)

**Query Parameters:**
- `period` (optional) - `month` | `week` | `all` (default: `month`)

**Success Response (200):**
```json
{
 "usage": {
  "credits_used": 15,
  "credits_total": 25,
  "credits_remaining": 10,
  "percentage_used": 60,
  "scripts_generated": 10,
  "ui_elements_created": 3,
  "images_generated": 0,
  "discord_setups": 2,
  "period": "month",
  "billing_cycle_start": "2026-03-01T00:00:00Z",
  "billing_cycle_end": "2026-04-01T00:00:00Z"
 }
}
```

**Error Responses:**
- `401` - Unauthorized
- `500` - Internal server error

---

## AI Chat Endpoints

### POST /api/chat/roblox

Generate Roblox scripts or UI elements using AI.

**Authentication:** Required (JWT or API Key)

**Request Body:**
```json
{
 "prompt": "Create a simple damage script for a weapon",
 "type": "script" // or "ui"
}
```

**Success Response (200):**
```json
{
 "response": {
  "code": "-- Damage Script\nlocal weapon = script.Parent\n...",
  "explanation": "This script handles weapon damage...",
  "credits_used": 5,
  "credits_remaining": 20
 },
 "conversation_id": "uuid",
 "message_id": "uuid"
}
```

**Error Responses:**
- `400` - Prompt is required
- `400` - Type must be 'script' or 'ui'
- `401` - Unauthorized
- `402` - Insufficient credits
- `500` - AI generation failed

**Credit Costs:**
- Simple script: 2 credits
- Medium script: 5 credits
- Complex script: 10 credits
- Full system: 15-25 credits
- Simple UI: 5 credits
- Medium UI: 10 credits
- Advanced UI: 15-25 credits

---

### POST /api/chat/discord

Generate Discord server configurations using AI.

**Authentication:** Required (JWT or API Key)

**Request Body:**
```json
{
 "prompt": "Create a gaming community server with roles and channels",
 "type": "setup" // or "planning" or "blueprint"
}
```

**Success Response (200):**
```json
{
 "response": {
  "config": {
   "channels": [
    {"name": "general", "type": "text"},
    {"name": "voice-chat", "type": "voice"}
   ],
   "roles": [
    {"name": "Member", "permissions": []},
    {"name": "Moderator", "permissions": ["MANAGE_MESSAGES"]}
   ],
   "welcome_message": "Welcome to the server!"
  },
  "explanation": "This setup creates...",
  "credits_used": 5,
  "credits_remaining": 20
 },
 "conversation_id": "uuid",
 "message_id": "uuid"
}
```

**Error Responses:**
- `400` - Prompt is required
- `401` - Unauthorized
- `402` - Insufficient credits
- `500` - AI generation failed

**Credit Costs:**
- Channel/role creation: 1 credit
- Autorole setup: 1 credit
- Welcome/goodbye messages: 2 credits
- Server planning: 3 credits
- Full blueprint: 5-10 credits

---

### GET /api/chat/conversations

Get user's conversation history.

**Authentication:** Required (JWT or API Key)

**Query Parameters:**
- `limit` (optional) - Number of conversations to return (default: 20, max: 100)
- `offset` (optional) - Pagination offset (default: 0)

**Success Response (200):**
```json
{
 "conversations": [
  {
   "id": "uuid",
   "title": "Weapon Damage Script",
   "type": "roblox",
   "created_at": "2026-03-12T10:30:00Z",
   "updated_at": "2026-03-12T10:35:00Z",
   "message_count": 5
  }
 ],
 "total": 42,
 "limit": 20,
 "offset": 0
}
```

**Error Responses:**
- `401` - Unauthorized
- `500` - Internal server error

---

## Plugin Endpoints

### POST /api/plugin/task

Send a task to the Roblox Studio plugin.

**Authentication:** Required (API Key only)

**Request Body:**
```json
{
 "task_type": "INSERT_SCRIPT",
 "data": {
  "code": "print('Hello World')",
  "location": "ServerScriptService"
 }
}
```

**Task Types:**
- `INSERT_SCRIPT` - Insert Lua script into Studio
- `CREATE_UI` - Create UI elements
- `INSERT_INSTANCE` - Insert Roblox instances
- `READ_EXPLORER` - Read Studio explorer tree
- `START_PLAYTEST` - Start playtest
- `AUTO_PLAYTEST` - Auto playtest with checks
- `UPLOAD_IMAGE` - Upload image asset
- `APPLY_IMAGE` - Apply image to object

**Success Response (200):**
```json
{
 "message": "Task sent to plugin",
 "task_id": "uuid",
 "status": "pending"
}
```

**Error Responses:**
- `400` - Invalid task type
- `400` - Missing required data
- `401` - Unauthorized
- `503` - Plugin server unavailable

**Notes:**
- Plugin must be running in Roblox Studio
- Plugin polls server every 3 seconds for tasks
- Results are returned asynchronously

---

## Error Responses

All error responses follow this format:

```json
{
 "error": "Error message description"
}
```

### HTTP Status Codes

- `200` - Success
- `201` - Created (signup successful)
- `400` - Bad Request (validation error)
- `401` - Unauthorized (missing or invalid auth)
- `402` - Payment Required (insufficient credits)
- `404` - Not Found
- `500` - Internal Server Error
- `503` - Service Unavailable (plugin server down)

---

## Rate Limiting

**Current Limits:**
- Authentication endpoints: 5 requests per minute per IP
- AI generation: 20 requests per minute per user
- Other endpoints: 60 requests per minute per user

**Rate Limit Headers:**
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1234567890
```

When rate limited, you'll receive:
```json
{
 "error": "Rate limit exceeded. Try again in 30 seconds."
}
```

---

## Webhooks (Future)

Webhooks are planned for:
- Low credits notification
- Subscription changes
- Task completion from plugin

---

## SDK Examples

### JavaScript/TypeScript

```typescript
// Signup
const signup = async (email: string, password: string) => {
 const response = await fetch('https://revro.dev/api/auth/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
 });
 return response.json();
};

// Generate Roblox script with API key
const generateScript = async (apiKey: string, prompt: string) => {
 const response = await fetch('https://revro.dev/api/chat/roblox', {
  method: 'POST',
  headers: {
   'Content-Type': 'application/json',
   'x-api-key': apiKey
  },
  body: JSON.stringify({ prompt, type: 'script' })
 });
 return response.json();
};
```

### Python

```python
import requests

# Signup
def signup(email, password):
  response = requests.post(
    'https://revro.dev/api/auth/signup',
    json={'email': email, 'password': password}
  )
  return response.json()

# Generate script with API key
def generate_script(api_key, prompt):
  response = requests.post(
    'https://revro.dev/api/chat/roblox',
    headers={'x-api-key': api_key},
    json={'prompt': prompt, 'type': 'script'}
  )
  return response.json()
```

### Lua (Roblox Plugin)

```lua
local HttpService = game:GetService("HttpService")

local API_KEY = "your_api_key_here"
local BASE_URL = "https://revro.dev"

local function generateScript(prompt)
  local response = HttpService:RequestAsync({
    Url = BASE_URL .. "/api/chat/roblox",
    Method = "POST",
    Headers = {
      ["Content-Type"] = "application/json",
      ["x-api-key"] = API_KEY
    },
    Body = HttpService:JSONEncode({
      prompt = prompt,
      type = "script"
    })
  })
  
  return HttpService:JSONDecode(response.Body)
end
```

---

## Testing

### Using cURL

```bash
# Signup
curl -X POST https://revro.dev/api/auth/signup \
 -H "Content-Type: application/json" \
 -d '{"email":"test@example.com","password":"testpass123"}'

# Get user info with API key
curl -H "x-api-key: your_api_key" \
 https://revro.dev/api/user/me

# Generate Roblox script
curl -X POST https://revro.dev/api/chat/roblox \
 -H "Content-Type: application/json" \
 -H "x-api-key: your_api_key" \
 -d '{"prompt":"Create a simple health regeneration script","type":"script"}'
```

### Using Postman

1. Import the base URL
2. Add `x-api-key` header to collection
3. Test each endpoint with sample data

---

## Changelog

### v1.0.0 (March 2026)
- Initial API release
- Authentication endpoints
- AI chat for Roblox and Discord
- Plugin integration
- Credit system
- Email notifications

---

## Support

For API support, contact:
- Email: support@revro.dev
- Documentation issues: Open an issue on GitLab

---

**Last Updated:** March 12, 2026
