import html, { type HtmlSafeString } from "../shared/escape-html-template-tag/escape.js";

type QualityKey = "adaptive" | "512kbps" | "1mbps" | "2mbps" | "4mbps";

type ClientConfig = {
    basicAuth: {
        password: string;
        username: string;
    } | null;
    currentQuality: QualityKey;
    searchLimit: number;
    searchMinLength: number;
};

type Channel = {
    group: string;
    id: string;
    logoUrl: string | null;
    name: string;
    playlistPath: string;
};

type ChannelsResponse = {
    channels?: Channel[];
};

type QualityResponse = {
    label: string;
    quality: QualityKey;
};

type ChannelLookupResponse = {
    name?: string;
};

type StreamStatusResponse = {
    messages?: string[];
    ready: boolean;
};

type HlsEventCallback = (event: string, data?: { details?: string }) => void;

interface HlsInstance {
    attachMedia(media: HTMLVideoElement): void;
    destroy(): void;
    loadSource(source: string): void;
    on(eventName: string, callback: HlsEventCallback): void;
}

interface HlsConstructor {
    new(config: { liveSyncDurationCount: number; lowLatencyMode: boolean }): HlsInstance;
    isSupported(): boolean;
    Events: {
        ERROR: string;
        MANIFEST_PARSED: string;
    };
}

declare global {
    interface Element {
        safeInnerHTML: HtmlSafeString;
        safeOuterHTML: HtmlSafeString;
    }

    interface Window {
        Hls?: HlsConstructor;
    }
}

const searchInput = getElement<HTMLInputElement>("search");
const qualitySelect = getElement<HTMLSelectElement>("quality");
const playlistUrlInput = getElement<HTMLInputElement>("playlist-url");
const copyPlaylistButton = getElement<HTMLButtonElement>("copy-playlist");
const playlistStatus = getElement<HTMLElement>("playlist-status");
const resultsContainer = getElement<HTMLElement>("results");
const searchStatus = getElement<HTMLElement>("search-status");
const nowPlaying = getElement<HTMLElement>("now-playing");
const streamDebug = getElement<HTMLElement>("stream-debug");
const streamDebugText = getElement<HTMLElement>("stream-debug-text");
const video = getElement<HTMLVideoElement>("player");

const config = readClientConfig();
const SEARCH_STORAGE_KEY = "iptv-proxy.search";

let hls: HlsInstance | null = null;
let activePlaylistPath: string | null = null;
let activeChannelName: string | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let streamStatusTimer: ReturnType<typeof setInterval> | null = null;
let copyButtonResetTimer: ReturnType<typeof setTimeout> | null = null;
let currentQuality: QualityKey = config.currentQuality;

Object.defineProperty(Element.prototype, "safeInnerHTML", {
    set: function setSafeInnerHTML(this: Element, str: HtmlSafeString) {
        this.innerHTML = str.toString();
    },
});

Object.defineProperty(Element.prototype, "safeOuterHTML", {
    set: function setSafeOuterHTML(this: Element, str: HtmlSafeString) {
        this.outerHTML = str.toString();
    },
});

function getElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing required element: #${id}`);
    }

    return element as T;
}

function readClientConfig(): ClientConfig {
    const element = getElement<HTMLScriptElement>("app-config");
    return JSON.parse(element.textContent ?? "{}") as ClientConfig;
}

function setStatus(message: string): void {
    searchStatus.textContent = message;
}

function setNowPlaying(message: string): void {
    nowPlaying.textContent = message;
}

function setPlaylistStatus(message: string): void {
    playlistStatus.textContent = message;
}

function loadStoredSearchTerm(): string {
    try {
        return localStorage.getItem(SEARCH_STORAGE_KEY) ?? "";
    }
    catch {
        return "";
    }
}

function persistSearchTerm(query: string): void {
    try {
        if (query.length === 0) {
            localStorage.removeItem(SEARCH_STORAGE_KEY);
            return;
        }

        localStorage.setItem(SEARCH_STORAGE_KEY, query);
    }
    catch {
        // Ignore storage failures and continue without persistence.
    }
}

function updatePlaylistUrl(): void {
    const playlistUrl = new URL("/playlist.m3u", window.location.origin);
    if (config.basicAuth) {
        playlistUrl.username = config.basicAuth.username;
        playlistUrl.password = config.basicAuth.password;
    }

    playlistUrlInput.value = playlistUrl.toString();
}

function updateQualityStatus(): void {
    const selectedLabel = qualitySelect.options[qualitySelect.selectedIndex]?.text || currentQuality;
    qualitySelect.title = `Current bandwidth: ${selectedLabel}`;
}

function showStreamDebug(message: string): void {
    streamDebug.hidden = false;
    streamDebugText.textContent = message;
}

function hideStreamDebug(): void {
    streamDebug.hidden = true;
    streamDebugText.textContent = "";
}

function stopStreamStatusPolling(): void {
    if (!streamStatusTimer) {
        return;
    }

    clearInterval(streamStatusTimer);
    streamStatusTimer = null;
}

async function pollStreamStatus(playlistPath: string): Promise<void> {
    const response = await fetch(`/api/stream-status?playlistPath=${encodeURIComponent(playlistPath)}`, {
        cache: "no-store",
    });
    if (!response.ok) {
        return;
    }

    const payload = (await response.json()) as StreamStatusResponse;
    if (payload.ready) {
        return;
    }

    if (Array.isArray(payload.messages) && payload.messages.length > 0) {
        showStreamDebug(payload.messages.join("\n"));
    }
}

function startStreamStatusPolling(playlistPath: string): void {
    stopStreamStatusPolling();
    streamDebugText.textContent = "";
    showStreamDebug("Waiting for stream to attach...");
    void pollStreamStatus(playlistPath);
    streamStatusTimer = setInterval(() => {
        void pollStreamStatus(playlistPath);
    }, 1000);
}

function initials(name: string): string {
    return (
        name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() ?? "")
            .join("") || "?"
    );
}

function renderResults(results: Channel[]): void {
    if (results.length === 0) {
        resultsContainer.safeInnerHTML = html`<div class="hint">No matching live channels found.</div>`;
        return;
    }

    resultsContainer.safeInnerHTML = html`${results.map((channel) => {
            const activeClass = channel.playlistPath === activePlaylistPath ? " is-active" : "";
            const logo = channel.logoUrl
                ? html`<img src="${channel.logoUrl}" alt="">`
                : html`${initials(channel.name)}`;

            return html`
                <button class="result${activeClass}" type="button" data-playlist="${channel.playlistPath}" data-name="${channel.name}">
                    <div class="logo">${logo}</div>
                    <div>
                        <div class="name">${channel.name}</div>
                        <div class="meta">${channel.group}</div>
                    </div>
                </button>
            `;
        })}`;

    for (const button of resultsContainer.querySelectorAll<HTMLButtonElement>(".result")) {
        button.addEventListener("click", () => {
            const playlistPath = button.getAttribute("data-playlist");
            const name = button.getAttribute("data-name");
            if (!playlistPath || !name) {
                return;
            }

            setStatus("Switching active stream...");
            setNowPlaying(`Starting ${name}. This will replace the current active provider stream.`);
            activePlaylistPath = playlistPath;
            activeChannelName = name;
            history.replaceState({}, "", `/?play=${encodeURIComponent(playlistPath)}`);
            renderResults(results);
            void loadStream(playlistPath, name);
        });
    }
}

async function searchChannels(query: string): Promise<void> {
    if (query.trim().length < config.searchMinLength) {
        resultsContainer.safeInnerHTML = html`<div class="hint">Start typing to search the live channel list.</div>`;
        setStatus("No stream selected yet.");
        return;
    }

    setStatus("Searching...");

    const response = await fetch(`/api/channels?q=${encodeURIComponent(query)}`, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`Search failed with ${response.status}`);
    }

    const payload = (await response.json()) as ChannelsResponse;
    renderResults(payload.channels || []);
    setStatus(`Showing ${payload.channels?.length || 0} results.`);
}

async function updateQuality(nextQuality: string): Promise<QualityResponse> {
    const response = await fetch("/api/settings/quality", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ quality: nextQuality }),
    });

    if (!response.ok) {
        throw new Error(`Quality update failed with ${response.status}`);
    }

    const payload = (await response.json()) as QualityResponse;
    currentQuality = payload.quality;
    qualitySelect.value = payload.quality;
    updateQualityStatus();
    return payload;
}

async function lookupChannelName(playlistPath: string): Promise<string> {
    const response = await fetch(`/api/channel?playlistPath=${encodeURIComponent(playlistPath)}`, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`Channel lookup failed with ${response.status}`);
    }

    const payload = (await response.json()) as ChannelLookupResponse;
    return payload.name || playlistPath;
}

function destroyPlayer(): void {
    stopStreamStatusPolling();
    if (hls) {
        hls.destroy();
        hls = null;
    }

    video.removeAttribute("src");
    video.load();
}

async function loadStream(playlistPath: string, name: string): Promise<void> {
    destroyPlayer();
    startStreamStatusPolling(playlistPath);

    if (window.Hls?.isSupported()) {
        const hlsInstance = new window.Hls({
            lowLatencyMode: false,
            liveSyncDurationCount: 3,
        });
        hls = hlsInstance;

        hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
            stopStreamStatusPolling();
            hideStreamDebug();
            setStatus("Playback ready.");
            setNowPlaying(`Now playing: ${name}`);
            void video.play().catch(() => {
                setStatus("Playback ready. Press play if autoplay is blocked.");
            });
        });

        hlsInstance.on(window.Hls.Events.ERROR, (_event, data) => {
            setStatus(`Playback issue: ${data?.details ?? "unknown"}`);
        });

        hlsInstance.loadSource(playlistPath);
        hlsInstance.attachMedia(video);
        return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = playlistPath;
        video.addEventListener(
            "loadedmetadata",
            () => {
                stopStreamStatusPolling();
                hideStreamDebug();
                setStatus("Playback ready.");
                setNowPlaying(`Now playing: ${name}`);
                void video.play().catch(() => {
                    setStatus("Playback ready. Press play if autoplay is blocked.");
                });
            },
            { once: true },
        );
        return;
    }

    setStatus("This browser does not support HLS playback.");
}

searchInput.addEventListener("input", () => {
    const query = searchInput.value;
    persistSearchTerm(query);
    if (searchTimer) {
        clearTimeout(searchTimer);
    }

    searchTimer = setTimeout(() => {
        void searchChannels(query).catch((error: unknown) => {
            setStatus(error instanceof Error ? error.message : "Search failed.");
        });
    }, 180);
});

qualitySelect.addEventListener("change", () => {
    const nextQuality = qualitySelect.value;
    setStatus("Updating bandwidth and restarting the active stream...");
    void updateQuality(nextQuality)
        .then((payload) => {
            setStatus(`Bandwidth set to ${payload.label}.`);
            if (activePlaylistPath) {
                setNowPlaying(`Restarting current stream at ${payload.label}...`);
                return loadStream(activePlaylistPath, activeChannelName || activePlaylistPath);
            }
        })
        .catch((error: unknown) => {
            qualitySelect.value = currentQuality;
            updateQualityStatus();
            setStatus(error instanceof Error ? error.message : "Quality update failed.");
        });
});

copyPlaylistButton.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(playlistUrlInput.value);
        if (copyButtonResetTimer) {
            clearTimeout(copyButtonResetTimer);
        }

        copyPlaylistButton.textContent = "✓ Copied";
        copyButtonResetTimer = setTimeout(() => {
            copyPlaylistButton.textContent = "Copy";
            copyButtonResetTimer = null;
        }, 3000);
    }
    catch {
        playlistUrlInput.focus();
        playlistUrlInput.select();
        setPlaylistStatus("Clipboard access failed. The URL is selected so you can copy it manually.");
    }
});

const initialPlaylistPath = new URL(window.location.href).searchParams.get("play");
const storedSearchTerm = loadStoredSearchTerm();

if (storedSearchTerm.length > 0) {
    searchInput.value = storedSearchTerm;
    void searchChannels(storedSearchTerm).catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : "Search failed.");
    });
}

if (initialPlaylistPath) {
    activePlaylistPath = initialPlaylistPath;
    setStatus("Deep link loaded. Search to reveal the channel card.");
    void lookupChannelName(initialPlaylistPath)
        .then((name) => {
            activeChannelName = name;
            setNowPlaying(`Preparing ${name}...`);
            return loadStream(initialPlaylistPath, name);
        })
        .catch((error: unknown) => {
            setStatus(error instanceof Error ? error.message : "Failed to load channel.");
        });
}
else if (storedSearchTerm.length === 0) {
    resultsContainer.safeInnerHTML = html`<div class="hint">Start typing to search the live channel list.</div>`;
}

updatePlaylistUrl();
updateQualityStatus();

export {};
