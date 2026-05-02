import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

async function upsertContact(email: string, firstName: string): Promise<void> {
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!audienceId) return;
  // Ignore errors — contact may already exist, which is fine
  await resend.contacts.create({ audienceId, email, firstName, unsubscribed: false }).catch(() => {});
}

/**
 * Fire a Resend automation event. Never throws — all errors are logged only.
 * Call with `void fireResendEvent(...)` so it doesn't block the response.
 */
export async function fireResendEvent(
  eventName: string,
  email: string,
  firstName: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!audienceId) {
    console.warn(`[Resend] RESEND_AUDIENCE_ID not set — skipping ${eventName}`);
    return;
  }
  try {
    await upsertContact(email, firstName);
    // createEvent fires Resend automation triggers
    await (resend.contacts as any).createEvent({ eventName, email, audienceId, data });
    console.log(`[Resend] ${eventName} → ${email}`);
  } catch (err) {
    console.error(`[Resend] Failed to fire ${eventName} for ${email}:`, err);
  }
}
