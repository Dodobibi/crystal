import chalk from "chalk";
import debugFactory from "debug";
import type { TE } from "tamedevil";
import te from "tamedevil";

import { inspect } from "../inspect.js";
import type { ExecutionExtra } from "../interfaces.js";
import type { ExecutableStep } from "../step.js";
import { UnbatchedExecutableStep } from "../step.js";
import LRU from "@graphile/lru";

/** @internal */
export const expressionSymbol = Symbol("expression");

function access1(key1: number | string | symbol, fallback: any) {
  if (fallback !== undefined) {
    return function quicklyAccessKey1WithFallback(
      _extra: ExecutionExtra,
      value: any,
    ) {
      return value?.[key1] ?? fallback;
    };
  } else {
    return function quicklyAccessKey1(_extra: ExecutionExtra, value: any) {
      return value?.[key1];
    };
  }
}

function access2(
  key1: number | string | symbol,
  key2: number | string | symbol,
  fallback: any,
) {
  if (fallback !== undefined) {
    return function quicklyAccessKey2WithFallback(
      _extra: ExecutionExtra,
      value: any,
    ) {
      return value?.[key1]?.[key2] ?? fallback;
    };
  } else {
    return function quicklyAccessKey2(_extra: ExecutionExtra, value: any) {
      return value?.[key1]?.[key2];
    };
  }
}

const makeDestructureHyperCache = new LRU<
  string,
  (_extra: ExecutionExtra, value: any) => any
>({ maxLength: 1000 });
const makingDestructureHyperCache = new Map<
  string,
  Array<(fn: (_extra: ExecutionExtra, value: any) => any) => void>
>();

// We could use an LRU here, but there's no need - there's only 100 possible values;
type Factory = (
  ...path: Array<string | number | symbol>
) => (_extra: ExecutionExtra, value: any) => any;
const makeDestructureCache: { [signature: string]: Factory } =
  Object.create(null);
const makingDestructureCache: {
  [signature: string]: Array<(factory: Factory) => void>;
} = Object.create(null);

/**
 * Returns a function that will extract the value at the given path from an
 * incoming object. If possible it will return a dynamically constructed
 * function which will enable V8 to optimise the function over time via the
 * JIT.
 */
function constructDestructureFunction(
  path: (string | number | symbol)[],
  fallback: any,
  callback: (fn: (_extra: ExecutionExtra, value: any) => any) => void,
): void {
  const n = path.length;
  /** 0 - slow mode; 1 - middle mode; 2 - turbo mode */
  let mode: 0 | 1 | 2 = n > 50 ? 0 : n > 5 ? 1 : 2;

  for (let i = 0; i < n; i++) {
    const pathItem = path[i];
    const t = typeof pathItem;
    if (t === "symbol") {
      // Cannot use in superfast mode (because cannot create signature)
      if (mode === 2) mode = 1;
    } else if (t === "string") {
      // Cannot use in superfast mode (because signature becomes ambiguous)
      if (t.includes("|") && mode === 2) mode = 1;
    } else if (t === "number") {
      if (!Number.isFinite(pathItem)) {
        mode = 0;
      }
    } else if (pathItem == null) {
      // Slow mode required
      mode = 0;
    } else {
      throw new Error(
        `Invalid path item: ${inspect(pathItem)} in path '${JSON.stringify(
          path,
        )}'`,
      );
    }
  }

  if (mode === 0) {
    // Slow mode
    callback(function slowlyExtractValueAtPath(_meta: any, value: any): any {
      let current = value;
      for (let i = 0, l = path.length; i < l && current != null; i++) {
        const pathItem = path[i];
        current = current[pathItem];
      }
      return current ?? fallback;
    });
  } else if (mode === 1) {
    const signature = (fallback !== undefined ? "f" : "n") + n;
    // PERF: we could add jitParts here if we wanted to
    const fn = makeDestructureCache[signature];
    if (fn) {
      callback(fn(...path));
      return;
    }
    if (makingDestructureCache[signature]) {
      makingDestructureCache[signature].push((fn) => callback(fn(...path)));
      return;
    }
    const callbacks: Array<(fn: Factory) => void> = [
      (fn) => callback(fn(...path)),
    ];
    makingDestructureCache[signature] = callbacks;

    // DO NOT REFERENCE 'path' BELOW HERE!

    const names: TE[] = [];
    const access: TE[] = [];
    for (let i = 0; i < n; i++) {
      const te_name = te.identifier(`p${i}`);
      names.push(te_name);
      access.push(te`[${te_name}]`);
    }
    te.runInBatch<Factory>(
      te`function (${te.join(names, ", ")}) {
return (_meta, value) => value${te.join(access, "")};
}`,
      (factory) => {
        makeDestructureCache[signature] = factory;
        delete makingDestructureCache[signature];
        for (const callback of callbacks) {
          callback(factory);
        }
      },
    );
  } else {
    // Super fast mode! This stores jitParts for OutputPlan to use.
    // NOTE: path has already been validated as safe.
    const signature = path.join("|");
    const fn = makeDestructureHyperCache.get(signature);
    if (fn) {
      callback(fn);
      return;
    }
    const making = makingDestructureHyperCache.get(signature);
    if (making) {
      making.push(callback);
      return;
    }
    const callbacks: Array<typeof callback> = [callback];
    makingDestructureHyperCache.set(signature, callbacks);

    const done = (fn: Parameters<typeof callback>[0]) => {
      makeDestructureHyperCache.set(signature, fn);
      makingDestructureHyperCache.delete(signature);
      for (const callback of callbacks) {
        callback(fn);
      }
    };

    const jitParts: TE[] = [];

    for (let i = 0, l = path.length; i < l; i++) {
      const pathItem = path[i];
      jitParts.push(te.get(pathItem));
    }

    // ?.blah?.bog?.["!!!"]?.[0]
    const expression = te.join(jitParts, "");
    const expressionDetail = [expression, fallback];

    if (path.length === 1) {
      const quicklyExtractValueAtPath = access1(path[0], fallback) as any;
      quicklyExtractValueAtPath[expressionSymbol] = expressionDetail;
      done(quicklyExtractValueAtPath);
    } else if (path.length === 2) {
      const quicklyExtractValueAtPath = access2(
        path[0],
        path[1],
        fallback,
      ) as any;
      quicklyExtractValueAtPath[expressionSymbol] = expressionDetail;
      done(quicklyExtractValueAtPath);
    } else {
      // (extra, value) => value?.blah?.bog?.["!!!"]?.[0]
      te.runInBatch<any>(
        te`\
(function quicklyExtractValueAtPath(extra, value) {
  return (value${expression})${
          fallback !== undefined ? te` ?? ${te.lit(fallback)}` : te.blank
        };
})`,
        (quicklyExtractValueAtPath) => {
          // JIT this for great performance.
          quicklyExtractValueAtPath[expressionSymbol] = expressionDetail;
          done(quicklyExtractValueAtPath);
        },
      );
    }
  }
}

const debugAccessPlan = debugFactory("grafast:AccessStep");
const debugAccessPlanVerbose = debugAccessPlan.extend("verbose");

/**
 * Accesses a (potentially nested) property from the result of a plan.
 *
 * NOTE: this could lead to unexpected results (which could introduce security
 * issues) if it is not used carefully; only use it on JSON-like data,
 * preferably where the objects have null prototypes, and be sure to adhere to
 * the naming conventions detailed in assertSafeToAccessViaBraces.
 */
export class AccessStep<TData> extends UnbatchedExecutableStep<TData> {
  static $$export = {
    moduleName: "grafast",
    exportName: "AccessStep",
  };
  isSyncAndSafe = true;

  allowMultipleOptimizations = true;
  public readonly path: (string | number | symbol)[];

  constructor(
    parentPlan: ExecutableStep<unknown>,
    path: (string | number | symbol)[],
    public readonly fallback?: any,
  ) {
    super();
    this.path = path;
    this.addDependency(parentPlan);
  }

  toStringMeta(): string {
    return `${chalk.bold.yellow(String(this.getDep(0).id))}.${this.path
      .map((p) => String(p))
      .join(".")}`;
  }

  /**
   * Get the named property of an object.
   */
  get<TAttr extends keyof TData>(attrName: TAttr): AccessStep<TData[TAttr]> {
    if (typeof attrName !== "string") {
      throw new Error(`AccessStep::get can only be called with string values`);
    }
    return new AccessStep(this.getDep(0), [...this.path, attrName]);
  }

  /**
   * Get the entry at the given index in an array.
   */
  at<TIndex extends keyof TData>(index: TIndex): AccessStep<TData[TIndex]> {
    if (typeof index !== "number") {
      throw new Error(`AccessStep::get can only be called with string values`);
    }
    return new AccessStep(this.getDep(0), [...this.path, index]);
  }

  // An access of an access can become a single access
  optimize(): AccessStep<TData> {
    const $dep = this.getDep(0);
    if ($dep instanceof AccessStep && $dep.fallback === undefined) {
      return access(
        $dep.getDep(0),
        [...$dep.path, ...this.path],
        this.fallback,
      );
    }
    // This must be in `optimize` rather than `finalize` because
    // `OutputPlan.optimize` depends on it.
    // TODO: resolve the above comment; this should be in finalize.
    constructDestructureFunction(this.path, this.fallback, (fn) => {
      this.unbatchedExecute = fn;
    });
    return this;
  }

  unbatchedExecute(_extra: ExecutionExtra, ..._values: any[]): any {
    throw new Error(
      `${this}: should have had unbatchedExecute method replaced`,
    );
  }

  deduplicate(peers: AccessStep<unknown>[]): AccessStep<TData>[] {
    const myPath = JSON.stringify(this.path);
    const peersWithSamePath = peers.filter(
      (p) => p.fallback === this.fallback && JSON.stringify(p.path) === myPath,
    );
    debugAccessPlanVerbose(
      "%c deduplicate: peers with same path %o = %c",
      this,
      this.path,
      peersWithSamePath,
    );
    return peersWithSamePath as AccessStep<TData>[];
  }
}

/**
 * Access the property at path `path` in the value returned from `parentPlan`,
 * falling back to `fallback` if it were null-ish.
 */
export function access<TData>(
  parentPlan: ExecutableStep<unknown>,
  path: (string | number | symbol)[] | string | number | symbol,
  fallback?: any,
): AccessStep<TData> {
  return new AccessStep<TData>(
    parentPlan,
    Array.isArray(path) ? path : [path],
    fallback,
  );
}
