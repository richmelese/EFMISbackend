import { Global, Module } from '@nestjs/common';
import { DomainEvents } from './domain-events.service';

/** Global so any module can publish or subscribe without importing this module. */
@Global()
@Module({ providers: [DomainEvents], exports: [DomainEvents] })
export class DomainEventsModule {}
