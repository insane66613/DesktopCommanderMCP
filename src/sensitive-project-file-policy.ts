export const SENSITIVE_PROJECT_FILE_POLICIES = [
  'block',
  'require_explicit_override',
  'allow',
] as const;

export type SensitiveProjectFilePolicy = typeof SENSITIVE_PROJECT_FILE_POLICIES[number];

export const DEFAULT_SENSITIVE_PROJECT_FILE_POLICY: SensitiveProjectFilePolicy = 'require_explicit_override';

export const DEFAULT_SENSITIVE_PROJECT_FILE_ALLOWED_PATTERNS = [
  '.env.example',
  '.env.sample',
  '.env.template',
] as const;

export const BUILTIN_SENSITIVE_PROJECT_FILE_PATTERNS = [
  '.env',
  '.env.*',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'credentials.json',
  'token.json',
  'tokens.json',
  'secrets.json',
  'secret.json',
  'firebase-adminsdk*.json',
  'service-account*.json',
] as const;

function toPatternRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesSensitiveProjectFilePattern(basename: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return false;
  }
  return toPatternRegExp(normalizedPattern).test(basename);
}

export function isSensitiveProjectFile(
  basename: string,
  extraPatterns: readonly string[] = [],
  allowedPatterns: readonly string[] = DEFAULT_SENSITIVE_PROJECT_FILE_ALLOWED_PATTERNS,
): boolean {
  if (allowedPatterns.some((pattern) => matchesSensitiveProjectFilePattern(basename, pattern))) {
    return false;
  }

  return [...BUILTIN_SENSITIVE_PROJECT_FILE_PATTERNS, ...extraPatterns]
    .some((pattern) => matchesSensitiveProjectFilePattern(basename, pattern));
}

export interface SensitiveProjectFileDecision {
  sensitive: boolean;
  allowed: boolean;
  reason: 'not_sensitive' | 'policy_allow' | 'explicit_override' | 'blocked_policy' | 'override_required';
}

export function evaluateSensitiveProjectFileAccess(args: {
  basename: string;
  policy?: string;
  explicitOverride?: boolean;
  extraPatterns?: readonly string[];
  allowedPatterns?: readonly string[];
}): SensitiveProjectFileDecision {
  const policy = SENSITIVE_PROJECT_FILE_POLICIES.includes(args.policy as SensitiveProjectFilePolicy)
    ? args.policy as SensitiveProjectFilePolicy
    : DEFAULT_SENSITIVE_PROJECT_FILE_POLICY;
  const sensitive = isSensitiveProjectFile(
    args.basename,
    args.extraPatterns ?? [],
    args.allowedPatterns ?? DEFAULT_SENSITIVE_PROJECT_FILE_ALLOWED_PATTERNS,
  );

  if (!sensitive) {
    return { sensitive: false, allowed: true, reason: 'not_sensitive' };
  }
  if (policy === 'allow') {
    return { sensitive: true, allowed: true, reason: 'policy_allow' };
  }
  if (policy === 'block') {
    return { sensitive: true, allowed: false, reason: 'blocked_policy' };
  }
  if (args.explicitOverride === true) {
    return { sensitive: true, allowed: true, reason: 'explicit_override' };
  }
  return { sensitive: true, allowed: false, reason: 'override_required' };
}
