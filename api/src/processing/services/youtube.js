import HLS from "hls-parser";

import { fetch } from "undici";
import { Innertube, Session } from "youtubei.js";

import { env } from "../../config.js";
import { getCookie } from "../cookie/manager.js";
import { getYouTubeSession } from "../helpers/youtube-session.js";

import { Constants, UniversalCache } from 'youtubei.js';
import { YT } from 'youtubei.js';
import GoogleVideo, { base64ToU8, PART, Protos, QUALITY } from 'googlevideo';
import crypto from 'crypto';
import { fetchToken } from "../../misc/getToken.js";

const PLAYER_REFRESH_PERIOD = 1000 * 10 * 1; // ms

////////////////////

async function encryptRequest(clientKey, data) {
  if (clientKey.length !== 32) throw new Error('Invalid client key length');

  const aesKeyData = clientKey.slice(0, 16);
  const hmacKeyData = clientKey.slice(16, 32);

  const iv = crypto.getRandomValues(new Uint8Array(16));

  const aesKey = await crypto.subtle.importKey(
    'raw',
    aesKeyData,
    { name: 'AES-CTR', length: 128 },
    false,
    ['encrypt']
  );

  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 128 }, aesKey, data)
  );

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    hmacKeyData,
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign']
  );

  const hmac = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, new Uint8Array([...encrypted, ...iv]))
  );

  return { encrypted, hmac, iv };
}
async function decryptResponse(iv, hmac, data, clientKeyData) {
  if (!iv || !hmac || !data || !clientKeyData) throw new Error('Invalid input');

  const aesKey = await crypto.subtle.importKey(
    'raw',
    clientKeyData.slice(0, 16),
    { name: 'AES-CTR', length: 128 },
    false,
    ['decrypt']
  );

  const decryptedData = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 128 }, aesKey, data)
  );

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    clientKeyData.slice(16, 32),
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['verify']
  );

  const isValid = await crypto.subtle.verify(
    'HMAC',
    hmacKey,
    hmac,
    new Uint8Array([...data, ...iv])
  );

  if (!isValid) throw new Error('HMAC verification failed');

  return decryptedData;
}

/**
 * Fetches and parses the YouTube TV client configuration.
 * Configurations from other clients can be used as well. I chose TVHTML5 for its simplicity.
 */
async function getYouTubeTVClientConfig() {
  const tvConfigResponse = await fetch('https://www.youtube.com/tv_config?action_get_config=true&client=lb4&theme=cl', {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version'
    }
  });

  const tvConfig = await tvConfigResponse.text();
  if (!tvConfig.startsWith(')]}'))
    throw new Error('Invalid response from YouTube TV config endpoint.');

  const tvConfigJson = JSON.parse(tvConfig.slice(4));

  const webPlayerContextConfig = tvConfigJson.webPlayerContextConfig.WEB_PLAYER_CONTEXT_CONFIG_ID_LIVING_ROOM_WATCH;
  const onesieHotConfig = webPlayerContextConfig.onesieHotConfig;

  const clientKeyData = base64ToU8(onesieHotConfig.clientKey);
  const encryptedClientKey = base64ToU8(onesieHotConfig.encryptedClientKey);
  const onesieUstreamerConfig = base64ToU8(onesieHotConfig.onesieUstreamerConfig);
  const baseUrl = onesieHotConfig.baseUrl;

  return {
    clientKeyData,
    encryptedClientKey,
    onesieUstreamerConfig,
    baseUrl
  };
}

/**
 * Prepares a Onesie request.
 */
async function prepareOnesieRequest(args) {
  const { videoId, poToken, clientConfig, innertube } = args;
  const { clientKeyData, encryptedClientKey, onesieUstreamerConfig } = clientConfig;
  const clonedInnerTubeContext = structuredClone(innertube.session.context);

  // Change or remove these if you want to use a different client. I chose TVHTML5 purely for testing.
  clonedInnerTubeContext.client.clientName = Constants.CLIENTS.MWEB.NAME;
  clonedInnerTubeContext.client.clientVersion = Constants.CLIENTS.MWEB.VERSION;
  
  const params = {
    playbackContext: {
      contentPlaybackContext: {
        vis: 0,
        splay: false,
        lactMilliseconds: '-1',
        signatureTimestamp: innertube.session.player?.sts
      }
    },
    videoId
  };
  
  if (poToken) {
    params.serviceIntegrityDimensions = {};
    params.serviceIntegrityDimensions.poToken = poToken;
  }
  
  const playerRequestJson = {
    context: clonedInnerTubeContext,
    ...params
  };

  const headers = [ {
    name: 'Content-Type',
    value: 'application/json'
  },
  {
    name: 'User-Agent',
    value: innertube.session.context.client.userAgent
  },
  {
    name: 'X-Goog-Visitor-Id',
    value: innertube.session.context.client.visitorData
  } ];

  const onesieRequest = Protos.OnesiePlayerRequest.encode({
    url: 'https://youtubei.googleapis.com/youtubei/v1/player?key=AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8',
    headers,
    body: JSON.stringify(playerRequestJson),
    proxiedByTrustedBandaid: true,
    skipResponseEncryption: true
  }).finish();

  const { encrypted, hmac, iv } = await encryptRequest(clientKeyData, onesieRequest);

  const body = Protos.OnesieRequest.encode({
    urls: [],
    playerRequest: {
      encryptedClientKey,
      encryptedOnesiePlayerRequest: encrypted,
      /* 
       * If you want to use an unencrypted player request:
       * unencryptedOnesiePlayerRequest: onesieRequest, 
       */
      enableCompression: false,
      hmac: hmac,
      iv: iv,
      TQ: true,
      serializeResponseAsJson: true // If false, the response will be serialized as protobuf.
    },
    clientAbrState: {
      timeSinceLastManualFormatSelectionMs: 0,
      lastManualDirection: 0,
      lastManualSelectedResolution: QUALITY.HD720,
      stickyResolution: QUALITY.HD720,
      playerTimeMs: 0,
      visibility: 0
    },
    streamerContext: {
      field5: [],
      field6: [],
      poToken: poToken ? base64ToU8(poToken) : undefined,
      playbackCookie: undefined,
      clientInfo: {
        clientName: parseInt(Constants.CLIENT_NAME_IDS.MWEB),
        clientVersion: clonedInnerTubeContext.client.clientVersion
      }
    },
    bufferedRanges: [],
    onesieUstreamerConfig
  }).finish();

  const videoIdBytes = base64ToU8(videoId);
  const encodedVideoIdChars = [];

  for (const byte of videoIdBytes) {
    encodedVideoIdChars.push(byte.toString(16).padStart(2, '0'));
  }

  const encodedVideoId = encodedVideoIdChars.join('');

  return { body, encodedVideoId };
}

/**
 * Fetches basic video info (streaming data, video details, etc.) using a Onesie request (/initplayback).
 */
async function getBasicInfo(innertube, videoId) {
  const redirectorResponse = await fetch(`https://redirector.googlevideo.com/initplayback?source=youtube&itag=0&pvi=0&pai=0&owc=yes&cmo:sensitive_content=yes&alr=yes&id=${Math.round(Math.random() * 1E5)}`, { method: 'GET' });
  const redirectorResponseUrl = await redirectorResponse.text();

  if (!redirectorResponseUrl.startsWith('https://'))
    throw new Error('Invalid redirector response');

  const clientConfig = await getYouTubeTVClientConfig();
  const onesieRequest = await prepareOnesieRequest({ videoId, /* If needed - poToken,*/ clientConfig, innertube });

  let url = `${redirectorResponseUrl.split('/initplayback')[0]}${clientConfig.baseUrl}`;

  const queryParams = [];
  queryParams.push(`id=${onesieRequest.encodedVideoId}`);
  queryParams.push('opr=1');
  queryParams.push('por=1');
  queryParams.push('rn=1');
  queryParams.push('cmo:sensitive_content=yes');

  url += `&${queryParams.join('&')}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'content-type': 'text/plain'
    },
    referrer: 'https://www.youtube.com/',
    body: onesieRequest.body
  });

  const arrayBuffer = await response.arrayBuffer();
  const googUmp = new GoogleVideo.UMP(new GoogleVideo.ChunkedDataBuffer([ new Uint8Array(arrayBuffer) ]));

  const onesie = [];

  googUmp.parse((part) => {
    const data = part.data.chunks[0];
    switch (part.type) {
      case PART.SABR_ERROR:
        console.log('[SABR_ERROR]:', Protos.SabrError.decode(data));
        break;
      case PART.ONESIE_HEADER:
        onesie.push(Protos.OnesieHeader.decode(data));
        break;
      case PART.ONESIE_DATA:
        onesie[onesie.length - 1].data = data;
        break;
      default:
        break;
    }
  });

  const onesiePlayerResponse = onesie.find((header) => header.type === Protos.OnesieHeaderType.PLAYER_RESPONSE);

  if (onesiePlayerResponse) {
    if (!onesiePlayerResponse.cryptoParams)
      throw new Error('Crypto params not found');

    const iv = onesiePlayerResponse.cryptoParams.iv;
    const hmac = onesiePlayerResponse.cryptoParams.hmac;

    // If skipResponseEncryption is set to true in the request, the response will not be encrypted.
    const decryptedData = hmac?.length && iv?.length ? await decryptResponse(iv, hmac, onesiePlayerResponse.data, clientConfig.clientKeyData) : onesiePlayerResponse.data;
    const response = Protos.OnesiePlayerResponse.decode(decryptedData);

    if (response.onesieProxyStatus !== Protos.OnesieProxyStatus.ONESIE_PROXY_STATUS_OK)
      throw new Error('Onesie proxy status not OK');

    if (response.httpStatus !== 200)
      throw new Error('Http status not OK');

    const playerResponse = {
      success: true,
      status_code: 200,
      data: JSON.parse(new TextDecoder().decode(response.body))
    };

    return new YT.VideoInfo([ playerResponse ], innertube.actions, '');
  }

  throw new Error('Player response not found');
}

///////////////////////////////////////////////////////////////////

let innertube, lastRefreshedAt;

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
    let token = await fetchToken();
    if (useSession && env.ytSessionServer && !sessionTokens?.potoken) {
        throw "no_session_tokens";
    }

    if (!innertube || shouldRefreshPlayer) {
        innertube = await Innertube.create({
            cache: new UniversalCache(false),
            fetch: customFetch,
            retrieve_player: true,
            cookie,
            po_token: token.poToken,
            visitor_data: token.visitorData
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
        token.poToken
    );

    const yt = new Innertube(session);
    return yt;
}

export default async function (o) {
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
                dispatcher: o.dispatcher
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
    try {
        info = await getBasicInfo(yt, o.id);
        //info = await yt.getBasicInfo(o.id, innertubeClient)
    } catch (e) {
        if (e?.info) {
            let errorInfo;
            try { errorInfo = JSON.parse(e?.info); } catch {}

            if (errorInfo?.reason === "This video is private") {
                return { error: "content.video.private" };
            }
            if (["INVALID_ARGUMENT", "UNAUTHENTICATED"].includes(errorInfo?.error?.status)) {
                return { error: "youtube.api_error" };
            }
        }

        if (e?.message === "This video is unavailable") {
            return { error: "content.video.unavailable" };
        }

        return { error: "fetch.fail" };
    }
    if (!info) return { error: "fetch.fail" };

    const playability = info.playability_status;
    const basicInfo = info.basic_info;

    switch (playability.status) {
        case "LOGIN_REQUIRED":
            if (playability.reason.endsWith("bot")) {
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

        const fetchedHlsManifest = await fetch(hlsManifest, {
            dispatcher: o.dispatcher,
        }).then(r => {
            if (r.status === 200) {
                return r.text();
            } else {
                throw new Error("couldn't fetch the HLS playlist");
            }
        }).catch(() => { });

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
            audio = selected.audio.find(i => i.name.endsWith("- original"));
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

        if (audio?.audio_track && !audio?.audio_track?.audio_is_default) {
            audio = sorted_formats[codec].audio.find(i =>
                i?.audio_track?.audio_is_default
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
            urls = audio.decipher(innertube.session.player);
        }

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
                video = video.decipher(innertube.session.player);
                audio = audio.decipher(innertube.session.player);
            } else {
                video = video.url;
                audio = audio.url;
            }
        }

        filenameAttributes.qualityLabel = `${resolution}p`;
        filenameAttributes.youtubeFormat = codec;

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