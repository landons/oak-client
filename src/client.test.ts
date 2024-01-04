import Boom from "@hapi/boom";
import nock from "nock";
import { OakClient } from "./client";
import { TimeoutError } from "./errors";
import * as middleware from "./middleware";

describe("@oak Client", () => {
  jest.setTimeout(1000);

  beforeAll(() => {
    nock.disableNetConnect();
  });

  beforeEach(() => {
    // GET
    nock('http://www.example.com')
      .get('/resource')
      .reply(function () {
        return [200, { foo: "bar"}];
      });

    // GET (delayed)
    nock('http://www.example.com')
      .get('/delay')
      .delay(500)
      .reply(function () {
        return [200, { foo: "bar"}];
      });

    // GET (authenticated)
    nock('http://www.example.com')
      .persist()
      .get('/authenticated')
      .reply(function () {
        if (!this.req.headers.authorization) {
          return [401, {}];
        }
        return [200, { foo: "bar"}];
      });

    // GET (error)
    nock('http://www.example.com')
      .persist()
      .get('/error')
      .reply(function () {
        const statusHeader = this.req.headers["x-status"];
        if (statusHeader) {
          const status = parseInt(statusHeader);
          return [status, {}];
        }
        return [500, {}];
      });

    // POST
    nock('http://www.example.com')
      .post('/resource', { foo: "bar" })
      .reply(function () {
        return [201, { foo: "baz"}];
      });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  function headers({ headers }: { headers?: HeadersInit }) {
    return new Headers(headers || {});
  }
  
  it("should make GET requests", async () => {
    const client = new OakClient();

    client.use(async ({ req }, next) => {
      expect(req.input).toEqual("http://www.example.com/resource");
      expect(req.init.method).toEqual("GET");
      return next();
    });

    const response = await client.get("http://www.example.com/resource");
    expect(response.status).toEqual(200);
    expect(response.data).toMatchObject({ foo: "bar" });
  });

  it("should make POST requests", async () => {
    const client = new OakClient();

    client.use(async ({ req }, next) => {
      expect(req.input).toEqual("http://www.example.com/resource");
      expect(req.init.method).toEqual("POST");
      expect(headers(req.init).get("content-type")).toEqual("application/json");
      return next();
    });

    const response = await client.post("http://www.example.com/resource", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ foo: "bar" }),
    });
    expect(response.status).toEqual(201);
    expect(response.data).toMatchObject({ foo: "baz" });
  });

  it("should make POST requests with shorthand", async () => {
    const client = new OakClient();

    client.use(middleware.urlPrefix("http://www.example.com"));

    client.use(async ({ req }, next) => {
      expect(req.input).toEqual("http://www.example.com/resource");
      expect(req.init.method).toEqual("POST");
      expect(headers(req.init).get("content-type")).toEqual("application/json");
      return next();
    });

    const response = await client.postJson("/resource", { foo: "bar" });
    expect(response.status).toEqual(201);
    expect(response.data).toMatchObject({ foo: "baz" });
  });

  it("should apply middleware in order", async () => {
    const client = new OakClient();

    client.use(middleware.urlPrefix("http://www.example.com"));

    const appendFooHeader = (value: string): middleware.OakHandler => {
      return ({ req }, next) => {
        const headers = new Headers(req.init.headers || {});
        req.init.headers = {
          foo: `${headers.get("foo") ?? ""}-${value}`,
        };
        return next();
      };
    };

    client.use(appendFooHeader("bar"));
    client.use(appendFooHeader("baz"));

    client.use(async ({ req }, next) => {
      expect(headers(req.init).get("foo")).toEqual("-bar-baz");
      return next();
    });

    const response = await client.get("/resource");
    expect(response.status).toEqual(200);
  });

  it("should set default headers", async () => {
    const client = new OakClient();

    client.use(middleware.urlPrefix("http://www.example.com"));
    client.use(middleware.defaultHeaders({
      foo: "bar",
    }));

    client.use(async ({ req }, next) => {
      const headers = new Headers(req.init.headers);
      expect(Object.fromEntries((headers as any).entries())).toMatchObject({
        foo: "bar",
        bar: "baz",
      });
      return next();
    });

    const response = await client.post("/resource", {
      headers: {
        bar: "baz",
        "content-type": "application/json",
      },
      body: JSON.stringify({ foo: "bar" }),
    });
    expect(response.status).toEqual(201);
  });

  it("should wait for response to complete", async () => {
    const client = new OakClient();

    client.use(async (_, next) => {
      try {
        await next();
        throw new Error("expected timeout to hit. false success!");
      } catch (e) {
        expect(e instanceof TimeoutError).toBe(true);
      }
    });

    client.use(middleware.timeout(50));

    await client.get("http://www.example.com/delay");
  });

  it("should allow retries", async () => {
    const spy = jest.fn();
    const client = new OakClient();

    const MAX_ATTEMPTS = 3;

    client.use(middleware.retry((_, attempt) => attempt < MAX_ATTEMPTS));

    // Simulate errors until the final attempt
    let attempt = 1;
    client.use(async (_, next) => {
      attempt += 1;
      spy(attempt);
      if (attempt < MAX_ATTEMPTS) {
        throw new Error("Unrecoverable Error");
      }
      return next();
    });

    await client.get("http://www.example.com/resource");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("should retry errors", async () => {
    const client = new OakClient();

    client.use(middleware.retry(({ req }, attempt, e) => {
      if (attempt > 1) {
        return false;
      } else if (!Boom.isBoom(e) || e.output.statusCode !== 401) {
        return false;
      }

      const headers = new Headers(req.init.headers);
      headers.set("authorization", "Bearer token");
      req.init.headers = headers;
      return true;
    }));

    client.throwErrors();

    const response = await client.get("http://www.example.com/authenticated");
    expect(response.status).toEqual(200);

  });

  it("should handle errors", async () => {
    const client = new OakClient();
    client.throwErrors();

    function make(statusCode: number) {
      return {
        headers: {
          "x-status": statusCode.toString(),
        },
      };
    }

    await expect(client.get("http://www.example.com/error", make(400))).rejects.toEqual(Boom.badRequest());
    await expect(client.get("http://www.example.com/error", make(401))).rejects.toEqual(Boom.unauthorized());
    await expect(client.get("http://www.example.com/error", make(403))).rejects.toEqual(Boom.forbidden());
    await expect(client.get("http://www.example.com/error")).rejects.toEqual(Boom.internal());
  });
});
