import { calculateInvoiceCharge } from "./charge";

export function calculatesActiveInvoiceCharge(): boolean {
  return calculateInvoiceCharge(100, 0.2) === 120;
}
