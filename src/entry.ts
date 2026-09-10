import worker, { TradingEngine } from "./worker";
import { handleTelegramWebhook } from "./telegram_chat";

export { TradingEngine };

export default {
  async fetch(request: Request, env: Parameters<typeof worker.fetch>[1], ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    return worker.fetch(request, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: Parameters<typeof worker.scheduled>[1],
    ctx: ExecutionContext
  ) {
    return worker.scheduled(controller, env, ctx);
  }
};
