import 'dotenv/config';
import { logDiscordConsole, logDiscordEvent } from './utils/discord-bot.js';

function setWebhookUrl() {
  console.warn('[discord] Webhook logging is disabled; using bot channels instead.');
  return false;
}

function setManaPoolWebhookUrl() {
  console.warn('[discord] Webhook logging is disabled; using bot channels instead.');
  return false;
}

async function log(message) {
  await logDiscordConsole(message);
}

async function sendManaPoolWebhook(message) {
  await logDiscordEvent(message);
}

export {
  log,
  setWebhookUrl,
  setManaPoolWebhookUrl,
  sendManaPoolWebhook
};

