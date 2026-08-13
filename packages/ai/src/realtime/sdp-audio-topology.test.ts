import { describe, expect, it } from 'vitest';
import { realtimeSdpSingleAudioDirection } from './sdp-audio-topology';

function sdp(...lines: string[]): string {
  return ['v=0', ...lines, ''].join('\r\n');
}

const AUDIO = 'm=audio 9 UDP/TLS/RTP/SAVPF 111';
const DATA = 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel';

describe('realtimeSdpSingleAudioDirection', () => {
  it.each([
    ['direction implicite', sdp(AUDIO, DATA), 'sendrecv'],
    ['direction audio explicite', sdp(AUDIO, 'a=sendrecv', DATA), 'sendrecv'],
    [
      'answer Pion/OpenAI avec direction du data channel',
      sdp(AUDIO, 'a=sendrecv', DATA, 'a=sendrecv'),
      'sendrecv',
    ],
    ['direction de session', sdp('a=sendonly', AUDIO, DATA), 'sendonly'],
    [
      'override media sur session',
      sdp('a=recvonly', AUDIO, 'a=sendrecv', DATA),
      'sendrecv',
    ],
    ['recvonly', sdp(AUDIO, 'a=recvonly', DATA), 'recvonly'],
    ['inactive', sdp(AUDIO, 'a=inactive', DATA), 'inactive'],
  ] as const)('classe %s', (_label, value, expected) => {
    expect(realtimeSdpSingleAudioDirection(value)).toBe(expected);
  });

  it.each([
    ['version absente', sdp(AUDIO).replace('v=0\r\n', '')],
    ['retour chariot isolé', `v=0\rm=audio 9 UDP/TLS/RTP/SAVPF 111\r`],
    ['m-line tronquée', sdp('m=audio 9 UDP/TLS/RTP/SAVPF')],
    ['port non numérique', sdp('m=audio nine UDP/TLS/RTP/SAVPF 111')],
    ['port hors plage', sdp('m=audio 65536 UDP/TLS/RTP/SAVPF 111')],
    ['compteur multiport hors profil Bob', sdp('m=audio 9/2 UDP/TLS/RTP/SAVPF 111')],
    ['nombre de ports nul', sdp('m=audio 9/0 UDP/TLS/RTP/SAVPF 111')],
    ['audio data channel déguisé', sdp('m=audio 9 DTLS/SCTP webrtc-datachannel', 'a=sendrecv', DATA)],
    ['audio RTP non sécurisé', sdp('m=audio 9 RTP/AVP 0', 'a=sendrecv', DATA)],
    ['audio protocole presque valide', sdp('m=audio 9 UDP/TLS/RTP/SAVP 111', DATA)],
    ['payload non numérique', sdp('m=audio 9 UDP/TLS/RTP/SAVPF webrtc-datachannel', DATA)],
    ['payload hors plage RTP', sdp('m=audio 9 UDP/TLS/RTP/SAVPF 128', DATA)],
    ['payload dupliqué', sdp('m=audio 9 UDP/TLS/RTP/SAVPF 111 111', DATA)],
    ['audio port zéro', sdp('m=audio 0 UDP/TLS/RTP/SAVPF 111', 'a=inactive')],
    ['deux audio dont une rejetée', sdp(AUDIO, 'm=audio 0 UDP/TLS/RTP/SAVPF 111')],
    ['vidéo active', sdp(AUDIO, 'm=video 9 UDP/TLS/RTP/SAVPF 96')],
    ['média RTP inconnu actif', sdp(AUDIO, 'm=text 9 RTP/AVP 98')],
    ['application RTP active', sdp(AUDIO, 'm=application 9 RTP/AVP 96', 'a=sendrecv')],
    ['application pseudo-SCTP', sdp(AUDIO, 'm=application 9 UDP/DTLS/SCTP rtp-data')],
    ['application SCTP multi-format', sdp(AUDIO, 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel 5000')],
    ['bundle-only ambigu', sdp(AUDIO, DATA, 'a=bundle-only')],
    ['direction session dupliquée', sdp('a=sendrecv', 'a=sendrecv', AUDIO)],
    ['direction media dupliquée', sdp(AUDIO, 'a=sendrecv', 'a=sendrecv')],
    ['direction media contradictoire', sdp(AUDIO, 'a=sendrecv', 'a=recvonly')],
    ['direction malformée', sdp(AUDIO, 'a=sendrecv:unexpected')],
    ['direction suffixée', sdp(AUDIO, 'a=sendrecvx')],
    ['direction data channel dupliquée', sdp(AUDIO, DATA, 'a=sendrecv', 'a=sendrecv')],
    ['direction data channel malformée', sdp(AUDIO, DATA, 'a=sendrecv:unexpected')],
    [
      'direction dupliquée sur une vidéo rejetée',
      sdp(AUDIO, 'm=video 0 UDP/TLS/RTP/SAVPF 96', 'a=inactive', 'a=inactive'),
    ],
    ['NUL', `${sdp(AUDIO)}\u0000`],
  ] as const)('refuse %s', (_label, value) => {
    expect(realtimeSdpSingleAudioDirection(value)).toBeNull();
  });

  it('tolère une section vidéo rejetée non bundle sans l’assimiler à une piste active', () => {
    expect(realtimeSdpSingleAudioDirection(sdp(
      AUDIO,
      'm=video 0 UDP/TLS/RTP/SAVPF 96',
      'a=inactive',
      DATA,
    ))).toBe('sendrecv');
  });

  it('tolère la forme SCTP numérique historique sans ouvrir un média RTP supplémentaire', () => {
    expect(realtimeSdpSingleAudioDirection(sdp(
      AUDIO,
      'm=application 9 DTLS/SCTP 5000',
      'a=sendrecv',
    ))).toBe('sendrecv');
  });
});
