import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

export const MONAD_MAINNET = defineChain({
  id: 143,
  name: "Monad Mainnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } }
});

export const NADFUN_ROUTER = "0x8986C8fD44eb85294A725a7e61AF35E76bA26F91" as Address;
export const NADFUN_FACTORY = "0xA25b13127e63ddae6d0b35570FF3D39dBD621001" as Address;
export const NADFUN_BONDING = "0x9f3832732923252A21044F21eE6bd87F09514ae4" as Address;
export const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address;

const routerAbi = [
  { type: "function", name: "getAmountOut", stateMutability: "view", inputs: [{ name: "token", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "isBuy", type: "bool" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getAmountIn", stateMutability: "view", inputs: [{ name: "token", type: "address" }, { name: "amountOut", type: "uint256" }, { name: "isBuy", type: "bool" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isGraduated", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "buyWithNative", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [{ name: "amountOutMin", type: "uint256" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }] }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sellToNative", stateMutability: "nonpayable", inputs: [{ name: "params", type: "tuple", components: [{ name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }] }], outputs: [{ type: "uint256" }] }
] as const;

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }
] as const;

export function publicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({ chain: MONAD_MAINNET, transport: http(rpcUrl || MONAD_MAINNET.rpcUrls.default.http[0]) });
}

function wallet(rpcUrl: string | undefined, privateKey: string): WalletClient {
  const account = privateKeyToAccount(privateKey as Hex);
  return createWalletClient({ account, chain: MONAD_MAINNET, transport: http(rpcUrl || MONAD_MAINNET.rpcUrls.default.http[0]) });
}

export async function walletAddress(privateKey?: string): Promise<Address | null> {
  if (!privateKey) return null;
  return privateKeyToAccount(privateKey as Hex).address;
}

export async function quoteSell(client: PublicClient, token: Address, amountIn: bigint) {
  return client.readContract({ address: NADFUN_ROUTER, abi: routerAbi, functionName: "getAmountOut", args: [token, amountIn, false] });
}

export async function quoteBuy(client: PublicClient, token: Address, monAmount: bigint) {
  return client.readContract({ address: NADFUN_ROUTER, abi: routerAbi, functionName: "getAmountOut", args: [token, monAmount, true] });
}

export async function tokenBalance(client: PublicClient, token: Address, owner: Address) {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function approveRouter(client: PublicClient, privateKey: string, token: Address, amount: bigint) {
  const w = wallet(undefined, privateKey);
  const hash = await w.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [NADFUN_ROUTER, amount], account: w.account!, chain: MONAD_MAINNET });
  return hash;
}

export async function buyWithNative(args: { rpcUrl?: string; privateKey: string; token: Address; amountIn: bigint; amountOutMin: bigint; deadlineSeconds?: number }) {
  const w = wallet(args.rpcUrl, args.privateKey);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (args.deadlineSeconds ?? 45));
  return w.writeContract({ address: NADFUN_ROUTER, abi: routerAbi, functionName: "buyWithNative", args: [{ amountOutMin: args.amountOutMin, token: args.token, to: w.account!.address, deadline }], value: args.amountIn, account: w.account!, chain: MONAD_MAINNET });
}

export async function sellToNative(args: { rpcUrl?: string; privateKey: string; token: Address; amountIn: bigint; amountOutMin: bigint; deadlineSeconds?: number }) {
  const w = wallet(args.rpcUrl, args.privateKey);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (args.deadlineSeconds ?? 45));
  return w.writeContract({ address: NADFUN_ROUTER, abi: routerAbi, functionName: "sellToNative", args: [{ amountIn: args.amountIn, amountOutMin: args.amountOutMin, token: args.token, to: w.account!.address, deadline }], account: w.account!, chain: MONAD_MAINNET });
}

export { parseEther };
