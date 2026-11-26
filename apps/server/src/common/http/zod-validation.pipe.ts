import { HttpStatus, PipeTransform } from '@nestjs/common';
import { ZodTypeAny, z } from 'zod';
import { AppException } from './app-exception';

/**
 * Validates and transforms a request part with a Zod schema.
 * Usage: `@Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput`.
 */
export class ZodValidationPipe<TSchema extends ZodTypeAny> implements PipeTransform<unknown, z.output<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    throw new AppException(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_FAILED',
      'Request validation failed',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
}

export const uuidParam = new ZodValidationPipe(z.string().uuid());
