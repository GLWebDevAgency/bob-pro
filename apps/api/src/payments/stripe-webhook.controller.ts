import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { WithoutTenantPersistenceTransaction } from '../persistence/tenant-persistence.interceptor';
import {
  StripeBillingService,
  StripeReconciliationError,
  type StripeWebhookReceipt,
} from './stripe-billing.service';

interface RawBodyRequest {
  readonly rawBody?: Buffer;
}

@Controller('webhooks/stripe')
@WithoutTenantPersistenceTransaction()
@SkipThrottle()
export class StripeWebhookController {
  constructor(private readonly stripeBilling: StripeBillingService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest,
    @Headers('stripe-signature') signature: string | string[] | undefined,
  ): Promise<StripeWebhookReceipt> {
    if (!Buffer.isBuffer(request.rawBody)) {
      throw new BadRequestException({ code: 'STRIPE_RAW_BODY_REQUIRED' });
    }
    if (typeof signature !== 'string' || signature.length > 2_048) {
      throw new BadRequestException({ code: 'STRIPE_SIGNATURE_REQUIRED' });
    }
    try {
      return await this.stripeBilling.handleWebhook(request.rawBody, signature);
    } catch (error) {
      if (error instanceof StripeReconciliationError && !error.retryable) {
        throw new BadRequestException({ code: error.code });
      }
      // Un 2xx ferait perdre l'événement. Stripe doit le rejouer après une panne DB/API ou une
      // course de traitement ; aucun détail fournisseur ni payload n'est renvoyé.
      throw new ServiceUnavailableException({
        code: error instanceof StripeReconciliationError ? error.code : 'STRIPE_RECONCILIATION_FAILED',
      });
    }
  }
}
