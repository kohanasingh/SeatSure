import { Module } from '@nestjs/common';
import { MockPaymentProvider } from './mock-payment.provider';
import { PAYMENT_PROVIDER } from './payment.provider';

@Module({
  providers: [{ provide: PAYMENT_PROVIDER, useClass: MockPaymentProvider }],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
