/** PDF.js still assumes this API even in its legacy build. Safari <17.4 lacks it. */
type Resolvers<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };
const promiseConstructor = Promise as PromiseConstructor & { withResolvers?: <T>() => Resolvers<T> };
if (!promiseConstructor.withResolvers) {
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true, writable: true,
    value: function<T>(this: PromiseConstructor): Resolvers<T> {
      let resolve!: Resolvers<T>["resolve"], reject!: Resolvers<T>["reject"];
      const promise = new this<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    },
  });
}
