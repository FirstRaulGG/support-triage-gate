// Teams message bodies are HTML. This turns them into the plain text the model reads. Pure.

import { ATTACHMENT_MARKER } from "../../core/kits.js";
import { isGraphUrl } from "./graph.js";

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">",
  hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  bull: "•", middot: "·", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", cent: "¢",
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", auml: "ä", aring: "å",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï",
  oacute: "ó", ograve: "ò", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü",
  ccedil: "ç", ntilde: "ñ", szlig: "ß",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å",
  Eacute: "É", Egrave: "È", Ecirc: "Ê", Euml: "Ë",
  Iacute: "Í", Igrave: "Ì", Icirc: "Î", Iuml: "Ï",
  Oacute: "Ó", Ograve: "Ò", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
  Uacute: "Ú", Ugrave: "Ù", Ucirc: "Û", Uuml: "Ü",
  Ccedil: "Ç", Ntilde: "Ñ",
};

function fromCodePoint(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => fromCodePoint(parseInt(hex, 16)) ?? match)
    .replace(/&#(\d+);/g, (match, dec: string) => fromCodePoint(parseInt(dec, 10)) ?? match)
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) =>
      name === "amp" ? match : (NAMED_ENTITIES[name] ?? match),
    )
    .replace(/&amp;/g, "&"); // last: otherwise "&amp;lt;" would become "<"
}

/** Inline image URLs, kept only when hosted by Graph. Arbitrary hosts are never followed. */
export function extractInlineImageUrls(html: string): string[] {
  const urls: string[] = [];
  const pattern = /<img\b[^>]*\bsrc="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const url = match[1]!.replace(/&amp;/g, "&");
    if (isGraphUrl(url)) urls.push(url);
  }
  return urls;
}

/**
 * HTML -> text. Every image becomes `ATTACHMENT_MARKER`: that marker is how the rest of the system
 * knows, deterministically, that the reporter attached something. Mentions lose the tag and keep
 * the name.
 */
export function stripTeamsHtml(html: string): string {
  const withoutTags = html
    .replace(/<img\b[^>]*>/gi, `${ATTACHMENT_MARKER}\n`)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "");

  return decodeEntities(withoutTags)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
