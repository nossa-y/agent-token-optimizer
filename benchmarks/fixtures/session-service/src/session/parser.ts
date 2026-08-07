export function parseSession(value: { readonly token?: string }): string {
  if (!value.token) {
    throw new TypeError("Cannot read properties of undefined");
  }

  return value.token;
}
