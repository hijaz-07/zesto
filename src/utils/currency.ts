/** Formats a paise amount as an Indian Rupee string, e.g. 12000 -> "₹120". */
export function formatPaiseAsRupees(priceInPaise: number): string {
  const rupees = priceInPaise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: rupees % 1 === 0 ? 0 : 2,
  }).format(rupees);
}
