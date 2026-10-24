import { describe, expect, it } from 'vitest';
import {
  answeredTopics,
  describeCaseState,
  emptyCaseState,
  mergeCaseState,
  type CaseUpdate,
} from './case-state.js';

const upd = (over: Partial<CaseUpdate> = {}): CaseUpdate => ({
  issue_type: 'unknown',
  confirmed_facts: [],
  denied_facts: [],
  retracted_facts: [],
  other_facts: [],
  desired_resolution: 'unknown',
  resolution_confirmed: false,
  asks_next_step: false,
  corrections: [],
  ...over,
});

describe('mergeCaseState', () => {
  it('accumulates facts across turns', () => {
    let s = mergeCaseState(
      null,
      upd({ issue_type: 'return', confirmed_facts: ['item_unused'] }),
      'm1',
    );
    s = mergeCaseState(s, upd({ confirmed_facts: ['original_packaging'] }), 'm2');
    expect(s.confirmed_facts).toEqual(['item_unused', 'original_packaging']);
    expect(s.issue_type).toBe('return'); // "unknown" never overwrites a known issue
    expect(s.as_of_message_id).toBe('m2');
  });

  it('a later statement overrides an earlier one', () => {
    let s = mergeCaseState(null, upd({ confirmed_facts: ['item_unused'] }), 'm1');
    s = mergeCaseState(s, upd({ denied_facts: ['item_unused'] }), 'm2');
    expect(s.confirmed_facts).toEqual([]);
    expect(s.denied_facts).toEqual(['item_unused']);
    s = mergeCaseState(s, upd({ confirmed_facts: ['item_unused'] }), 'm3');
    expect(s.denied_facts).toEqual([]);
  });

  it('retractions remove a fact', () => {
    let s = mergeCaseState(null, upd({ confirmed_facts: ['item_damaged'] }), 'm1');
    s = mergeCaseState(
      s,
      upd({ retracted_facts: ['item_damaged'], corrections: ['it was not damaged after all'] }),
      'm2',
    );
    expect(s.confirmed_facts).toEqual([]);
    expect(s.corrections).toEqual(['it was not damaged after all']);
  });

  it('applies an issue correction (seller error → customer ordered the wrong item)', () => {
    let s = mergeCaseState(
      null,
      upd({ issue_type: 'general', confirmed_facts: ['item_differs_from_listing'] }),
      'm1',
    );
    s = mergeCaseState(
      s,
      upd({
        issue_type: 'return',
        confirmed_facts: ['customer_ordered_wrong_item'],
        retracted_facts: ['item_differs_from_listing'],
        corrections: ['customer ordered the wrong item'],
      }),
      'm2',
    );
    expect(s.issue_type).toBe('return');
    expect(s.confirmed_facts).toEqual(['customer_ordered_wrong_item']);
  });

  it('resolution confirmation is sticky, resets when the resolution changes, and clears when withdrawn', () => {
    let s = mergeCaseState(
      null,
      upd({ desired_resolution: 'return', resolution_confirmed: true }),
      'm1',
    );
    s = mergeCaseState(s, upd({ asks_next_step: true }), 'm2'); // model says unknown/false this turn
    expect(s.desired_resolution).toBe('return');
    expect(s.resolution_confirmed).toBe(true);
    s = mergeCaseState(
      s,
      upd({ desired_resolution: 'exchange', resolution_confirmed: false }),
      'm3',
    );
    expect(s.resolution_confirmed).toBe(false);
    s = mergeCaseState(s, upd({ desired_resolution: 'none' }), 'm4');
    expect(s.resolution_confirmed).toBe(false);
  });

  it('is idempotent when the same message is processed twice (repeated customer messages)', () => {
    const u = upd({
      issue_type: 'return',
      confirmed_facts: ['item_unused'],
      desired_resolution: 'return',
      resolution_confirmed: true,
    });
    const once = mergeCaseState(null, u, 'm1');
    const twice = mergeCaseState(once, u, 'm1');
    expect(twice).toEqual(once);
  });

  it('caps free-form memory', () => {
    const s = mergeCaseState(
      null,
      upd({ other_facts: Array.from({ length: 20 }, (_, i) => `fact ${i}`) }),
      'm1',
    );
    expect(s.other_facts).toHaveLength(12);
  });
});

describe('answeredTopics / describeCaseState', () => {
  it('lists topics that must not be asked again', () => {
    const s = mergeCaseState(
      null,
      upd({
        confirmed_facts: ['item_unused'],
        denied_facts: ['original_packaging'],
        desired_resolution: 'return',
        resolution_confirmed: true,
      }),
      'm1',
    );
    const t = answeredTopics(s, { orderLinked: true, customerSentImage: false });
    expect([...t].sort()).toEqual([
      'item_unused',
      'order_reference',
      'original_packaging',
      'resolution_confirmation',
    ]);
  });
  it('labels customer statements as unverified', () => {
    expect(describeCaseState(emptyCaseState())).toMatch(/unverified/);
  });
});

describe('answeredTopics: legitimate clarifications stay possible', () => {
  it('does not treat descriptive facts as closed questions', () => {
    const s = mergeCaseState(
      null,
      upd({
        confirmed_facts: [
          'item_differs_from_listing',
          'item_damaged',
          'customer_ordered_wrong_item',
        ],
      }),
      'm1',
    );
    expect([...answeredTopics(s, { orderLinked: false, customerSentImage: false })]).toEqual([]);
  });
});
