import { useEffect, useState } from 'react';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Нет соединения с сервером. Проверьте, что backend запущен, и повторите запрос.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body.detail;
    throw new Error(typeof detail === 'string' ? detail : response.status === 422
      ? 'Проверьте поля формы: обязательные поля не могут быть пустыми, текст — длиннее 10 000 символов.'
      : `Не удалось выполнить запрос (${response.status}). Попробуйте ещё раз.`);
  }
  return response.json() as Promise<T>;
}

export const send = <T>(path: string, method: string, body?: unknown) => api<T>(path, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export function useResource<T>(path: string | null, revision = 0) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (path === null) { setState({ loading: false }); return; }
    setState({ loading: true });
    api<T>(path, { signal: controller.signal })
      .then((data) => { if (active) setState({ data, loading: false }); })
      .catch((error) => { if (active) setState({ error: error instanceof Error ? error.message : 'Ошибка соединения', loading: false }); });
    return () => { active = false; controller.abort(); };
  }, [path, revision, retry]);
  return { ...state, retry: () => setRetry((value) => value + 1) };
}
