import { buildStatusReport } from "./status_report";

export async function handleTelegramCommand(
  command: string,
  env: { CIEL_STATE: KVNamespace; DB: D1Database }
): Promise<string | null> {
  const normalized = command.trim().toLowerCase();

  if (normalized === "/status" || normalized === "/ciel") {
    return buildStatusReport(env);
  }

  if (normalized === "/help") {
    return [
      "🧠 Ciel commands",
      "/status - system status",
      "/ciel - intelligence status",
      "/help - command list"
    ].join("\n");
  }

  return null;
}
