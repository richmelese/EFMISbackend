import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/** Any class instance can be an event; its constructor identifies the event type. */
export type EventType<E extends object> = new (...args: any[]) => E;

/**
 * Handler for one event type. `manager` is the publisher's transaction (undefined when published outside one):
 * write through it so the handler's changes commit or roll back together with the change that raised the event.
 */
export type DomainEventHandler<E extends object> = (event: E, manager?: EntityManager) => Promise<void> | void;

/**
 * In-process domain events (architecture rule 3: consistency through events in the same transaction).
 *
 *   // owner module, inside its transaction
 *   await this.events.publish(new DemandApproved(lineId, qtl), m);
 *
 *   // subscriber module (e.g. in onModuleInit)
 *   this.events.subscribe(DemandApproved, (e, m) => this.totals.add(e, m));
 *
 * Handlers run sequentially, in subscription order, and are awaited: an error rejects `publish()` so the caller's
 * transaction rolls back. Side effects that must not roll back (email, SMS, external APIs) go to the outbox instead.
 */
@Injectable()
export class DomainEvents {
  private readonly logger = new Logger('DomainEvents');
  private readonly handlers = new Map<EventType<object>, DomainEventHandler<any>[]>();

  /** Registers a handler; returns a function that removes it. */
  subscribe<E extends object>(type: EventType<E>, handler: DomainEventHandler<E>): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return () => {
      const current = this.handlers.get(type) ?? [];
      this.handlers.set(type, current.filter(h => h !== handler));
    };
  }

  /** Runs every handler for the event's type with the caller's transaction manager. */
  async publish<E extends object>(event: E, manager?: EntityManager): Promise<void> {
    const list = this.handlers.get(event.constructor as EventType<object>) ?? [];
    for (const handler of list) {
      try {
        await handler(event, manager);
      } catch (e) {
        this.logger.error(`Handler for ${event.constructor.name} failed: ${(e as Error).message}`);
        throw e;
      }
    }
  }

  /** Number of handlers registered for a type (diagnostics and tests). */
  handlerCount(type: EventType<object>): number {
    return this.handlers.get(type)?.length ?? 0;
  }
}
