import type { Dialect } from '../../core/types';

/** One line per dialect, shared by every prompt that names the writer's spelling. */
export const DIALECT_LINE: Record<Dialect, string> = {
  'en-US': 'Dialect: American English (en-US). Use American spelling and conventions (color, organize, gray).',
  'en-GB': 'Dialect: British English (en-GB). Use British spelling and conventions (colour, organise, grey).',
  'en-CA': 'Dialect: Canadian English (en-CA). Use Canadian spelling: colour, centre and grey, but -ize endings (organize, realize).',
  'en-AU': 'Dialect: Australian English (en-AU). Follow British spelling and conventions (colour, centre, organise with -ise endings, grey).',
  'en-IN': 'Dialect: Indian English (en-IN). Follow British spelling and conventions (colour, centre, organise with -ise endings, grey).',
};
