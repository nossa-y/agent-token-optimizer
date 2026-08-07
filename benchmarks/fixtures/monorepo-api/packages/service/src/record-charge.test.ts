import { recordCharge } from "./record-charge";

export function recordsCharge(): boolean {
  return recordCharge(20).amount === 20;
}
