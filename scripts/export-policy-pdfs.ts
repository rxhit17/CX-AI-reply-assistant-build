/**
 * Exports one policy-handbook PDF per brand from the live knowledge base (active, non-archived entries only),
 * so the documents always match what the assistant uses. Output: docs/policies/<brand-slug>-policies.pdf
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key, { auth: { persistSession: false } });

const ORDER = [
  'return_policy',
  'refund_policy',
  'shipping_policy',
  'cancellation_policy',
  'damaged_products',
  'missing_products',
  'delivery_problems',
  'payment_issues',
  'warranty',
  'product_information',
  'faq',
  'general_support',
];
const title = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

interface Entry {
  title: string;
  category: string;
  content: string;
  version: number;
  conditions: Record<string, unknown> | null;
  updated_at: string;
}

function keyFacts(c: Record<string, unknown> | null): string[] {
  if (!c) return [];
  const f: string[] = [];
  if (c.window_days)
    f.push(
      `Window: ${c.window_days} days from ${c.window_anchor === 'order' ? 'order date' : 'delivery'}`,
    );
  if (c.report_within_days)
    f.push(`Report within: ${Number(c.report_within_days) * 24} hours of delivery`);
  if (c.requires_photo) f.push('Photo evidence required');
  if (c.free_shipping_threshold !== undefined)
    f.push(`Free shipping on orders over $${c.free_shipping_threshold}`);
  if (Array.isArray(c.delivery_business_days))
    f.push(
      `Delivery: ${c.delivery_business_days[0]}-${c.delivery_business_days[1]} business days after dispatch`,
    );
  if (c.cancellable_until)
    f.push(
      `Cancellable until status: ${c.cancellable_until === 'processing' ? 'Processing' : 'Shipped (before carrier scan)'}`,
    );
  if (c.discretionary_review)
    f.push(
      'Requests outside the standard window may be reviewed individually (no guaranteed outcome)',
    );
  return f;
}

const { data: brands } = await db.from('brands').select('id, name, slug').order('name');
mkdirSync('docs/policies', { recursive: true });

for (const brand of brands ?? []) {
  const { data } = await db
    .from('knowledge_base')
    .select('title, category, content, version, conditions, updated_at')
    .eq('brand_id', brand.id)
    .eq('is_active', true)
    .is('archived_at', null);
  const entries = ((data ?? []) as Entry[]).sort(
    (a, b) =>
      ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.title.localeCompare(b.title),
  );
  const { data: settings } = await db
    .from('brand_settings')
    .select('sign_off')
    .eq('brand_id', brand.id)
    .single();

  const file = `docs/policies/${brand.slug}-policies.pdf`;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
    info: { Title: `${brand.name} Customer Policies`, Author: brand.name },
  });
  doc.pipe(createWriteStream(file));
  const teal = '#0f766e';

  // cover block
  doc.fillColor(teal).fontSize(26).font('Helvetica-Bold').text(brand.name);
  doc.moveDown(0.2).fillColor('#0f172a').fontSize(16).font('Helvetica').text('Customer Policies');
  doc
    .moveDown(0.4)
    .fontSize(9)
    .fillColor('#64748b')
    .text(
      `Document generated ${new Date().toISOString().slice(0, 10)} from the live policy knowledge base. Fictional demo policies.`,
    );
  doc.moveDown(1);

  // summary table of contents
  doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text('Contents');
  doc.moveDown(0.3).font('Helvetica').fontSize(10).fillColor('#334155');
  entries.forEach((e, i) => doc.text(`${i + 1}.  ${e.title}  (${title(e.category)})`));
  doc.moveDown(1);

  entries.forEach((e, i) => {
    if (doc.y > 640) doc.addPage();
    doc.moveDown(0.6);
    doc
      .fillColor(teal)
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(`${i + 1}. ${e.title}`);
    doc
      .fillColor('#64748b')
      .font('Helvetica')
      .fontSize(8.5)
      .text(`${title(e.category)} · version ${e.version} · updated ${e.updated_at.slice(0, 10)}`);
    doc
      .moveDown(0.4)
      .fillColor('#0f172a')
      .fontSize(10.5)
      .text(e.content, { align: 'left', lineGap: 2 });
    const facts = keyFacts(e.conditions);
    if (facts.length) {
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(9.5).fillColor('#0f172a').text('Key facts');
      doc.font('Helvetica').fontSize(9.5).fillColor('#334155');
      facts.forEach((f) => doc.text(`•  ${f}`, { indent: 6 }));
    }
    doc.moveDown(0.6);
    doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(64, doc.y).lineTo(531, doc.y).stroke();
  });

  doc
    .moveDown(1)
    .font('Helvetica-Oblique')
    .fontSize(9)
    .fillColor('#64748b')
    .text(
      `${settings?.sign_off ?? brand.name}\nQuestions about a specific order? Contact our support team and quote your order number.`,
    );
  doc.end();
  console.log(`${file}  (${entries.length} policies)`);
}
