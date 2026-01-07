# agent.md — brass-runtime

This document describes the **current architecture, invariants, and mental model**
of brass-runtime. It is intended for contributors and for future maintainers.

brass-runtime is intentionally small, explicit, and opinionated.

---

## Core Philosophy

- **Effects are values**
- **Async is explicit**
- **Cancellation is mandatory**
- **Concurrency is structured**
- **Resources are scoped**
- **Streams are first‑class**
- **Streaming should be boring and safe**

If an async operation cannot be cancelled, it is considered a bug.

---

## Execution Model

### Effects

The core abstraction is `Async<R, E, A>` (and `ZIO` aliases):

- `R`: required environment
- `E`: typed failure
- `A`: success value

Effects are:
- lazy
- composable
- cancelable
- interpretable by a runtime

Execution happens via:

```ts
toPromise(effect, env)
```

The runtime schedules fibers using the global scheduler.

---

## Fibers

Fibers are lightweight concurrent processes.

Properties:
- interruptible
- forkable
- joinable
- parent/child structured relationship

Rules:
- Child fibers are owned by a parent scope
- Interrupting a scope interrupts all children
- No detached background work by default

---

## Scheduler

The scheduler:
- drives async callbacks
- ensures fairness
- prevents runaway recursion

All async boundaries must go through the scheduler.

---

## Scope

`Scope<R>` is responsible for **resource lifetime**.

A scope:
- owns finalizers
- owns child fibers
- defines cancellation boundaries

### Invariants

- Finalizers are run **exactly once**
- Finalizers run in **reverse registration order**
- Scope interruption propagates to all children
- Scope closure must eventually complete

### Important Notes

- `scope.close()` is fire‑and‑forget
- `scope.closeAsync(exit)` returns an `Async` that can be awaited
- If something “hangs on cancel”, it is almost always a finalizer bug

---

## Streams (`ZStream`)

A `ZStream<R, E, A>` represents a pull‑based stream.

Characteristics:
- backpressure aware
- cancelable
- resource‑safe
- lazy

Streams are built from **pulls**:

```ts
pull: ZIO<R, Option<E>, [A, ZStream<R, E, A>]>
```

Conventions:
- `Failure(None)` → end of stream
- `Failure(Some(e))` → stream failure

---

## Pipelines (ZPipeline‑style)

Pipelines are **reusable stream transformers**.

```ts
type ZPipeline<Rp, Ep, In, Out> =
  <R, E>(stream: ZStream<R, E, In>) =>
    ZStream<R & Rp, E | Ep, Out>;
```

Why pipelines exist:
- reuse
- separation of concerns
- stateful transforms
- better ergonomics than `map/flatMap` chains

### Composition

- `andThen(p1, p2)` / `>>>`
- `compose(p2, p1)` / `<<<`
- `via(stream, pipeline)`

### Design Rules

- Pipelines must not break backpressure
- Pipelines must respect cancellation
- Pipelines must not leak resources

---

## HTTP Client

brass-runtime exposes **two HTTP clients**:

### 1) Non‑streaming client

- `getText`
- `getJson`
- `post`
- `postJson`

This client eagerly consumes the body via `fetch().text()`.

It is intended for:
- small payloads
- simple DX
- classic REST usage

### 2) Streaming HTTP client

- `httpClientStream`
- body is a `ZStream<Uint8Array>`

This client:
- does NOT eagerly read the body
- supports backpressure
- supports cancellation
- works in Browser and Node 18+

---

## HTTP Streaming Internals

### Web Streams → ZStream

`ReadableStream<Uint8Array>` is adapted via:

```ts
streamFromReadableStream(body, normalizeError)
```

This helper:
- builds a pull‑based `ZStream`
- registers `reader.cancel()` as a finalizer
- propagates fetch abort on interruption

### Cancellation Flow

1. Fiber interrupted
2. Scope closes
3. `AbortController.abort()` is called
4. Reader is cancelled
5. Stream ends

If cancellation hangs, the bug is:
- a finalizer that never completes
- or misuse of `scope.close()` instead of `closeAsync`

---

## HTTP Request Model

`HttpRequest` intentionally separates:

- `headers`
- `init` (RequestInit without headers/body/method)
- `body`

This avoids implicit mutation of `RequestInit`
and makes header handling explicit.

Client helpers (`post`, `postJson`) accept
a convenient `init + headers` shape and adapt it internally.

---

## Error Handling

- All errors are typed
- Stream end is NOT an error
- Cancellation is modeled explicitly

If you see `unknown` creeping into stream errors,
it usually means a constructor was not typed strictly enough.

---

## Common Failure Modes

### Scope never finishes cancelling

Almost always:
- a finalizer returns a non‑terminating effect
- `unit` was returned instead of `unit()`
- `scope.close()` was used instead of awaiting `closeAsync()`

### HTTP streaming hangs

Usually:
- reader was not cancelled
- fetch was not wired to `AbortSignal`
- stream adapter leaked

---

## Non‑Goals

brass-runtime intentionally does NOT try to be:

- a framework
- a Promise wrapper
- RxJS
- a magic abstraction

Everything is explicit by design.

---

## Design North Star

> Make effects explicit.  
> Make cancellation correct.  
> Make streaming boring and safe.
