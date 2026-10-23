import type { FastifyRequest } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Role } from '@cx/shared';
import { forbidden, notFound, unauthorized } from './errors.js';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  /** Brands this user may act on. Resolved from the database, never from the request. */
  brandIds: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

export function canAccessBrand(user: Pick<AuthUser, 'brandIds'>, brandId: string): boolean {
  return user.brandIds.includes(brandId);
}

/** 404 (not 403) so the existence of other brands' records is not revealed. */
export function assertBrandAccess(
  user: Pick<AuthUser, 'brandIds'>,
  brandId: string | null | undefined,
  what = 'Resource',
): void {
  if (!brandId || !canAccessBrand(user, brandId)) throw notFound(what);
}

export function assertAdmin(user: Pick<AuthUser, 'role'>): void {
  if (user.role !== 'admin') throw forbidden('Administrator access required');
}

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

export async function authenticate(req: FastifyRequest, db: SupabaseClient): Promise<AuthUser> {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw unauthorized();

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw unauthorized('Invalid or expired session');

  const { data: profile } = await db
    .from('profiles')
    .select('id, email, role')
    .eq('id', data.user.id)
    .maybeSingle();
  if (!profile) throw forbidden('No profile for this account');

  let brandIds: string[];
  if (profile.role === 'admin') {
    const { data: brands } = await db.from('brands').select('id');
    brandIds = (brands ?? []).map((b) => b.id as string);
  } else {
    const { data: memberships } = await db
      .from('brand_memberships')
      .select('brand_id')
      .eq('user_id', profile.id);
    brandIds = (memberships ?? []).map((m) => m.brand_id as string);
  }
  return {
    id: profile.id as string,
    email: profile.email as string,
    role: profile.role as Role,
    brandIds,
  };
}
