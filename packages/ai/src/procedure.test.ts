import { describe, expect, it } from 'vitest';
import {
  findUnauthorizedProcedures,
  hasDocumentedProcedure,
  procedureTermsIn,
} from './procedure.js';

const NORDIC_RETURN = {
  category: 'return_policy',
  content:
    'Items may be returned within 30 days of delivery provided they are unused and in their original packaging. Return shipping is paid by the customer unless the item arrived defective or damaged, in which case we arrange a prepaid collection.',
};
const NORDIC_DAMAGED = {
  category: 'damaged_products',
  content:
    'Damage must be reported within 14 days. After verification we will arrange a complimentary collection and offer a replacement.',
};

describe('procedureTermsIn', () => {
  it('recognises operational terms', () => {
    expect(
      procedureTermsIn('Print the return label, then drop it off at any post office.'),
    ).toEqual(['return label', 'drop-off']);
    expect(procedureTermsIn('Send it to 12 Oak Street, Springfield.')).toContain('street address');
    expect(procedureTermsIn('The team will follow up with instructions.')).toEqual([]);
  });
});

describe('findUnauthorizedProcedures', () => {
  it('a term that no source mentions is not documented', () => {
    expect(
      findUnauthorizedProcedures('Please print the return label.', [NORDIC_RETURN], {
        caseHasDefect: false,
      }),
    ).toEqual([{ term: 'return label', reason: 'not_documented' }]);
  });

  it('a collection documented only for defective goods does NOT authorise it for a customer ordering mistake', () => {
    const v = findUnauthorizedProcedures(
      'We will arrange a prepaid collection of the table.',
      [NORDIC_RETURN],
      { caseHasDefect: false },
    );
    expect(v).toEqual([{ term: 'collection', reason: 'only_documented_for_defective_items' }]);
  });

  it('the same collection is allowed when the case involves a defect', () => {
    expect(
      findUnauthorizedProcedures('We will arrange a prepaid collection.', [NORDIC_RETURN], {
        caseHasDefect: true,
      }),
    ).toEqual([]);
  });

  it('every sentence of a damage policy is defect-scoped', () => {
    expect(
      findUnauthorizedProcedures('We will arrange a collection.', [NORDIC_DAMAGED], {
        caseHasDefect: false,
      }),
    ).toHaveLength(1);
    expect(
      findUnauthorizedProcedures('We will arrange a collection.', [NORDIC_DAMAGED], {
        caseHasDefect: true,
      }),
    ).toEqual([]);
  });

  it('a sentence without a defect qualifier authorises the term for any case', () => {
    const general = {
      category: 'return_policy',
      content: 'To start a return, use our return portal. Items must be unused.',
    };
    expect(
      findUnauthorizedProcedures('Please use the return portal.', [general], {
        caseHasDefect: false,
      }),
    ).toEqual([]);
  });

  it('does not let one sentence borrow another sentence’s authority', () => {
    // "portal" is documented for a different purpose than "label"
    const src = {
      category: 'return_policy',
      content: 'Use the returns portal to track a return. We never email labels.',
    };
    expect(
      findUnauthorizedProcedures('Here is your return label.', [src], { caseHasDefect: false }),
    ).toHaveLength(1);
  });

  it('replies without operational terms are never flagged', () => {
    expect(
      findUnauthorizedProcedures('Our team will follow up with the exact instructions.', [], {
        caseHasDefect: false,
      }),
    ).toEqual([]);
  });
});

describe('hasDocumentedProcedure', () => {
  it('is false when the only procedure is for defective goods and the case has no defect', () => {
    expect(hasDocumentedProcedure([NORDIC_RETURN], { caseHasDefect: false })).toBe(false);
    expect(hasDocumentedProcedure([NORDIC_RETURN], { caseHasDefect: true })).toBe(true);
  });
  it('a contact instruction counts as a documented procedure', () => {
    expect(
      hasDocumentedProcedure(
        [
          {
            category: 'missing_products',
            content: 'Contact us within 7 days with your order number.',
          },
        ],
        { caseHasDefect: false },
      ),
    ).toBe(true);
  });
  it('is false with no sources', () => {
    expect(hasDocumentedProcedure([], { caseHasDefect: false })).toBe(false);
  });
});
