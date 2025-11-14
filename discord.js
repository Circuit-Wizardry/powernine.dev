import 'dotenv/config';

/**
 * A simple logger for sending messages to a Discord webhook using Node.js's native fetch.
 */

// Store the webhook URL privately in the module.
let webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';

/**
 * Sets the Discord webhook URL to be used by the logger.
 * You must call this function before sending any logs.
 * @param {string} url - The full Discord webhook URL.
 */
function setWebhookUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    console.warn('Webhook URL cannot be empty. Discord logging remains disabled.');
    return false;
  }
  webhookUrl = url.trim();
  console.log('Discord webhook URL has been set.');
  return true;
}

/**
 * Sends a log message to the configured Discord webhook.
 * @param {string} message - The message string to send.
 * @returns {Promise<void>}
 */
async function log(message) {
  if (!webhookUrl) {
    console.warn('Discord webhook URL is not set. Skipping log message.');
    return;
  }

  // Discord webhooks expect a JSON payload.
  // The 'content' key holds the message text.
  const payload = {
    content: message,
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // A 204 No Content response means the message was sent successfully.
    if (!response.ok && response.status !== 204) {
      console.error(`Error sending message to Discord: ${response.status} ${response.statusText}`);
      const errorBody = await response.text();
      console.error('Response Body:', errorBody);
    }
  } catch (error) {
    console.error('Failed to send log to Discord:', error);
  }
}

// Export the functions for use in other files.
export {
  log,
  setWebhookUrl,
};

