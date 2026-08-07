import { validateBearerToken } from "./token";

export function rejectsExpiredToken(): boolean {
  return !validateBearerToken({ value: "secret", expiresAt: 1 }, 2);
}
