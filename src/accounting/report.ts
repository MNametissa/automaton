import type Database from 'better-sqlite3';

interface RecordedTransaction {
  id: string;
  type: string;
  amount_cents: number | null;
  operation_ref: string | null;
  created_at: string;
}

const validAmount = (amount: unknown): amount is number =>
  typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER;

/** All local ledger rows, with economic purpose kept separate from money movement.
 * Operational cost estimates are disclosed separately and never added to settled
 * expenses: they can describe the same request as an x402 payment.
 */
export function recordedFinancialReport(db: Database.Database) {
  const totals = {
    revenueCents: 0,
    capitalContributionsCents: 0,
    prepaidPurchasesCents: 0,
    internalTransfersInCents: 0,
    internalTransfersOutCents: 0,
    consumptionCents: 0,
    x402ConsumptionCents: 0,
    x402PaymentCashOutCents: 0,
    duplicateExpenseTransactionCount: 0,
    unresolvedExpenseOperationCount: 0,
    unresolvedExpenseTransactionCount: 0,
    unverifiedConsumptionCents: 0,
    unverifiedConsumptionTransactionCount: 0,
    unclassifiedCents: 0,
    unclassifiedTransactionCount: 0,
    invalidAmountTransactionCount: 0,
    transactionCount: 0,
  };
  const unclassifiedByType: Record<string, { count: number; amountCents: number }> = Object.create(null);
  const invalidAmountTransactionIds: string[] = [];
  const expenseOperations = new Map<string, { amounts: Set<number>; paymentAmounts: Set<number>; count: number }>();
  const unresolvedExpenseOperations: { operationRef: string; amountsCents: number[]; transactionCount: number }[] = [];
  let invalidExpenseRecordCount = 0;
  let firstRecordedAt: string | null = null;
  let lastRecordedAt: string | null = null;

  // Iterate without a LIMIT; total history is never a recent-window approximation.
  for (const row of db.prepare('SELECT id,type,amount_cents,operation_ref,created_at FROM transactions').iterate() as Iterable<RecordedTransaction>) {
    totals.transactionCount++;
    if (firstRecordedAt === null || row.created_at < firstRecordedAt) firstRecordedAt = row.created_at;
    if (lastRecordedAt === null || row.created_at > lastRecordedAt) lastRecordedAt = row.created_at;
    if (row.type === 'credit_check') continue; // A balance observation is not a transaction.

    const informational = row.type === 'funding_request';
    if (!validAmount(row.amount_cents) && !(informational && row.amount_cents === null)) {
      totals.invalidAmountTransactionCount++;
      if (row.type === 'consumption' || row.type === 'x402_payment') invalidExpenseRecordCount++;
      if (invalidAmountTransactionIds.length < 20) invalidAmountTransactionIds.push(row.id);
      continue;
    }
    const amount = row.amount_cents ?? 0;
    switch (row.type) {
      case 'customer_revenue': totals.revenueCents += amount; break;
      case 'capital_contribution': totals.capitalContributionsCents += amount; break;
      case 'credit_purchase':
      case 'topup': totals.prepaidPurchasesCents += amount; break;
      case 'internal_transfer_in': totals.internalTransfersInCents += amount; break;
      case 'internal_transfer_out': totals.internalTransfersOutCents += amount; break;
      case 'x402_payment':
      case 'consumption': {
        if (typeof row.operation_ref !== 'string' || !row.operation_ref.length
          || row.operation_ref.trim() !== row.operation_ref || row.operation_ref.length > 512) {
          totals.unverifiedConsumptionCents += amount;
          totals.unverifiedConsumptionTransactionCount++;
          break;
        }
        let operation = expenseOperations.get(row.operation_ref);
        if (!operation) {
          operation = { amounts: new Set(), paymentAmounts: new Set(), count: 0 };
          expenseOperations.set(row.operation_ref, operation);
        }
        operation.amounts.add(amount);
        if (row.type === 'x402_payment') operation.paymentAmounts.add(amount);
        operation.count++;
        break;
      }
      case 'inference':
      case 'tool_use':
        totals.unverifiedConsumptionCents += amount;
        totals.unverifiedConsumptionTransactionCount++;
        break;
      default: {
        totals.unclassifiedCents += amount;
        totals.unclassifiedTransactionCount++;
        const group = unclassifiedByType[row.type] ??= { count: 0, amountCents: 0 };
        group.count++;
        group.amountCents += amount;
      }
    }
  }

  // Economic purpose determines the event class: a prepaid acquisition is
  // separate from its later consumption even when both reference a purchase.
  for (const [operationRef, operation] of expenseOperations) {
    if (operation.paymentAmounts.size === 1) totals.x402PaymentCashOutCents += [...operation.paymentAmounts][0];
    if (operation.amounts.size !== 1) {
      totals.unresolvedExpenseOperationCount++;
      totals.unresolvedExpenseTransactionCount += operation.count;
      if (unresolvedExpenseOperations.length < 20) unresolvedExpenseOperations.push({
        operationRef, amountsCents: [...operation.amounts].sort((a, b) => a - b), transactionCount: operation.count,
      });
      continue;
    }
    const amount = [...operation.amounts][0];
    totals.consumptionCents += amount;
    if (operation.paymentAmounts.size) totals.x402ConsumptionCents += amount;
    totals.duplicateExpenseTransactionCount += operation.count - 1;
  }

  let estimatedInferenceCostCents = 0;
  let invalidInferenceEstimateCount = 0;
  for (const row of db.prepare('SELECT cost_cents FROM inference_costs').iterate() as Iterable<{ cost_cents: unknown }>) {
    if (validAmount(row.cost_cents)) estimatedInferenceCostCents += row.cost_cents;
    else invalidInferenceEstimateCount++;
  }
  const classificationComplete = totals.unclassifiedTransactionCount === 0
    && totals.invalidAmountTransactionCount === 0 && totals.unverifiedConsumptionTransactionCount === 0
    && totals.unresolvedExpenseOperationCount === 0;
  const expenseDeduplicationComplete = totals.unverifiedConsumptionTransactionCount === 0
    && totals.unresolvedExpenseOperationCount === 0 && invalidExpenseRecordCount === 0;
  const reasons = [
    'Local recorded transactions do not establish complete external income, costs, or colony-wide coverage.',
    'Operational inference estimates and task costs are informational and excluded from recorded consumption expenses.',
    'Prepaid purchases are asset acquisition and payment totals; remaining prepaid balances require reconciliation.',
  ];
  if (!expenseDeduplicationComplete) reasons.push('Unreferenced historical expenses or conflicting operation amounts remain unresolved and are excluded from expense totals.');
  if (!classificationComplete) reasons.push('Historical transactions contain unknown purposes, unverified costs, or invalid amounts.');
  if (invalidInferenceEstimateCount) reasons.push('Some operational inference estimates have invalid amounts.');

  const recordedOperatingNetCents = totals.revenueCents - totals.consumptionCents;
  return {
    ...totals,
    // Retain existing consumers, but these are recorded operating totals, not profit.
    expenseCents: totals.consumptionCents,
    // Consumption of previously purchased credits incurs a cost without new cash payment.
    recordedPaymentCashOutCents: totals.prepaidPurchasesCents + totals.x402PaymentCashOutCents,
    netCents: recordedOperatingNetCents,
    recordedOperatingNetCents,
    profitCents: null,
    estimatedInferenceCostCents,
    invalidInferenceEstimateCount,
    unclassifiedByType,
    invalidAmountTransactionIds,
    invalidAmountTransactionIdsOmitted: totals.invalidAmountTransactionCount - invalidAmountTransactionIds.length,
    unresolvedExpenseOperations,
    unresolvedExpenseOperationsOmitted: totals.unresolvedExpenseOperationCount - unresolvedExpenseOperations.length,
    completeness: {
      scope: 'local_recorded_transactions',
      historyTruncated: false,
      firstRecordedAt,
      lastRecordedAt,
      classificationComplete,
      expenseDeduplicationComplete,
      expenseDeduplication: expenseDeduplicationComplete ? 'complete_for_referenced_records' : 'unresolved_records_excluded',
      profitComplete: false,
      reasons,
    },
  };
}
