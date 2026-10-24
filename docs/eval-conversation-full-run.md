# Conversation-intelligence evaluation (real model)

_Generated 2026-10-24T07:34:41.126Z · chat `gpt-4o-mini` · judge `gpt-4.1-mini` · 8 scenarios × 6 runs = 48 conversations · real brand knowledge bases_

Each run feeds customer messages one at a time through the production workflow; the draft after each message is "sent" by the agent and the next message follows. Checks are code-based (regexes and case-state assertions); no model grades another. Images are synthetic drawings, so image scenarios test pipeline behaviour, not vision accuracy.

**Conversations passing every turn check: 43/48**

| Scenario                                                                                       | Passed | Result       |
| ---------------------------------------------------------------------------------------------- | ------ | ------------ |
| A. Nordic: wrong product ordered, return/refund progression (six messages)                     | 5/6    | intermittent |
| A. Nordic: reported transcript (facts together, next step asked twice)                         | 6/6    | stable       |
| B. Nordic: ambiguous mismatch report is clarified, not answered with eligibility               | 6/6    | stable       |
| B. Nordic: incorrect product delivered (seller error): clarify or hand off, no invented remedy | 6/6    | stable       |
| C. Bloom: damaged bottle WITHOUT photo evidence                                                | 6/6    | stable       |
| C. Bloom: damaged bottle WITH photo evidence, then a refund question                           | 2/6    | intermittent |
| D. Bloom: refund request outside the standard window                                           | 6/6    | stable       |
| E. Nordic: an agent’s assumption is not a customer confirmation                                | 6/6    | stable       |

## Failures

A failure in every run of its scenario points to a deterministic code/prompt defect; one that occurs only sometimes is model variability.

| Scenario | Turn | Failure                                                           | Runs | Kind         |
| -------- | ---- | ----------------------------------------------------------------- | ---- | ------------ |
| C2       | 2    | empty reply                                                       | 2/6  | intermittent |
| C2       | 1    | empty reply                                                       | 2/6  | intermittent |
| A1       | 3    | fell back to the handoff message (blocked: no_redundant_question) | 1/6  | intermittent |
| C2       | 3    | error: Connection error.                                          | 1/6  | intermittent |
| C2       | 3    | empty reply                                                       | 1/6  | intermittent |
| C2       | 2    | error: KB search failed: TypeError: fetch failed                  | 1/6  | intermittent |
| C2       | 1    | error: Connection error.                                          | 1/6  | intermittent |
| C2       | 2    | error: TypeError: fetch failed                                    | 1/6  | intermittent |
| C2       | 1    | error: TypeError: fetch failed                                    | 1/6  | intermittent |

**C2 turn 2** (empty reply): example reply

>

Extraction timeline of a failing run:

```
1. "My order was delivered but the bottle is broken." -> issue=damaged +[item_damaged] -[] retracted[] want=unknown | state=[item_damaged]
2. "Here it is." -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=unknown | state=[item_damaged,photo_provided]
3. "What about the refund?" -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=refund | state=[item_damaged,photo_provided]
```

**C2 turn 1** (empty reply): example reply

>

Extraction timeline of a failing run:

```
1. "My order was delivered but the bottle is broken." -> issue=damaged +[item_damaged] -[] retracted[] want=unknown | state=[item_damaged]
2. "Here it is." -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=unknown | state=[item_damaged,photo_provided]
3. "What about the refund?" -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=refund | state=[item_damaged,photo_provided]
```

**A1 turn 3** (fell back to the handoff message (blocked: no_redundant_question)): example reply

> Thank you for your message. I am passing your return request for order NL-20077 to our team, who will contact you with the next steps.
> [withheld candidate] You have confirmed that the Oak Side Table is unused. Since you are within the 30-day return window, you are eligible to return the item. Please ensure that it is in its original packaging. The return shipping will be at your expense unless the item arrived defective or damaged. The team will follow

Extraction timeline of a failing run:

```
1. "I purchased an Oak Side Table, but it doesn't look" -> issue=mismatch +[item_differs_from_listing] -[] retracted[] want=unknown | state=[item_differs_from_listing]
2. "I think I ordered the wrong product." -> issue=return +[customer_ordered_wrong_item] -[] retracted[item_differs_from_listing] want=return | state=[customer_ordered_wrong_item]
3. "Yes, it is unused." -> issue=return +[item_unused] -[] retracted[] want=return | state=[customer_ordered_wrong_item,item_unused]
4. "It is in the original packaging too." -> issue=return +[item_unused,original_packaging,customer_ordered_wrong_item] -[] retracted[] want=return | state=[customer_ordered_wrong_item,item_unused,original_packaging]
5. "I want to return it and get a refund." -> issue=return +[customer_ordered_wrong_item,item_unused,original_packaging] -[] retracted[] want=return_and_refund(confirmed) | state=[customer_ordered_wrong_item,item_unused,original_packaging]
6. "I already confirmed. What is the next step?" -> issue=return +[customer_ordered_wrong_item,item_unused,original_packaging] -[] retracted[] want=return_and_refund(confirmed) | state=[customer_ordered_wrong_item,item_unused,original_packaging]
```

**C2 turn 3** (error: Connection error.): example reply

>

Extraction timeline of a failing run:

```
1. "My order was delivered but the bottle is broken." -> issue=damaged +[item_damaged] -[] retracted[] want=unknown | state=[item_damaged]
2. "Here it is." -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=unknown | state=[item_damaged,photo_provided]
3. "What about the refund?" -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=refund | state=[item_damaged,photo_provided]
```

**C2 turn 3** (empty reply): example reply

>

Extraction timeline of a failing run:

```
1. "My order was delivered but the bottle is broken." -> issue=damaged +[item_damaged] -[] retracted[] want=unknown | state=[item_damaged]
2. "Here it is." -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=unknown | state=[item_damaged,photo_provided]
3. "What about the refund?" -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=refund | state=[item_damaged,photo_provided]
```

**C2 turn 2** (error: KB search failed: TypeError: fetch failed): example reply

>

Extraction timeline of a failing run:

```
1. "My order was delivered but the bottle is broken." -> issue=damaged +[item_damaged] -[] retracted[] want=unknown | state=[item_damaged]
2. "Here it is." -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=unknown | state=[item_damaged,photo_provided]
3. "What about the refund?" -> issue=damaged +[item_damaged,photo_provided] -[] retracted[] want=refund | state=[item_damaged,photo_provided]
```

## Example conversation (A. Nordic: reported transcript (facts together, next step asked twice), run 1)

**Customer 1:** I purchased an Oak Side Table, but it doesn't look like what I ordered.

_intent complaint → complaint, next action clarify_request, known facts: item_differs_from_listing, attempts 1, escalation suggested_

> Dear Emma,
> I understand your concern regarding the Oak Side Table you received. To assist you further, could you please clarify whether the item you received differs significantly from what you expected based on the listing? This will help us determine the next steps in addressing the issue.
> With kind regards, Nordic Living Customer Care

**Customer 2:** I think I ordered the wrong product.

_intent return_request → return_request, next action explain_eligibility, known facts: customer_ordered_wrong_item, attempts 2_

> You mentioned that you believe you ordered the wrong product. Since the Oak Side Table can be returned within 30 days of delivery, you are eligible to initiate a return, provided the item is unused and in its original packaging. The return shipping will be at your expense unless the item arrived defective or damaged. Please confirm whether the item is unused and in its original packaging so that we can proceed with the return process.

**Customer 3:** Yes, it is unused and in the original packaging.

_intent return_request → return_request, next action provide_next_step, known facts: customer_ordered_wrong_item, item_unused, original_packaging, attempts 1, escalation suggested_

> Since you have confirmed that the Oak Side Table is unused and in its original packaging, you are eligible to initiate a return. The next step is for our team to provide you with the return instructions. Please allow us a moment to follow up with the exact details regarding the return process.

**Customer 4:** I want to return it and get a refund.

_intent return_request → return_request, next action explain_eligibility, known facts: customer_ordered_wrong_item, item_unused, original_packaging, attempts 1, escalation suggested_

> You have confirmed your intention to return the Oak Side Table and request a refund. As you are within the 30-day return and refund window, the next step is for our team to provide you with the return instructions. Please allow us a moment to follow up with the exact details regarding the return process.

**Customer 5:** I already confirmed. What is the next step?

_intent return_request → return_request, next action provide_next_step, known facts: customer_ordered_wrong_item, item_unused, original_packaging, attempts 1, escalation suggested_

> Thank you for your confirmation regarding the return and refund for the Oak Side Table. As you are within the 30-day return and refund window, our team will follow up shortly with the specific return instructions. Please allow us a moment to provide you with the necessary details to proceed with the return process.

**Customer 6:** I already confirmed. What is the next step?

_intent return_request → return_request, next action follow_up_pending, known facts: customer_ordered_wrong_item, item_unused, original_packaging, attempts 1, escalation suggested_

> Your request for a return and refund for the Oak Side Table is currently with our team. They will provide you with the specific return instructions shortly. Please allow us a moment to finalize these details for you.
