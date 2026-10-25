import { describe, expect, it } from 'vitest';
import {
  hasOrderNumberCandidate,
  matchOrderNumber,
  needsOrderData,
  normalizeOrderNumber,
  orderRequestMessage,
} from './order-gate.js';

const orders = [
  { id: 'o1', order_number: 'BB-10041' },
  { id: 'o2', order_number: 'BB-10012' },
];

describe('needsOrderData', () => {
  it.each(['order_status', 'return_request', 'refund_request', 'damaged_product', 'cancellation'])(
    '%s needs an order',
    (intent) => {
      expect(needsOrderData(intent as never, 'unknown')).toBe(true);
    },
  );
  it('does not need an order for policy questions, greetings or human requests', () => {
    expect(needsOrderData('general_question', 'unknown')).toBe(false);
    expect(needsOrderData('greeting', 'unknown')).toBe(false);
    expect(needsOrderData('human_agent_request', 'return')).toBe(false);
    expect(needsOrderData('shipping_question', 'unknown')).toBe(false);
  });
  it('treats a bare reply as a continuation of an open order-related case', () => {
    expect(needsOrderData('unclear', 'return')).toBe(true);
    expect(needsOrderData('unclear', 'damaged')).toBe(true);
    expect(needsOrderData('unclear', 'unknown')).toBe(false);
    expect(needsOrderData('unclear', 'warranty')).toBe(false);
  });
});

describe('matchOrderNumber', () => {
  it.each([
    'BB-10041',
    'bb-10041',
    'bb10041',
    '#BB-10041',
    'BB 10041',
    'my order id is BB-10041 please help',
    'Order number: bb 10041.',
  ])('matches "%s"', (text) => {
    expect(matchOrderNumber(text, orders)?.id).toBe('o1');
  });

  it('does not match a different or partial number', () => {
    expect(matchOrderNumber('BB-10099', orders)).toBeNull();
    expect(matchOrderNumber('10041', orders)).toBeNull();
    expect(matchOrderNumber('BB-1004', orders)).toBeNull();
    expect(matchOrderNumber('', orders)).toBeNull();
    expect(matchOrderNumber('hello there', orders)).toBeNull();
  });

  it("never matches an order that is not in the customer's list", () => {
    // NL-20077 belongs to someone else / another brand: it is simply not in this customer's list
    expect(matchOrderNumber('NL-20077', orders)).toBeNull();
    expect(matchOrderNumber('BB-10041', [])).toBeNull();
  });

  it('prefers the longest number when one is a prefix of another', () => {
    const list = [
      { id: 'a', order_number: 'BB-10041' },
      { id: 'b', order_number: 'BB-100412' },
    ];
    expect(matchOrderNumber('BB-100412', list)?.id).toBe('b');
  });
});

describe('hasOrderNumberCandidate', () => {
  it.each([
    'BB-99999',
    'bb99999',
    'my order id is 12345',
    'order number: ABC-7',
    'NL 20077',
    '10041',
  ])('sees a candidate in "%s"', (text) => {
    expect(hasOrderNumberCandidate(text)).toBe(true);
  });
  it.each([
    'I want to return it',
    'it cost $180',
    'I paid Rs 1200 for it',
    'delivered in 2026',
    'within 30 days',
    'I bought 2 of them',
    'hello',
  ])('sees no candidate in "%s"', (text) => {
    expect(hasOrderNumberCandidate(text)).toBe(false);
  });
});

describe('normalizeOrderNumber / messages', () => {
  it('normalises case, spaces, dashes and #', () => {
    expect(normalizeOrderNumber(' #bb-10 041 ')).toBe('BB10041');
  });
  it('uses fixed wording and falls back to English', () => {
    expect(orderRequestMessage('en', 'ask', 0)).toMatch(/share your order number/);
    expect(orderRequestMessage('en', 'ask', 1)).toMatch(/could not find an order/);
    expect(orderRequestMessage('en', 'handoff', 3)).toMatch(/passing this to our team/);
    expect(orderRequestMessage('fr', 'ask', 0)).toBe(orderRequestMessage('en', 'ask', 0));
    expect(orderRequestMessage('hinglish', 'ask', 0)).toMatch(/order number/);
  });
});
