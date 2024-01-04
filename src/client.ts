import fetch from "cross-fetch";
import * as mw from "./middleware";

export type FetchType = typeof fetch;
export type FetchArgs = Parameters<FetchType>;

export interface OakResponse<T extends object = any> {
  status: number;
  headers: Headers;
  data: T;
  raw?: string;
}

export interface OakContext<T extends object = any> {
  req: {
    input: RequestInfo;
    init: RequestInit,
  };
  res?: OakResponse<T>;
  error?: Error;
}

export type OakNext = () => Promise<void | OakResponse>;

export class OakClient {
  protected fetchImplementation: typeof fetch = fetch;
  protected middleware: mw.OakHandler[] = [];
  
  public use(middleware: mw.OakHandler) {
    this.middleware.push(middleware);
  }

  public get<T extends object = any>(input: RequestInfo, init?: RequestInit) {
    return this.fetch<T>(input, { ...init, method: "GET" });
  }

  public post<T extends object = any>(input: RequestInfo, init?: RequestInit) {
    return this.fetch<T>(input, { ...init, method: "POST" });
  }

  public postJson<T extends object = any>(input: RequestInfo, body: object, init?: RequestInit) {
    return this.fetch<T>(input, {
      ...init,
      method: "POST",
      headers: {
        ...(init?.headers || {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  public async fetch<T extends object = any>(input: RequestInfo, init: RequestInit = {}): Promise<OakResponse<T>> {
    const ctx: OakContext = {
      req: { input, init },
      res: undefined,
    };

    const fn = mw.compose(this.middleware);
    await fn(ctx, async () => {
      try {
        // IMPORTANT: we can't construct a new Request() object because it requires absolute urls
        const { input, init } = ctx.req;
        const response = await this.fetchImplementation(input, init);

        let raw: string | undefined;
        let data = {};
        const contentTypeHeader = response.headers.get("content-type") || "";
        if (contentTypeHeader.indexOf("application/json") >= 0) {
          data = await response.json() as T;
        } else {
          raw = await response.text();
        }

        ctx.res = {
          status: response.status,
          headers: response.headers,
          data,
          raw,
        };
      } catch (e) {
        ctx.error = e as Error;
        throw e;
      }
    });

    // TODO: is there a way to do this without coersion?
    return ctx.res as OakResponse<T>;
  }

  public urlPrefix(...args: Parameters<typeof mw.urlPrefix>) {
    this.use(mw.urlPrefix(...args));
    return this;
  }

  public defaultHeaders(...args: Parameters<typeof mw.defaultHeaders>) {
    this.use(mw.defaultHeaders(...args));
    return this;
  }

  public throwErrors(...args: Parameters<typeof mw.throwErrors>) {
    this.use(mw.throwErrors(...args));
    return this;
  }

  public timeout(...args: Parameters<typeof mw.timeout>) {
    this.use(mw.timeout(...args));
    return this;
  }

  public retry(...args: Parameters<typeof mw.retry>) {
    this.use(mw.retry(...args));
    return this;
  }
}
