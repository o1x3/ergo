export type OutputFormat =
  | 'pretty'
  | 'plain'
  | 'json'
  | 'agent'
  | 'sarif'
  | 'markdown';

export const OUTPUT_FORMATS: OutputFormat[] = [
  'pretty',
  'plain',
  'json',
  'agent',
  'sarif',
  'markdown',
];
