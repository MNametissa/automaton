/**
 * x402 Payment Protocol
 *
 * Enables the automaton to make USDC micropayments via HTTP 402.
 * Adapted from conway-mcp/src/x402/index.ts
 */

import {
  createPublicClient,
  http,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { createHash } from 'node:crypto';
import type { PaymentContext } from '../payments/context.js';
import { anchorPayment, reconcilePayment } from '../payments/settlement.js';
import { ResilientHttpClient } from "./http-client.js";
import type { ChainType } from "../identity/chain.js";

const x402HttpClient = new ResilientHttpClient();

import { USDC_ADDRESSES, CHAINS, BALANCE_OF_ABI, parsePaymentRequired, signPayment, parseMaxAmountRequired } from './x402-protocol.js';
import type { X402PaymentResult, UsdcBalanceResult, PaymentRequirement } from './x402-protocol.js';
export type { UsdcBalanceResult } from './x402-protocol.js';

/** Solana USDC mint address (mainnet). */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Get the USDC balance for the automaton's wallet on a given network.
 * Supports both EVM (Base) and Solana networks.
 */
export async function getUsdcBalance(
  address: string,
  network: string = "eip155:8453",
  chainType?: ChainType,
): Promise<number> {
  if (chainType === "solana" || network === "solana:mainnet") {
    return getSolanaUsdcBalance(address);
  }
  const result = await getUsdcBalanceDetailed(address as Address, network);
  return result.balance;
}

/**
 * Get the USDC balance on Solana using @solana/web3.js.
 */
async function getSolanaUsdcBalance(address: string): Promise<number> {
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const ownerPubkey = new PublicKey(address);
    const mintPubkey = new PublicKey(SOLANA_USDC_MINT);

    // Find associated token account for USDC
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      ownerPubkey,
      { mint: mintPubkey },
    );

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    // Sum all USDC token accounts (usually just one)
    let totalBalance = 0;
    for (const account of tokenAccounts.value) {
      const parsed = account.account.data.parsed;
      if (parsed?.info?.tokenAmount?.uiAmount != null) {
        totalBalance += parsed.info.tokenAmount.uiAmount;
      }
    }

    return totalBalance;
  } catch (err: any) {
    throw new Error(`Solana USDC balance check failed: ${err?.message || String(err)}`);
  }
}

/**
 * Get the USDC balance and read status details for diagnostics.
 */
export async function getUsdcBalanceDetailed(
  address: Address,
  network: string = "eip155:8453",
): Promise<UsdcBalanceResult> {
  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  if (!chain || !usdcAddress) {
    return {
      balance: 0,
      network,
      ok: false,
      error: `Unsupported USDC network: ${network}`,
    };
  }

  try {
    const rpcUrl = process.env.AUTOMATON_RPC_URL || undefined;
    const client = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 10_000 }),
    });

    const balance = await client.readContract({
      address: usdcAddress,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address],
    });

    // USDC has 6 decimals
    return {
      balance: Number(balance) / 1_000_000,
      network,
      ok: true,
    };
  } catch (err: any) {
    return {
      balance: 0,
      network,
      ok: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Check if a URL requires x402 payment.
 */
export async function checkX402(
  url: string,
): Promise<PaymentRequirement | null> {
  try {
    const resp = await x402HttpClient.request(url, { method: "HEAD" });
    if (resp.status !== 402) {
      return null;
    }
    const parsed = await parsePaymentRequired(resp);
    return parsed?.requirement ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL with automatic x402 payment.
 * If the endpoint returns 402, sign and pay, then retry.
 */
export async function x402Fetch(
  url: string,
  account: PrivateKeyAccount,
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
  maxPaymentCents?: number,
  chainType?: ChainType,
  context?: PaymentContext,
): Promise<X402PaymentResult> {
  let attemptId: string | undefined;
  let submitted = false;
  let amountAtomic: string | undefined;
  try {
    if (chainType === 'solana') throw new Error('x402 payment requires an EVM wallet');
    const target = new URL(url);
    if (target.username || target.password) throw new Error('Credentials in payment URLs are forbidden');
    const extraHeaders = new Headers(headers);
    for (const name of ['x-payment', 'payment-signature', 'payment-required', 'x-payment-required']) {
      if (extraHeaders.has(name)) throw new Error('Caller-supplied payment headers are forbidden');
    }
    if (context?.purchaseId !== undefined && (typeof context.purchaseId !== 'string' || !context.purchaseId.trim() || context.purchaseId.length > 128)) {
      throw new Error('Invalid purchase ID');
    }
    target.hash = '';
    target.searchParams.sort();
    const isTopup = context?.kind === 'topup_credits' || /\/pay\//i.test(decodeURIComponent(target.pathname));
    const operationKey = createHash('sha256').update(JSON.stringify([
      account.address.toLowerCase(),
      isTopup ? [target.origin, 'topup'] : [target.href, method.toUpperCase(), body ?? ''],
    ])).digest('hex');
    const canonicalHeaders: [string, string][] = [];
    extraHeaders.forEach((value, key) => canonicalHeaders.push([key, value]));
    const requestFingerprint = createHash('sha256').update(JSON.stringify([
      target.href, method.toUpperCase(), body ?? '', canonicalHeaders.sort(),
    ])).digest('hex');
    const previous = context?.ledger.completed(operationKey, context.purchaseId);
    if (previous) {
      if (previous.request_fingerprint !== requestFingerprint) throw new Error('Purchase ID already belongs to a different request; inspect payment_status before requesting a new purchase');
      return { success: true, paymentStatus: 'confirmed', replayed: true, attemptId: previous.id,
        amountAtomic: previous.amount_atomic, status: previous.response_status!, response: JSON.parse(previous.response_json!) };
    }
    const initialResp = await x402HttpClient.request(url, {
      method, headers: { ...headers, 'Content-Type': 'application/json' }, body,
      redirect: 'error', retries: 0,
    });
    if (initialResp.status !== 402) {
      return { success: initialResp.ok, response: await readResponse(initialResp), status: initialResp.status, paymentStatus: 'unpaid' };
    }
    if (!context) throw new Error('Explicit durable payment budget is required');
    if (target.protocol !== 'https:') throw new Error('Payments require HTTPS');
    if (!context.allowedDomains.some(domain => target.hostname === domain || target.hostname.endsWith('.' + domain))) {
      throw new Error('Payment domain is not authorized');
    }
    const parsed = await parsePaymentRequired(initialResp);
    if (!parsed) throw new Error('Unsupported or invalid payment requirements');
    const amount = parseMaxAmountRequired(parsed.requirement.maxAmountRequired, parsed.x402Version);
    amountAtomic = amount.toString();
    const limit = maxPaymentCents ?? context.limits.maxSingleCents;
    if (!Number.isSafeInteger(limit) || limit < 0 || amount > BigInt(limit) * 10000n) {
      throw new Error('Payment exceeds the authorized amount');
    }
    attemptId = context.ledger.reserve({ operationKey, payer: account.address, recipient: parsed.requirement.payToAddress,
      asset: parsed.requirement.usdcAddress, network: parsed.requirement.network, amountAtomic,
      domain: target.hostname, kind: context.kind, purchaseId: context.purchaseId, requestFingerprint }, context.limits);
    await anchorPayment(context.ledger, attemptId);
    const payment = await signPayment(account, parsed.requirement, parsed.x402Version);
    context.ledger.submitted(attemptId, payment.payload.authorization.nonce);
    submitted = true;
    const paymentHeader = parsed.x402Version === 2 ? 'PAYMENT-SIGNATURE' : 'X-Payment';
    const paidResp = await x402HttpClient.request(url, {
      method, headers: { ...headers, 'Content-Type': 'application/json',
        [paymentHeader]: Buffer.from(JSON.stringify(payment)).toString('base64') },
      body, redirect: 'error', retries: 0,
    });
    // Persist the hash before reading a possibly broken response stream.
    let settlement: Record<string, unknown> | undefined;
    try {
      const encoded = paidResp.headers.get('PAYMENT-RESPONSE') ?? paidResp.headers.get('X-PAYMENT-RESPONSE');
      if (encoded) settlement = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch { /* An invalid provider receipt is not proof of settlement. */ }
    const hash = typeof settlement?.transaction === 'string' && /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)
      ? settlement.transaction : undefined;
    context.ledger.uncertain(attemptId, hash);
    const data = await readResponse(paidResp);
    const credits = data && typeof data === 'object' ? (data as Record<string, unknown>).credits_cents : undefined;
    const tier = Number(decodeURIComponent(target.pathname).match(/\/pay\/(\d+)\//i)?.[1]);
    const expectedCredits = context.expectedCreditsCents ?? (Number.isSafeInteger(tier) && tier > 0 ? tier * 100 : Infinity);
    const delivered = paidResp.ok && (!isTopup
      || (Number.isSafeInteger(credits) && Number(credits) >= expectedCredits));
    context.ledger.delivery(attemptId, data, paidResp.status, delivered);
    const confirmed = await reconcilePayment(context.ledger, attemptId);
    return { success: confirmed && delivered, response: data, status: paidResp.status,
      paymentStatus: confirmed ? 'confirmed' : 'uncertain', attemptId, amountAtomic,
      ...(!confirmed ? { error: 'Payment settlement is uncertain; reservation retained, do not repay' }
        : !delivered ? { error: 'Payment confirmed but delivery is unverified; do not repay' } : {}) };
  } catch (error) {
    if (context && attemptId) {
      if (submitted) context.ledger.uncertain(attemptId);
      else context.ledger.release(attemptId);
    }
    return { success: false, error: error instanceof Error ? error.message : String(error),
      paymentStatus: submitted ? 'uncertain' : 'blocked', attemptId, amountAtomic };
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}
