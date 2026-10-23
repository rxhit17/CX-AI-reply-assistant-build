import { useQuery } from '@tanstack/react-query';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

function ApiStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['api-health'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { status: string };
    },
    refetchInterval: 30_000,
  });
  const label = isPending ? 'Checking API…' : isError ? 'API unreachable' : `API ${data.status}`;
  const color = isError ? 'bg-red-500' : isPending ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-600" role="status">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">CX Reply Assistant</h1>
      <ApiStatus />
    </main>
  );
}
