import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import { MediaSource, MediaStatus, MediaType, UserRole } from '@prisma/client';
import { CurrentUser, JwtAuthGuard, JwtPayload, Roles, RolesGuard } from '../../common';
import { MAX_IMAGE_UPLOAD_BYTES } from '../uploads/image-processing';
import { MediaService } from './media.service';
import { MEDIA_UPLOAD_THROTTLE, parseEntityId, parseEntityType, requestIp } from './media.policy';

function parseEnum<T extends string>(values: Record<string, T>, raw: unknown, label: string): T | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = String(raw).trim().toUpperCase();
  if (!(Object.values(values) as string[]).includes(v)) throw new BadRequestException(`Invalid ${label}`);
  return v as T;
}

function parseDate(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Number.isNaN(new Date(String(raw)).getTime())) throw new BadRequestException(`Invalid ${label}`);
  return String(raw);
}

/**
 * Central Media API. Every route requires a logged-in user; what each role may upload is
 * decided per entity type by the media policy (media.policy.ts), not by the route.
 *
 *   POST   /media/image     multipart: file, entityType, entityId?   -> media object
 *   GET    /media           admin Media Library (search + filters, paginated)
 *   GET    /media/:id       owner or admin
 *   PATCH  /media/:id       sortOrder / isPrimary (owner or admin); entityType/entityId (admin)
 *   DELETE /media/:id       owner or admin, only when not attached to a record
 */
@ApiTags('Media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('media')
export class MediaController {
  constructor(private media: MediaService) {}

  @Throttle(MEDIA_UPLOAD_THROTTLE)
  @Post('image')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(), // never spooled to disk — the upload only exists in memory until it passes every check
    limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES, files: 1 },
  }))
  uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
    @Body('entityType') entityType: string,
    @Body('entityId') entityId: string | undefined,
    @Req() req: any,
  ) {
    const type = parseEntityType(entityType);
    if (!type) throw new BadRequestException('entityType is required');
    return this.media.ingestImage({
      buffer: file?.buffer,
      declaredMimeType: file?.mimetype,
      originalName: file?.originalname,
      entityType: type,
      // Admins may file an upload directly against a record; for everyone else the link is
      // made (with ownership checks) when the record itself is saved.
      entityId: user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN ? parseEntityId(entityId) ?? null : null,
      actor: { id: user.sub, role: user.role },
      ip: requestIp(req),
    });
  }

  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get()
  list(@Query() q: Record<string, string>) {
    return this.media.list({
      q: q.q ? String(q.q).slice(0, 200) : undefined,
      entityType: parseEntityType(q.entityType),
      entityId: parseEntityId(q.entityId),
      mediaType: parseEnum(MediaType, q.mediaType, 'mediaType'),
      status: parseEnum(MediaStatus, q.status, 'status'),
      source: parseEnum(MediaSource, q.source, 'source'),
      uploadedBy: parseEntityId(q.uploadedBy),
      from: parseDate(q.from, 'from'),
      to: parseDate(q.to, 'to'),
      page: q.page ? Number(q.page) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.media.get(id, { id: user.sub, role: user.role });
  }

  @Patch(':id')
  update(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    return this.media.update(id, { id: user.sub, role: user.role }, {
      isPrimary: body.isPrimary === undefined ? undefined : body.isPrimary === true || body.isPrimary === 'true',
      sortOrder: body.sortOrder === undefined ? undefined : Number(body.sortOrder),
      entityType: parseEntityType(body.entityType),
      entityId: body.entityId === null ? null : parseEntityId(body.entityId),
    });
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Req() req: any) {
    return this.media.remove(id, { id: user.sub, role: user.role }, requestIp(req));
  }
}
