import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// Email templates as simple HTML strings for now
// Later you can import React Email templates

const WELCOME_EMAIL_HTML = (userName: string, apiKey: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #484848; }
    .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    h1 { color: #1d1c1d; font-size: 36px; margin-bottom: 30px; }
    .button { background-color: #5865F2; color: white; padding: 14px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; }
    .code-box { background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; margin: 20px 0; }
    .footer { color: #8898aa; font-size: 14px; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Welcome to Revro</h1>
    <p>Hi ${userName},</p>
    <p>You now have access to AI-powered tools that help you create Roblox scripts, UI elements, and Discord server setups.</p>
    
    <h2>Your API Key</h2>
    <p>Here's your API key for the Roblox Studio plugin:</p>
    <div class="code-box">${apiKey}</div>
    <p><strong>Keep this key secure!</strong> You can view it anytime in your dashboard settings.</p>
    
    <h2>What's included:</h2>
    <ul>
      <li>AI-powered script generation</li>
      <li>Roblox Studio plugin integration</li>
      <li>Discord bot setup tools</li>
      <li>Monthly credits for generations</li>
    </ul>
    
    <p style="margin-top: 30px;">
      <a href="https://revro.dev" class="button">Get Started</a>
    </p>
    
    <p class="footer">
      Need help? Contact support@revro.dev<br><br>
      The Revro Team
    </p>
  </div>
</body>
</html>
`;

const VERIFICATION_EMAIL_HTML = (verificationCode: string, verificationUrl: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #484848; }
    .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    h1 { color: #1d1c1d; font-size: 36px; margin-bottom: 30px; }
    .code-box { background-color: #f4f4f5; padding: 24px; border-radius: 8px; text-align: center; margin: 32px 0; }
    .code { font-size: 32px; font-weight: bold; letter-spacing: 4px; font-family: monospace; color: #1d1c1d; }
    .button { background-color: #5865F2; color: white; padding: 14px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; }
    .footer { color: #8898aa; font-size: 14px; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Verify Your Email</h1>
    <p>Thanks for signing up for Revro! Please verify your email address to get started.</p>
    
    <div class="code-box">
      <div class="code">${verificationCode}</div>
    </div>
    
    <p>Or click the button below to verify:</p>
    <p style="margin-top: 20px;">
      <a href="${verificationUrl}" class="button">Verify Email Address</a>
    </p>
    
    <p style="color: #8898aa; font-size: 14px; margin-top: 20px;">
      This verification code will expire in 15 minutes.
    </p>
    
    <p class="footer">
      If you didn't create a Revro account, you can safely ignore this email.
    </p>
  </div>
</body>
</html>
`;

const PASSWORD_RESET_EMAIL_HTML = (resetUrl: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #484848; }
    .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    h1 { color: #1d1c1d; font-size: 36px; margin-bottom: 30px; }
    .button { background-color: #5865F2; color: white; padding: 14px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; }
    .warning { background-color: #fef5f1; border-left: 4px solid #e04f1a; padding: 16px; margin: 24px 0; color: #856404; }
    .footer { color: #8898aa; font-size: 14px; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Reset Your Password</h1>
    <p>We received a request to reset your password for your Revro account.</p>
    <p>Click the button below to create a new password:</p>
    
    <p style="margin-top: 30px;">
      <a href="${resetUrl}" class="button">Reset Password</a>
    </p>
    
    <p style="color: #8898aa; font-size: 14px; margin-top: 20px;">
      This link will expire in 15 minutes for security reasons.
    </p>
    
    <div class="warning">
      If you didn't request a password reset, please ignore this email or contact support if you have concerns.
    </div>
    
    <p class="footer">
      For security, this link can only be used once.<br><br>
      The Revro Team
    </p>
  </div>
</body>
</html>
`;

// Email sending functions
export async function sendWelcomeEmail(
  email: string,
  userName: string,
  apiKey: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Revro <noreply@revro.dev>', // Use resend.dev for now, change to your domain later
      to: email,
      subject: 'Welcome to Revro',
      html: WELCOME_EMAIL_HTML(userName, apiKey),
    });

    if (error) {
      console.error('Failed to send welcome email:', error);
      return { success: false, error: error.message };
    }

    console.log('Welcome email sent:', data);
    return { success: true };
  } catch (error) {
    console.error('Error sending welcome email:', error);
    return { success: false, error: 'Failed to send email' };
  }
}

export async function sendVerificationEmail(
  email: string,
  verificationCode: string,
  verificationUrl: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Revro <noreply@revro.dev>',
      to: email,
      subject: 'Verify your Revro email',
      html: VERIFICATION_EMAIL_HTML(verificationCode, verificationUrl),
    });

    if (error) {
      console.error('Failed to send verification email:', error);
      return { success: false, error: error.message };
    }

    console.log('Verification email sent:', data);
    return { success: true };
  } catch (error) {
    console.error('Error sending verification email:', error);
    return { success: false, error: 'Failed to send email' };
  }
}

export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Revro <noreply@revro.dev>',
      to: email,
      subject: 'Reset your Revro password',
      html: PASSWORD_RESET_EMAIL_HTML(resetUrl),
    });

    if (error) {
      console.error('Failed to send password reset email:', error);
      return { success: false, error: error.message };
    }

    console.log('Password reset email sent:', data);
    return { success: true };
  } catch (error) {
    console.error('Error sending password reset email:', error);
    return { success: false, error: 'Failed to send email' };
  }
}

export async function sendLowCreditsEmail(
  email: string,
  userName: string,
  creditsRemaining: number,
  creditsTotal: number,
  plan: string,
  resetDate: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #484848; }
          .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
          h1 { color: #1d1c1d; font-size: 36px; margin-bottom: 30px; }
          .button { background-color: #5865F2; color: white; padding: 14px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; }
          .footer { color: #8898aa; font-size: 14px; margin-top: 32px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Running Low on Credits</h1>
          <p>Hi ${userName},</p>
          <p>You have <strong>${creditsRemaining} out of ${creditsTotal} credits</strong> remaining this month.</p>
          <p>Your credits will reset on <strong>${resetDate}</strong>.</p>
          <p>In the meantime, you can:</p>
          <ul>
            <li>Purchase additional credits</li>
            <li>Upgrade your plan for more monthly credits</li>
          </ul>
          <p style="margin-top: 30px;">
            <a href="https://revro.dev/billing" class="button">Manage Credits</a>
          </p>
          <p class="footer">The Revro Team</p>
        </div>
      </body>
      </html>
    `;

    const { data, error } = await resend.emails.send({
      from: 'Revro <noreply@revro.dev>',
      to: email,
      subject: 'Running low on Revro credits',
      html,
    });

    if (error) {
      console.error('Failed to send low credits email:', error);
      return { success: false, error: error.message };
    }

    console.log('Low credits email sent:', data);
    return { success: true };
  } catch (error) {
    console.error('Error sending low credits email:', error);
    return { success: false, error: 'Failed to send email' };
  }
}

export async function sendMonthlyUsageEmail(
  email: string,
  userName: string,
  month: string,
  creditsUsed: number,
  creditsTotal: number,
  scriptsGenerated: number,
  uiElementsGenerated: number,
  imagesGenerated: number,
  discordServersSetup: number,
  plan: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #484848; }
          .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
          h1 { color: #1d1c1d; font-size: 36px; margin-bottom: 30px; }
          .stats-box { background-color: #f8f9fa; border-radius: 8px; padding: 24px; margin: 24px 0; }
          .stats-label { color: #1d1c1d; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin: 16px 0 8px 0; }
          .button { background-color: #5865F2; color: white; padding: 14px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; }
          .footer { color: #8898aa; font-size: 14px; margin-top: 32px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Your ${month} Summary</h1>
          <p>Hi ${userName},</p>
          <p>Here's what you built with Revro in ${month}:</p>
          <div class="stats-box">
            <p class="stats-label">Roblox</p>
            <p><strong>${scriptsGenerated}</strong> scripts generated<br>
               <strong>${uiElementsGenerated}</strong> UI elements created<br>
               <strong>${imagesGenerated}</strong> images generated</p>
            <p class="stats-label">Discord</p>
            <p><strong>${discordServersSetup}</strong> servers configured</p>
            <p class="stats-label">Credits</p>
            <p><strong>${creditsUsed} / ${creditsTotal}</strong> used this month<br>
               <strong>Plan:</strong> ${plan}</p>
          </div>
          <p style="margin-top: 30px;">
            <a href="https://revro.dev/dashboard" class="button">View Dashboard</a>
          </p>
          <p class="footer">Keep creating!<br><br>The Revro Team</p>
        </div>
      </body>
      </html>
    `;

    const { data, error } = await resend.emails.send({
      from: 'Revro <noreply@revro.dev>',
      to: email,
      subject: `Your Revro usage summary for ${month}`,
      html,
    });

    if (error) {
      console.error('Failed to send monthly usage email:', error);
      return { success: false, error: error.message };
    }

    console.log('Monthly usage email sent:', data);
    return { success: true };
  } catch (error) {
    console.error('Error sending monthly usage email:', error);
    return { success: false, error: 'Failed to send email' };
  }
}

export async function sendPaymentConfirmationEmail(
  email: string,
  userName: string,
  plan: string,
  amount: string,
  billingPeriod: string,
  nextBillingDate: string,
  receiptId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #484848; }
          .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
          h1 { color: #1d1c1d; font-size: 36px; margin-bottom: 30px; }
          .receipt-box { background-color: #f8f9fa; border-radius: 8px; padding: 24px; margin: 24px 0; }
          .receipt-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #e8e8e8; font-size: 14px; }
          .receipt-key { color: #8898aa; }
          .receipt-value { color: #1d1c1d; font-weight: 600; }
          .button { background-color: #5865F2; color: white; padding: 14px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; }
          .footer { color: #8898aa; font-size: 14px; margin-top: 32px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Payment Confirmed</h1>
          <p>Hi ${userName},</p>
          <p>Your payment was successful. You now have access to all <strong>${plan}</strong> plan features.</p>
          <div class="receipt-box">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="color:#8898aa;font-size:14px;padding:6px 0;">Plan</td><td style="text-align:right;font-size:14px;font-weight:600;color:#1d1c1d;">${plan}</td></tr>
              <tr><td style="color:#8898aa;font-size:14px;padding:6px 0;">Amount</td><td style="text-align:right;font-size:14px;font-weight:600;color:#1d1c1d;">${amount}</td></tr>
              <tr><td style="color:#8898aa;font-size:14px;padding:6px 0;">Billing period</td><td style="text-align:right;font-size:14px;font-weight:600;color:#1d1c1d;">${billingPeriod}</td></tr>
              <tr><td style="color:#8898aa;font-size:14px;padding:6px 0;">Next billing date</td><td style="text-align:right;font-size:14px;font-weight:600;color:#1d1c1d;">${nextBillingDate}</td></tr>
              <tr><td style="color:#8898aa;font-size:14px;padding:6px 0;">Receipt ID</td><td style="text-align:right;font-size:14px;font-weight:600;color:#1d1c1d;">${receiptId}</td></tr>
            </table>
          </div>
          <p style="margin-top: 30px;">
            <a href="https://revro.dev/dashboard" class="button">Go to Dashboard</a>
          </p>
          <p class="footer">Questions? Contact <a href="mailto:support@revro.dev">support@revro.dev</a><br><br>The Revro Team</p>
        </div>
      </body>
      </html>
    `;

    const { data, error } = await resend.emails.send({
      from: 'Revro <noreply@revro.dev>',
      to: email,
      subject: `Payment confirmed — ${plan} plan`,
      html,
    });

    if (error) {
      console.error('Failed to send payment confirmation email:', error);
      return { success: false, error: error.message };
    }

    console.log('Payment confirmation email sent:', data);
    return { success: true };
  } catch (error) {
    console.error('Error sending payment confirmation email:', error);
    return { success: false, error: 'Failed to send email' };
  }
}

export async function sendPaymentFailedEmail(
  email: string,
  userName: string,
  plan: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #484848; }
          .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
          h1 { color: #1d1c1d; font-size: 36px; margin-bottom: 30px; }
          .warning { background-color: #fef5f1; border-left: 4px solid #e04f1a; border-radius: 4px; padding: 16px 20px; margin: 24px 0; }
          .button { background-color: #5865F2; color: white; padding: 14px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; }
          .footer { color: #8898aa; font-size: 14px; margin-top: 32px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Payment Failed</h1>
          <p>Hi ${userName},</p>
          <p>We were unable to process your payment for the <strong>${plan}</strong> plan.</p>
          <div class="warning">
            <strong>Action required:</strong> Please update your payment method to keep your subscription active. If no action is taken, your account may be downgraded to the Free plan.
          </div>
          <p style="margin-top: 30px;">
            <a href="https://whop.com/hub" class="button">Update Payment Method</a>
          </p>
          <p class="footer">Questions? Contact <a href="mailto:support@revro.dev">support@revro.dev</a><br><br>The Revro Team</p>
        </div>
      </body>
      </html>
    `;

    const { data, error } = await resend.emails.send({
      from: 'Revro <noreply@revro.dev>',
      to: email,
      subject: 'Action required: payment failed for your Revro subscription',
      html,
    });

    if (error) {
      console.error('Failed to send payment failed email:', error);
      return { success: false, error: error.message };
    }

    console.log('Payment failed email sent:', data);
    return { success: true };
  } catch (error) {
    console.error('Error sending payment failed email:', error);
    return { success: false, error: 'Failed to send email' };
  }
}

export async function sendSubscriptionCancelledEmail(
  email: string,
  userName: string,
  plan: string,
  accessUntil: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #484848; }
          .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
          h1 { color: #1d1c1d; font-size: 36px; margin-bottom: 30px; }
          .info-box { background-color: #fef5f1; border-left: 4px solid #e04f1a; border-radius: 4px; padding: 16px 20px; margin: 24px 0; }
          .button { background-color: #5865F2; color: white; padding: 14px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; }
          .footer { color: #8898aa; font-size: 14px; margin-top: 32px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Subscription Cancelled</h1>
          <p>Hi ${userName},</p>
          <p>Your <strong>${plan}</strong> subscription has been cancelled. You'll continue to have access until <strong>${accessUntil}</strong>, after which your account reverts to the Free plan.</p>
          <div class="info-box">
            <strong>What happens next:</strong><br>
            — Credits reset to 25/month (Free plan)<br>
            — AI model reverts to Standard AI<br>
            — Image generation no longer available
          </div>
          <p>Changed your mind? You can resubscribe at any time.</p>
          <p style="margin-top: 30px;">
            <a href="https://revro.dev/dashboard/settings?tab=billing" class="button">Resubscribe</a>
          </p>
          <p class="footer">Questions? Contact <a href="mailto:support@revro.dev">support@revro.dev</a><br><br>The Revro Team</p>
        </div>
      </body>
      </html>
    `;

    const { data, error } = await resend.emails.send({
      from: 'Revro <noreply@revro.dev>',
      to: email,
      subject: `Your ${plan} subscription has been cancelled`,
      html,
    });

    if (error) {
      console.error('Failed to send subscription cancelled email:', error);
      return { success: false, error: error.message };
    }

    console.log('Subscription cancelled email sent:', data);
    return { success: true };
  } catch (error) {
    console.error('Error sending subscription cancelled email:', error);
    return { success: false, error: 'Failed to send email' };
  }
}
