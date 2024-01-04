import Boom from "@hapi/boom";
import { TimeoutError } from "./errors";
import { OakContext, OakNext, OakResponse } from "./client";

export type OakHandler = (ctx: OakContext, next: OakNext) => Promise<void | OakResponse>;

export const urlPrefix = (prefix: string): OakHandler => async (ctx: OakContext, next: OakNext) => {
  ctx.req.input = `${prefix}${ctx.req.input}`;
  return next();
};

export const defaultHeaders = (defaultHeaders: HeadersInit) => async ({ req }: OakContext, next: OakNext) => {
  req.init.headers = {
    ...Object.fromEntries((new Headers(defaultHeaders) as any).entries()),
    ...Object.fromEntries((new Headers(req.init.headers) as any).entries()),
  };
  return next();
};

export const timeout = (ms: number) => async ({ req }: OakContext, next: OakNext) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  req.init.signal = controller.signal;
  try {
    await next();
  } catch (e) {
    if ((e as Error).constructor.name === "AbortError") {
      throw new TimeoutError();
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

type RetryHandler = (ctx: OakContext, attempt: number, e: Error) => boolean | Promise<boolean>;

export const retry = (handler: RetryHandler) => async (ctx: OakContext, next: OakNext) => {
  let canRetry = false;
  let attempt = 0;
  do {
    attempt += 1;
    try {
      return await next();
    } catch (e) {
      canRetry = await handler(ctx, attempt, e as Error);
      if (!canRetry) {
        throw e;
      }
    }
  } while(canRetry);
};

export const throwErrors = () => async (ctx: OakContext, next: OakNext) => {
  await next();

  const { status } = ctx.res!;
  if (status >= 400) {
    throw new Boom.Boom(undefined, {
      statusCode: status,
    });
  }
};


export function compose (middleware: OakHandler[]) {
  if (!Array.isArray(middleware)) throw new TypeError('Middleware stack must be an array!')
  for (const fn of middleware) {
    if (typeof fn !== 'function') throw new TypeError('Middleware must be composed of functions!')
  }

  return function (context: OakContext, next?: OakNext) {
    return dispatch(0)
    function dispatch (i: number): Promise<void | OakResponse> {
      let fn: OakNext | OakHandler | undefined = middleware[i];
      if (i === middleware.length) fn = next;
      if (!fn) return Promise.resolve()
      try {
        return Promise.resolve(fn(context, dispatch.bind(null, i + 1)))
      } catch (err) {
        return Promise.reject(err)
      }
    }
  }
}

