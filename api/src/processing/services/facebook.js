import { fetch } from "undici";
import { nanoid } from "nanoid";

import { env } from "../../config.js";
import { extract, normalizeURL } from "../url.js";
import { closeSessionProxyAgent, createSessionProxyAgent } from "../helpers/proxy-agent.js";

// facebook serves full pages to its own crawler, even on ips where
// a regular browser user agent gets a login wall or an error
const headers = {
    'User-Agent': 'facebookexternalhit/1.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
}

const REQUEST_TIMEOUT = 15000;
const MAX_REDIRECTS = 5;

// containers of unrelated videos rendered next to the requested one
const unrelatedContainers = new Set([
    'recent_posts',
    'lasso_blue_feed',
    'related_videos',
]);

const validId = /^\d{1,20}$/;
const validPostId = /^(pfbid[A-Za-z0-9]{1,128}|\d{1,20})$/;
const validName = /^[\p{L}\p{N}._-]{1,100}$/u;
const validShortLink = /^[A-Za-z0-9_-]{1,32}$/;

const isFacebookHost = (hostname) =>
    hostname === "facebook.com"
    || hostname.endsWith(".facebook.com")
    || hostname === "fb.watch";

// only links to facebook's cdn are handed out
const mediaURL = (url) => {
    try {
        const { protocol, hostname } = new URL(url);
        if (protocol === "https:" && hostname.endsWith(".fbcdn.net")) {
            return url;
        }
    } catch {}
}

const request = (url, dispatcher) => fetch(url, {
    headers,
    dispatcher,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
});

const getPage = async (url, dispatcher) => {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
        const res = await request(url, dispatcher);
        const location = res.headers.get("location");

        if (res.status >= 300 && res.status < 400 && location) {
            res.body?.cancel().catch(() => {});
            url = new URL(location, url);

            if (!isFacebookHost(url.hostname)) return;
            if (url.pathname.startsWith("/login")) return { loginWall: true };

            continue;
        }

        return { html: await res.text() };
    }
}

// short & share links redirect to the canonical video or post url
const resolveLink = async (url, dispatcher) => {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
        const res = await request(url, dispatcher);
        res.body?.cancel().catch(() => {});

        const location = res.headers.get("location");
        if (!location) return;

        url = new URL(location, url);
        if (!isFacebookHost(url.hostname)) return;

        const parsed = extract(normalizeURL(url.href));
        const match = parsed?.patternMatch;

        if (match?.id || match?.postId) return match;
    }
}

const getFormats = (video) => {
    const legacy = video.videoDeliveryLegacyFields || video;
    const formats = {
        hd: mediaURL(legacy.browser_native_hd_url) || mediaURL(legacy.playable_url_quality_hd),
        sd: mediaURL(legacy.browser_native_sd_url) || mediaURL(legacy.playable_url),
    };

    const progressive = video.videoDeliveryResponseFragment
        ?.videoDeliveryResponseResult?.progressive_urls || [];

    for (const p of progressive) {
        const quality = p?.metadata?.quality?.toLowerCase();
        if ((quality === "hd" || quality === "sd") && !formats[quality]) {
            formats[quality] = mediaURL(p.progressive_url);
        }
    }

    if (formats.hd || formats.sd) return formats;
}

// returns all videos in page data, along with whether
// they're a part of unrelated content (feeds, recommendations)
const getVideos = (html) => {
    const videos = [];

    const walk = (obj, unrelated) => {
        if (!obj || typeof obj !== "object") return;

        if (obj.__typename === "Video" && obj.id) {
            const formats = getFormats(obj);
            if (formats) {
                videos.push({ id: String(obj.id), formats, unrelated });
            }
        }

        for (const [key, value] of Object.entries(obj)) {
            walk(value, unrelated || unrelatedContainers.has(key));
        }
    }

    for (const [, raw] of html.matchAll(/data-sjs>(\{.*?\})<\/script>/gs)) {
        if (!raw.includes("browser_native_") && !raw.includes("progressive_url")) {
            continue;
        }
        try {
            walk(JSON.parse(raw), false);
        } catch {}
    }

    return videos;
}

const isValid = ({ id, postId, username, shortLink, shareType, shareId }) => {
    if (id) return validId.test(id);
    if (postId) return validPostId.test(postId) && validName.test(username || '');
    if (shortLink) return validShortLink.test(shortLink);
    if (shareId) return validShortLink.test(shareId) && /^[a-z]$/.test(shareType || '');
    return false;
}

export default async function(o) {
    if (!isValid(o)) {
        return { error: "link.unsupported" };
    }

    let { id, postId, username } = o;

    // short links send proxy ips to a login loop, so they're resolved
    // without the proxy. this only reads the redirect, not the content.
    if (o.shortLink || o.shareId) {
        const url = o.shortLink
            ? `https://fb.watch/${o.shortLink}/`
            : `https://www.facebook.com/share/${o.shareType}/${o.shareId}/`;

        const resolved = await resolveLink(url, o.dispatcher).catch(() => {});
        if (!resolved || !isValid(resolved)) {
            return { error: "fetch.short_link" };
        }

        ({ id, postId, username } = resolved);
    }

    const pageURL = id
        ? `https://www.facebook.com/watch/?v=${id}`
        : `https://www.facebook.com/${username}/posts/${postId}`;

    // the page is requested through a sticky proxy session, which only
    // lives for the duration of extraction. if facebook shows a login wall
    // or a page without the video, we retry once with another session.
    const maxAttempts = env.externalProxy ? 2 : 1;
    let page, video;

    for (let attempt = 0; attempt < maxAttempts && !video; attempt++) {
        const proxyAgent = createSessionProxyAgent(`fb-${nanoid(12)}`);

        page = await getPage(pageURL, proxyAgent ?? o.dispatcher)
            .catch(() => {})
            .finally(() => closeSessionProxyAgent(proxyAgent));

        if (!page?.html) continue;

        // pages also contain recommended videos, so we only take the requested
        // video, or the first video of the post if there's no video id
        const videos = getVideos(page.html);
        video = id
            ? videos.find(v => v.id === id)
            : videos.find(v => !v.unrelated);
    }

    if (!video) {
        if (page?.loginWall) return { error: "content.video.private" };
        if (!page?.html) return { error: "fetch.fail" };
        return { error: "fetch.empty" };
    }

    const { hd, sd } = video.formats;
    const preferSd = o.quality !== "max" && Number(o.quality) < 720;
    const baseFilename = `facebook_${video.id}`;

    return {
        urls: preferSd ? (sd || hd) : (hd || sd),
        filename: `${baseFilename}.mp4`,
        audioFilename: `${baseFilename}_audio`,
    }
}
