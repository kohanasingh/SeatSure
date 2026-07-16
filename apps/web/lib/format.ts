export const formatPrice = (cents: number): string => `₹${(cents / 100).toFixed(2)}`;

export const formatDateTime = (iso: string): string =>
  new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
