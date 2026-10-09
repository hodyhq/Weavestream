import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  integrationOAuthProviderSchema,
  updateIntegrationOAuthAppSchema,
  type IntegrationOAuthProvider,
  type UpdateIntegrationOAuthAppInput,
} from '@weavestream/shared';
import { ZodBody } from '../../common/zod-validation.pipe.js';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator.js';
import { RequirePermission } from '../../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../../auth/step-up/require-step-up.decorator.js';
import { InteractiveOnly } from '../../auth/interactive-only.decorator.js';
import { requestMetaOf as meta } from '../../common/request-meta.js';
import { IntegrationOAuthAppService } from './integration-oauth-app.service.js';
import { IntegrationOAuthService, type OAuthCallbackQuery } from './integration-oauth.service.js';
import { OAuthCallbackRedirectFilter } from './oauth-callback-redirect.filter.js';

function parseProvider(raw: string): IntegrationOAuthProvider {
  const parsed = integrationOAuthProviderSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundException('Unknown OAuth provider.');
  return parsed.data;
}

/**
 * Instance OAuth apps (Admin > Settings > Integrations). Settings
 * permission; saving the client secret also needs a fresh step-up.
 */
@Controller({ path: 'settings/integration-oauth-apps', version: '1' })
export class IntegrationOAuthAppsController {
  constructor(private readonly apps: IntegrationOAuthAppService) {}

  @Get(':provider')
  @RequirePermission('settings.manage')
  get(@Param('provider') provider: string) {
    return this.apps.get(parseProvider(provider));
  }

  @Put(':provider')
  @RequirePermission('settings.manage')
  @RequireStepUp()
  @InteractiveOnly()
  update(
    @CurrentUser() user: AuthedUser,
    @Param('provider') provider: string,
    @Body(new ZodBody(updateIntegrationOAuthAppSchema)) dto: UpdateIntegrationOAuthAppInput,
    @Req() req: Request,
  ) {
    return this.apps.update(user, parseProvider(provider), dto, meta(req));
  }

  /** Check setup: verifies the saved client against the provider (read-only). */
  @Post(':provider/check')
  @RequirePermission('settings.manage')
  @InteractiveOnly()
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  check(@CurrentUser() user: AuthedUser, @Param('provider') provider: string, @Req() req: Request) {
    return this.apps.check(user, parseProvider(provider), meta(req));
  }
}

/**
 * OAuth connect / disconnect for integrations whose driver declares
 * `oauth`. Interactive sessions only: an API key can never start or
 * complete a grant.
 *
 *   - GET  /admin/integrations/:id/oauth             connection status
 *   - POST /admin/integrations/:id/oauth/start       provider authorize URL
 *   - GET  /admin/integrations/oauth/callback        provider redirect target
 *   - POST /admin/integrations/:id/oauth/disconnect  revoke + wipe
 */
@Controller({ path: 'admin/integrations', version: '1' })
@InteractiveOnly()
export class IntegrationOAuthController {
  constructor(private readonly oauth: IntegrationOAuthService) {}

  @Get('oauth/callback')
  @RequirePermission('integration.manage')
  @UseFilters(OAuthCallbackRedirectFilter)
  async callback(
    @CurrentUser() user: AuthedUser,
    @Query() query: OAuthCallbackQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.oauth.callback(user, query ?? {}, meta(req)));
  }

  @Get(':id/oauth')
  @RequirePermission('integration.manage')
  status(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.oauth.status(id);
  }

  @Post(':id/oauth/start')
  @RequirePermission('integration.manage')
  @RequireStepUp()
  start(@CurrentUser() user: AuthedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.oauth.start(user, id);
  }

  @Post(':id/oauth/disconnect')
  @RequirePermission('integration.manage')
  @RequireStepUp()
  @HttpCode(204)
  async disconnect(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.oauth.disconnect(user, id, meta(req));
  }
}
