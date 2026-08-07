export function calculateInvoiceCharge(subtotal: number, taxRate: number): number {
  return subtotal + subtotal * taxRate;
}
