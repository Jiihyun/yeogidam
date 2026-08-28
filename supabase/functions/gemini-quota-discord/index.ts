import { handleGeminiQuotaDiscord } from "./handler.ts";

Deno.serve((request) =>
  handleGeminiQuotaDiscord(request, {
    webhookUsername: Deno.env.get("MONITORING_WEBHOOK_USERNAME"),
    webhookPassword: Deno.env.get("MONITORING_WEBHOOK_PASSWORD"),
    discordWebhookUrl: Deno.env.get("DISCORD_GEMINI_ALERT_WEBHOOK_URL"),
    log: (entry) => console.info(JSON.stringify(entry)),
  })
);
