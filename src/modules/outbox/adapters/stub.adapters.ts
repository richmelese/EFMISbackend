import { Logger } from '@nestjs/common';
import { ChannelAdapter, DeliveryResult, OutboxChannel } from '../outbox.types';

/**
 * Stand-in for a provider that has no credentials yet (EMAIL, SMS, PUSH): logs the message and reports it sent.
 * Replaced by registering the real provider adapter for the channel.
 */
export class LoggingStubAdapter implements ChannelAdapter {
  private readonly logger = new Logger('OutboxStub');

  constructor(readonly channel: OutboxChannel) {}

  async send(payload: Record<string, unknown>, messageId: string): Promise<DeliveryResult> {
    const to = Array.isArray(payload.to) ? `${payload.to.length} recipient(s)` : 'no recipients';
    this.logger.log(`[${this.channel} stub] ${messageId} → ${to}: ${String(payload.title ?? payload.subject ?? '')}`);
    return { providerRef: `stub-${messageId}` };
  }
}
