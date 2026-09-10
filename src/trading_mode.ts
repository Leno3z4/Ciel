export type TradingMode = "paper" | "live";

export interface TradingEnvironment {
  TRADING_ENABLED?: string;
  PAPER_TRADING?: string;
}

export function getTradingMode(
  env: TradingEnvironment
): TradingMode {

  if (env.TRADING_ENABLED === "true") {
    return "live";
  }

  return "paper";
}


export function isLiveTrading(
  env: TradingEnvironment
): boolean {

  return getTradingMode(env) === "live";
}


export function isPaperTrading(
  env: TradingEnvironment
): boolean {

  return getTradingMode(env) === "paper";
}
