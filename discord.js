import 'dotenv/config';

let webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
let manapoolWebhookUrl = process.env.MANAPOOL_WEBHOOK_URL || '';

const normalizeUrl = (url) => (typeof url === 'string' ? url.trim() : '');

function setWebhookUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    console.warn('[discord] Webhook URL cannot be empty. Discord logging remains disabled.');
    return false;
  }
  webhookUrl = normalized;
  console.log('[discord] Primary webhook URL configured.');
  return true;
}

function setManaPoolWebhookUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    console.warn('[discord] ManaPool webhook URL cannot be empty. ManaPool alerts disabled.');
    return false;
  }
  manapoolWebhookUrl = normalized;
  console.log('[discord] ManaPool webhook URL configured.');
  return true;
}

const sendWebhookMessage = async (url, label, message) => {
  if (!url) {
    console.warn(`[discord] ${label} webhook URL is not set. Skipping message.`);
    return;
  }
  if (!message) return;
  const payload = typeof message === 'string' ? { content: message } : { ...message };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok && response.status !== 204) {
      console.error(`[discord] Error sending message to ${label} webhook: ${response.status} ${response.statusText}`);
      const errorBody = await response.text();
      console.error('[discord] Response Body:', errorBody);
    }
  } catch (error) {
    console.error(`[discord] Failed to send ${label} webhook message:`, error);
  }
};

async function log(message) {
  await sendWebhookMessage(webhookUrl, 'primary', message);
}

async function sendManaPoolWebhook(message) {
  await sendWebhookMessage(manapoolWebhookUrl, 'ManaPool', message);
}

export {
  log,
  setWebhookUrl,
  setManaPoolWebhookUrl,
  sendManaPoolWebhook
};

