import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form';
import { Badge, Card, ErrorState, Select, Skeleton } from '@/components/ui/primitives';
import { settingsOf, useBrands } from '@/hooks';
import { api, errorMessage } from '@/lib/api';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'hi', label: 'Hindi' },
];

export function SettingsPage() {
  const { me } = useAuth();
  const brands = useBrands();
  const [brandId, setBrandId] = useState('');
  const isAdmin = me?.role === 'admin';
  const brand = brands.data?.find((b) => b.id === brandId) ?? brands.data?.[0];
  const settings = brand ? settingsOf(brand) : null;
  useEffect(() => {
    if (!brandId && brands.data?.[0]) setBrandId(brands.data[0].id);
  }, [brands.data, brandId]);

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-lg font-semibold">Settings</h1>

        <Card className="space-y-1 p-4 text-sm">
          <h2 className="font-semibold">Your account</h2>
          <p>
            {me?.full_name} · {me?.email}
          </p>
          <Badge tone={isAdmin ? 'violet' : 'blue'}>{me?.role}</Badge>
        </Card>

        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Brand voice</h2>
              <p className="text-xs text-muted-foreground">
                Applied after policy and safety rules. Voice can never override refund, legal or
                safety restrictions.
              </p>
            </div>
            <div className="w-56">
              <Select
                aria-label="Brand"
                value={brandId}
                onValueChange={setBrandId}
                options={(brands.data ?? []).map((b) => ({ value: b.id, label: b.name }))}
              />
            </div>
          </div>
          {brands.isPending ? (
            <Skeleton className="h-40" />
          ) : brands.isError ? (
            <ErrorState message={brands.error.message} />
          ) : !brand || !settings ? (
            <p className="text-sm text-muted-foreground">No brand settings available.</p>
          ) : (
            <VoiceForm key={brand.id} brandId={brand.id} initial={settings} readOnly={!isAdmin} />
          )}
          {!isAdmin && (
            <p className="text-xs text-muted-foreground">
              Only administrators can change brand voice.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

function VoiceForm({
  brandId,
  initial,
  readOnly,
}: {
  brandId: string;
  initial: NonNullable<ReturnType<typeof settingsOf>>;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [tone, setTone] = useState(initial.tone);
  const [style, setStyle] = useState(initial.communication_style);
  const [greeting, setGreeting] = useState(initial.greeting_preference ?? '');
  const [signOff, setSignOff] = useState(initial.sign_off);
  const [langs, setLangs] = useState<string[]>(initial.supported_languages);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/brands/${brandId}/settings`, {
        tone: tone.trim(),
        communication_style: style.trim(),
        greeting_preference: greeting.trim() || null,
        sign_off: signOff.trim(),
        supported_languages: langs,
      }),
    onSuccess: () => {
      toast.success('Brand voice saved. New drafts will use it.');
      void queryClient.invalidateQueries({ queryKey: ['brands'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!tone.trim() || !style.trim()) return setError('Tone and style are required.');
    if (langs.length === 0) return setError('Select at least one supported language.');
    setError(null);
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field label="Tone" htmlFor="v-tone">
        <Textarea
          id="v-tone"
          className="min-h-[60px]"
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          disabled={readOnly}
        />
      </Field>
      <Field label="Communication style" htmlFor="v-style">
        <Textarea
          id="v-style"
          className="min-h-[60px]"
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          disabled={readOnly}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Greeting (optional)"
          htmlFor="v-greet"
          hint="Use {first_name}. Added to the first reply only (English)."
        >
          <Input
            id="v-greet"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            disabled={readOnly}
          />
        </Field>
        <Field label="Fixed sign-off" htmlFor="v-sign">
          <Input
            id="v-sign"
            value={signOff}
            onChange={(e) => setSignOff(e.target.value)}
            disabled={readOnly}
          />
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Supported languages</legend>
        <div className="flex flex-wrap gap-3">
          {LANGUAGES.map((l) => (
            <label key={l.code} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={langs.includes(l.code)}
                disabled={readOnly}
                onChange={(e) =>
                  setLangs((cur) =>
                    e.target.checked ? [...cur, l.code] : cur.filter((x) => x !== l.code),
                  )
                }
              />
              {l.label}
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!readOnly && (
        <Button type="submit" loading={save.isPending}>
          Save brand voice
        </Button>
      )}
    </form>
  );
}
