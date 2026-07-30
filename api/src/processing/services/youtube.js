import HLS from "hls-parser";

import { Agent, fetch } from "undici";

import { cobaltUserAgent, env } from "../../config.js";
import { getCookie } from "../cookie/manager.js";
import { getYouTubeSession } from "../helpers/youtube-session.js";
import {
    closeSessionProxyAgent,
    createSessionProxyAgent,
    getSessionProxyUsername
} from "../helpers/proxy-agent.js";


import Innertube, { Constants, UniversalCache, YT, Session, Platform} from 'youtubei.js';


const PLAYER_REFRESH_PERIOD = 1000 * 60 * 15; // ms


let innertube, lastRefreshedAt;
const directAgent = new Agent();
const companionAgent = new Agent();

const codecList = {
    h264: {
        videoCodec: "avc1",
        audioCodec: "mp4a",
        container: "mp4"
    },
    av1: {
        videoCodec: "av01",
        audioCodec: "opus",
        container: "webm"
    },
    vp9: {
        videoCodec: "vp9",
        audioCodec: "opus",
        container: "webm"
    }
}

const hlsCodecList = {
    h264: {
        videoCodec: "avc1",
        audioCodec: "mp4a",
        container: "mp4"
    },
    vp9: {
        videoCodec: "vp09",
        audioCodec: "mp4a",
        container: "webm"
    }
}

const clientsWithNoCipher = ['IOS', 'ANDROID', 'YTSTUDIO_ANDROID', 'YTMUSIC_ANDROID'];

const videoQualities = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];

const cloneInnertube = async (customFetch, useSession) => {
    const shouldRefreshPlayer = lastRefreshedAt + PLAYER_REFRESH_PERIOD < new Date();

    const rawCookie = getCookie('youtube');
    const cookie = rawCookie?.toString();

    const sessionTokens = getYouTubeSession();
    const retrieve_player = Boolean(sessionTokens || cookie);
    //let token = await fetchToken();
    if (useSession && env.ytSessionServer && !sessionTokens?.potoken) {
        throw "no_session_tokens";
    }

    if (!innertube || shouldRefreshPlayer) {
        innertube = await Innertube.create({
            cache: new UniversalCache(true),
            fetch: customFetch,
            enable_session_cache: false,
            retrieve_innertube_config: false,
            client_type: "ANDROID_VR",
            //player_id: 'ecc3e9a7',
            retrieve_player: false,
            cookie,
            //po_token: token.poToken,
            //isitor_data: token.visitorData
        });
        lastRefreshedAt = +new Date();
    }

    const session = new Session(
        innertube.session.context,
        innertube.session.api_key,
        innertube.session.api_version,
        innertube.session.account_index,
        innertube.session.config_data,
        innertube.session.player,
        cookie,
        customFetch ?? innertube.session.http.fetch,
        innertube.session.cache,
        //token.poToken
    );

    const yt = new Innertube(session);
    return yt;
}

function addCpnQuery(url) {
        // append query param
        const urlObj = new URL(url);
        urlObj.searchParams.set("cpn", "");
        url = urlObj.toString();
        return url;
}
async function reportBannedIp(reason, videoId, dispatcher) {
    if (!env.externalProxy || !env.proxyUsername || !env.proxyPassword) {
        return null;
    }

    const ipDispatcher = dispatcher ?? createSessionProxyAgent(videoId);

    try {
        const proxyUrl = new URL(env.externalProxy);
        const krakenApi = new URL('/api/ip/ban', proxyUrl);
        krakenApi.port = '5680';
        krakenApi.username = '';
        krakenApi.password = '';

        const IP_CHECK_API = 'https://api64.ipify.org?format=json';
        const req = await fetch(IP_CHECK_API, {
            dispatcher: ipDispatcher
        });

        if (!req.ok) {
            throw new Error(`Failed to fetch IP address: ${req.statusText}`);
        }

        const data = await req.json();
        const ipAddress = data.ip;

        if (!ipAddress) {
            return null;
        }

        const payload = {
            ip: ipAddress,
            reason,
            reporter: 'Cobalt-exact/youtube',
            duration: 864000,
            severity: "permanent"
        };

        const credentials = Buffer.from(`${env.proxyUsername}:${env.proxyPassword}`).toString('base64');
        const report = await fetch(krakenApi, {
            method: "POST",
            headers: {
                accept: "*/*",
                "content-type": "application/json",
                authorization: `Basic ${credentials}`
            },
            body: JSON.stringify(payload)
        });

        if (!report.ok) {
            throw new Error(`Failed to report banned IP: ${report.statusText}`);
        }

        //console.log(`Reported banned IP ${ipAddress} for video ${videoId}`);
        return await report.json().catch(() => null);
    }
    catch (e) {
        console.error(`Failed to report banned IP for video ${videoId}: ${e.message}`);
        return null;
    }
    finally {
        closeSessionProxyAgent(ipDispatcher);
    }
}
async function getStreamingDataFromExternalProvider(videoId, innertube) {
  const req = await fetch('http://127.0.0.1:8282/companion/youtubei/v1/player', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer abc123abc123abc1'
    },
    body: JSON.stringify({ videoId }),
    dispatcher: companionAgent
  });
  
  if (!req.ok) {
    throw new Error(`Failed to fetch streaming data for video ${videoId}: ${req.statusText}`);
  }
  
  const data = await req.json();
  
  const playerResponse = {
    success: true,
    status_code: 200,
    data: data
  };

  const videoInfo = new YT.VideoInfo([playerResponse], innertube.actions, '');
  
  return videoInfo;
}
export default async function (o) {
    if (!o.id || o.id === "" || o.id === "undefined" || o.id === "null") {
        return { error: "fetch.fail" };
    }
    const proxySessionId = o.proxySessionId ?? o.id;
    const proxyUsername = getSessionProxyUsername(proxySessionId);
    let proxyAgent, proxyAgentInitialized = false;
    const getDispatcher = () => {
        if (!proxyAgentInitialized) {
            proxyAgent = createSessionProxyAgent(proxySessionId);
            proxyAgentInitialized = true;
        }
        return proxyAgent ?? o.dispatcher;
    };

    if (proxyUsername) {
        //console.log(`Using proxy session ${proxyUsername}`);
    }

    const quality = o.quality === "max" ? 9000 : Number(o.quality);

    let useHLS = o.youtubeHLS;
    let innertubeClient = o.innertubeClient || env.customInnertubeClient || "IOS";

    // HLS playlists from the iOS client don't contain the av1 video format.
    if (useHLS && o.format === "av1") {
        useHLS = false;
    }

    if (useHLS) {
        innertubeClient = "IOS";
    }

    // iOS client doesn't have adaptive formats of resolution >1080p,
    // so we use the WEB_EMBEDDED client instead for those cases
    const useSession =
        env.ytSessionServer && (
            (
                !useHLS
                && innertubeClient === "IOS"
                && (
                    (quality > 1080 && o.format !== "h264")
                    || (quality > 1080 && o.format !== "vp9")
                )
            )
        );

    if (useSession) {
        innertubeClient = env.ytSessionInnertubeClient || "WEB_EMBEDDED";
    }

    let yt;
    try {
        yt = await cloneInnertube(
            (input, init) => fetch(input, {
                ...init,
                dispatcher: directAgent,
            }),
            useSession
        );
    } catch (e) {
        if (e === "no_session_tokens") {
            return { error: "youtube.no_session_tokens" };
        } else if (e.message?.endsWith("decipher algorithm")) {
            return { error: "youtube.decipher" }
        } else if (e.message?.includes("refresh access token")) {
            return { error: "youtube.token_expired" }
        } else throw e;
    }

    let info;
    // try {
    //     info = await getBasicInfo(yt, o.id);
    //     //info = await yt.getBasicInfo(o.id, innertubeClient)
    // } catch (e) {
    //     if (e?.info) {
    //         let errorInfo;
    //         try { errorInfo = JSON.parse(e?.info); } catch {}

    //         if (errorInfo?.reason === "This video is private") {
    //             return { error: "content.video.private" };
    //         }
    //         if (["INVALID_ARGUMENT", "UNAUTHENTICATED"].includes(errorInfo?.error?.status)) {
    //             return { error: "youtube.api_error" };
    //         }
    //     }

    //     if (e?.message === "This video is unavailable") {
    //         return { error: "content.video.unavailable" };
    //     }

    //     return { error: "fetch.fail" };
    // }
    info = await getStreamingDataFromExternalProvider(o.id, innertube);


    if (!info) return { error: "fetch.fail" };
    
    const playability = info.playability_status;
    const basicInfo = info.basic_info;

    switch (playability.status) {
        case "LOGIN_REQUIRED":
            if (playability.reason.endsWith("bot")) {
                void reportBannedIp("LOGIN_REQUIRED", o.id, getDispatcher());
                return { error: "youtube.login" }
            }
            if (playability.reason.endsWith("age") || playability.reason.endsWith("inappropriate for some users.")) {
                return { error: "content.video.age" }
            }
            if (playability?.error_screen?.reason?.text === "Private video") {
                return { error: "content.video.private" }
            }
            break;

        case "UNPLAYABLE":
            if (playability?.reason?.endsWith("request limit.")) {
                return { error: "fetch.rate" }
            }
            if (playability?.error_screen?.subreason?.text?.endsWith("in your country")) {
                return { error: "content.video.region" }
            }
            if (playability?.error_screen?.reason?.text === "Private video") {
                return { error: "content.video.private" }
            }
            break;

        case "AGE_VERIFICATION_REQUIRED":
            return { error: "content.video.age" };
    }

    if (playability.status !== "OK") {
        return { error: "content.video.unavailable" };
    }

    if (basicInfo.is_live) {
        return { error: "content.video.live" };
    }

    if (basicInfo.duration > env.durationLimit) {
        return { error: "content.too_long" };
    }

    // return a critical error if returned video is "Video Not Available"
    // or a similar stub by youtube
    if (basicInfo.id !== o.id) {
        return {
            error: "fetch.fail",
            critical: true
        }
    }

    const normalizeQuality = res => {
        const shortestSide = Math.min(res.height, res.width);
        return videoQualities.find(qual => qual >= shortestSide);
    }

    let video, audio, dubbedLanguage,
        codec = o.format || "h264", itag = o.itag;

    if (useHLS) {
        const hlsManifest = info.streaming_data.hls_manifest_url;

        if (!hlsManifest) {
            return { error: "youtube.no_hls_streams" };
        }

        const hlsDispatcher = getDispatcher();
        const fetchedHlsManifest = await fetch(hlsManifest, {
            dispatcher: hlsDispatcher,
        }).then(r => {
            if (r.status === 200) {
                return r.text();
            } else {
                throw new Error("couldn't fetch the HLS playlist");
            }
        }).catch(() => { })
          .finally(() => closeSessionProxyAgent(hlsDispatcher));

        if (!fetchedHlsManifest) {
            return { error: "youtube.no_hls_streams" };
        }

        const variants = HLS.parse(fetchedHlsManifest).variants.sort(
            (a, b) => Number(b.bandwidth) - Number(a.bandwidth)
        );

        if (!variants || variants.length === 0) {
            return { error: "youtube.no_hls_streams" };
        }

        const matchHlsCodec = codecs => (
            codecs.includes(hlsCodecList[codec].videoCodec)
        );

        const best = variants.find(i => matchHlsCodec(i.codecs));

        const preferred = variants.find(i =>
            matchHlsCodec(i.codecs) && normalizeQuality(i.resolution) === quality
        );

        let selected = preferred || best;

        if (!selected) {
            codec = "h264";
            selected = variants.find(i => matchHlsCodec(i.codecs));
        }

        if (!selected) {
            return { error: "youtube.no_matching_format" };
        }

        audio = selected.audio.find(i => i.isDefault);

        // some videos (mainly those with AI dubs) don't have any tracks marked as default
        // why? god knows, but we assume that a default track is marked as such in the title
        if (!audio) {
            audio = selected.audio.find(i => i.name.endsWith("original"));
        }

        if (o.dubLang) {
            const dubbedAudio = selected.audio.find(i =>
                i.language?.startsWith(o.dubLang)
            );

            if (dubbedAudio && !dubbedAudio.isDefault) {
                dubbedLanguage = dubbedAudio.language;
                audio = dubbedAudio;
            }
        }

        selected.audio = [];
        selected.subtitles = [];
        video = selected;
    } else {
        // i miss typescript so bad
        const sorted_formats = {
            h264: {
                video: [],
                audio: [],
                bestVideo: undefined,
                bestAudio: undefined,
            },
            vp9: {
                video: [],
                audio: [],
                bestVideo: undefined,
                bestAudio: undefined,
            },
            av1: {
                video: [],
                audio: [],
                bestVideo: undefined,
                bestAudio: undefined,
            },
        }

        const checkFormat = (format, pCodec) => format.content_length &&
            (format.mime_type.includes(codecList[pCodec].videoCodec)
                || format.mime_type.includes(codecList[pCodec].audioCodec));
        
        // sort formats & weed out bad ones
        info.streaming_data.adaptive_formats.sort((a, b) =>
            Number(b.bitrate) - Number(a.bitrate)
        ).forEach(format => {
            Object.keys(codecList).forEach(yCodec => {
                const matchingItag = slot => !itag?.[slot] || itag[slot] === format.itag;
                const sorted = sorted_formats[yCodec];
                const goodFormat = checkFormat(format, yCodec);
                if (!goodFormat) return;

                if (format.has_video && matchingItag('video')) {
                    sorted.video.push(format);
                    if (!sorted.bestVideo)
                        sorted.bestVideo = format;
                }

                if (format.has_audio && matchingItag('audio')) {
                    sorted.audio.push(format);
                    if (!sorted.bestAudio)
                        sorted.bestAudio = format;
                }
            })
        });
        
        const noBestMedia = () => {
            const vid = sorted_formats[codec]?.bestVideo;
            const aud = sorted_formats[codec]?.bestAudio;
            return (!vid && !o.isAudioOnly) || (!aud && o.isAudioOnly)
        };

        if (noBestMedia()) {
            if (codec === "av1") codec = "vp9";
            else if (codec === "vp9") codec = "av1";

            // if there's no higher quality fallback, then use h264
            if (noBestMedia()) codec = "h264";
        }

        // if there's no proper combo of av1, vp9, or h264, then give up
        if (noBestMedia()) {
            return { error: "youtube.no_matching_format" };
        }

        audio = sorted_formats[codec].bestAudio;

        if (audio?.audio_track && !audio?.is_original) {
            audio = sorted_formats[codec].audio.find(i =>
                i?.is_original
            );
        }

        if (o.dubLang) {
            const dubbedAudio = sorted_formats[codec].audio.find(i =>
                i.language?.startsWith(o.dubLang) && i.audio_track
            );

            if (dubbedAudio && !dubbedAudio?.audio_track?.audio_is_default) {
                audio = dubbedAudio;
                dubbedLanguage = dubbedAudio.language;
            }
        }

        if (!o.isAudioOnly) {
            const qual = (i) => {
                return normalizeQuality({
                    width: i.width,
                    height: i.height,
                })
            }

            const bestQuality = qual(sorted_formats[codec].bestVideo);
            const useBestQuality = quality >= bestQuality;

            video = useBestQuality
                ? sorted_formats[codec].bestVideo
                : sorted_formats[codec].video.find(i => qual(i) === quality);

            if (!video) video = sorted_formats[codec].bestVideo;
        }
    }

    if (video?.drm_families || audio?.drm_families) {
        return { error: "youtube.drm" };
    }
        
    //let reinfo = await yt.getInfo(o.id, 'ANDROID');
    const fileMetadata = {
        title: basicInfo.title.trim(),
        artist: basicInfo.author.replace("- Topic", "").trim()
    }

    if (basicInfo?.short_description?.startsWith("Provided to YouTube by")) {
        const descItems = basicInfo.short_description.split("\n\n", 5);

        if (descItems.length === 5) {
            fileMetadata.album = descItems[2];
            fileMetadata.copyright = descItems[3];
            if (descItems[4].startsWith("Released on:")) {
                fileMetadata.date = descItems[4].replace("Released on: ", '').trim();
            }
        }
    }

    const filenameAttributes = {
        service: "youtube",
        id: o.id,
        title: fileMetadata.title,
        author: fileMetadata.artist,
        youtubeDubName: dubbedLanguage || false,
    }
    
    itag = {
        video: video?.itag,
        audio: audio?.itag
    };

    const originalRequest = {
        ...o,
        dispatcher: undefined,
        proxySessionId,
        itag,
        innertubeClient
    };

    if (audio && o.isAudioOnly) {
        let bestAudio = codec === "h264" ? "m4a" : "opus";
        let urls = audio.url;

        if (useHLS) {
            bestAudio = "mp3";
            urls = audio.uri;
        }

        if (!clientsWithNoCipher.includes(innertubeClient) && innertube) {
            urls = await audio.decipher(innertube.session.player);
        }

        urls = addCpnQuery(urls);

        return {
            type: "audio",
            isAudioOnly: true,
            urls,
            filenameAttributes,
            fileMetadata,
            bestAudio,
            isHLS: useHLS,
            originalRequest
        }
    }

    if (video && audio) {
        let resolution;

        if (useHLS) {
            resolution = normalizeQuality(video.resolution);
            filenameAttributes.resolution = `${video.resolution.width}x${video.resolution.height}`;
            filenameAttributes.extension = hlsCodecList[codec].container;

            video = video.uri;
            audio = audio.uri;
        } else {
            resolution = normalizeQuality({
                width: video.width,
                height: video.height,
            });

            filenameAttributes.resolution = `${video.width}x${video.height}`;
            filenameAttributes.extension = codecList[codec].container;

            if (!clientsWithNoCipher.includes(innertubeClient) && innertube) {
                video = await video.decipher(innertube.session.player);
                audio = await audio.decipher(innertube.session.player);
            } else {
                video = video.url;
                audio = audio.url;
            }
        }

        filenameAttributes.qualityLabel = `${resolution}p`;
        filenameAttributes.youtubeFormat = codec;

        video = addCpnQuery(video);
        audio = addCpnQuery(audio);
        
        return {
            type: "merge",
            urls: [
                video,
                audio,
            ],
            filenameAttributes,
            fileMetadata,
            isHLS: useHLS,
            originalRequest
        }
    }

    return { error: "youtube.no_matching_format" };
}
