export interface UserRecord {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
}

export function formatUserRecord(user: UserRecord): string {
  return `${user.displayName} (${user.id})`;
}
