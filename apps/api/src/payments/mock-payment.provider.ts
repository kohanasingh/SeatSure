import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChargeRequest, ChargeResult, PaymentProvider } from './payment.provider';

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  constructor(private readonly config: ConfigService) {}

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    // read per-charge (not cached at boot) so tests can vary it at runtime
    const latencyMs = Number(this.config.get('SIMULATE_PAYMENT_LATENCY_MS') ?? 0);
    if (latencyMs > 0) await sleep(latencyMs);

    // deterministic failure hook: amounts ending in 99 decline
    if (req.amountCents % 100 === 99) {
      return { ok: false, providerRef: `mock_${randomUUID()}`, failureCode: 'card_declined' };
    }
    return { ok: true, providerRef: `mock_${randomUUID()}` };
  }
}
