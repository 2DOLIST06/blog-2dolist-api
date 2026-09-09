export type CleanedText = {
  value: string;
  blocksRemoved: number;
  charactersRemoved: number;
  firstRemovalOffset?: number;
};

export type CleanedContentJson = {
  value: unknown;
  blocksRemoved: number;
  charactersRemoved: number;
  previews: Array<{ blockIndex: number; field: 'html' | 'contentHtml'; before: string; after: string }>;
};

// A complete pair is required: an isolated or malformed marker is deliberately preserved.
const wordpressCommentsBlockPattern = /<!--\s+wp:comments(?:\s+\{[^\r\n]*\})?\s*-->[\s\S]*?<!--\s+\/wp:comments\s*-->/gi;

export function removeWordpressCommentsBlocks(value: string): CleanedText {
  let blocksRemoved = 0;
  let charactersRemoved = 0;
  let firstRemovalOffset: number | undefined;

  const cleaned = value.replace(wordpressCommentsBlockPattern, (match, offset: number) => {
    blocksRemoved += 1;
    charactersRemoved += match.length;
    firstRemovalOffset ??= offset;
    return '';
  });

  return { value: cleaned, blocksRemoved, charactersRemoved, firstRemovalOffset };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function removeWordpressCommentsFromContentJson(contentJson: unknown): CleanedContentJson {
  if (!isRecord(contentJson) || !Array.isArray(contentJson.blocks)) {
    return { value: contentJson, blocksRemoved: 0, charactersRemoved: 0, previews: [] };
  }

  let blocksRemoved = 0;
  let charactersRemoved = 0;
  let changed = false;
  const previews: CleanedContentJson['previews'] = [];
  const blocks = contentJson.blocks.map((block, blockIndex) => {
    if (!isRecord(block) || (block.type !== 'html' && block.type !== 'contentHtml')) return block;

    let nextBlock = block;
    for (const field of ['html', 'contentHtml'] as const) {
      if (typeof block[field] !== 'string') continue;
      const result = removeWordpressCommentsBlocks(block[field]);
      if (result.blocksRemoved === 0) continue;

      nextBlock = { ...nextBlock, [field]: result.value };
      changed = true;
      blocksRemoved += result.blocksRemoved;
      charactersRemoved += result.charactersRemoved;
      previews.push({ blockIndex, field, before: block[field], after: result.value });
    }
    return nextBlock;
  });

  return {
    value: changed ? { ...contentJson, blocks } : contentJson,
    blocksRemoved,
    charactersRemoved,
    previews,
  };
}
