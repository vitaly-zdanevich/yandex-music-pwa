const configuredBase = import.meta.env.VITE_API_BASE_URL as string | undefined;

export function apiUrl(path: string): URL {
  const base = configuredBase?.trim().replace(/\/$/, '') || window.location.origin;
  return new URL(`${base}${path}`);
}
