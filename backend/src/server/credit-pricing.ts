import "server-only";

export const CREDIT_PRICING_VERSION = "2026-07-17.v1";

export const CREDIT_OPERATION_COSTS = {
  research: 25n,
  specification: 50n,
  build: 300n,
  polish: 240n,
  release: 40n,
  rollback: 20n,
  connection_test: 0n,
} as const;

export const CREDIT_PRICES = CREDIT_OPERATION_COSTS;

export type CreditOperation = keyof typeof CREDIT_OPERATION_COSTS;

export interface CreditQuote {
  operation: CreditOperation;
  pricingVersion: typeof CREDIT_PRICING_VERSION;
  credits: bigint;
}

export function isCreditOperation(value: string): value is CreditOperation {
  return Object.hasOwn(CREDIT_OPERATION_COSTS, value);
}

export function creditCost(operation: CreditOperation): bigint {
  return CREDIT_OPERATION_COSTS[operation];
}

export function quoteCreditOperation(operation: CreditOperation): CreditQuote {
  return {
    operation,
    pricingVersion: CREDIT_PRICING_VERSION,
    credits: creditCost(operation),
  };
}
