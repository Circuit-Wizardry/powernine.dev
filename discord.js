/**
 * A simple logger for sending messages to a Discord webhook using Node.js's native fetch.
 */

// Store the webhook URL privately in the module.
let webhookUrl = 'https://discord.com/api/webhooks/1419878447714668686/XEJ1RC56BAMbomLDz0bwEQ8HMzUianIBiygMx609eu44pcz0Hlg_IJj2xXd-hdh3WnLi';

/**
 * Sets the Discord webhook URL to be used by the logger.
 * You must call this function before sending any logs.
 * @param {string} url - The full Discord webhook URL.
 */
function setWebhookUrl(url) {
  if (!url) {
    console.error('Webhook URL cannot be empty.');
    return;
  }
  webhookUrl = url;
  console.log('Discord webhook URL has been set.');
}

/**
 * Sends a log message to the configured Discord webhook.
 * @param {string} message - The message string to send.
 * @returns {Promise<void>}
 */
async function log(message) {
  if (!webhookUrl) {
    console.error('Error: Discord webhook URL is not set. Please call setWebhookUrl() first.');
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
};

