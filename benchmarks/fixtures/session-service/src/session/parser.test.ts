import { parseSession } from "./parser";

export function rejectsMissingSessionToken(): boolean {
  try {
    parseSession({});
    return false;
  } catch {
    return true;
  }
}
