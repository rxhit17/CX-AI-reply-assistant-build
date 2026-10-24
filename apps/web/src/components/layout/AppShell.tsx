import { BookOpen, LayoutDashboard, LogOut, MessagesSquare, ScrollText, Settings, Wifi, WifiOff } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { useConnectionStatus } from '@/realtime/RealtimeProvider';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/conversations', label: 'Conversations', icon: MessagesSquare },
  { to: '/knowledge-base', label: 'Knowledge Base', icon: BookOpen },
  { to: '/logs', label: 'AI Logs', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function ConnectionBadge() {
  const status = useConnectionStatus();
  const live = status === 'live';
  return (
    <span
      role="status"
      aria-label={`Realtime connection: ${status}`}
      className={cn('inline-flex items-center gap-1.5 text-xs', live ? 'text-emerald-700' : 'text-amber-700')}
      data-testid="connection-status"
    >
      {live ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
      {live ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'}
    </span>
  );
}

export function AppShell() {
  const { me, signOut } = useAuth();
  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b bg-card md:w-56 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:block">
          <div>
            <p className="text-sm font-semibold">CX Reply Assistant</p>
            <p className="hidden text-xs text-muted-foreground md:block">AI-assisted support</p>
          </div>
          <div className="md:hidden">
            <ConnectionBadge />
          </div>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:overflow-visible md:pb-0">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-muted',
                  isActive && 'bg-teal-50 text-primary',
                )
              }
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden space-y-2 border-t p-3 md:block">
          <ConnectionBadge />
          <div className="text-xs">
            <p className="truncate font-medium" title={me?.email}>
              {me?.full_name || me?.email}
            </p>
            <Badge tone={me?.role === 'admin' ? 'violet' : 'blue'} className="mt-1">
              {me?.role}
            </Badge>
          </div>
          <button
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-muted"
          >
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
