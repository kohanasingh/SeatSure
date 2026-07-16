// The Stripe seam (API_AND_DATA_SPEC.md §5): the booking service depends only
// on this interface via the PAYMENT_PROVIDER token. Swapping in Stripe later
// is a module-level provider change plus the saga refactor noted in README.

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export interface ChargeRequest {
  userId: string;
  bookingId: string;
  amountCents: number; // computed server-side from DB prices — never from client
  currency: string;
  idempotencyKey: string;
}

export interface ChargeResult {
  ok: boolean;
  providerRef: string; // charge id
  failureCode?: 'card_declined' | 'insufficient_funds' | 'provider_error';
}

export interface PaymentProvider {
  charge(req: ChargeRequest): Promise<ChargeResult>;
}
