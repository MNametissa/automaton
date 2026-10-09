import { createPublicClient, http, decodeEventLog, parseAbi, type TransactionReceipt, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { PaymentLedger, type PaymentAttempt } from './ledger.js';

const events = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

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
  const chain = row.network === 'eip155:8453' ? base : row.network === 'eip155:84532' ? baseSepolia : undefined;
  if (!chain) return false;
  try {
    const client = createPublicClient({ chain, transport: http(undefined, { retryCount: 0, timeout: 5000 }) });
    const receipt = await client.getTransactionReceipt({ hash: row.tx_hash as Hex });
    const head = await client.getBlockNumber();
    if (head < receipt.blockNumber + 1n || !matchesPayment(row, receipt)) return false;
    ledger.confirm(id, row.tx_hash);
    return true;
  } catch { return false; }
}

export async function reconcilePendingPayments(ledger: PaymentLedger): Promise<number> {
  // At most two independent RPC lookups in parallel; unresolved rows remain held.
  const results = await Promise.all(ledger.pending().slice(0, 2).map(row => {
    ledger.checked(row.id);
    return reconcilePayment(ledger, row.id);
  }));
  return results.filter(Boolean).length;
}
