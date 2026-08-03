import { ProxyAgent } from "undici";

import { env } from "../../config.js";

const sessionProxyAgents = new WeakMap();

const trackSessionProxyAgent = (agent) => {
    sessionProxyAgents.set(agent, 0);
    return agent;
}

const closeDispatcher = (dispatcher) => {
    try {
        const close = dispatcher?.close?.bind(dispatcher);
        if (close) {
            Promise.resolve(close()).catch(() => {
                try { dispatcher?.destroy?.() } catch {}
            });
        } else {
            dispatcher?.destroy?.();
        }
    } catch {
        try { dispatcher?.destroy?.() } catch {}
    }
}

export const getSessionProxyUsername = (sessionId) => {
    if (!sessionId || !env.proxyUsername || !env.proxyPassword) return;
    const safeProxySessionId = sessionId.replaceAll("_", "-");
    return `${safeProxySessionId}__${env.proxyUsername}`;
}

export const createSessionProxyAgent = (sessionId) => {
    if (!env.externalProxy || !sessionId) return;

    const proxyUsername = getSessionProxyUsername(sessionId);

    if (!proxyUsername) {
        return trackSessionProxyAgent(new ProxyAgent(env.externalProxy));
    }

    return trackSessionProxyAgent(new ProxyAgent({
        uri: env.externalProxy,
        token: `Basic ${Buffer.from(`${proxyUsername}:${env.proxyPassword}`).toString('base64')}`,
    }));
}

export const retainSessionProxyAgent = (dispatcher) => {
    if (!sessionProxyAgents.has(dispatcher)) return;
    sessionProxyAgents.set(dispatcher, sessionProxyAgents.get(dispatcher) + 1);
}

export const releaseSessionProxyAgent = (dispatcher) => {
    if (!sessionProxyAgents.has(dispatcher)) return;

    const refCount = sessionProxyAgents.get(dispatcher);
    if (refCount > 1) {
        sessionProxyAgents.set(dispatcher, refCount - 1);
        return;
    }

    sessionProxyAgents.delete(dispatcher);
    closeDispatcher(dispatcher);
}

export const closeSessionProxyAgent = (dispatcher) => {
    if (!sessionProxyAgents.has(dispatcher)) return;

    sessionProxyAgents.delete(dispatcher);
    closeDispatcher(dispatcher);
}
