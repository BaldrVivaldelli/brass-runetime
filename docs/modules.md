# 📦 Modules — brass-runtime

This document describes the current and planned modules in **brass-runtime**, how they relate to each other, and how users are expected to navigate them.

The structure intentionally mirrors the mental model of **ZIO**:
- a small, principled **core**
- optional, layered **modules**
- everything expressed in terms of typed effects and structured concurrency

---

## Core modules (foundation)

These modules form the **runtime kernel**. Everything else builds on top of them.

### `runtime`
**Status:** ✅ stable

Responsible for executing effects.

Contents:
- `Scheduler` — cooperative, deterministic task scheduler
- task queue, microtask flushing
- fairness and explicit async boundaries

You almost never interact with this directly as a user.

---

### `asyncEffect` / `types`
**Status:** ✅ stable

The heart of the system.

Key types:
- `Effect<R, E, A>`
- `Async<R, E, A>`
- `Exit<E, A>`

Capabilities:
- sync + async algebra (no Promises in semantics)
- `map`, `flatMap`, `fold`, etc.
- explicit async registration via callbacks

This is the **semantic core** of brass.

---

### `fiber`
**Status:** ✅ stable

Lightweight fibers with structured lifecycle.

Features:
- `Fiber<E, A>` abstraction
- cooperative interruption
- `join`, `interrupt`
- LIFO finalizers

Fibers are always run under a `Scope`.

---

### `scope`
**Status:** ✅ stable

Structured concurrency and resource safety.

Features:
- parent / child scopes
- deterministic cleanup
- `addFinalizer`, `close`
- used by fibers, streams, HTTP, resources

Scopes ensure:
> no leaks, no zombies, no forgotten cleanup

---

### `resource`
**Status:** ✅ stable

Resource-safe acquisition.

API:
- `acquireRelease`
- `fromResource`

Ties resource lifetimes to scopes.

---

## Concurrency combinators

### `concurrency`
**Status:** ✅ stable

High-level structured concurrency.

Includes:
- `race`
- `zipPar`
- `collectAllPar`
- `fork`

Semantics:
- loser fibers are interrupted
- errors propagate deterministically
- scopes are respected

---

## Stream modules (ZStream-like)

### `stream`
**Status:** 🚧 active

Pull-based, resource-safe streams.

Key ideas:
- `Pull<R, E, A>`
- `ZStream<R, E, A>`
- explicit backpressure
- scope-aware

Includes:
- constructors (`fromArray`, `fromPull`, `empty`)
- transformations (`map`, `filter`)
- execution (`runCollect`, `collectStream`)

---

### `buffer`
**Status:** 🚧 active

Stream buffering with backpressure.

Features:
- bounded buffers
- backpressure vs dropping modes
- deterministic cleanup

This is the foundation for:
- pipelines
- async boundaries in streams
- future hubs

---

### Planned stream modules
**Status:** ⏳ planned

- `pipeline` — ZPipeline-style transformations
- `sink` — consumers / reducers
- `hub` — broadcast / pub-sub streams
- `channel` — low-level streaming algebra

---

## HTTP module

### `http`
**Status:** ✅ usable / evolving

ZIO-HTTP–inspired client built on brass runtime.

Layers:
- **wire layer**: `HttpClient = Request => Async<_, HttpError, HttpWireResponse>`
- **middleware**: request/response transforms
- **DX layer**: ergonomic helpers (`getJson`, `postJson`, etc.)

Key concepts:
- fully lazy
- cancelable via fibers
- no Promises in core semantics
- middleware-style composition (`withMeta`, logging, retries, auth)

Submodules:
- `client.ts` — low-level HTTP execution
- `httpClient.ts` — DX + helpers
- `withMeta` — response enrichment middleware

Example usage:
```ts
const http = httpClientBuilder({ baseUrl }).withMeta();

const post = await toPromise(http.getJson<Post>("/posts/1"), {});
```

---

## Interop modules

### `promise`
**Status:** ✅ stable

Interop with Promise-based APIs.

Includes:
- `toPromise` — await effects externally
- `fromPromiseAbortable`
- `tryPromiseAbortable`

Important:
> Promises are **interop only**, never a runtime primitive.

---

## Examples module

### `examples`
**Status:** ✅ maintained

Executable documentation.

Covers:
- fibers & interruption
- scopes & finalizers
- abortable promises
- streams + buffering
- HTTP usage

If you’re new:
👉 start here.

---

## How to navigate the project

### If you want to…

**Understand the runtime**
- `asyncEffect`
- `scheduler`
- `fiber`
- `scope`

**Use effects**
- `map`, `flatMap`, `fold`
- `toPromise` (interop only)

**Do concurrency**
- `race`
- `zipPar`
- `fork`

**Work with streams**
- `stream`
- `buffer`

**Call HTTP**
- `http/client`
- `http/httpClient`
- middleware like `withMeta`

---

## Design philosophy

- Explicit > implicit
- Structured > ad-hoc
- Lazy by default
- Cancellation is cooperative and visible
- No hidden async semantics

brass is not trying to be “easy first” — it’s trying to be **correct first**.

---

## Future directions

- Public API stabilization
- Docs site (mdbook / Docusaurus)
- ZIO-style module layering (`Layer`-like)
- Metrics & tracing middleware
- Typed errors across HTTP + streams

---

If you want:
- a **diagram** of module dependencies
- a **shorter npm-facing version**
- or a **ZIO comparison table**

say the word.
