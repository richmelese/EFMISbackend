import { EntityManager } from 'typeorm';
import { DomainEvents } from './domain-events.service';

class DemandApproved {
  constructor(readonly lineId: number, readonly qtl: number) {}
}
class OtherEvent {}

describe('DomainEvents', () => {
  let events: DomainEvents;
  beforeEach(() => (events = new DomainEvents()));

  it('delivers an event to the handlers of its type, in subscription order, with the caller transaction', async () => {
    const calls: string[] = [];
    const manager = {} as EntityManager;
    events.subscribe(DemandApproved, (e, m) => void calls.push(`a:${e.qtl}:${m === manager}`));
    events.subscribe(DemandApproved, async e => void calls.push(`b:${e.lineId}`));
    events.subscribe(OtherEvent, () => void calls.push('other'));

    await events.publish(new DemandApproved(7, 3.5), manager);

    expect(calls).toEqual(['a:3.5:true', 'b:7']);
  });

  it('rejects publish() when a handler fails, so the publisher can roll back', async () => {
    const after = jest.fn();
    events.subscribe(DemandApproved, () => {
      throw new Error('totals unavailable');
    });
    events.subscribe(DemandApproved, after);

    await expect(events.publish(new DemandApproved(1, 1))).rejects.toThrow('totals unavailable');
    expect(after).not.toHaveBeenCalled();
  });

  it('is a no-op for events nobody subscribes to', async () => {
    await expect(events.publish(new OtherEvent())).resolves.toBeUndefined();
  });

  it('unsubscribes', async () => {
    const h = jest.fn();
    const off = events.subscribe(DemandApproved, h);
    expect(events.handlerCount(DemandApproved)).toBe(1);
    off();
    await events.publish(new DemandApproved(1, 1));
    expect(h).not.toHaveBeenCalled();
    expect(events.handlerCount(DemandApproved)).toBe(0);
  });
});
