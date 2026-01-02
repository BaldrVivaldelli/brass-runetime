// src/http/httpClient.ts
import { Async } from "../types/asyncEffect";
import {
    HttpClient,
    HttpError,
    HttpRequest,
    HttpWireResponse,
    MakeHttpConfig,
    makeHttp,
    mapAsync,
    mapTryAsync,
} from "./client";

/**
 * “Contenido” (sin meta). Esto es lo que querés que sea el default.
 */
export type HttpResponse<A> = {
    status: number;
    headers: Record<string, string>;
    body: A;
};

/**
 * Meta (opcional / inyectable por middleware).
 */
export type HttpMeta = {
    statusText: string;
    ms: number;
};

/**
 * “Contenido + meta” (resultado de aplicar withMeta).
 */
export type HttpResponseWithMeta<A> = HttpResponse<A> & { meta: HttpMeta };

/**
 * Client “DX” base:
 * - expone wire (request/get/post/postJson)
 * - expone contenido (getText/getJson) SIN meta
 */
export type HttpClientDx = {
    // wire
    request: (req: HttpRequest) => Async<unknown, HttpError, HttpWireResponse>;
    get: (url: string, init?: Omit<RequestInit, "method">) => Async<unknown, HttpError, HttpWireResponse>;
    post: (
        url: string,
        body?: string,
        init?: Omit<RequestInit, "method" | "body">
    ) => Async<unknown, HttpError, HttpWireResponse>;
    postJson: <A extends object>(
        url: string,
        body: A,
        init?: Omit<RequestInit, "method" | "body">
    ) => Async<unknown, HttpError, HttpWireResponse>;

    // contenido (sin meta)
    getText: (url: string, init?: Omit<RequestInit, "method">) => Async<unknown, HttpError, HttpResponse<string>>;
    getJson: <A>(url: string, init?: Omit<RequestInit, "method">) => Async<unknown, HttpError, HttpResponse<A>>;
};

/**
 * Client “DX” con meta:
 * misma API, pero getText/getJson devuelven HttpResponseWithMeta.
 */
export type HttpClientDxWithMeta = Omit<HttpClientDx, "getText" | "getJson"> & {
    getText: (url: string, init?: Omit<RequestInit, "method">) => Async<unknown, HttpError, HttpResponseWithMeta<string>>;
    getJson: <A>(url: string, init?: Omit<RequestInit, "method">) => Async<unknown, HttpError, HttpResponseWithMeta<A>>;
};

const toText = (w: HttpWireResponse): HttpResponse<string> => ({
    status: w.status,
    headers: w.headers,
    body: w.bodyText,
});

const toJson = <A>(w: HttpWireResponse): HttpResponse<A> => ({
    status: w.status,
    headers: w.headers,
    body: JSON.parse(w.bodyText) as A,
});

const toTextWithMeta = (w: HttpWireResponse): HttpResponseWithMeta<string> => ({
    status: w.status,
    headers: w.headers,
    body: w.bodyText,
    meta: { statusText: w.statusText, ms: w.ms },
});

const toJsonWithMeta = <A>(w: HttpWireResponse): HttpResponseWithMeta<A> => ({
    status: w.status,
    headers: w.headers,
    body: JSON.parse(w.bodyText) as A,
    meta: { statusText: w.statusText, ms: w.ms },
});

/**
 * Builder base: por default NO mete meta.
 * Internamente crea makeHttp(cfg) y te expone una API usable.
 */
export function httpClient(cfg: MakeHttpConfig = {}): HttpClientDx {
    const wire: HttpClient = makeHttp(cfg);

    const request = (req: HttpRequest) => wire(req);

    const get = (url: string, init?: Omit<RequestInit, "method">) =>
        request({ method: "GET", url, init });

    const post = (url: string, body?: string, init?: Omit<RequestInit, "method" | "body">) =>
        request({
            method: "POST",
            url,
            body: body && body.length > 0 ? body : undefined,
            init,
        });

    const postJson = <A extends object>(url: string, bodyObj: A, init?: Omit<RequestInit, "method" | "body">) =>
        request({
            method: "POST",
            url,
            body: JSON.stringify(bodyObj),
            headers: { "content-type": "application/json", ...(init?.headers as any) },
            init: { ...(init ?? {}) },
        });

    // contenido (sin meta)
    const getText = (url: string, init?: Omit<RequestInit, "method">) =>
        mapAsync(get(url, init), toText);

    const getJson = <A>(url: string, init?: Omit<RequestInit, "method">) =>
        // parse puede tirar -> usamos mapTryAsync
        mapTryAsync(get(url, init), toJson<A>);

    return { request, get, post, postJson, getText, getJson };
}

/**
 * Middleware “zio-like”: recibe un client base y devuelve uno “enriquecido”.
 * Nota: NO toca el wire; sólo cambia cómo “renderizás” contenido.
 */
export function withMeta(client: HttpClientDx): HttpClientDxWithMeta {
    const getText = (url: string, init?: Omit<RequestInit, "method">) =>
        mapAsync(client.get(url, init), toTextWithMeta);

    const getJson = <A>(url: string, init?: Omit<RequestInit, "method">) =>
        mapTryAsync(client.get(url, init), toJsonWithMeta<A>);

    return {
        request: client.request,
        get: client.get,
        post: client.post,
        postJson: client.postJson,
        getText,
        getJson,
    };
}

/**
 * Convenience: “todo transparente”
 * - crea el client base
 * - le aplica withMeta
 */
export function httpClientWithMeta(cfg: MakeHttpConfig = {}): HttpClientDxWithMeta {
    return withMeta(httpClient(cfg));
}
