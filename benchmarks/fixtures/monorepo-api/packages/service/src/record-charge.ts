import type { LedgerEntry } from "../../contracts/src/ledger";

export function recordCharge(amount: number): LedgerEntry {
  return { amount, reference: "charge" };
}
