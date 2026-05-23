// Shared helpers for the REST boundary contract.
//
// `ApiError` is the uniform error-response envelope every route uses
// (`res.status(4xx).json({ error: '...' })`). A handful of routes attach
// extra fields alongside `error` (e.g. webhooks ship a `message`); compose
// with `&` at the call site rather than widening this type.
//
// `TypedResponse<T>` lets `api.foo()` keep returning a `Response` while
// narrowing the body produced by `.json()`. Consumers stay shaped like
// `const r = await api.foo(); if (r.ok) { const data = await r.json(); }`
// — `data` becomes `T` automatically.

export interface ApiError {
  error: string;
}

export type TypedResponse<T> = Omit<Response, 'json'> & {
  json(): Promise<T>;
};

// Static type-level test helper. Calls compile-check that a value
// satisfies `T` without emitting any runtime cost.
export const expectType = <_T>(_value: _T): void => {};
