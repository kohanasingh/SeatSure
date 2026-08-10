import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { ChargeRequest, ChargeResult, PaymentProvider } from './payment.provider';

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    // Read directly from process.env (not ConfigService) per-charge, so
    // tests can vary it at runtime: ConfigService.get() resolves against the
    // Zod-validated boot-time snapshot before ever consulting live
    // process.env, so a runtime mutation would silently never take effect.
    const latencyMs = Number(process.env.SIMULATE_PAYMENT_LATENCY_MS ?? 0);
    if (latencyMs > 0) await sleep(latencyMs);

    // deterministic failure hook: amounts ending in 99 decline
    if (req.amountCents % 100 === 99) {
      return { ok: false, providerRef: `mock_${randomUUID()}`, failureCode: 'card_declined' };
    }
    return { ok: true, providerRef: `mock_${randomUUID()}` };
  }
}
