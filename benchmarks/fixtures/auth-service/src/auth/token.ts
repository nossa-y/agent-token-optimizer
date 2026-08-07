export interface BearerToken {
  readonly value: string;
  readonly expiresAt: number;
}

export function validateBearerToken(token: BearerToken, _now: number): boolean {
  return token.value.length > 0;
}
