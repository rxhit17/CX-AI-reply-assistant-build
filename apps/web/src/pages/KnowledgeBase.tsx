import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  BookOpen,
  History,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Telescope,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { KB_CATEGORIES } from '@cx/shared';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form';
import {
  ALL,
  Badge,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  Switch,
} from '@/components/ui/primitives';
import { useBrands, useKb } from '@/hooks';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import type { KbRow, RetrievalPreview } from '@/lib/types';

const CATEGORY_OPTIONS = KB_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }));
const EMB_TONE = { ready: 'green', pending: 'amber', failed: 'red' } as const;

export function KnowledgeBase() {
  const { me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const brands = useBrands();
  const [brand, setBrand] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<KbRow | 'new' | null>(null);
  const [versionsFor, setVersionsFor] = useState<KbRow | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const queryClient = useQueryClient();

  const list = useKb({
    brand_id: brand === ALL ? undefined : brand,
    category: category === ALL ? undefined : category,
    q: q.trim() || undefined,
    include_archived: archived ? 'true' : undefined,
  });
  const brandName = (id: string) => brands.data?.find((b) => b.id === id)?.name ?? '';
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['kb'] });

  const toggle = useMutation({
    mutationFn: (e: KbRow) => api.patch(`/api/knowledge-base/${e.id}`, { is_active: !e.is_active }),
    onSuccess: () => void invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const reembed = useMutation({
    mutationFn: (e: KbRow) =>
      api.post<{ outcome: string }>(`/api/knowledge-base/${e.id}/reembed`, {
        force: e.embedding_status !== 'ready',
      }),
    onSuccess: ({ outcome }) => {
      toast.success(
        outcome === 'skipped'
          ? 'Already up to date'
          : outcome === 'embedded'
            ? 'Embedding refreshed'
            : 'Embedding failed. See the status badge.',
      );
      void invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const archive = useMutation({
    mutationFn: (e: KbRow) =>
      e.archived_at
        ? api.post(`/api/knowledge-base/${e.id}/restore`)
        : api.delete(`/api/knowledge-base/${e.id}`),
    onSuccess: () => void invalidate(),
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">Knowledge Base</h1>
            <p className="text-sm text-muted-foreground">
              Policies the assistant may use. Each brand only ever sees its own entries.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setPreviewing(true)}>
              <Telescope className="h-4 w-4" aria-hidden /> Preview retrieval
            </Button>
            {isAdmin && (
              <Button onClick={() => setEditing('new')} data-testid="new-kb-entry">
                <Plus className="h-4 w-4" aria-hidden /> New entry
              </Button>
            )}
          </div>
        </div>
        {!isAdmin && (
          <p className="rounded-md bg-sky-50 p-2.5 text-xs text-sky-900">
            You have read-only access. Administrators edit policies.
          </p>
        )}

        <Card className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              aria-label="Search entries"
              placeholder="Search title or content"
              className="pl-8"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Select
            aria-label="Filter by brand"
            value={brand}
            onValueChange={setBrand}
            options={[
              { value: ALL, label: 'All brands' },
              ...(brands.data ?? []).map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
          <Select
            aria-label="Filter by category"
            value={category}
            onValueChange={setCategory}
            options={[{ value: ALL, label: 'All categories' }, ...CATEGORY_OPTIONS]}
          />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={archived} onCheckedChange={setArchived} aria-label="Show archived" />{' '}
            Show archived
          </label>
        </Card>

        {list.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
        ) : list.data.length === 0 ? (
          <Card>
            <EmptyState icon={<BookOpen className="h-8 w-8" />} title="No entries match">
              Change the filters{isAdmin ? ' or create a new entry.' : '.'}
            </EmptyState>
          </Card>
        ) : (
          <ul className="space-y-2" data-testid="kb-list">
            {list.data.map((e) => (
              <li key={e.id}>
                <Card className={`p-3 ${e.archived_at ? 'opacity-60' : ''}`} data-testid="kb-entry">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h2 className="text-sm font-medium">{e.title}</h2>
                        <Badge tone="violet">{brandName(e.brand_id)}</Badge>
                        <Badge>{titleCase(e.category)}</Badge>
                        <Badge tone="blue">v{e.version}</Badge>
                        <Badge
                          tone={EMB_TONE[e.embedding_status]}
                          title={e.embedding_error ?? undefined}
                        >
                          embedding: {e.embedding_status}
                        </Badge>
                        {e.archived_at && <Badge tone="neutral">archived</Badge>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{e.content}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Updated {formatDateTime(e.updated_at)}
                        {e.embedding_error && (
                          <span className="text-destructive"> · {e.embedding_error}</span>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <label className="mr-2 flex items-center gap-1.5 text-xs">
                        <Switch
                          checked={e.is_active}
                          disabled={!isAdmin || Boolean(e.archived_at) || toggle.isPending}
                          onCheckedChange={() => toggle.mutate(e)}
                          aria-label={`${e.title} active`}
                        />
                        {e.is_active ? 'On' : 'Off'}
                      </label>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Version history"
                        onClick={() => setVersionsFor(e)}
                      >
                        <History className="h-4 w-4" />
                      </Button>
                      {isAdmin && (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Edit entry"
                            onClick={() => setEditing(e)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Re-embed entry"
                            disabled={reembed.isPending}
                            onClick={() => reembed.mutate(e)}
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={e.archived_at ? 'Restore entry' : 'Archive entry'}
                            onClick={() => archive.mutate(e)}
                          >
                            {e.archived_at ? (
                              <RotateCcw className="h-4 w-4" />
                            ) : (
                              <Archive className="h-4 w-4" />
                            )}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <EntryDialog
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void invalidate()}
        />
      )}
      {versionsFor && <VersionsDialog entry={versionsFor} onClose={() => setVersionsFor(null)} />}
      {previewing && <PreviewDialog onClose={() => setPreviewing(false)} />}
    </div>
  );
}

// -------------------------------------------------------------------------------- create / edit
interface SaveResult {
  conditions_sync?: { changes: string[]; warnings: string[] };
}

function EntryDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: KbRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const brands = useBrands();
  const [brandId, setBrandId] = useState(entry?.brand_id ?? '');
  const [title, setTitle] = useState(entry?.title ?? '');
  const [category, setCategory] = useState<string>(entry?.category ?? 'faq');
  const [content, setContent] = useState(entry?.content ?? '');
  const [active, setActive] = useState(entry?.is_active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      entry
        ? api.patch<SaveResult>(`/api/knowledge-base/${entry.id}`, payload)
        : api.post<SaveResult>('/api/knowledge-base', payload),
    onSuccess: (res) => {
      const sync = res.conditions_sync;
      toast.success(entry ? 'Entry updated. New replies will use it.' : 'Entry created', {
        description: sync?.changes.length
          ? `Eligibility rules updated from the new wording: ${sync.changes.join('; ')}`
          : undefined,
        duration: sync?.changes.length ? 8000 : undefined,
      });
      if (sync?.warnings.length)
        toast.warning('Please check the wording', {
          description: sync.warnings.join('; '),
          duration: 10000,
        });
      onSaved();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const next: Record<string, string> = {};
    if (!entry && !brandId) next.brand = 'Choose a brand';
    if (title.trim().length < 3) next.title = 'Title needs at least 3 characters';
    if (content.trim().length < 10) next.content = 'Content needs at least 10 characters';
    setErrors(next);
    if (Object.keys(next).length) return;

    const payload = {
      title: title.trim(),
      category,
      content: content.trim(),
      is_active: active,
    };
    save.mutate(entry ? payload : { ...payload, brand_id: brandId });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={entry ? 'Edit entry' : 'New entry'}
        description="Saved changes apply to the next generated reply. Existing drafts that used this entry become stale."
      >
        <form onSubmit={submit} className="space-y-3" noValidate>
          {!entry && (
            <Field label="Brand" htmlFor="kb-brand" error={errors.brand}>
              <Select
                id="kb-brand"
                value={brandId}
                onValueChange={setBrandId}
                placeholder="Choose a brand"
                options={(brands.data ?? []).map((b) => ({ value: b.id, label: b.name }))}
              />
            </Field>
          )}
          <Field label="Title" htmlFor="kb-title" error={errors.title}>
            <Input
              id="kb-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="Category" htmlFor="kb-category">
            <Select
              id="kb-category"
              value={category}
              onValueChange={setCategory}
              options={CATEGORY_OPTIONS}
            />
          </Field>
          <Field
            label="Policy content"
            htmlFor="kb-content"
            error={errors.content}
            hint="Plain language. The assistant quotes and summarises this text; it never invents policy beyond it."
          >
            <Textarea
              id="kb-content"
              className="min-h-[140px]"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={8000}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={active} onCheckedChange={setActive} aria-label="Entry active" /> Active
            (available to the assistant)
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} data-testid="save-kb-entry">
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------- versions
function VersionsDialog({ entry, onClose }: { entry: KbRow; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['kb-versions', entry.id],
    queryFn: async () =>
      (
        await api.get<{
          versions: {
            id: string;
            version: number;
            title: string;
            content: string;
            created_at: string;
            is_active: boolean;
          }[];
        }>(`/api/knowledge-base/${entry.id}/versions`)
      ).versions,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Version history: ${entry.title}`}
        description="Immutable snapshots; every change to wording, conditions or activation creates a version."
      >
        {q.isPending ? (
          <Skeleton className="h-24" />
        ) : q.isError ? (
          <ErrorState message={q.error.message} />
        ) : (
          <ol className="space-y-2">
            {q.data.map((v) => (
              <li key={v.id} className="rounded border p-2.5 text-xs">
                <div className="flex items-center justify-between">
                  <Badge tone="blue">v{v.version}</Badge>
                  <span className="text-muted-foreground">
                    {formatDateTime(v.created_at)}
                    {!v.is_active && ' · inactive'}
                  </span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap">{v.content}</p>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------- retrieval preview
function PreviewDialog({ onClose }: { onClose: () => void }) {
  const brands = useBrands();
  const [brandId, setBrandId] = useState('');
  const [query, setQuery] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api.post<RetrievalPreview>('/api/knowledge-base/preview', {
        brand_id: brandId,
        query: query.trim(),
      }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const result = run.data;
  const relevant = new Set(result?.relevant.map((r) => r.id));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Preview retrieval"
        description="See which entries the assistant would retrieve for a customer question, with scores. Search is limited to the selected brand."
        className="max-w-2xl"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (brandId && query.trim().length >= 2) run.mutate();
          }}
          className="space-y-3"
        >
          <Field label="Brand" htmlFor="pv-brand">
            <Select
              id="pv-brand"
              value={brandId}
              onValueChange={setBrandId}
              placeholder="Choose a brand"
              options={(brands.data ?? []).map((b) => ({ value: b.id, label: b.name }))}
            />
          </Field>
          <Field label="Customer question" htmlFor="pv-query">
            <Input
              id="pv-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. Can I return this?"
            />
          </Field>
          <Button
            type="submit"
            loading={run.isPending}
            disabled={!brandId || query.trim().length < 2}
          >
            Search
          </Button>
        </form>
        {result && (
          <div className="mt-4 space-y-2 text-xs" data-testid="preview-result">
            <p className="rounded bg-muted p-2">
              <strong>{result.sufficient ? 'Sufficient context' : 'Insufficient context'}</strong> ·{' '}
              {result.reason} · mode: {result.mode}
              {result.embeddingError && (
                <span className="text-destructive">
                  {' '}
                  · embeddings unavailable ({result.embeddingError})
                </span>
              )}
            </p>
            <ul className="space-y-1">
              {result.entries.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-2 rounded border px-2 py-1.5"
                >
                  <span className="truncate">
                    {e.title} <span className="text-muted-foreground">v{e.version}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {e.vector_score !== null && (
                      <span className="text-muted-foreground">sim {e.vector_score.toFixed(2)}</span>
                    )}
                    <Badge tone={relevant.has(e.id) ? 'green' : 'neutral'}>
                      {relevant.has(e.id) ? 'used' : 'below threshold'}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Thresholds: similarity ≥ {result.thresholds.minVectorSimilarity}, within{' '}
              {result.thresholds.relativeMargin} of the best match.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
