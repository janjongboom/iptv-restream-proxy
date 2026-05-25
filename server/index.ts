import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type Channel = {
    extInfLine: string;
    id: string;
    group: string;
    logoUrl: string | null;
    name: string;
    playlistPath: string;
    sourceUrl: string;
    streamKey: string;
};

type ChannelSearchResult = Pick<Channel, "group" | "id" | "logoUrl" | "name" | "playlistPath">;
type CliOptions = {
    basicAuth: {
        password: string;
        username: string;
    } | null;
    m3uFile: string;
    port: number;
};
type QualityKey = "adaptive" | "512kbps" | "1mbps" | "2mbps" | "4mbps";
type QualitySettings = {
    audioBitrate: string;
    bufferSize: string | null;
    label: string;
    maxRate: string | null;
    mode: "adaptive" | "capped";
    videoBitrate: string | null;
};
type PersistedSettings = {
    quality: QualityKey;
};
type ClientBootstrapConfig = {
    basicAuth: {
        password: string;
        username: string;
    } | null;
    currentQuality: QualityKey;
    searchLimit: number;
    searchMinLength: number;
};

const DEFAULT_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const OUTPUT_DIR = path.resolve(".hls");
const PLAYLIST_NAME = "stream.m3u8";
const PLAYLIST_PATH = path.join(OUTPUT_DIR, PLAYLIST_NAME);
const SEGMENT_PATTERN = "segment-%05d.ts";
const SEGMENTS_PREFIX = "/segments/";
const SETTINGS_PATH = path.resolve(".iptv-proxy-settings.json");
const HLS_JS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vendor/hls.min.js");
const INDEX_HTML_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.html");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEGMENT_DURATION_SECONDS = 4;
const PLAYLIST_SIZE = 12;
const DELETE_THRESHOLD = 4;
const RESTART_DELAY_MS = 3000;
const PLAYLIST_WAIT_TIMEOUT_MS = 15000;
const PLAYLIST_WAIT_INTERVAL_MS = 250;
const SEARCH_MIN_LENGTH = 2;
const SEARCH_LIMIT = 40;
const STREAM_IDLE_TIMEOUT_MS = 20000;
const DECODE_ERROR_RESTART_THRESHOLD = 6;
const DECODE_ERROR_WINDOW_MS = 8000;
const STREAM_STATUS_MESSAGE_LIMIT = 12;
const DEFAULT_QUALITY: QualityKey = "2mbps";
const QUALITY_OPTIONS: Record<QualityKey, QualitySettings> = {
    adaptive: {
        audioBitrate: "128k",
        bufferSize: null,
        label: "Adaptive",
        maxRate: "8000k",
        mode: "adaptive",
        videoBitrate: null,
    },
    "512kbps": {
        audioBitrate: "96k",
        bufferSize: "1024k",
        label: "512 kbps",
        maxRate: "512k",
        mode: "capped",
        videoBitrate: "416k",
    },
    "1mbps": {
        audioBitrate: "128k",
        bufferSize: "2000k",
        label: "1 Mbps",
        maxRate: "1000k",
        mode: "capped",
        videoBitrate: "872k",
    },
    "2mbps": {
        audioBitrate: "128k",
        bufferSize: "4200k",
        label: "2 Mbps",
        maxRate: "2100k",
        mode: "capped",
        videoBitrate: "1800k",
    },
    "4mbps": {
        audioBitrate: "192k",
        bufferSize: "8200k",
        label: "4 Mbps",
        maxRate: "4100k",
        mode: "capped",
        videoBitrate: "3900k",
    },
};

let ffmpegProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
let activeChannel: Channel | null = null;
let pendingRestartChannelId: string | null = null;
let lastFfmpegError: string | null = null;
let recentFfmpegMessages: string[] = [];
let activationQueue: Promise<{ channelChanged: boolean }> = Promise.resolve({ channelChanged: false });
let idleStopTimer: NodeJS.Timeout | null = null;
let lastStreamActivityAt = 0;
let currentQuality: QualityKey = await loadPersistedQuality();
let decodeErrorCount = 0;
let decodeErrorWindowStartedAt = 0;
let decodeErrorRestartScheduled = false;
const transpiledModuleCache = new Map<string, { mtimeMs: number; source: string }>();
const intentionallyStopping = new WeakSet<ChildProcessByStdio<null, Readable, Readable>>();
const cliOptions = await parseCliArgs(process.argv.slice(2));

const channels = await loadChannels(cliOptions.m3uFile);

async function parseCliArgs(args: string[]): Promise<CliOptions> {
    let m3uFile: string | null = null;
    let port = DEFAULT_PORT;
    let username: string | null = null;
    let password: string | null = null;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--port") {
            const value = args[i + 1];
            if (!value) {
                throw new Error("Missing value for --port");
            }

            port = parsePort(value);
            i += 1;
            continue;
        }

        if (arg.startsWith("--port=")) {
            port = parsePort(arg.slice("--port=".length));
            continue;
        }

        if (arg === "--username") {
            const value = args[i + 1];
            if (!value) {
                throw new Error("Missing value for --username");
            }

            username = value;
            i += 1;
            continue;
        }

        if (arg.startsWith("--username=")) {
            username = arg.slice("--username=".length);
            continue;
        }

        if (arg === "--password") {
            const value = args[i + 1];
            if (!value) {
                throw new Error("Missing value for --password");
            }

            password = value;
            i += 1;
            continue;
        }

        if (arg.startsWith("--password=")) {
            password = arg.slice("--password=".length);
            continue;
        }

        if (arg === "--m3u-file" || arg === "--m3u-path") {
            const value = args[i + 1];
            if (!value) {
                throw new Error(`Missing value for ${arg}`);
            }

            m3uFile = path.resolve(value);
            i += 1;
            continue;
        }

        if (arg.startsWith("--m3u-file=")) {
            m3uFile = path.resolve(arg.slice("--m3u-file=".length));
            continue;
        }

        if (arg.startsWith("--m3u-path=")) {
            m3uFile = path.resolve(arg.slice("--m3u-path=".length));
            continue;
        }

    }

    if (!m3uFile) {
        m3uFile = await resolveImplicitM3uFile();
    }

    if ((username === null) !== (password === null)) {
        throw new Error("Provide both --username and --password, or neither.");
    }

    if (username === "XXX" || password === "YYY") {
        throw new Error('Refusing placeholder credentials. Choose a real --username/--password instead of "XXX"/"YYY".');
    }

    return {
        basicAuth: username && password ? { password, username } : null,
        m3uFile,
        port,
    };
}

async function resolveImplicitM3uFile(): Promise<string> {
    const entries = await readdir(REPO_ROOT, { withFileTypes: true });
    const m3uFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".m3u"))
        .map((entry) => path.join(REPO_ROOT, entry.name))
        .sort();

    if (m3uFiles.length === 1) {
        return m3uFiles[0];
    }

    if (m3uFiles.length === 0) {
        throw new Error(`No .m3u files found in ${REPO_ROOT}. Pass --m3u-path <file>.`);
    }

    throw new Error(
        `Found multiple .m3u files in ${REPO_ROOT}: ${m3uFiles.map((filePath) => path.basename(filePath)).join(", ")}. Pass --m3u-path <file>.`,
    );
}

function parsePort(value: string): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --port value: ${value}`);
    }

    return port;
}

async function loadChannels(m3uFile: string): Promise<Map<string, Channel>> {
    const fileContents = await readFile(m3uFile, "utf8");
    const lines = fileContents.split(/\r?\n/);
    const catalog = new Map<string, Channel>();

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]?.trim();
        if (!line || !line.startsWith("#EXTINF:")) {
            continue;
        }

        const sourceUrl = lines[i + 1]?.trim();
        if (!sourceUrl || (!sourceUrl.startsWith("http://") && !sourceUrl.startsWith("https://"))) {
            continue;
        }

        if (sourceUrl.toLowerCase().endsWith(".mkv")) {
            continue;
        }

        const parsed = parseChannel(line, sourceUrl);
        if (!parsed) {
            continue;
        }

        catalog.set(parsed.streamKey, parsed);
    }

    return catalog;
}

async function loadPersistedQuality(): Promise<QualityKey> {
    try {
        const contents = await readFile(SETTINGS_PATH, "utf8");
        const parsed = JSON.parse(contents) as Partial<PersistedSettings>;
        if (parsed.quality && parsed.quality in QUALITY_OPTIONS) {
            return parsed.quality;
        }
    }
    catch {
        return DEFAULT_QUALITY;
    }

    return DEFAULT_QUALITY;
}

async function persistQuality(quality: QualityKey): Promise<void> {
    const payload: PersistedSettings = { quality };
    await writeFile(SETTINGS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseChannel(extInfLine: string, sourceUrl: string): Channel | null {
    let url: URL;
    try {
        url = new URL(sourceUrl);
    }
    catch {
        return null;
    }

    const streamKey = sourceUrl;
    const playlistPath = `/play.m3u8?src=${encodeSourceUrl(sourceUrl)}`;
    const metadata = parseExtInfAttributes(extInfLine);
    const nameFromLine = extInfLine.split(",").slice(1).join(",").trim();
    const fallbackName = url.pathname.split("/").filter(Boolean).at(-1) || url.hostname;
    const name = metadata["tvg-name"] || nameFromLine || fallbackName;
    const group = metadata["group-title"] || "Ungrouped";
    const logoUrl = metadata["tvg-logo"] || null;

    return {
        extInfLine,
        id: streamKey,
        group,
        logoUrl,
        name,
        playlistPath,
        sourceUrl,
        streamKey,
    };
}

function parseExtInfAttributes(extInfLine: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const matches = extInfLine.matchAll(/([\w-]+)="([^"]*)"/g);

    for (const match of matches) {
        attributes[match[1]] = match[2];
    }

    return attributes;
}

function encodeSourceUrl(sourceUrl: string): string {
    return encodeURIComponent(sourceUrl);
}

function decodeSourceUrl(encodedSourceUrl: string): string | null {
    try {
        const sourceUrl = decodeURIComponent(encodedSourceUrl);
        const parsed = new URL(sourceUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }

        return sourceUrl;
    }
    catch {
        return null;
    }
}

function getCurrentQualitySettings(): QualitySettings {
    return QUALITY_OPTIONS[currentQuality];
}

function getQualityChoices(): Array<{ key: QualityKey; label: string }> {
    return Object.entries(QUALITY_OPTIONS).map(([key, settings]) => ({
        key: key as QualityKey,
        label: settings.label,
    }));
}

async function prepareOutputDirectory(): Promise<void> {
    await rm(OUTPUT_DIR, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });
}

async function cleanupOldSegments(): Promise<void> {
    const files = await readdir(OUTPUT_DIR);
    await Promise.all(
        files
            .filter((file) => file.endsWith(".m3u8") || file.endsWith(".ts"))
            .map((file) => rm(path.join(OUTPUT_DIR, file), { force: true })),
    );
}

async function hasPlaylist(): Promise<boolean> {
    try {
        await access(PLAYLIST_PATH);
        return true;
    }
    catch {
        return false;
    }
}

async function getHlsJsSource(): Promise<string> {
    return readFile(HLS_JS_PATH, "utf8");
}

function resolveTranspiledModulePath(requestPathname: string): string | null {
    if (!requestPathname.endsWith(".js")) {
        return null;
    }

    if (!requestPathname.startsWith("/client/") && !requestPathname.startsWith("/shared/")) {
        return null;
    }

    const relativeRequestPath = requestPathname.slice(1);
    const candidatePath = path.resolve(REPO_ROOT, relativeRequestPath).replace(/\.js$/, ".ts");
    const relativeCandidatePath = path.relative(REPO_ROOT, candidatePath);
    if (relativeCandidatePath.startsWith("..") || path.isAbsolute(relativeCandidatePath)) {
        return null;
    }

    return candidatePath;
}

async function getTranspiledModuleSource(filePath: string): Promise<string> {
    const fileStats = await stat(filePath);
    const cachedModule = transpiledModuleCache.get(filePath);
    if (cachedModule && cachedModule.mtimeMs === fileStats.mtimeMs) {
        return cachedModule.source;
    }

    const source = await readFile(filePath, "utf8");
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            lib: ["DOM", "ES2022"],
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: path.relative(REPO_ROOT, filePath),
    });

    transpiledModuleCache.set(filePath, {
        mtimeMs: fileStats.mtimeMs,
        source: transpiled.outputText,
    });

    return transpiled.outputText;
}

function buildClientBootstrapConfig(): ClientBootstrapConfig {
    return {
        basicAuth: cliOptions.basicAuth,
        currentQuality,
        searchLimit: SEARCH_LIMIT,
        searchMinLength: SEARCH_MIN_LENGTH,
    };
}

function escapeJsonForHtml(value: unknown): string {
    return JSON.stringify(value).replaceAll("<", "\\u003c");
}

async function getIndexPageSource(): Promise<string> {
    const qualityOptionsMarkup = getQualityChoices()
        .map(({ key, label }) => {
            const selected = key === currentQuality ? " selected" : "";
            return `<option value="${key}"${selected}>${label}</option>`;
        })
        .join("");
    const template = await readFile(INDEX_HTML_PATH, "utf8");
    return template
        .replace("__QUALITY_OPTIONS__", qualityOptionsMarkup)
        .replaceAll("__SEARCH_MIN_LENGTH__", String(SEARCH_MIN_LENGTH))
        .replaceAll("__SEARCH_LIMIT__", String(SEARCH_LIMIT))
        .replace("__APP_CONFIG__", escapeJsonForHtml(buildClientBootstrapConfig()));
}

function sendText(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
    response.writeHead(statusCode, {
        "Cache-Control": "no-store",
        "Content-Type": contentType,
    });
    response.end(body);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    sendText(response, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
}

async function serveFile(response: ServerResponse, filePath: string, contentType: string): Promise<void> {
    try {
        const contents = await readFile(filePath);
        response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Type": contentType,
        });
        response.end(contents);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        sendText(response, 404, `Not found: ${message}`, "text/plain; charset=utf-8");
    }
}

function sanitizeSegmentName(segmentName: string): string | null {
    if (!/^segment-\d{5}\.ts$/.test(segmentName)) {
        return null;
    }

    return segmentName;
}

function normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildPublicBaseUrl(requestUrl: URL): string {
    const publicUrl = new URL(requestUrl.origin);
    if (cliOptions.basicAuth) {
        publicUrl.username = cliOptions.basicAuth.username;
        publicUrl.password = cliOptions.basicAuth.password;
    }

    return publicUrl.toString().replace(/\/$/, "");
}

function readBasicAuthCredentials(request: IncomingMessage): { password: string; username: string } | null {
    const authorizationHeader = request.headers.authorization;
    if (!authorizationHeader?.startsWith("Basic ")) {
        return null;
    }

    try {
        const decoded = Buffer.from(authorizationHeader.slice("Basic ".length), "base64").toString("utf8");
        const separatorIndex = decoded.indexOf(":");
        if (separatorIndex === -1) {
            return null;
        }

        return {
            password: decoded.slice(separatorIndex + 1),
            username: decoded.slice(0, separatorIndex),
        };
    }
    catch {
        return null;
    }
}

function isAuthorized(request: IncomingMessage): boolean {
    if (!cliOptions.basicAuth) {
        return true;
    }

    const credentials = readBasicAuthCredentials(request);
    return credentials?.username === cliOptions.basicAuth.username && credentials.password === cliOptions.basicAuth.password;
}

function requestBasicAuth(response: ServerResponse): void {
    response.writeHead(401, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="IPTV Proxy"',
    });
    response.end("Authentication required.");
}

function buildQualityVariantName(name: string, quality: QualityKey): string {
    return `${name} ${quality}`;
}

function buildQualityVariantExtInf(channel: Channel, quality: QualityKey): string {
    const qualityName = buildQualityVariantName(channel.name, quality);
    let line = channel.extInfLine.replace(/,([^,]*)$/, `,${qualityName}`);

    if (/tvg-name="[^"]*"/.test(line)) {
        line = line.replace(/tvg-name="[^"]*"/, `tvg-name="${qualityName}"`);
    }

    return line;
}

function buildRehostedM3u(requestUrl: URL): string {
    const baseUrl = buildPublicBaseUrl(requestUrl);
    const lines = ["#EXTM3U"];

    for (const channel of channels.values()) {
        for (const { key } of getQualityChoices()) {
            lines.push(buildQualityVariantExtInf(channel, key));
            lines.push(`${baseUrl}${channel.playlistPath}&quality=${encodeURIComponent(key)}`);
        }
    }

    return `${lines.join("\n")}\n`;
}

function clearIdleStopTimer(): void {
    if (!idleStopTimer) {
        return;
    }

    clearTimeout(idleStopTimer);
    idleStopTimer = null;
}

function scheduleIdleStop(channelId: string): void {
    clearIdleStopTimer();

    idleStopTimer = setTimeout(() => {
        if (shuttingDown || activeChannel?.id !== channelId || !ffmpegProcess) {
            return;
        }

        const idleForMs = Date.now() - lastStreamActivityAt;
        if (idleForMs < STREAM_IDLE_TIMEOUT_MS) {
            scheduleIdleStop(channelId);
            return;
        }

        console.log(`Stopping idle stream after ${Math.round(idleForMs / 1000)}s with no clients: ${activeChannel.name}`);
        pendingRestartChannelId = null;

        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }

        void stopFfmpeg()
            .then(() => cleanupOldSegments())
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : "Unknown error";
                console.error(`Failed to stop idle stream cleanly: ${message}`);
            });
    }, STREAM_IDLE_TIMEOUT_MS);

    idleStopTimer.unref();
}

function noteStreamActivity(channelId: string): void {
    if (activeChannel?.id !== channelId) {
        return;
    }

    lastStreamActivityAt = Date.now();
    scheduleIdleStop(channelId);
}

function searchChannels(query: string): ChannelSearchResult[] {
    const normalized = normalizeSearchText(query);
    if (normalized.length < SEARCH_MIN_LENGTH) {
        return [];
    }

    const terms = normalized.split(" ").filter(Boolean);
    const matches: ChannelSearchResult[] = [];
    for (const channel of channels.values()) {
        const haystack = normalizeSearchText(`${channel.name} ${channel.group} ${channel.sourceUrl}`);
        const isMatch = terms.every((term) => haystack.includes(term));

        if (isMatch) {
            matches.push({
                group: channel.group,
                id: channel.id,
                logoUrl: channel.logoUrl,
                name: channel.name,
                playlistPath: channel.playlistPath,
            });
        }

        if (matches.length >= SEARCH_LIMIT) {
            break;
        }
    }

    return matches;
}

function getChannelFromRequestUrl(requestUrl: URL): Channel | null {
    if (requestUrl.pathname !== "/play.m3u8") {
        return null;
    }

    const encodedSourceUrl = requestUrl.searchParams.get("src");
    if (!encodedSourceUrl) {
        return null;
    }

    const sourceUrl = decodeSourceUrl(encodedSourceUrl);
    if (!sourceUrl) {
        return null;
    }

    return channels.get(sourceUrl) ?? null;
}

function getRequestedQuality(requestUrl: URL): QualityKey | null {
    const quality = requestUrl.searchParams.get("quality");
    if (!quality) {
        return null;
    }

    if (quality in QUALITY_OPTIONS) {
        return quality as QualityKey;
    }

    return null;
}

function logFfmpegOutput(prefix: string, chunk: Buffer): void {
    const text = chunk.toString("utf8").trim();
    if (text.length > 0) {
        console.log(`[${prefix}] ${text}`);
    }
}

function noteFfmpegStatusMessage(text: string): void {
    if (!text) {
        return;
    }

    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    for (const line of lines) {
        recentFfmpegMessages.push(line);
    }

    if (recentFfmpegMessages.length > STREAM_STATUS_MESSAGE_LIMIT) {
        recentFfmpegMessages = recentFfmpegMessages.slice(-STREAM_STATUS_MESSAGE_LIMIT);
    }
}

function isDecoderCorruptionLogLine(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
        normalized.includes("decode error rate") ||
        normalized.includes("corrupt decoded frame") ||
        normalized.includes("invalid data found when processing input") ||
        normalized.includes("mmco: unref short failure") ||
        normalized.includes("number of reference frames") ||
        normalized.includes("non-existing pps") ||
        normalized.includes("non-existing sps")
    );
}

function resetDecodeErrorTracking(): void {
    decodeErrorCount = 0;
    decodeErrorWindowStartedAt = 0;
    decodeErrorRestartScheduled = false;
}

function scheduleDecoderRecovery(channel: Channel): void {
    if (decodeErrorRestartScheduled || activeChannel?.id !== channel.id || shuttingDown) {
        return;
    }

    decodeErrorRestartScheduled = true;
    console.warn(`Decoder corruption threshold reached for ${channel.name}; restarting transcoder to recover.`);

    void activateChannel(channel, { allowReuse: false, isRestart: true }).finally(() => {
        resetDecodeErrorTracking();
    });
}

function noteDecoderCorruption(channel: Channel, text: string): void {
    if (activeChannel?.id !== channel.id || !isDecoderCorruptionLogLine(text)) {
        return;
    }

    const now = Date.now();
    if (decodeErrorWindowStartedAt === 0 || now - decodeErrorWindowStartedAt > DECODE_ERROR_WINDOW_MS) {
        decodeErrorWindowStartedAt = now;
        decodeErrorCount = 0;
    }

    decodeErrorCount += 1;

    if (decodeErrorCount >= DECODE_ERROR_RESTART_THRESHOLD) {
        scheduleDecoderRecovery(channel);
    }
}

function scheduleRestart(channel: Channel): void {
    if (shuttingDown || restartTimer || activeChannel?.id !== channel.id) {
        return;
    }

    pendingRestartChannelId = channel.id;
    restartTimer = setTimeout(() => {
        restartTimer = null;
        const nextChannel = pendingRestartChannelId ? channels.get(pendingRestartChannelId) ?? null : null;
        pendingRestartChannelId = null;
        if (!nextChannel) {
            return;
        }

        void activateChannel(nextChannel, { allowReuse: true, isRestart: true });
    }, RESTART_DELAY_MS);
}

async function stopFfmpeg(): Promise<void> {
    if (!ffmpegProcess) {
        return;
    }

    const currentProcess = ffmpegProcess;
    ffmpegProcess = null;
    intentionallyStopping.add(currentProcess);

    await new Promise<void>((resolve) => {
        let finished = false;

        const finish = () => {
            if (finished) {
                return;
            }

            finished = true;
            resolve();
        };

        currentProcess.once("exit", finish);
        currentProcess.kill("SIGTERM");

        setTimeout(() => {
            if (finished) {
                return;
            }

            currentProcess.kill("SIGKILL");
            finish();
        }, 5000).unref();
    });
}

async function startFfmpeg(channel: Channel): Promise<void> {
    resetDecodeErrorTracking();
    recentFfmpegMessages = [];
    const qualitySettings = getCurrentQualitySettings();
    const videoArgs =
        qualitySettings.mode === "adaptive"
            ? [
                  "-crf",
                  "23",
                  "-maxrate",
                  qualitySettings.maxRate ?? "8000k",
                  "-bufsize",
                  qualitySettings.bufferSize ?? "16000k",
              ]
            : [
                  "-b:v",
                  qualitySettings.videoBitrate ?? "1800k",
                  "-maxrate",
                  qualitySettings.maxRate ?? "2100k",
                  "-bufsize",
                  qualitySettings.bufferSize ?? "4200k",
              ];

    const args = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-max_error_rate",
        "1",
        "-fflags",
        "+discardcorrupt",
        "-err_detect",
        "ignore_err",
        "-probesize",
        "10000000",
        "-analyzeduration",
        "10000000",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-i",
        channel.sourceUrl,
        "-ignore_unknown",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        ...videoArgs,
        "-pix_fmt",
        "yuv420p",
        "-g",
        "48",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        qualitySettings.audioBitrate,
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "hls",
        "-hls_time",
        String(SEGMENT_DURATION_SECONDS),
        "-hls_list_size",
        String(PLAYLIST_SIZE),
        "-hls_delete_threshold",
        String(DELETE_THRESHOLD),
        "-hls_flags",
        "delete_segments+independent_segments",
        "-hls_base_url",
        SEGMENTS_PREFIX,
        "-hls_segment_filename",
        path.join(OUTPUT_DIR, SEGMENT_PATTERN),
        PLAYLIST_PATH,
    ];

    const child = spawn("ffmpeg", args, {
        stdio: ["ignore", "pipe", "pipe"],
    });

    ffmpegProcess = child;
    lastFfmpegError = null;

    child.stdout.on("data", (chunk: Buffer) => {
        logFfmpegOutput("ffmpeg", chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        lastFfmpegError = text || lastFfmpegError;
        noteFfmpegStatusMessage(text);
        noteDecoderCorruption(channel, text);
        logFfmpegOutput("ffmpeg", chunk);
    });

    child.on("error", (error) => {
        lastFfmpegError = error.message;
        noteFfmpegStatusMessage(error.message);
        console.error(`Failed to start ffmpeg for ${channel.name}: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
        const wasIntentionalStop = intentionallyStopping.has(child);
        intentionallyStopping.delete(child);
        const exitedActiveChannel = activeChannel?.id === channel.id;
        console.error(`ffmpeg exited for ${channel.name} with code=${code ?? "null"} signal=${signal ?? "null"}`);
        if (ffmpegProcess === child) {
            ffmpegProcess = null;
        }

        if (shuttingDown || wasIntentionalStop || !exitedActiveChannel) {
            return;
        }

        scheduleRestart(channel);
    });
}

async function waitForPlaylist(channelId: string): Promise<boolean> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < PLAYLIST_WAIT_TIMEOUT_MS) {
        if (activeChannel?.id !== channelId) {
            return false;
        }

        if (await hasPlaylist()) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, PLAYLIST_WAIT_INTERVAL_MS));
    }

    return false;
}

async function activateChannel(
    channel: Channel,
    options: { allowReuse: boolean; isRestart?: boolean },
): Promise<{ channelChanged: boolean }> {
    activationQueue = activationQueue.then(async () => {
        if (shuttingDown) {
            return { channelChanged: false };
        }

        const sameChannel = activeChannel?.id === channel.id;
        if (sameChannel && ffmpegProcess && options.allowReuse) {
            return { channelChanged: false };
        }

        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }

        clearIdleStopTimer();

        pendingRestartChannelId = null;

        await stopFfmpeg();
        await cleanupOldSegments();

        activeChannel = channel;
        lastFfmpegError = null;
        recentFfmpegMessages = [];
        lastStreamActivityAt = Date.now();
        resetDecodeErrorTracking();

        console.log(
            options.isRestart
                ? `Restarting active stream: ${channel.name}`
                : `Activating stream: ${channel.name} (${channel.playlistPath})`,
        );

        await startFfmpeg(channel);
        scheduleIdleStop(channel.id);
        return { channelChanged: !sameChannel };
    });

    return activationQueue;
}

async function handleIndexRequest(response: ServerResponse): Promise<void> {
    sendText(response, 200, await getIndexPageSource(), "text/html; charset=utf-8");
}

async function handleChannelsApi(requestUrl: URL, response: ServerResponse): Promise<void> {
    const query = requestUrl.searchParams.get("q") ?? "";
    sendJson(response, 200, {
        channels: searchChannels(query),
        query,
    });
}

async function handleChannelLookupApi(requestUrl: URL, response: ServerResponse): Promise<void> {
    const playlistPath = requestUrl.searchParams.get("playlistPath");
    if (!playlistPath) {
        sendText(response, 400, "Missing playlistPath.", "text/plain; charset=utf-8");
        return;
    }

    const playlistUrl = new URL(playlistPath, "http://localhost");
    const channel = getChannelFromRequestUrl(playlistUrl);
    if (!channel) {
        sendText(response, 404, "Channel not found.", "text/plain; charset=utf-8");
        return;
    }

    sendJson(response, 200, {
        group: channel.group,
        id: channel.id,
        logoUrl: channel.logoUrl,
        name: channel.name,
        playlistPath: channel.playlistPath,
    });
}

async function handleStreamStatusApi(requestUrl: URL, response: ServerResponse): Promise<void> {
    const playlistPath = requestUrl.searchParams.get("playlistPath");
    const playlistUrl = playlistPath ? new URL(playlistPath, "http://localhost") : null;
    const channel = playlistUrl ? getChannelFromRequestUrl(playlistUrl) : null;
    const isActiveChannel = channel ? activeChannel?.id === channel.id : false;

    sendJson(response, 200, {
        active: isActiveChannel,
        messages: recentFfmpegMessages,
        ready: isActiveChannel ? await hasPlaylist() : false,
    });
}

function buildQualityPayload() {
    const settings = getCurrentQualitySettings();
    return {
        choices: getQualityChoices(),
        label: settings.label,
        quality: currentQuality,
    };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        if (typeof chunk === "string") {
            chunks.push(Buffer.from(chunk));
            continue;
        }

        if (chunk instanceof Uint8Array) {
            chunks.push(Buffer.from(chunk));
            continue;
        }

        throw new TypeError("Unexpected request chunk type.");
    }

    const body = Buffer.concat(chunks).toString("utf8").trim();
    if (body.length === 0) {
        return {};
    }

    return JSON.parse(body);
}

async function restartActiveChannelForQualityChange(): Promise<void> {
    if (!activeChannel) {
        return;
    }

    await activateChannel(activeChannel, { allowReuse: false });
}

async function setCurrentQuality(nextQuality: QualityKey): Promise<void> {
    if (nextQuality === currentQuality) {
        return;
    }

    currentQuality = nextQuality;
    await persistQuality(currentQuality);
}

async function handleSettingsRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET") {
        sendJson(response, 200, buildQualityPayload());
        return;
    }

    if (request.method !== "POST") {
        sendText(response, 405, "Method not allowed.", "text/plain; charset=utf-8");
        return;
    }

    const payload = await readJsonBody(request);
    const nextQuality = (payload as { quality?: string }).quality;
    if (!nextQuality || !(nextQuality in QUALITY_OPTIONS)) {
        sendText(response, 400, "Invalid quality value.", "text/plain; charset=utf-8");
        return;
    }

    if (nextQuality === currentQuality) {
        sendJson(response, 200, buildQualityPayload());
        return;
    }

    await setCurrentQuality(nextQuality as QualityKey);
    await restartActiveChannelForQualityChange();
    sendJson(response, 200, buildQualityPayload());
}

async function handleRehostedM3u(requestUrl: URL, response: ServerResponse): Promise<void> {
    sendText(response, 200, buildRehostedM3u(requestUrl), "application/x-mpegURL; charset=utf-8");
}

async function handlePlaylistRequest(channel: Channel, requestedQuality: QualityKey | null, response: ServerResponse): Promise<void> {
    const qualityChanged = requestedQuality !== null && requestedQuality !== currentQuality;
    if (requestedQuality) {
        await setCurrentQuality(requestedQuality);
    }

    await activateChannel(channel, { allowReuse: !qualityChanged });
    noteStreamActivity(channel.id);

    const ready = await waitForPlaylist(channel.id);
    if (!ready) {
        sendText(
            response,
            503,
            lastFfmpegError
                ? `Stream is not ready yet. ffmpeg reported: ${lastFfmpegError}`
                : "Stream is starting up, playlist not ready yet.",
            "text/plain; charset=utf-8",
        );
        return;
    }

    await serveFile(response, PLAYLIST_PATH, "application/vnd.apple.mpegurl");
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAuthorized(request)) {
        requestBasicAuth(response);
        return;
    }

    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = requestUrl.pathname;
    const requestedQuality = getRequestedQuality(requestUrl);

    if (pathname === "/") {
        await handleIndexRequest(response);
        return;
    }

    if (pathname === "/assets/hls.min.js") {
        try {
            const contents = await getHlsJsSource();
            sendText(response, 200, contents, "application/javascript; charset=utf-8");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            sendText(response, 500, `Bundled hls.js asset is missing.\n${message}`, "text/plain; charset=utf-8");
        }
        return;
    }

    const transpiledModulePath = resolveTranspiledModulePath(pathname);
    if (transpiledModulePath) {
        try {
            const contents = await getTranspiledModuleSource(transpiledModulePath);
            sendText(response, 200, contents, "application/javascript; charset=utf-8");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            sendText(response, 500, `Client script is unavailable.\n${message}`, "text/plain; charset=utf-8");
        }
        return;
    }

    if (pathname === "/api/channels") {
        await handleChannelsApi(requestUrl, response);
        return;
    }

    if (pathname === "/api/channel") {
        await handleChannelLookupApi(requestUrl, response);
        return;
    }

    if (pathname === "/api/stream-status") {
        await handleStreamStatusApi(requestUrl, response);
        return;
    }

    if (pathname === "/api/settings/quality") {
        await handleSettingsRequest(request, response);
        return;
    }

    if (pathname === "/playlist.m3u" || pathname === "/channels.m3u") {
        await handleRehostedM3u(requestUrl, response);
        return;
    }

    if (pathname.startsWith(SEGMENTS_PREFIX)) {
        if (activeChannel) {
            noteStreamActivity(activeChannel.id);
        }

        const segmentName = pathname.slice(SEGMENTS_PREFIX.length);
        const safeSegmentName = sanitizeSegmentName(segmentName);
        if (!safeSegmentName) {
            sendText(response, 400, "Invalid segment name.", "text/plain; charset=utf-8");
            return;
        }

        await serveFile(response, path.join(OUTPUT_DIR, safeSegmentName), "video/mp2t");
        return;
    }

    const channel = getChannelFromRequestUrl(requestUrl);
    if (channel) {
        if (requestUrl.searchParams.has("quality") && !requestedQuality) {
            sendText(response, 400, "Invalid quality value.", "text/plain; charset=utf-8");
            return;
        }

        await handlePlaylistRequest(channel, requestedQuality, response);
        return;
    }

    sendText(response, 404, "Not found.", "text/plain; charset=utf-8");
}

async function ensureHlsJsIsInstalled(): Promise<void> {
    try {
        const fileStats = await stat(HLS_JS_PATH);
        if (!fileStats.isFile()) {
            throw new Error("hls.js asset path is not a file.");
        }
    }
    catch {
        console.warn("Bundled hls.js is missing. Download vendor/hls.min.js before opening the player page.");
    }
}

async function main(): Promise<void> {
    await prepareOutputDirectory();
    await ensureHlsJsIsInstalled();

    const server = createServer((request, response) => {
        void handleRequest(request, response).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Unknown error";
            console.error(`Request failed: ${message}`);
            if (!response.headersSent) {
                sendText(response, 500, "Internal server error.", "text/plain; charset=utf-8");
            }
            else {
                response.end();
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
        };

        const onListening = () => {
            server.off("error", onError);
            console.log(`Listening on: 0.0.0.0:${cliOptions.port}`);
            console.log(`Index page: http://localhost:${cliOptions.port}/`);
            console.log(`Rehosted M3U: http://localhost:${cliOptions.port}/playlist.m3u`);
            console.log(`Source M3U file: ${cliOptions.m3uFile}`);
            console.log(`Startup quality: ${getCurrentQualitySettings().label}`);
            console.log(`Indexed live channels: ${channels.size}`);
            resolve();
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(cliOptions.port, "0.0.0.0");
    });

    const shutdown = async () => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;

        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }

        clearIdleStopTimer();

        console.log("Shutting down...");
        server.close();
        await stopFfmpeg();
        process.exit(0);
    };

    process.once("SIGINT", () => {
        void shutdown();
    });

    process.once("SIGTERM", () => {
        void shutdown();
    });
}

void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Startup failed: ${message}`);
    process.exit(1);
});
