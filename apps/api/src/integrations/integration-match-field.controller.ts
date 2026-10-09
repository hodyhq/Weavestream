import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ensureResourceMatchFieldSchema, type EnsureResourceMatchFieldInput } from '@weavestream/shared';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { IntegrationMatchFieldService } from './integration-match-field.service.js';

/** Map layouts: create the match field on an existing layout (see IntegrationMatchFieldService). */
@Controller({ path: 'admin/integrations', version: '1' })
export class IntegrationMatchFieldController {
  constructor(private readonly matchFields: IntegrationMatchFieldService) {}

  @Post(':id/resources/:resourceKey/match-field')
  @RequirePermission('integration.manage')
  @HttpCode(200)
  ensureMatchField(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('resourceKey') resourceKey: string,
    @Body(new ZodBody(ensureResourceMatchFieldSchema)) dto: EnsureResourceMatchFieldInput,
    @Req() req: Request,
  ) {
    return this.matchFields.ensureMatchField(user, id, resourceKey, dto.assetLayoutId, meta(req));
  }
}
