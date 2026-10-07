/**
 * Acceso a datos de la web. No contiene reglas de promociones: pide resultados
 * calculados por los casos de uso compartidos, que en la web estática corren en
 * el dispositivo (ver local/router.ts).
 */
import { handle, LocalApiError } from './local/router';

export interface ApiResult<T> {
  data: T;
  /** Fecha de los datos guardados si se sirvieron sin conexión. */
  offlineSince: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const r = await handle(method, path, body);
    // copia profunda: la UI nunca muta el estado interno
    return { data: structuredClone(r.data) as T, offlineSince: r.offlineSince };
  } catch (e) {
    if (e instanceof LocalApiError) throw new ApiError(e.message, e.status);
    throw new ApiError((e as Error).message, 500);
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
