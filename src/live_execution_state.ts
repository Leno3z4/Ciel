export type ExecutionSide =
  | "BUY"
  | "SELL";


export type ExecutionMode =
  | "paper"
  | "live";


export interface ExecutionRecord {

  token: string;

  symbol?: string;

  side: ExecutionSide;

  mode: ExecutionMode;


  amount: number;

  price?: number;


  reason: string;


  confidence?: number;


  txHash?: string;


  success: boolean;


  error?: string;


  timestamp: number;

}



export function createExecutionRecord(
  input: Omit<ExecutionRecord, "timestamp">
): ExecutionRecord {

  return {

    ...input,

    timestamp: Date.now()

  };

}
