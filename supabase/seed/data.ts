// Fictional demo data. Every date is relative to `now` so scenarios stay valid whenever the seed runs.
import { createHash } from 'node:crypto';
import type { KbCategory, PolicyConditions } from '@cx/shared';

/** Deterministic UUID from a stable name, so re-seeding upserts the same rows. */
export function id(name: string): string {
  const h = createHash('sha1').update(`cx-ai-assistant:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'DemoPass!2026';

export const users = [
  { key: 'admin', email: 'admin@demo.test', full_name: 'Avery Admin', role: 'admin', brands: [] as string[] },
  { key: 'bloom-agent', email: 'agent.bloom@demo.test', full_name: 'Bea Bloom', role: 'agent', brands: ['bloom'] },
  { key: 'nordic-agent', email: 'agent.nordic@demo.test', full_name: 'Nils Nordic', role: 'agent', brands: ['nordic'] },
  { key: 'multi-agent', email: 'agent.multi@demo.test', full_name: 'Maya Multi', role: 'agent', brands: ['bloom', 'nordic'] },
] as const;

export const brands = [
  {
    key: 'bloom',
    name: 'Bloom Botanics',
    slug: 'bloom-botanics',
    settings: {
      tone: 'Friendly, casual and warm; light and upbeat without being unprofessional.',
      communication_style: 'Short, concise sentences. Plain language. At most one emoji (🌿) when it fits.',
      greeting_preference: 'Hi {first_name}!',
      sign_off: 'Happy growing, The Bloom Botanics Team',
      supported_languages: ['en', 'es', 'hi', 'fr'],
    },
  },
  {
    key: 'nordic',
    name: 'Nordic Living',
    slug: 'nordic-living',
    settings: {
      tone: 'Professional, premium and formal; calm, courteous and precise.',
      communication_style: 'Complete, well-structured sentences. No slang and no emoji. Address customers formally.',
      greeting_preference: 'Dear {first_name},',
      sign_off: 'With kind regards, Nordic Living Customer Care',
      supported_languages: ['en', 'fr', 'es'],
    },
  },
] as const;

export interface KbSeed {
  key: string;
  brand: 'bloom' | 'nordic';
  category: KbCategory;
  title: string;
  content: string;
  conditions?: PolicyConditions;
}

export const knowledgeBase: KbSeed[] = [
  // ---------------- Bloom Botanics ----------------
  {
    key: 'bloom-return',
    brand: 'bloom',
    category: 'return_policy',
    title: 'Bloom Botanics Return Policy',
    content:
      'Unused, non-plant items (pots, tools, bottles, accessories) can be returned within 7 days of delivery in their original condition. Live plants cannot be returned because they are perishable; plants that arrive damaged or unhealthy are covered by the Damaged Products policy instead. Customers pay return shipping unless the item arrived damaged or incorrect. Exchanges follow the same 7-day window and are subject to stock.',
    conditions: { window_days: 7, window_anchor: 'delivery' },
  },
  {
    key: 'bloom-refund',
    brand: 'bloom',
    category: 'refund_policy',
    title: 'Bloom Botanics Refund Policy',
    content:
      'Refunds are available when a return or damage claim is made within 7 days of delivery. Approved refunds go back to the original payment method within 5-7 business days after we receive and inspect the returned item. Requests made after 7 days are not eligible for a standard refund; our support team may review exceptional cases individually, but no refund can be promised in advance.',
    conditions: { window_days: 7, window_anchor: 'delivery' },
  },
  {
    key: 'bloom-shipping',
    brand: 'bloom',
    category: 'shipping_policy',
    title: 'Bloom Botanics Shipping Policy',
    content:
      'Shipping is free on orders over $50. Orders of $50 or less ship for a flat $5.95. Standard delivery takes 3-5 business days after dispatch. Live plants ship Monday to Wednesday only so they never sit in a warehouse over a weekend.',
    conditions: { free_shipping_threshold: 50 },
  },
  {
    key: 'bloom-cancel',
    brand: 'bloom',
    category: 'cancellation_policy',
    title: 'Bloom Botanics Cancellation Policy',
    content:
      'Orders can be cancelled only while they are still in Processing status. Once an order has shipped it cannot be cancelled; after delivery you can use our return policy instead. Cancelled orders are refunded to the original payment method within 5-7 business days.',
    conditions: { cancellable_until: 'processing' },
  },
  {
    key: 'bloom-damaged',
    brand: 'bloom',
    category: 'damaged_products',
    title: 'Bloom Botanics Damaged Items Policy',
    content:
      'If an item or plant arrives damaged, please report it within 48 hours of delivery and include a clear photo of the damage and the packaging. Once verified we will send a free replacement or issue a full refund (including shipping), whichever the customer prefers. Damage reported after 48 hours is reviewed case by case and a replacement or refund cannot be guaranteed.',
    conditions: { report_within_days: 2, requires_photo: true },
  },
  {
    key: 'bloom-missing',
    brand: 'bloom',
    category: 'missing_products',
    title: 'Bloom Botanics Missing Items Policy',
    content:
      'If something is missing from your parcel, contact us within 7 days of delivery with your order number. We will check the packing record and either send the missing item or refund its value. Please keep the original packaging until the case is resolved.',
  },
  {
    key: 'bloom-delivery',
    brand: 'bloom',
    category: 'delivery_problems',
    title: 'Bloom Botanics Delivery Problems',
    content:
      'If tracking shows delivered but the parcel has not arrived, wait 24 hours and check with neighbours and any safe places. If it still has not turned up, contact us within 5 days of the delivery scan and we will open a carrier investigation and resend or refund the order once the investigation concludes.',
  },
  {
    key: 'bloom-warranty',
    brand: 'bloom',
    category: 'warranty',
    title: 'Bloom Botanics Warranty',
    content:
      'Ceramic planters and glass bottles carry a 6-month warranty against manufacturing defects. The warranty does not cover accidental breakage, misuse or normal wear. Live plants are not covered by the warranty.',
  },
  {
    key: 'bloom-faq',
    brand: 'bloom',
    category: 'faq',
    title: 'Bloom Botanics FAQ: Plant arrival and care',
    content:
      'Plants may arrive with a few yellowed leaves after travel; this is normal and usually recovers within two weeks. Unpack plants within 24 hours of delivery, water lightly and place in bright indirect light.',
  },
  // ---------------- Nordic Living ----------------
  {
    key: 'nordic-return',
    brand: 'nordic',
    category: 'return_policy',
    title: 'Nordic Living Return Policy',
    content:
      'Items may be returned within 30 days of delivery provided they are unused and in their original packaging. Return shipping is paid by the customer unless the item arrived defective or damaged, in which case we arrange a prepaid collection. Made-to-order and personalised items cannot be returned unless faulty. Exchanges are available within the same 30-day period, subject to availability.',
    conditions: { window_days: 30, window_anchor: 'delivery' },
  },
  {
    key: 'nordic-refund',
    brand: 'nordic',
    category: 'refund_policy',
    title: 'Nordic Living Refund Policy',
    content:
      'Refunds are available for returns initiated within 30 days of delivery. After the returned item has been received and inspected, the refund is processed within 10 business days to the original payment method; original shipping charges are refunded only for faulty or damaged goods. Requests after 30 days are not eligible for a standard refund, though Customer Care may consider exceptional circumstances individually without any guarantee.',
    conditions: { window_days: 30, window_anchor: 'delivery' },
  },
  {
    key: 'nordic-shipping',
    brand: 'nordic',
    category: 'shipping_policy',
    title: 'Nordic Living Shipping Policy',
    content:
      'Complimentary shipping is provided on orders over $100. Orders of $100 or less incur a flat shipping fee of $12. Standard delivery takes 5-8 business days after dispatch; large furniture is delivered by appointment with a two-person carrier team.',
    conditions: { free_shipping_threshold: 100 },
  },
  {
    key: 'nordic-cancel',
    brand: 'nordic',
    category: 'cancellation_policy',
    title: 'Nordic Living Cancellation Policy',
    content:
      'Orders may be cancelled free of charge until they have been handed to the carrier, that is while the status is Processing or Shipped. Once the carrier has scanned the parcel (In Transit) the order can no longer be cancelled and the return policy applies after delivery. Refunds for cancelled orders are issued within 10 business days.',
    conditions: { cancellable_until: 'shipped' },
  },
  {
    key: 'nordic-damaged',
    brand: 'nordic',
    category: 'damaged_products',
    title: 'Nordic Living Damaged Goods Policy',
    content:
      'Damage to goods on arrival must be reported within 14 days of delivery, together with photographs of the item and its packaging. After verification we will arrange a complimentary collection and offer either a replacement or a full refund including shipping charges, at the customer\'s choice. Damage reported after 14 days is assessed individually without any guarantee of remedy.',
    conditions: { report_within_days: 14, requires_photo: true },
  },
  {
    key: 'nordic-missing',
    brand: 'nordic',
    category: 'missing_products',
    title: 'Nordic Living Missing Items Policy',
    content:
      'Should any item be missing from a delivery, please notify Customer Care within 14 days of delivery quoting your order number. We will verify against the dispatch record and either dispatch the missing item at no cost or refund its value.',
  },
  {
    key: 'nordic-delivery',
    brand: 'nordic',
    category: 'delivery_problems',
    title: 'Nordic Living Delivery Problems',
    content:
      'If a delivery is marked as completed but has not been received, please contact Customer Care within 7 days. We will open a carrier investigation, which typically concludes within 5 business days, and arrange redelivery or a full refund.',
  },
  {
    key: 'nordic-warranty',
    brand: 'nordic',
    category: 'warranty',
    title: 'Nordic Living Warranty',
    content:
      'All furniture carries a 2-year warranty against defects in materials and workmanship. Textiles and lighting carry a 1-year warranty. The warranty excludes damage caused by misuse, improper assembly or normal wear.',
  },
  {
    key: 'nordic-payment',
    brand: 'nordic',
    category: 'payment_issues',
    title: 'Nordic Living Payment Issues',
    content:
      'If a payment fails or you were charged twice, please do not place the order again. A duplicate authorisation is normally released by your bank within 5 business days. Customer Care can confirm the payment status using your order number.',
  },
];

export interface OrderSeed {
  key: string;
  brand: 'bloom' | 'nordic';
  customer: string;
  number: string;
  status: 'processing' | 'shipped' | 'in_transit' | 'delivered' | 'cancelled';
  total: number;
  placedDaysAgo: number;
  shippedDaysAgo?: number;
  deliveredDaysAgo?: number;
  etaInDays?: number;
  items: { name: string; quantity: number; unit_price: number }[];
}

export const customers = [
  { key: 'maya', brand: 'bloom', name: 'Maya Patel', email: 'maya.patel@example.test', lang: 'en' },
  { key: 'liam', brand: 'bloom', name: 'Liam Chen', email: 'liam.chen@example.test', lang: 'en' },
  { key: 'sofia', brand: 'bloom', name: 'Sofía García', email: 'sofia.garcia@example.test', lang: 'es' },
  { key: 'arjun', brand: 'bloom', name: 'Arjun Mehta', email: 'arjun.mehta@example.test', lang: 'hi' },
  { key: 'emma', brand: 'nordic', name: 'Emma Larsen', email: 'emma.larsen@example.test', lang: 'en' },
  { key: 'oliver', brand: 'nordic', name: 'Oliver Berg', email: 'oliver.berg@example.test', lang: 'en' },
  { key: 'helene', brand: 'nordic', name: 'Hélène Dubois', email: 'helene.dubois@example.test', lang: 'fr' },
  { key: 'noah', brand: 'nordic', name: 'Noah Svensson', email: 'noah.svensson@example.test', lang: 'en' },
] as const;

export const orders: OrderSeed[] = [
  {
    key: 'maya-1', brand: 'bloom', customer: 'maya', number: 'BB-10041', status: 'delivered', total: 64.5,
    placedDaysAgo: 5, shippedDaysAgo: 4, deliveredDaysAgo: 1,
    items: [
      { name: 'Glass Propagation Bottle (set of 2)', quantity: 1, unit_price: 28.5 },
      { name: 'Monstera Deliciosa 4" plant', quantity: 1, unit_price: 36 },
    ],
  },
  {
    key: 'liam-1', brand: 'bloom', customer: 'liam', number: 'BB-10012', status: 'delivered', total: 42,
    placedDaysAgo: 26, shippedDaysAgo: 24, deliveredDaysAgo: 20,
    items: [{ name: 'Ceramic Planter, Sand', quantity: 2, unit_price: 21 }],
  },
  {
    key: 'sofia-1', brand: 'bloom', customer: 'sofia', number: 'BB-10055', status: 'in_transit', total: 78,
    placedDaysAgo: 3, shippedDaysAgo: 2, etaInDays: 2,
    items: [{ name: 'Fiddle Leaf Fig 6" plant', quantity: 1, unit_price: 78 }],
  },
  {
    key: 'arjun-1', brand: 'bloom', customer: 'arjun', number: 'BB-10062', status: 'processing', total: 35.9,
    placedDaysAgo: 0,
    items: [{ name: 'Brass Watering Can', quantity: 1, unit_price: 35.9 }],
  },
  {
    key: 'emma-1', brand: 'nordic', customer: 'emma', number: 'NL-20077', status: 'delivered', total: 180,
    placedDaysAgo: 17, shippedDaysAgo: 15, deliveredDaysAgo: 12,
    items: [{ name: 'Oak Side Table', quantity: 1, unit_price: 180 }],
  },
  {
    key: 'oliver-1', brand: 'nordic', customer: 'oliver', number: 'NL-20031', status: 'delivered', total: 129,
    placedDaysAgo: 46, shippedDaysAgo: 44, deliveredDaysAgo: 40,
    items: [{ name: 'Wool Throw Blanket', quantity: 1, unit_price: 129 }],
  },
  {
    key: 'helene-1', brand: 'nordic', customer: 'helene', number: 'NL-20090', status: 'shipped', total: 95,
    placedDaysAgo: 2, shippedDaysAgo: 0, etaInDays: 6,
    items: [{ name: 'Ceramic Table Lamp', quantity: 1, unit_price: 95 }],
  },
  {
    key: 'noah-1', brand: 'nordic', customer: 'noah', number: 'NL-20084', status: 'delivered', total: 240,
    placedDaysAgo: 8, shippedDaysAgo: 6, deliveredDaysAgo: 3,
    items: [{ name: 'Glass Carafe Set', quantity: 1, unit_price: 240 }],
  },
];

export interface MessageSeed {
  from: 'customer' | 'agent';
  body: string;
  minutesAgo: number;
}
export interface ConversationSeed {
  key: string;
  customer: string;
  order: string | null;
  status: 'open' | 'closed';
  messages: MessageSeed[];
}

export const conversations: ConversationSeed[] = [
  {
    key: 'maya', customer: 'maya', order: 'maya-1', status: 'open',
    messages: [
      { from: 'customer', body: 'Hi, my order was delivered but the bottle is broken. What can I do?', minutesAgo: 30 },
    ],
  },
  {
    key: 'liam', customer: 'liam', order: 'liam-1', status: 'open',
    messages: [
      { from: 'customer', body: 'I received the order 20 days ago. Can I get a refund?', minutesAgo: 90 },
    ],
  },
  {
    key: 'sofia', customer: 'sofia', order: 'sofia-1', status: 'open',
    messages: [{ from: 'customer', body: 'Hola, ¿cuándo llegará mi pedido?', minutesAgo: 45 }],
  },
  {
    key: 'arjun', customer: 'arjun', order: 'arjun-1', status: 'open',
    messages: [{ from: 'customer', body: 'मैं अपना ऑर्डर रद्द करना चाहता हूँ, क्या यह संभव है?', minutesAgo: 10 }],
  },
  {
    key: 'emma', customer: 'emma', order: 'emma-1', status: 'open',
    messages: [
      { from: 'customer', body: 'Hello, I changed my mind about the side table. Can I return it?', minutesAgo: 120 },
    ],
  },
  {
    key: 'oliver', customer: 'oliver', order: 'oliver-1', status: 'closed',
    messages: [
      { from: 'customer', body: 'Can I return the blanket I bought?', minutesAgo: 60 * 24 * 2 },
      {
        from: 'agent',
        body: 'Dear Oliver, thank you for your message. Returns are accepted within 30 days of delivery, and unfortunately your order was delivered 40 days ago. Kind regards, Nordic Living Customer Care',
        minutesAgo: 60 * 24 * 2 - 15,
      },
      { from: 'customer', body: 'Understood, thanks.', minutesAgo: 60 * 24 * 2 - 30 },
    ],
  },
  {
    key: 'helene', customer: 'helene', order: 'helene-1', status: 'open',
    messages: [{ from: 'customer', body: "Bonjour, je voudrais annuler ma commande, est-ce possible ?", minutesAgo: 25 }],
  },
  {
    key: 'noah', customer: 'noah', order: 'noah-1', status: 'open',
    messages: [
      { from: 'customer', body: 'The carafe arrived with a crack in it.', minutesAgo: 70 },
      { from: 'agent', body: 'Dear Noah, I am sorry to hear that. Could you kindly share a photograph of the damage and the packaging?', minutesAgo: 60 },
    ],
  },
];
