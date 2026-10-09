import { createPublicClient, http, decodeEventLog, encodeEventTopics, parseAbi, isAddress, toHex, hexToBigInt, type TransactionReceipt, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { PaymentLedger, type PaymentAttempt } from './ledger.js';

const events = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

function paymentClient(network: string) {
  const chain = network === 'eip155:8453' ? base : network === 'eip155:84532' ? baseSepolia : undefined;
  if (!chain) throw new Error('Unsupported payment network');
  return createPublicClient({ chain, transport: http(undefined, { retryCount: 0, timeout: 5000 }) });
}

/** Capture a stable lower bound before any signed authorization leaves the process. */
export async function anchorPayment(ledger: PaymentLedger, id: string): Promise<void> {
  const row = ledger.get(id);
  if (!row || row.status !== 'reserved') throw new Error('Payment is not reserved');
  const block = await paymentClient(row.network).getBlock({ blockTag: 'finalized' });
  if (block.number === null) throw new Error('Finalized block is unavailable');
  ledger.anchor(id, block.number);
}

export function matchesPayment(row: PaymentAttempt, receipt: TransactionReceipt): boolean {
  if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== row.tx_hash?.toLowerCase()) return false;
  let transfer = false, authorization = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== row.asset.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: events, data: log.data, topics: log.topics });
      if (event.eventName === 'Transfer') {
        transfer ||= event.args.from.toLowerCase() === row.payer.toLowerCase()
          && event.args.to.toLowerCase() === row.recipient.toLowerCase()
          && event.args.value === BigInt(row.amount_atomic);
      } else {
        authorization ||= event.args.authorizer.toLowerCase() === row.payer.toLowerCase()
          && event.args.nonce.toLowerCase() === row.nonce?.toLowerCase();
      }
    } catch { /* Other contract events do not prove this payment. */ }
  }
  return transfer && authorization;
}

export async function reconcilePayment(ledger: PaymentLedger, id: string, candidateHash?: string): Promise<boolean> {
  const stored = ledger.get(id);
  if (!stored || !['submitted', 'uncertain', 'confirmed'].includes(stored.status)) return false;
  const row = { ...stored, tx_hash: candidateHash ?? stored.tx_hash };
  if (row.status === 'confirmed') return row.tx_hash?.toLowerCase() === stored.tx_hash?.toLowerCase();
  if (!row.tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(row.tx_hash)) return false;
  try {
    const client = paymentClient(row.network);
    const receipt = await client.getTransactionReceipt({ hash: row.tx_hash as Hex });
    const head = await client.getBlockNumber({ cacheTime: 0 });
    if (head < receipt.blockNumber + 1n || !matchesPayment(row, receipt)) return false;
    ledger.confirm(id, row.tx_hash);
    return true;
  } catch { return false; }
}

/** One bounded page per wake; absence of an event never releases money. */
export async function discoverPayment(ledger: PaymentLedger, id: string): Promise<boolean> {
  const row = ledger.get(id);
  if (!row || !['submitted', 'uncertain'].includes(row.status)) return false;
  if (row.tx_hash) return reconcilePayment(ledger, id);
  if (!row.nonce || !/^0x[0-9a-fA-F]{64}$/.test(row.nonce)
    || !row.scan_next_block || !/^\d+$/.test(row.scan_next_block)
    || !isAddress(row.asset) || !isAddress(row.payer)) return false;
  try {
    const client = paymentClient(row.network);
    const finalized = await client.getBlock({ blockTag: 'finalized' });
    if (finalized.number === null) return false;
    const from = BigInt(row.scan_next_block);
    if (from > finalized.number) return false;
    const to = from + 1999n < finalized.number ? from + 1999n : finalized.number;
    // getLogs(event, strict) silently drops invalid logs. Only a genuinely empty
    // raw RPC page is evidence that we may advance past this interval.
    const logs = await client.request({ method: 'eth_getLogs', params: [{ address: row.asset,
      topics: encodeEventTopics({ abi: events, eventName: 'AuthorizationUsed', args: { authorizer: row.payer, nonce: row.nonce as Hex } }),
      fromBlock: toHex(from), toBlock: toHex(to) }] });
    if (!Array.isArray(logs)) return false;
    // Keep this page if a candidate cannot yet be verified. Never skip a failed receipt lookup.
    for (const log of logs.slice(0, 1)) {
      if (log.removed || !log.transactionHash || log.blockNumber === null
        || hexToBigInt(log.blockNumber) < from || hexToBigInt(log.blockNumber) > to
        || log.address.toLowerCase() !== row.asset.toLowerCase()) continue;
      const event = decodeEventLog({ abi: events, eventName: 'AuthorizationUsed', topics: log.topics, data: log.data });
      if (event.args.authorizer.toLowerCase() !== row.payer.toLowerCase()
        || event.args.nonce.toLowerCase() !== row.nonce.toLowerCase()) continue;
      if (await reconcilePayment(ledger, id, log.transactionHash)) return true;
    }
    if (logs.length === 0) ledger.advanceScan(id, from, to + 1n);
    return false;
  } catch { return false; }
}

export async function reconcilePendingPayments(ledger: PaymentLedger): Promise<number> {
  // At most two independent RPC lookups in parallel; unresolved rows remain held.
  const results = await Promise.all(ledger.pending().slice(0, 2).map(row => {
    ledger.checked(row.id);
    return discoverPayment(ledger, row.id);
  }));
  return results.filter(Boolean).length;
}
