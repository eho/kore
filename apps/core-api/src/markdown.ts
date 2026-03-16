import type { BaseFrontmatter } from "@kore/shared-types";

/**
 * Render a memory to the canonical Markdown template (data_schema.md §2).
 */
export function renderMarkdown(opts: {
  frontmatter: BaseFrontmatter;
  title: string;
  distilledItems?: string[];
  rawSource?: string;
}): string {
  const { frontmatter, title, distilledItems, rawSource } = opts;

  const yamlLines = [
    "---",
    `id: ${frontmatter.id}`,
    `type: ${frontmatter.type}`,
    `category: ${frontmatter.category}`,
    `date_saved: ${frontmatter.date_saved}`,
    ...(frontmatter.date_created ? [`date_created: ${frontmatter.date_created}`] : []),
    ...(frontmatter.date_modified ? [`date_modified: ${frontmatter.date_modified}`] : []),
    `source: ${frontmatter.source}`,
    `tags: [${frontmatter.tags.map((t) => `"${t}"`).join(", ")}]`,
  ];
  if (frontmatter.url) {
    yamlLines.push(`url: ${frontmatter.url}`);
  }
  if (frontmatter.intent) {
    yamlLines.push(`intent: ${frontmatter.intent}`);
  }
  if (frontmatter.confidence !== undefined) {
    yamlLines.push(`confidence: ${frontmatter.confidence}`);
  }
  yamlLines.push("---");

  const sections = [
    yamlLines.join("\n"),
    "",
    `# ${title}`,
    "",
  ];

  if (distilledItems && distilledItems.length > 0) {
    sections.push("## Distilled Memory Items");
    for (const item of distilledItems) {
      sections.push(`- **${item}**`);
    }
    sections.push("");
  }

  if (rawSource !== undefined) {
    sections.push("---");
    sections.push("## Raw Source");
    sections.push(rawSource);
    sections.push("");
  }

  return sections.join("\n");
}
