/**
 * Directions SDP utiles au contrat WebRTC Bob Live.
 *
 * Ce module classe le sous-ensemble SDP émis ou accepté par Bob. Il ne prétend pas être un
 * parseur RFC 8866 général et ne réécrit jamais la description fournie.
 */
export type RealtimeSdpAudioDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';

interface RealtimeSdpMediaSection {
  readonly kind: string;
  readonly port: number;
  readonly protocol: string;
  readonly formats: readonly string[];
  readonly directions: RealtimeSdpAudioDirection[];
  bundleOnly: boolean;
}

const SDP_DIRECTIONS = new Set<RealtimeSdpAudioDirection>([
  'sendrecv',
  'sendonly',
  'recvonly',
  'inactive',
]);
const SDP_MEDIA_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`{|}~-]+$/u;
const SDP_PROTOCOL_TOKEN = /^[A-Za-z0-9+./_-]+$/u;
const SDP_FORMAT_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`{|}~-]+$/u;
const SDP_PORT = /^\d+$/u;
const MAX_SDP_CHARS = 256 * 1024;

function parsePort(token: string): number | null {
  if (!SDP_PORT.test(token)) return null;
  const port = Number(token);
  return Number.isSafeInteger(port)
    && port >= 0
    && port <= 65_535
    ? port
    : null;
}

function containsForbiddenControl(sdp: string): boolean {
  for (let index = 0; index < sdp.length; index += 1) {
    const code = sdp.charCodeAt(index);
    if (
      code <= 8
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127
    ) return true;
  }
  return false;
}

function isSctpDataChannel(section: RealtimeSdpMediaSection): boolean {
  const protocol = section.protocol.toLowerCase();
  if (protocol !== 'udp/dtls/sctp' && protocol !== 'dtls/sctp') return false;
  if (section.formats.length !== 1) return false;
  const format = section.formats[0]?.toLowerCase();
  if (format === 'webrtc-datachannel') return true;
  const legacyPort = format === undefined ? null : parsePort(format);
  return legacyPort !== null && legacyPort > 0;
}

function isWebRtcSecureAudio(section: RealtimeSdpMediaSection): boolean {
  if (section.protocol.toLowerCase() !== 'udp/tls/rtp/savpf') return false;
  if (section.formats.length === 0) return false;
  const payloadTypes = section.formats.map((format) => parsePort(format));
  return payloadTypes.every((payloadType) => payloadType !== null && payloadType <= 127)
    && new Set(payloadTypes).size === payloadTypes.length;
}

/**
 * Retourne la direction effective de l'unique m-line audio du profil WebRTC Bob Live.
 *
 * Le profil autorise les sections `application` du data channel et refuse toute topologie
 * ambiguë. L'absence d'attribut de direction vaut `sendrecv`; une direction média remplace la
 * direction de session. `null` signifie que le SDP ne satisfait pas le profil Bob.
 */
export function realtimeSdpSingleAudioDirection(
  sdp: string,
): RealtimeSdpAudioDirection | null {
  if (
    sdp.length < 3
    || sdp.length > MAX_SDP_CHARS
    || /\r(?!\n)/u.test(sdp)
    || containsForbiddenControl(sdp)
  ) return null;

  const lines = sdp.split(/\r?\n/u);
  if (lines[0]?.trim() !== 'v=0') return null;

  const sessionDirections: RealtimeSdpAudioDirection[] = [];
  const mediaSections: RealtimeSdpMediaSection[] = [];
  let currentSection: RealtimeSdpMediaSection | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.startsWith('m=')) {
      const parts = line.slice(2).split(/[ \t]+/u);
      const kind = parts[0];
      const portToken = parts[1];
      const protocol = parts[2];
      const formats = parts.slice(3);
      if (
        parts.length < 4
        || kind === undefined
        || !SDP_MEDIA_TOKEN.test(kind)
        || portToken === undefined
        || protocol === undefined
        || !SDP_PROTOCOL_TOKEN.test(protocol)
        || formats.some((format) => !SDP_FORMAT_TOKEN.test(format))
      ) return null;
      const port = parsePort(portToken);
      if (port === null) return null;
      currentSection = {
        kind: kind.toLowerCase(),
        port,
        protocol,
        formats,
        directions: [],
        bundleOnly: false,
      };
      mediaSections.push(currentSection);
      continue;
    }

    if (!line.startsWith('a=')) continue;
    const attribute = line.slice(2).trim().toLowerCase();
    if (attribute === 'bundle-only') {
      if (currentSection === null || currentSection.bundleOnly) return null;
      currentSection.bundleOnly = true;
      continue;
    }
    const looksLikeDirection = [...SDP_DIRECTIONS].some((direction) => (
      attribute.startsWith(direction)
    ));
    if (!looksLikeDirection) continue;
    if (!SDP_DIRECTIONS.has(attribute as RealtimeSdpAudioDirection)) return null;
    const direction = attribute as RealtimeSdpAudioDirection;
    if (currentSection === null) sessionDirections.push(direction);
    else currentSection.directions.push(direction);
  }

  if (sessionDirections.length > 1) return null;
  const audioSections = mediaSections.filter((section) => section.kind === 'audio');
  if (audioSections.length !== 1) return null;
  const audio = audioSections[0];
  if (
    audio === undefined
    || audio.port === 0
    || audio.bundleOnly
    || audio.directions.length > 1
    || !isWebRtcSecureAudio(audio)
  ) return null;

  for (const section of mediaSections) {
    if (section.directions.length > 1) return null;
    if (section.bundleOnly) return null;
    if (section.kind === 'audio') continue;
    if (section.kind === 'application') {
      // Les implémentations JSEP/Pion peuvent porter `a=sendrecv` sur la m-line SCTP du data
      // channel. Cet attribut ne décrit pas le flux RTP audio et ne doit donc pas contaminer sa
      // classification. Seules les formes SCTP réellement prévues pour un data channel sont
      // admises : `application` ne doit jamais servir de passe-droit à un second média RTP.
      if (section.port !== 0 && !isSctpDataChannel(section)) return null;
      continue;
    }
    if (section.port !== 0) return null;
  }

  return audio.directions[0] ?? sessionDirections[0] ?? 'sendrecv';
}
