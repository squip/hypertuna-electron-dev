import { visit } from 'unist-util-visit'
import * as nip19 from '@nostr/tools/nip19'
import type { Root, Text, Link } from 'mdast'

export function remarkNostrLinks() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === null || index === undefined) return

      const text = node.value
      const parts: Array<Text | Link> = []
      let lastIndex = 0

      const combinedRegex =
        /(?:nostr:)?(npub1[a-z0-9]{58}|nprofile1[a-z0-9]+|note1[a-z0-9]{58}|nevent1[a-z0-9]+|naddr1[a-z0-9]+|nsec1[a-z0-9]{58})/gi

      let match
      while ((match = combinedRegex.exec(text)) !== null) {
        const matchedText = match[0]
        const matchIndex = match.index

        if (matchIndex > lastIndex) {
          parts.push({
            type: 'text',
            value: text.slice(lastIndex, matchIndex)
          })
        }

        const identifier = matchedText.replace(/^nostr:/, '')
        const url = getNostrUrl(identifier)

        const link: Link = {
          type: 'link',
          url,
          children: [
            {
              type: 'text',
              value: formatNostrMention(identifier)
            }
          ]
        }
        parts.push(link)

        lastIndex = matchIndex + matchedText.length
      }

      if (lastIndex < text.length) {
        parts.push({
          type: 'text',
          value: text.slice(lastIndex)
        })
      }

      if (parts.length > 0) {
        parent.children.splice(index, 1, ...parts)
      }
    })
  }
}

function getNostrUrl(identifier: string): string {
  try {
    const prefix = identifier.slice(0, identifier.indexOf('1') + 1)

    switch (prefix) {
      case 'npub1':
      case 'nprofile1':
        return `#/users/${identifier}`
      case 'note1':
      case 'nevent1':
        return `#/notes/${identifier}`
      case 'naddr1':
        try {
          const decoded = nip19.decode(identifier)
          if (decoded.type === 'naddr' && decoded.data.kind === 30023) {
            return `#/articles/${identifier}`
          }
        } catch (_e) {
          // fall through
        }
        return `#/notes/${identifier}`
      default:
        return `nostr:${identifier}`
    }
  } catch (_e) {
    return `nostr:${identifier}`
  }
}

function formatNostrMention(identifier: string): string {
  try {
    const decoded = nip19.decode(identifier)

    switch (decoded.type) {
      case 'npub':
        return `@${identifier.slice(0, 12)}...`
      case 'nprofile':
        return `@${identifier.slice(0, 12)}...`
      case 'note':
        return `note:${identifier.slice(5, 12)}...`
      case 'nevent':
        return `note:${identifier.slice(7, 14)}...`
      case 'naddr':
        if ('identifier' in decoded.data && decoded.data.identifier) {
          return decoded.data.identifier
        }
        return `${identifier.slice(0, 12)}...`
      default:
        return identifier
    }
  } catch (_e) {
    return identifier
  }
}

export const nostrSanitizeSchema = {
  attributes: {
    '*': ['className', 'id'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    code: ['className'],
    pre: ['className'],
    div: ['className'],
    span: ['className']
  },
  tagNames: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'strong',
    'em',
    'u',
    's',
    'del',
    'ins',
    'a',
    'img',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'div',
    'span',
    'sup',
    'sub'
  ],
  protocols: {
    href: ['http', 'https', 'mailto', 'nostr'],
    src: ['http', 'https', 'data']
  }
}
