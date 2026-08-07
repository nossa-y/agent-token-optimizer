import { formatUserRecord } from "./user-api";

export function testFormatUserRecord(): boolean {
  return (
    formatUserRecord({
      id: "user_123",
      displayName: "Ada Lovelace",
      active: true,
    }) === "Ada Lovelace (user_123)"
  );
}

export function testFormatInactiveUserRecord(): boolean {
  return (
    formatUserRecord({
      id: "user_456",
      displayName: "Grace Hopper",
      active: false,
    }) === "Grace Hopper (user_456)"
  );
}
