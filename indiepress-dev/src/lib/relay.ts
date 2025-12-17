import { TRelayInfo } from '@/types'

const LANGUAGE_NAMES: Record<string, string> = {
  af: 'Afrikaans',
  ar: 'Arabic',
  bg: 'Bulgarian',
  bn: 'Bengali',
  ca: 'Catalan',
  cs: 'Czech',
  cy: 'Welsh',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  et: 'Estonian',
  eu: 'Basque',
  fa: 'Persian',
  fi: 'Finnish',
  fr: 'French',
  ga: 'Irish',
  gl: 'Galician',
  gu: 'Gujarati',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  is: 'Icelandic',
  it: 'Italian',
  ja: 'Japanese',
  jw: 'Javanese',
  kn: 'Kannada',
  ko: 'Korean',
  la: 'Latin',
  lt: 'Lithuanian',
  lv: 'Latvian',
  mk: 'Macedonian',
  ml: 'Malayalam',
  mr: 'Marathi',
  ms: 'Malay',
  mt: 'Maltese',
  ne: 'Nepali',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  sq: 'Albanian',
  sr: 'Serbian',
  su: 'Sundanese',
  sv: 'Swedish',
  sw: 'Swahili',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tl: 'Tagalog',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  zh: 'Chinese'
}

export function checkSearchRelay(relayInfo: TRelayInfo | undefined) {
  return relayInfo?.supported_nips?.includes(50)
}

export function checkNip43Support(relayInfo: TRelayInfo | undefined) {
  return relayInfo?.supported_nips?.includes(43) && !!relayInfo.pubkey
}

export function getRelayDisplayName(relayInfo: TRelayInfo | undefined): string {
  if (!relayInfo) {
    return ''
  }

  const langMatch = relayInfo.url.match(/lang\.relays\.land\/([a-z]{2})$/i)
  if (langMatch) {
    const langCode = langMatch[1].toLowerCase()
    const languageName = LANGUAGE_NAMES[langCode]
    if (languageName) {
      return languageName
    }
  }

  return relayInfo.name || relayInfo.shortUrl
}
