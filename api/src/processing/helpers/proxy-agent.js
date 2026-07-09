import { ProxyAgent } from "undici";

import { env } from "../../config.js";

export const getSessionProxyUsername = (sessionId) => {
    if (!sessionId || !env.proxyUsername || !env.proxyPassword) return;
    return `${sessionId}__${env.proxyUsername}`;
}

export const createSessionProxyAgent = (sessionId) => {
    if (!env.externalProxy || !sessionId) return;

    const proxyUsername = getSessionProxyUsername(sessionId);

    if (!proxyUsername) {
        return new ProxyAgent(env.externalProxy);
    }

    return new ProxyAgent({
        uri: env.externalProxy,
        token: `Basic ${Buffer.from(`${proxyUsername}:${env.proxyPassword}`).toString('base64')}`,
    });
}
