import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthedUser } from '../../common/current-user.decorator.js';

/**
 * Keeps API-key principals out of the surfaces that exist to manage the
 * *interactive* identity behind them.
 *
 * Without this, a leaked key is an escalation rather than a contained loss: it
 * could rotate the owner's password, re-enroll MFA onto an attacker's
 * authenticator, enumerate and revoke the owner's browser sessions, or mint
 * further keys for itself. Each of those turns "someone has a token I can
 * revoke" into "someone owns the account".
 *
 * The containment is deliberately a **prefix denylist on the auth surface**,
 * not a scope check, because it must hold for every key regardless of how its
 * scopes were configured — including the default inherit-everything key a
 * SUPER_ADMIN mints for themselves. Business routes are unaffected; this guard
 * only ever says no to account-management paths.
 *
 * Runs after `AuthGuard` (which establishes `req.user`) and keys solely off the
 * server-derived principal, never off a client-supplied header (CLAUDE.md §1).
 */
const DENIED_PREFIXES = [
  '/auth/',          // login, logout, refresh, MFA enroll/verify, step-up
  '/me/sessions',    // list and revoke the owner's browser sessions
  '/me/mfa',         // backup-code regeneration
  '/me/password',    // password change
  '/me/api-keys',    // a key must not mint or revoke keys — only a human may
] as const;

/**
 * Paths a token *is* allowed on despite matching a denied prefix. `/auth/me`
 * is read-only identity introspection ("who am I, what can I do"), which is
 * how a client discovers its own authority — useful, and it grants nothing.
 */
const ALLOWED_EXACT = new Set(['/auth/me']);

/**
 * Reduce a raw request path to the stable route shape the lists above are
 * written against.
 *
 * The app mounts every route under `setGlobalPrefix('api')` with URI
 * versioning, so `req.path` arrives as `/api/v1/me/api-keys`. Matching the
 * denylist against the raw path would silently never fire — the guard would
 * appear installed and protect nothing.
 *
 * Also lowercases and collapses duplicate slashes: Express treats `//me//mfa`
 * and `/ME/MFA` as the same route, so a denylist that does not would be
 * trivially bypassable.
 */
function normalizePath(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/^\/api(?=\/|$)/, '')
    .replace(/^\/v\d+(?=\/|$)/, '')
    .replace(/\/+$/, '') || '/';
}

@Injectable()
export class ApiKeySurfaceGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    if (!req.user?.apiKeyId) return true;

    const path = normalizePath(req.path);
    if (ALLOWED_EXACT.has(path)) return true;

    if (DENIED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      throw new ForbiddenException(
        'API keys cannot be used on account-management endpoints. Sign in interactively.',
      );
    }
    return true;
  }
}
