/**
 * ADF <-> markdown, pinned on the shapes a ticket actually uses.
 *
 * Jira Cloud does not store markdown, and the rest of anvil only speaks markdown. The
 * conversion is deliberately a subset, so these tests cover the subset and the fallback:
 * an unknown node must keep its text rather than vanish. The round-trip test is the one
 * that matters most, because it is what makes acceptance criteria written in Jira readable
 * by the same extractor GitHub and local tickets use.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AdfDoc } from '@anvil/providers'
import { adfToMarkdown, extractAcceptance, markdownToAdf } from '@anvil/providers'

describe('ADF to markdown', () => {
  test('renders the block shapes a description uses', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Summary' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'The redirect loses the return path.' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
          ],
        },
        {
          type: 'orderedList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] }],
        },
        { type: 'rule' },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x = 1' }] },
      ],
    }

    assert.equal(
      adfToMarkdown(doc),
      [
        '## Summary',
        '',
        'The redirect loses the return path.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '',
        '---',
        '',
        '> quoted',
        '',
        '```ts',
        'const x = 1',
        '```',
      ].join('\n'),
    )
  })

  test('renders marks, links and a task list', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'code', marks: [{ type: 'code' }] },
            { type: 'text', text: ' and ' },
            {
              type: 'text',
              text: 'docs',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/docs' } }],
            },
          ],
        },
        {
          type: 'taskList',
          attrs: { localId: 'checks' },
          // A task item holds inline content in ADF, not paragraphs.
          content: [
            {
              type: 'taskItem',
              attrs: { localId: '1', state: 'DONE' },
              content: [{ type: 'text', text: 'finished' }],
            },
            {
              type: 'taskItem',
              attrs: { localId: '2', state: 'TODO' },
              content: [{ type: 'text', text: 'pending' }],
            },
          ],
        },
      ],
    }

    assert.equal(
      adfToMarkdown(doc),
      ['**bold** and `code` and [docs](https://example.com/docs)', '', '- [x] finished', '- [ ] pending'].join('\n'),
    )
  })

  test('a checklist item keeps its inline link and date', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'taskList',
          attrs: { localId: 'checks' },
          content: [
            {
              type: 'taskItem',
              attrs: { localId: '1', state: 'TODO' },
              content: [
                { type: 'text', text: 'ship by ' },
                { type: 'date', attrs: { timestamp: '1794873600000' } },
                { type: 'text', text: ' against ' },
                { type: 'inlineCard', attrs: { url: 'https://example.com/spec' } },
                { type: 'text', text: ' with ' },
                { type: 'mediaInline', attrs: { id: 'attachment-1', collection: 'jira', alt: 'screenshot' } },
              ],
            },
          ],
        },
      ],
    }

    assert.equal(adfToMarkdown(doc), '- [ ] ship by 2026-11-17 against https://example.com/spec with [screenshot]')
  })

  test('an out-of-range date is dropped rather than throwing', () => {
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'date', attrs: { timestamp: '8640000000000001' } }],
        },
      ],
    }
    assert.equal(adfToMarkdown(doc), '')
  })

  test('an unknown node keeps its text instead of disappearing', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'mystery', content: [{ type: 'text', text: 'kept' }] },
        { type: 'media', attrs: { alt: 'screenshot' } },
      ],
    } as unknown as AdfDoc
    const markdown = adfToMarkdown(doc)
    assert.match(markdown, /kept/)
    assert.match(markdown, /screenshot/)
  })

  test('a plain string body is accepted as markdown already', () => {
    assert.equal(adfToMarkdown('already markdown'), 'already markdown')
  })
})

describe('markdown to ADF', () => {
  test('converts headings, lists, marks and code', () => {
    const doc = markdownToAdf(
      [
        '# Title',
        '',
        'Some **bold** and `code`.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '',
        '```ts',
        'const x = 1',
        '```',
      ].join('\n'),
    )
    assert.deepEqual(
      doc.content.map((node) => node.type),
      ['heading', 'paragraph', 'bulletList', 'orderedList', 'codeBlock'],
    )
    const paragraph = doc.content[1]
    assert.deepEqual(
      paragraph?.content?.map((node) => ({ type: node.type, text: node.text })),
      [
        { type: 'text', text: 'Some ' },
        { type: 'text', text: 'bold' },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'code' },
        { type: 'text', text: '.' },
      ],
    )
    assert.deepEqual(paragraph?.content?.[1]?.marks, [{ type: 'strong' }])
    assert.deepEqual(paragraph?.content?.[3]?.marks, [{ type: 'code' }])
    assert.deepEqual(doc.content[4]?.attrs, { language: 'ts' })
  })

  test('a checklist stays literal so the shared extractor can read it back', () => {
    const markdown = ['- [ ] the return path survives', '- [x] the fallback works'].join('\n')
    const doc = markdownToAdf(markdown)
    assert.equal(adfToMarkdown(doc), markdown)
    assert.deepEqual(extractAcceptance(adfToMarkdown(markdownToAdf(markdown))), [
      'the return path survives',
      'the fallback works',
    ])
  })

  test('a full description survives a round trip', () => {
    const markdown = [
      'The redirect loses the return path.',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] the return path survives the login redirect',
      '- [ ] a missing return path falls back to the dashboard',
      '',
      '> Keep the query string.',
    ].join('\n')

    const back = adfToMarkdown(markdownToAdf(markdown))
    assert.equal(back, markdown)
    assert.deepEqual(extractAcceptance(back), [
      'the return path survives the login redirect',
      'a missing return path falls back to the dashboard',
    ])
  })

  test('ticket text with shell metacharacters is preserved as text', () => {
    const text = 'keep; rm -rf / #$(whoami) `id` **not bold'
    const back = adfToMarkdown(markdownToAdf(text))
    assert.match(back, /keep; rm -rf \/ #\$\(whoami\) `id`/)
  })

  test('CRLF input and a leading BOM do not leak into the document', () => {
    const doc = markdownToAdf('\uFEFF# Title\r\n\r\nBody\r\n')
    assert.equal(adfToMarkdown(doc), '# Title\n\nBody')
  })
})
